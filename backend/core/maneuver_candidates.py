"""Stable, immutable action/trajectory/mask bundles and independent execution shield."""
from dataclasses import dataclass, replace
import hashlib
import json
import math
import numpy as np
from .contracts import CommandSource, freeze_json, to_dict
from .corridor_uncertainty import uncertain_corridor_tracks
from .motion_geometry import GRID, footprint_centers, integrate
from .prediction import assess_conflicts
from .maneuver import route_path

MODES=('MANUAL_PROTECTION','AUTONOMOUS')
CANDIDATE_IDS=('HOLD','DRIVER','CONTINUE','SLOW','STOP','ACCELERATE','FORWARD_LEFT','FORWARD_RIGHT',
               'LANE_LEFT','LANE_RIGHT','REVERSE_STRAIGHT','REVERSE_LEFT','REVERSE_RIGHT',
               'PASS_LEFT','PASS_RIGHT','RETURN','ROUTE_LEFT','ROUTE_RIGHT')


@dataclass(frozen=True)
class CandidateBundle:
    scene_frame: int
    timestamp_s: float
    mode: str
    candidates: tuple
    status: str
    snapshot_hash: str
    observation_hash: str | None = None

    @property
    def masks(self):return np.array([c['admitted'] for c in self.candidates],bool)

    def wire(self):
        return {'frame_id':self.scene_frame,'timestamp_s':self.timestamp_s,'mode':self.mode,
                'candidate_ids':list(CANDIDATE_IDS),'candidates':to_dict(self.candidates),
                'action_masks':self.masks.tolist(),'status':self.status,'snapshot_hash':self.snapshot_hash,
                'observation_hash':self.observation_hash}


def signed_path(speed,steering,acceleration,geometry,reverse=False,*,bounded=False):
    speed=0. if abs(speed)<1e-4 else speed
    path=integrate(speed,steering,acceleration,geometry,cap_mps=1. if bounded else 15.)
    if reverse:
        path[:,1:3]*=-1.;path[:,3]*=-1.
        # Reflection of heading needs reintegration: reversing right steering
        # sweeps the rear right and rotates the front left in right-positive axes.
        ds=-np.linalg.norm(np.diff(path[:,1:3],axis=0),axis=1)
        yaw=np.r_[0.,np.cumsum(ds)]*math.tan(steering*geometry.max_steer_rad)/geometry.wheelbase_m
        mid=(yaw[:-1]+yaw[1:])*.5
        path[:,1:3]=np.vstack((np.zeros(2),np.cumsum(ds[:,None]*np.column_stack((np.cos(mid),np.sin(mid))),axis=0)))
        path[:,3]=yaw
    if bounded:
        distance=np.r_[0.,np.cumsum(np.linalg.norm(np.diff(path[:,1:3],axis=0),axis=1))]
        beyond=np.flatnonzero(distance>2.)
        if len(beyond):path[beyond]=path[max(0,beyond[0]-1)]
        path[:,0]=GRID
    return path


def stopping_tail(path,speed,geometry,reverse,*,reaction_s=.35,initial_deceleration=0.):
    """Reaction plus measured assumed stopping distance, with full curved body."""
    speed=0. if abs(speed)<1e-4 else speed
    end=path[-1]
    initial_deceleration=max(0.,min(3.,initial_deceleration))
    remaining=max(0.,speed-initial_deceleration*reaction_s)
    duration=(speed/initial_deceleration if initial_deceleration>0 and remaining==0 else reaction_s+remaining/3.)
    times=np.arange(.05,duration+.051,.05)
    velocities=np.where(times<=reaction_s,np.maximum(0.,speed-initial_deceleration*times),
                         np.maximum(0.,remaining-3.*(times-reaction_s)))
    dist=np.cumsum((np.r_[speed,velocities[:-1]]+velocities)*.025)
    signed=dist*(-1. if reverse else 1.)
    # Continue terminal measured curvature through the stopping tail.
    segment=np.diff(path[-2:,1:3],axis=0)[0];ds=np.linalg.norm(segment)
    curvature=(path[-1,3]-path[-2,3])/(ds*(-1 if reverse else 1)) if ds>.001 else 0.
    yaw=end[3]+signed*curvature
    if abs(curvature)<1e-5:
        xy=end[1:3]+signed[:,None]*np.array([math.cos(end[3]),math.sin(end[3])])
    else:
        xy=np.column_stack((end[1]+(np.sin(yaw)-math.sin(end[3]))/curvature,
                            end[2]+(math.cos(end[3])-np.cos(yaw))/curvature))
    return np.vstack((path,np.column_stack((end[0]+times,xy,yaw))))


