"""Read-only motion observer. Never submits commands or waits on the control loop."""
import copy
from collections import deque,OrderedDict
from pathlib import Path
import threading
import time
import numpy as np
from .active_safety import _mount
from .contracts import ControlCommand, CommandSource, SensorKind, to_dict
from .control_semantics import SemanticAssociator
from .prediction import PredictionEngine, rotation, intended_conflict,ego_paths,assess_conflicts
from .motion_quality import MotionQuality
from .kinematic_prediction import rank_learned_modes
from .maneuver import ObservedSpace
from .motion_geometry import object_assessments


def local_modes(modes, prediction, source_timestamp_s=None):
    """Pinned Trajectron emits odometry coordinates, converted for this frame."""
    r=rotation(prediction['odometry_yaw_rad']);origin=np.asarray(prediction['odometry_origin_m'])
    converted=[]
    for mode in modes:
        points=np.asarray(mode['points'],float)
        if points.ndim!=2 or points.shape[1]!=3 or not np.isfinite(points).all():
            raise ValueError('Invalid display trajectory')
        age=max(0.,prediction['timestamp_s']-source_timestamp_s) if source_timestamp_s is not None else 0.
        if age>=points[-1,0]:continue
        times=np.r_[age,points[points[:,0]>age,0]]
        points=np.column_stack((times-age,np.interp(times,points[:,0],points[:,1]),np.interp(times,points[:,0],points[:,2])))
        xy=(points[:,1:3]-origin)@r
        converted.append({**mode,'points':np.column_stack((points[:,0],xy)).tolist()})
    return converted


def measured_control_view(scene,reference):
    """Small display view; the complete immutable control forecasts stay owned.

    Do not copy/rebuild/score their full graph in a competing Python thread
    while the synchronized control owner is proving a maneuver.
    """
    keys=('id','position_m','half_size_m','velocity_mps','class','confirmed','occlusion_s','semantic_evidence','measurement_evidence')
    return {'version':3,'session_id':scene.session_id,'evaluation_frame':scene.observation.frame_id,
        'timestamp_s':scene.observation.timestamp_s,'coordinate_frame':'EGO_AT_EVALUATION',
        'published_wall_s':time.monotonic(),
        'render_reference':copy.deepcopy(reference),
        'tracks':[{key:to_dict(track[key]) for key in keys if key in track} for track in scene.prediction['tracks']],
        'trajectories':[],'conflicts':[],'used_for_applied_decision':False,
        'display_observer_deferred':True,'source':'MEASURED_CONTROL_SCENE',
        'deferred_reason':'Supplementary display forecasts deferred while control owns the maneuver'}


