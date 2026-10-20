"""Measured object volumes and corridor hypotheses, without simulator actor state."""
import math
import numpy as np
from .contracts import to_dict
from .prediction import ego_paths,assess_conflicts
from .pedestrian_anticipation import DRIVE_ACCELERATIONS


def metric_semantics(semantic,prediction,observation):
    depth=semantic.get('depth_evidence') or {}
    return bool(semantic.get('session_id')==prediction.get('session_id') and semantic.get('confidence',0)>=.65
        and semantic.get('source_sensor')=='frontCamera' and type(semantic.get('source_frame'))is int and semantic['source_frame']>=0
        and 0<=observation.timestamp_s-semantic.get('timestamp_s',-10)<=.75
        and depth.get('source_sensor')=='depth' and depth.get('frame_id')==semantic.get('source_frame')
        and abs(depth.get('timestamp_s',-10)-semantic.get('timestamp_s',-20))<1e-6
        and 0<depth.get('axial_m',0)<100 and depth.get('samples',0)>=4)


def measured_boxes(prediction,points,observation,*,lidar_points=None):
    points=np.asarray(points);result=[]
    for track in prediction.get('tracks',()):
        semantic=track.get('semantic_evidence') or {}
        if (not track.get('confirmed') or track.get('occlusion_s',1)>.1 or
            track.get('class') not in ('person','pedestrian','car','truck','bus','motorcycle','bicycle') or
            not metric_semantics(semantic,prediction,observation)):continue
        center=np.asarray(track['position_m']);half=np.asarray(track['half_size_m'])
        if center[0]<=0 or np.linalg.norm(center)>80 or max(half)>8:continue
        support=points[(np.abs(points[:,0]-center[0])<=half[0]+.15)&
            (np.abs(points[:,1]-center[1])<=half[1]+.15)&(points[:,2]>.15)&(points[:,2]<4.)]
        if len(support)<8:continue
        low,high=np.quantile(support[:,:3],[.03,.97],axis=0)
        if high[2]-low[2]<.35 or min(high[:2]-low[:2])<.03:continue
        maximum_height={'person':2.5,'pedestrian':2.5,'car':2.5,'motorcycle':2.5,'bicycle':2.5}.get(track['class'],4.)
        if high[2]-low[2]>maximum_height:continue # merged support is uncertain, never clipped into a fabricated body
        lidar_support=None
        if lidar_points is not None:
            lidar_points=np.asarray(lidar_points)
            lidar_support=int(np.count_nonzero((np.abs(lidar_points[:,0]-center[0])<=half[0]+.15)&
                (np.abs(lidar_points[:,1]-center[1])<=half[1]+.15)&(lidar_points[:,2]>.15)&(lidar_points[:,2]<4.)))
            if not lidar_support:continue
        result.append({'track_id':track['id'],'class':track['class'],'center_m':((low+high)/2).tolist(),
            'half_size_m':((high-low)/2).tolist(),'yaw_rad':0.,
            'velocity_mps':to_dict(track['velocity_mps']),'source':'CURRENT_SENSOR_GEOMETRY',
            'measurement_frame':observation.frame_id,'timestamp_s':observation.timestamp_s,
            'support_points':len(support),'lidar_support_points':lidar_support,'confidence':semantic['confidence'],
            'extent_kind':'MEASURED_VISIBLE_VOLUME_NOT_COMPLETE_OCCLUDED_BODY'})
    return result


def corridor_forecasts(prediction,observation,geometry,decision):
    base=decision.get('base_command') or {}
    speed=observation.ego.speed_mps;horizon=max(3.,.6+abs(speed)/5.)
    grid=np.arange(int(math.ceil(horizon/.1))+1)*.1
    throttle=base.get('throttle',observation.ego.throttle)
    steering=base.get('steering',observation.ego.steering)
    intent='LAUNCH' if speed<.2 and throttle>.01 else 'CONTINUE'
    paths=[p for p in ego_paths(speed,steering,throttle,geometry=geometry,grid=grid,
        drive_accelerations=DRIVE_ACCELERATIONS,cap_mps=decision.get('prediction_speed_cap_mps')) if p['intent']!='BRAKE']
    current=[t for t in prediction.get('tracks',()) if t.get('confirmed') and t.get('occlusion_s',1)<=.1
        and t['position_m'][0]>geometry.front_m]
    tracks=[t for t in current if t.get('class') in ('person','pedestrian','car','truck','bus','motorcycle','bicycle')
        and metric_semantics(t.get('semantic_evidence',{}),prediction,observation)]
    by_id={t['id']:t for t in tracks};modes=[]
    for mode in prediction.get('trajectories',()):
        track=by_id.get(mode['track_id'])
        if track is None:continue
        if track.get('observed_crossing_cleared') and mode['source'] in ('PEDESTRIAN_POSSIBLE_START','PEDESTRIAN_POSSIBLE_RETREAT','PEDESTRIAN_POSSIBLE_RUN'):continue
        modes.append(mode)
    result={}
    selected=decision.get('pedestrian_prediction') if decision.get('frame_id')==observation.frame_id else None
    if selected and selected['track_id'] in by_id:
        result[selected['track_id']]={'track_id':selected['track_id'],'source':selected['source'],
            'points':to_dict(selected['trajectory']),'class':by_id[selected['track_id']].get('class'),
            'used_for_actuation':True,'conflict_time_s':selected['time_s']}
    surface=decision.get('path_conflict') if decision.get('frame_id')==observation.frame_id else None
    if surface and surface.get('forecast_motion_mps'):
        center=np.asarray(surface['center_m']);velocity=np.asarray(surface['forecast_motion_mps'])
        nearest=min(current,key=lambda t:float(np.linalg.norm(np.asarray(t['position_m'])-center)),default=None)
        match=nearest if nearest and np.linalg.norm(np.asarray(nearest['position_m'])-center)<=1.5 else None
        identity=match['id'] if match else 'surface-conflict'
        if identity not in result:
            times=np.arange(26)*.1
            result[identity]={'track_id':identity,'source':surface.get('source','LIDAR_SURFACE_TRACK'),'class':match.get('class') if match else 'UNKNOWN',
                'points':to_dict(surface.get('trajectory')) if surface.get('trajectory') else np.column_stack((times,center[None,:]+times[:,None]*velocity)).tolist(),
                'used_for_actuation':True}
    if paths:
        for conflict in assess_conflicts(tracks,modes,paths,grid=grid):
            if conflict.get('separating_rear_overlap') or conflict.get('braking_worsens_rear_conflict'):continue
            key=conflict['track_id']
            if key in result:continue
            result[key]={'track_id':key,'source':conflict['source'],'points':to_dict(conflict['trajectory']),
                'class':by_id[key].get('class'),'used_for_actuation':False,'conflict_time_s':conflict['time_s']}
    return list(result.values())