class ExecutionShield:
    """No learned dependency; checks fresh space, every mode and entire body."""
    def check(self,scene,path,command,road,*,timestamp_s,wall_s,full_maneuver=False):
        if not scene.usable(timestamp_s,wall_s):return False,'STALE_CONTROL_SCENE',{}
        lookup=getattr(type(scene.space),'get_execution_proof',None)
        if lookup is None:
            return self._check(scene,path,command,road,timestamp_s=timestamp_s,wall_s=wall_s,full_maneuver=full_maneuver)
        # Reuse deterministic geometry, never a previous frame's permission.
        # The independent check revalidates freshness and binds every proposed
        # control, its exact path and the measured road context before lookup.
        digest=hashlib.sha256(np.asarray(path,dtype='<f8').tobytes())
        digest.update(np.asarray(road.get('drivable_strips',()),dtype='<f8').tobytes())
        digest.update(repr((int(command.frame_id),float(command.timestamp_s),float(command.throttle),float(command.brake),
            float(command.steering),bool(command.reverse),None if command.gear is None else int(command.gear),bool(command.handbrake),
            bool(road.get('traffic_stop')),bool(full_maneuver),'drivable_strips' in road,float(timestamp_s))).encode())
        key=digest.hexdigest();proof=lookup(scene.space,key)
        if proof is not None:
            ok,reason,evidence=to_dict(proof)
            return ok,reason,evidence
        result=self._check(scene,path,command,road,timestamp_s=timestamp_s,wall_s=wall_s,full_maneuver=full_maneuver)
        scene.space.put_execution_proof(key,result)
        return result

    def _check(self,scene,path,command,road,*,timestamp_s,wall_s,full_maneuver=False):
        if not scene.usable(timestamp_s,wall_s):return False,'STALE_CONTROL_SCENE',{}
        # The command lease is one decision interval, followed by a complete
        # reaction/braking tail. A three-second advisory forecast is not a
        # three-second commitment to drive through unobserved space.
        planned=np.asarray(path,float)
        leased=planned[planned[:,0]<=.1+1e-6]
        if len(leased)<2:leased=planned[:2]
        from .ego_motion import signed_speed,motion_speed
        speed=float(motion_speed(scene.observation.ego))
        braking_reverse=signed_speed(scene.observation.ego)<0
        if command.brake>0:
            # Preserve the proposed partial brake during its command lease.
            # Brake pressure is not a promise of instantaneous -3 m/s².
            leased=signed_path(speed,command.steering,-command.brake*5.,scene.geometry,braking_reverse)[:2]
        terminal=np.linalg.norm(leased[-1,1:3]-leased[-2,1:3])/max(.001,leased[-1,0]-leased[-2,0])
        checked=stopping_tail(leased,terminal,scene.geometry,braking_reverse if command.brake>0 else command.reverse,
                              initial_deceleration=command.brake*5.)
        if full_maneuver:
            # Admission of a lane change requires its intended corridor as
            # well as the independent check of the actual command each tick.
            checked=planned
        prediction=scene.prediction
        tracks=prediction['tracks'];modes=prediction['control_trajectories']
        incomplete=[m['track_id'] for m in modes if not len(m['points']) or m['points'][-1][0]+1e-6<checked[-1,0]]
        if incomplete:return False,'FORECAST_HORIZON_INCOMPLETE',{'track_ids':sorted(set(incomplete)),
            'required_horizon_s':float(checked[-1,0])}
        uncertain=uncertain_corridor_tracks(tracks,modes,checked,scene.geometry,retained_forecasts=True)
        if uncertain:return False,'REACHABLE_CORRIDOR_UNCERTAINTY',{'track_ids':uncertain}
        grid=np.unique(np.round(np.r_[GRID,checked[:,0]],6))
        conflict_path=np.column_stack((grid,*(np.interp(grid,checked[:,0],checked[:,i]) for i in (1,2,3))))
        conflicts=assess_conflicts(tracks,modes,[{'intent':'CANDIDATE','points':footprint_centers(conflict_path,scene.geometry),'half':scene.geometry.half}],grid=grid)
        conflicts=[c for c in conflicts if not c.get('separating_rear_overlap')]
        future_hold_conflicts=[c for c in conflicts if c['time_s']>checked[-1,0]+.1]
        conflicts=[c for c in conflicts if c['time_s']<=checked[-1,0]+.1]
        if conflicts:return False,'PREDICTED_INTERSECTION',{'conflicts':[
            {k:c[k] for k in ('track_id','mode','source','time_s','point_m')} for c in conflicts]}
        moving=bool(np.any(np.linalg.norm(path[:,1:3],axis=1)>.01))
        certificate=scene.space.certificate(checked)
        if not certificate['verified']:return False,'SWEPT_SPACE_UNKNOWN_OR_OCCUPIED',certificate
        if 'drivable_strips' in road:
            from .drivable_corridor import certificate as road_certificate
            road_evidence=road_certificate(checked,scene.geometry,road['drivable_strips'])
            if not road_evidence['verified']:return False,'BODY_OUTSIDE_DRIVABLE_ROAD',road_evidence
            certificate={**certificate,'drivable_body':road_evidence}
        if road.get('traffic_stop') and moving:return False,'TRAFFIC_RULE_STOP',certificate
        if command.reverse!=scene.observation.ego.reverse and speed>=.15:
            return False,'GEAR_CHANGE_REQUIRES_STOP',certificate
        return True,'VERIFIED_MEASURED_CORRIDOR',{**certificate,'execution_lease_s':.1,
            'complete_stopping_tail_verified':not full_maneuver,'intended_maneuver_verified':full_maneuver,
            'advisory_path_horizon_s':float(planned[-1,0]),
            'future_hold_conflicts':[{k:c[k] for k in ('track_id','time_s','point_m')} for c in future_hold_conflicts],
            'fallback_hold_safe_against_rear_impact':not any(c['point_m'][0]<-scene.geometry.rear_m for c in future_hold_conflicts)}