class DisplayPredictionService:
    def __init__(self, service, perception):
        self.service=service;self.perception=perception;self.latest=None;self.error=None
        self.engine=None;self.poses=deque(maxlen=64);self.worker=None;self.worker_error=None
        self.requested_until=0.
        self.quality=MotionQuality()
        self.frames=OrderedDict()
        root=Path(__file__).resolve().parents[2]
        try:
            if not (root/'.venv-trajectron/Scripts/python.exe').is_file():
                raise OSError('Trajectron runtime is not installed')
            from ..learning.async_worker import AsyncPredictionWorker
            self.worker=AsyncPredictionWorker('trajectron')
        except (OSError,ValueError) as error:self.worker_error=str(error)
        self.stop=threading.Event();self.thread=threading.Thread(target=self._run,daemon=True,name='display-motion-observer')
        self.thread.start()

    def _run(self):
        previous=None;last_submission=0.;due=time.monotonic()
        # The admitted test planner gets ten-Hz starts. Ordinary display-only
        # geometry runs at five Hz so a rejected planner does not consume the
        # normal driver's CPU budget. RGB and detector rates are independent.
        while not self.stop.wait(max(0.,due-time.monotonic())):
            observed_began=time.monotonic();due=observed_began+.1
            try:
                # This observer has no control consumer. Build optional visual
                # forecasts only while a Details client actually requests them.
                if observed_began>self.requested_until:continue
                s=self.service
                # Only copy immutable sensor data under the service lock. All
                # tracking, classification and learned inference run outside it.
                with s.lock:
                    if not s._live():self.latest=None;continue
                    history=s.policy_history.snapshot()
                    if not history:continue
                    observation=history[-1];key=(s.session_id,observation.frame_id)
                    planning_active=(getattr(s.provider,'navigation_planner',None) is not None or
                                     getattr(s.provider,'navigation_recovery',None) is not None or
                                     bool(getattr(s.provider,'navigation_bypass',None) and s.provider.navigation_bypass.motion_required))
                    from ..learning.recovery_budget import active_ticket
                    recovery_testing=active_ticket() is not None
                    planning_active=planning_active or recovery_testing
                    due=observed_began+(.1 if planning_active else .2)
                    if key==previous:continue
                    previous=key
                    from .route_bypass import RuleRouteBypass
                    bypass=getattr(s.provider,'navigation_bypass',None)
                    critical_control=(isinstance(bypass,RuleRouteBypass) and bypass.motion_required or
                        getattr(s,'journey',{}).get('driving_mode')=='HYBRID')
                    if critical_control:
                        # Capture the scene under the same lock as its frame.
                        # Previously a race could build a second complete scene
                        # and score forecasts while the owner missed 250 ms.
                        measured=getattr(s,'control_scene',None)
                        self.latest=(measured_control_view(measured,s.render_pose_cache.get(observation.frame_id))
                            if measured is not None and measured.observation.frame_id==observation.frame_id and
                               measured.prediction.get('motion_tracking_complete') else None)
                        self.error=None;due=observed_began+.2
                        continue
                    lidar=next(c for c in observation.channels if c.kind==SensorKind.LIDAR)
                    data=s.provider.get_sensor_asset(lidar.asset)
                    depth_assets={c.asset.path:s.provider.get_sensor_asset(c.asset) for c in observation.channels if c.kind==SensorKind.DEPTH}
                    reference=copy.deepcopy(s.render_pose_cache.get(observation.frame_id))
                    source_frames=s.sensor_frame_cache.get(observation.frame_id,())
                    front=next((f for f in source_frames if f.sensor_id=='frontCamera'),None)
                    front_camera={'width':front.metadata['width'],'height':front.metadata['height'],'fovDeg':front.metadata['fov_deg'],
                        'worldTransform':to_dict(front.transform),'frame':front.frame_id,'timestamp':front.timestamp_s} if front else None
                captured=time.monotonic()
                if self.engine is None or self.engine.session_id!=key[0]:
                    self.engine=PredictionEngine(key[0],enhanced=True,geometry=getattr(s.provider,'vehicle_geometry',None));self.poses.clear();self.quality=MotionQuality()
                    self.frames.clear();self.semantics=SemanticAssociator()
                position,angles=_mount(lidar)
                if np.any(np.abs(angles)>1e-4):raise ValueError('Display LiDAR mount must be level')
                points=np.frombuffer(data,dtype='<f4').reshape(-1,4)[:,:3]+position
                if not np.isfinite(points).all():raise ValueError('Invalid display LiDAR samples')
                ego=observation.ego
                base=ControlCommand(observation.frame_id,observation.timestamp_s,ego.throttle,ego.brake,
                    ego.steering,ego.reverse,ego.handbrake,CommandSource.SYSTEM,ego.gear)
                measured=getattr(s,'control_scene',None)
                if measured is None or measured.observation.frame_id!=observation.frame_id or not measured.prediction.get('motion_tracking_complete',True):
                    from .control_scene import ControlSceneBuilder
                    if getattr(self,'scene_builder',None) is None or self.scene_builder.session_id!=key[0]:
                        self.scene_builder=ControlSceneBuilder(key[0],getattr(s.provider,'vehicle_geometry',None))
                    assets={lidar.asset.path:data,**depth_assets}
                    measured=self.scene_builder.build(observation,lambda a:assets[a.path],received_wall_s=captured)
                prediction=to_dict(measured.prediction)
                applied=getattr(s,'control_decision_prediction',None)
                if applied and 0<=observation.timestamp_s-applied['timestamp_s']<=.1+1e-6:
                    prediction['applied_decision_prediction']=copy.deepcopy(applied)
                prediction['used_for_applied_decision']=False
                tracked=time.monotonic()
                # Admit measured control data before slower display/model
                # scoring. Control never waits for learned display trajectories.
                space=None
                if planning_active:
                    # Share the immutable measured scene and its lazy map. A
                    # display refresh must not reconstruct full control occupancy.
                    depth_ready=time.monotonic()
                    space=measured.space
                    mapped=time.monotonic()
                    control_prediction=copy.deepcopy(prediction)
                    control_prediction.update(published_wall_s=time.monotonic(),control_trajectories=control_prediction['trajectories'])
                    # ControlScene is published by the synchronized sensor owner.
                    # Display/model work never replaces that measured scene.
                space_ready=time.monotonic()
                self.poses.append((observation.timestamp_s,*prediction['odometry_origin_m'],prediction['odometry_yaw_rad'],observation.frame_id))
                detected=self.perception.latest(key[0]) if self.perception else {}
                self.semantics.apply(prediction,observation,self.poses,detected)
                prediction.update(render_reference=reference,display_only=True,display_source='MEASURED_KINEMATIC',
                    model_status='WARMING_UP',model_reason='Waiting for classified motion history',
                    published_wall_s=time.monotonic())
                prediction['front_camera']=front_camera
                g=self.engine.geometry;front=[];rear=[]
                for tr in prediction['tracks']:
                    x,y=tr['position_m'];hx,hy=tr['half_size_m'];vx=tr['velocity_mps'][0]
                    if not tr['confirmed'] or abs(y)>g.half_width_m+hy+.3:continue
                    if x>0:
                        gap=max(0.,x-hx-g.front_m);closing=ego.speed_mps-vx
                        front.append((gap,gap/closing if closing>.25 else None))
                    else:
                        gap=max(0.,-x-hx-g.rear_m);closing=vx-ego.speed_mps
                        rear.append((gap,gap/closing if closing>.25 else None))
                prediction['surroundings']={'front_gap_m':min((v[0] for v in front),default=None),'rear_gap_m':min((v[0] for v in rear),default=None),
                    'front_ttc_s':min((v[1] for v in front if v[1] is not None),default=None),'rear_ttc_s':min((v[1] for v in rear if v[1] is not None),default=None)}
                prediction['measured_trajectories']=prediction['trajectories']
                prediction['control_trajectories']=prediction['measured_trajectories']
                if not prediction['ego_trajectories']:
                    # The shared control scene deliberately omits display-only
                    # default forecasts. Build those here, outside control.
                    paths=ego_paths(ego.speed_mps,ego.steering,ego.throttle,geometry=self.engine.geometry)
                    prediction['ego_trajectories']=[{'intent':p['intent'],'points':p['points'].tolist()} for p in paths]
                    prediction['conflicts']=assess_conflicts(prediction['tracks'],prediction['control_trajectories'],paths)
                prediction['object_assessments']=object_assessments(prediction['tracks'],prediction['control_trajectories'],
                    prediction['ego_trajectories'][0]['points'],self.engine.geometry,prediction['conflicts'],centered=True)
                # Rear-only padded overlaps remain in the diagnostic list, but
                # are not presented as a forward crossing or a brake request.
                prediction['conflict_point']=intended_conflict([c for c in prediction['conflicts'] if c['point_m'][0]>0],ego.speed_mps,ego.throttle)
                if self.worker and not planning_active:
                    self.worker_error=self.worker.error
                    learned=self.worker.current(key[0],observation.timestamp_s)
                    if learned and learned.get('modes'):
                        modes,rejected=rank_learned_modes(local_modes(learned['modes'],prediction,learned['timestamp_s']),prediction['tracks'])
                        prediction['rejected_modes']=rejected
                        ids={m['track_id'] for m in modes}
                        prediction['supplementary_model_candidates']=modes
                        prediction.update(display_source='MEASURED_CONTROL_GEOMETRY',model_status='READY',
                            model_reason='Ranked by measured continuity · learned control acceptance pending',
                            learned_source_frame=learned['frame_id'],learned_source_timestamp_s=learned['timestamp_s'],
                            inference_ms=learned['end_to_end_ms'])
                    elif self.worker.latest and not learned:
                        prediction.update(model_status='STALE',model_reason='Trajectron result exceeded freshness limits; showing measured motion')
                    wall=time.monotonic()
                    if wall-last_submission>=.5:
                        tracks=[t for t in prediction['tracks'] if t['confirmed'] and t['class']!='UNKNOWN' and len(t['history'])>=2]
                        if tracks:
                            self.worker.submit(dict(session_id=key[0],frame_id=observation.frame_id,
                                timestamp_s=observation.timestamp_s,tracks=tracks[:16]))
                            last_submission=wall
                if self.worker_error:prediction.update(model_status='UNAVAILABLE',model_reason=self.worker_error)
                prediction['motionQuality']=(self.quality.snapshot() if planning_active else
                    self.quality.update(observation.timestamp_s,prediction['tracks'],prediction['trajectories'],
                        np.asarray(prediction['odometry_origin_m']),prediction['odometry_yaw_rad']))
                if planning_active:prediction.update(model_status='MEASURED_RECOVERY',
                    model_reason='Fresh measured trajectories during bounded recovery; display inference deferred')
                prediction['vehicle_geometry']=self.engine.geometry.snapshot() if self.engine.geometry else None
                # Immutable publication, outside the command lock. Raw points
                # stay in-process and never inflate dashboard/WebSocket payloads.
                # A rejected prototype must not spend normal-driving CPU on a
                # dense maneuver map that no control consumer is allowed to use.
                if recovery_testing and space is not None:
                    from .congestion_recovery import CongestionRecovery
                    probe=CongestionRecovery(self.engine.geometry)
                    prediction['recovery_readiness']={name:space.certificate(probe._path(ego.speed_mps,steer,reverse)[0])
                        for name,steer,reverse in (('forward',0.,False),('reverse',0.,True),('left',-.15,False),('right',.15,False))}
                    prediction['recovery_depth_channels']=[c.sensor_id for c in observation.channels if c.kind==SensorKind.DEPTH]
                prediction['quality_metrics']['observer_ms']=(time.monotonic()-observed_began)*1000
                prediction['quality_metrics'].update(capture_ms=(captured-observed_began)*1000,
                    tracking_ms=(tracked-captured)*1000,space_ms=(space_ready-tracked)*1000,
                    display_scoring_ms=(time.monotonic()-space_ready)*1000)
                if planning_active:prediction['quality_metrics'].update(depth_ms=(depth_ready-tracked)*1000,map_ms=(mapped-depth_ready)*1000,copy_ms=(space_ready-mapped)*1000)
                prediction['quality_metrics']['observer_target_hz']=10 if planning_active else 5
                s.motion_snapshot=prediction
                self.latest=prediction;self.error=None
                self.frames[observation.frame_id]=prediction
                while len(self.frames)>128:self.frames.popitem(last=False)
            except (ValueError,KeyError,OSError,TypeError,ArithmeticError,StopIteration) as error:
                self.error=str(error);self.latest=None

    def snapshot(self,frame_id=None):
        self.requested_until=time.monotonic()+2.
        result=self.frames.get(frame_id) if frame_id is not None else self.latest
        if frame_id is not None:
            return {'status':'RUNNING','prediction':result} if result else {'status':'WAITING','error':'No measured forecast for this exact image frame'}
        if self.error:return {'status':'ERROR','error':self.error}
        if not result:return {'status':'WAITING','error':'Waiting for complete native sensor frames'}
        if time.monotonic()-result['published_wall_s']>1.:
            return {'status':'STALE','error':'Motion observations stopped updating'}
        return {'status':'RUNNING','prediction':result}

    def close(self):
        self.stop.set();self.thread.join(timeout=3)
        if self.worker:self.worker.close()