class CandidateGenerator:
    def __init__(self):self.shield=ExecutionShield()

    def build(self,scene,base,road,mode,cap_mps,*,wall_s,permitted_candidates=None):
        if mode not in MODES:raise ValueError('Unknown policy mode')
        from .ego_motion import motion_speed
        o=scene.observation;g=scene.geometry;speed=motion_speed(o.ego)
        rows=[]
        for name in CANDIDATE_IDS:
            reverse=name.startswith('REVERSE')
            steer=base.steering;accel=0.;reason=None
            offset=0.;target=cap_mps
            if name in ('HOLD','STOP'):target=0.;accel=-3.
            elif name=='SLOW':target=max(0.,speed-2.);accel=-1.5
            elif name=='ACCELERATE':accel=2.
            elif name in ('CONTINUE','DRIVER'):accel=base.throttle*2.5-base.brake*5.
            if name in ('FORWARD_LEFT','FORWARD_RIGHT','REVERSE_LEFT','REVERSE_RIGHT'):
                steer=-.35 if name.endswith('LEFT') else .35
            if reverse:target=1.;accel=.5
            if name in ('FORWARD_LEFT','FORWARD_RIGHT'):target=1.;accel=.5
            if name=='REVERSE_STRAIGHT':steer=0.
            if name in ('LANE_LEFT','PASS_LEFT','LANE_RIGHT','PASS_RIGHT'):
                side='left' if name.endswith('LEFT') else 'right'
                offset=road.get('lane_width_m',3.5)*(-1 if side=='left' else 1)
                if not road.get(side+'_allowed') or road.get('junction_ahead',True):reason='LANE_PERMISSION_UNAVAILABLE'
                elif not road.get('full_lane_paths_validated',False):reason='FULL_LANE_VALIDATION_PENDING'
            if name.startswith('ROUTE_'):
                side=name.split('_')[1].lower()
                if not road.get('alternatives',{}).get(side):reason='ALTERNATE_STREET_UNAVAILABLE'
            if name=='RETURN' and not road.get('return_allowed'):reason='RETURN_PERMISSION_UNAVAILABLE'
            if name=='DRIVER' and mode!='MANUAL_PROTECTION':reason='AUTONOMOUS_MODE'
            if permitted_candidates is not None and name not in permitted_candidates:reason='CURRICULUM_CAPABILITY_PENDING'
            if name=='HOLD':
                path=np.column_stack((GRID,np.zeros((len(GRID),3))))
            elif name in ('CONTINUE','SLOW','STOP','ACCELERATE','LANE_LEFT','LANE_RIGHT','PASS_LEFT','PASS_RIGHT','RETURN'):
                path,_=route_path(speed,accel,offset,road,g,cap_mps)
            else:
                path=signed_path(speed,steer,accel,g,reverse,bounded=reverse or name in ('FORWARD_LEFT','FORWARD_RIGHT'))
            if name=='DRIVER':reverse=base.reverse;path=signed_path(speed,steer,accel,g,reverse)
            if name in ('DRIVER','CONTINUE'):
                command=replace(base,source=CommandSource.TRAINING)
                # Freeze the trajectory generated by the proposed controls,
                # rather than an ideal route shape that may turn differently.
                path=signed_path(speed,command.steering,command.throttle*2.5-command.brake*5.,g,command.reverse)
            else:
                if name in ('LANE_LEFT','LANE_RIGHT','PASS_LEFT','PASS_RIGHT','RETURN'):
                    distance=np.linalg.norm(path[:,1:3],axis=1)
                    index=min(len(path)-1,int(np.searchsorted(distance,max(2.,speed*.7))))
                    x,y=path[index,1:3]
                    steer=float(np.clip(math.atan2(2*g.wheelbase_m*y,max(.5,x*x+y*y))/g.max_steer_rad,-1.,1.))
                throttle=min(.5,max(0.,.18+.25*(target-speed))) if target>0 else 0.
                brake=min(1.,max(0.,.35*(speed-target)))
                if name in ('HOLD','STOP'):throttle=0.;brake=1.
                if reverse or name in ('FORWARD_LEFT','FORWARD_RIGHT'):
                    throttle=min(.2,max(0.,(1.-speed)*.2))
                    if speed>.95:throttle=0.;brake=max(brake,.05)
                command=replace(base,source=CommandSource.TRAINING,steering=steer,
                                throttle=0. if brake else throttle,brake=brake,reverse=reverse,
                                gear=-1 if reverse else 1,handbrake=False)
                if reverse!=o.ego.reverse:command=replace(command,throttle=0.,brake=1.)
            if reverse and speed>1.:reason='RECOVERY_SPEED_LIMIT'
            if name in ('FORWARD_LEFT','FORWARD_RIGHT') and speed>1.:reason='RECOVERY_SPEED_LIMIT'
            if reason is None:
                ok,reason,evidence=self.shield.check(scene,path,command,road,timestamp_s=o.timestamp_s,wall_s=wall_s)
                if name=='HOLD' and evidence.get('fallback_hold_safe_against_rear_impact') is False:
                    ok=False;reason='HOLD_EXPOSED_TO_REAR_IMPACT'
            else:ok=False;evidence={}
            rows.append({'id':name,'path':path.tolist(),'command':to_dict(command),'admitted':ok,
                         'reason':reason,'evidence':evidence,'reverse':reverse})
        status='VERIFIED_CANDIDATES' if any(r['admitted'] for r in rows) else 'NO_VERIFIED_SAFE_ACTION'
        if status=='NO_VERIFIED_SAFE_ACTION':
            # MaskablePPO needs a representable fallback. Its special admission
            # is explicitly an unverified hold, never a safety certificate.
            rows[0].update(admitted=True,fallback_unverified=True)
        payload={'frame':o.frame_id,'timestamp':o.timestamp_s,'mode':mode,'candidates':rows}
        digest=hashlib.sha256(json.dumps(payload,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()
        return CandidateBundle(o.frame_id,o.timestamp_s,mode,tuple(freeze_json(r) for r in rows),status,digest)
