"""Bounded sensor-only escape proposals, independently revalidated each frame.

This is maneuver planning, not a claim of learned driving. Traffic-rule exceptions
are explicit short leases; collision protection and unknown-space vetoes remain.
No target actor, simulator world, scenario identity or future truth is accepted.
"""
from dataclasses import replace
import math
import numpy as np
from .contracts import CommandSource
from .motion_geometry import GRID, VehicleGeometry, footprint_centers
from .prediction import assess_conflicts


class CongestionRecovery:
    MAX_SPEED_MPS = 1.
    MAX_DISTANCE_M = 2.
    MAX_DURATION_S = 4.
    BLOCKED_SECONDS = 2.

    def __init__(self, geometry=None, *, reverse_accepted=False, lateral_accepted=False, rule_exception_accepted=False):
        self.geometry = geometry or VehicleGeometry()
        self.reverse_accepted = reverse_accepted
        self.lateral_accepted = lateral_accepted
        self.rule_exception_accepted = rule_exception_accepted
        self.reset()

    def reset(self):
        self.blocked_since = self.started = self.previous_time = None
        self.distance = 0.
        self.intent = None
        self.phase = 'FOLLOW'
        self.cooldown_until = 0.
        self.last = None

    def _path(self, speed, steering, reverse):
        g = self.geometry
        v = np.clip(abs(speed)+.5*GRID, 0., self.MAX_SPEED_MPS)
        ds = (v[:-1]+v[1:])*.05 * (-1 if reverse else 1)
        yaw = np.r_[0.,np.cumsum(ds)] * math.tan(steering*g.max_steer_rad)/g.wheelbase_m
        mid = (yaw[:-1]+yaw[1:])*.5
        xy = np.vstack((np.zeros(2),np.cumsum(ds[:,None]*np.column_stack((np.cos(mid),np.sin(mid))),axis=0)))
        # Include a stopping tail, not just the requested movement horizon.
        path = np.column_stack((GRID,xy,yaw))
        return path, v

    def evaluate(self, observation, base, prediction, space, road, *, wall):
        now = observation.timestamp_s
        ego = observation.ego
        g = self.geometry
        result = {'version':1,'phase':self.phase,'action':'FOLLOW','reason':'NORMAL_ROUTE',
            'source_frame':observation.frame_id,'timestamp_s':now,'session_id':road.get('session_id'),
            'selected_path':None,'rejected':[],'rule_exception':None,'distance_m':self.distance,
            'learned_control_used':False,'experimental':True}
        def finish(command=None):
            self.last=result
            return command,result
        def hold(reason):
            result.update(action='HOLD',reason=reason,phase=self.phase)
            return finish(replace(base,source=CommandSource.NAVIGATION,throttle=0.,brake=1.,reverse=ego.reverse,
                gear=-1 if ego.reverse else 0 if ego.gear==0 else 1))
        age = now-prediction.get('timestamp_s',float('-inf')) if prediction else float('inf')
        wall_age = wall-prediction.get('published_wall_s',float('-inf')) if prediction else float('inf')
        if (not prediction or prediction.get('session_id')!=road.get('session_id') or
                not 0<=age<=.1+1e-6 or not 0<=wall_age<=.25 or space is None):
            self.blocked_since=None
            return hold('RECOVERY_OBSERVATION_UNAVAILABLE') if self.intent or ego.reverse or self.phase!='FOLLOW' else finish()
        if base.handbrake or ego.handbrake:
            return hold('HANDBRAKE_HELD') if self.intent else finish()
        if self.intent and ego.speed_mps>self.MAX_SPEED_MPS:
            return hold('RECOVERY_SPEED_LIMIT')
        if ego.reverse and not self.intent:self.phase='SETTLE'
        if self.previous_time is not None:
            dt=now-self.previous_time
            if dt<=0 or (dt>.15 and self.intent):
                self.intent=None;self.phase='SETTLE';self.blocked_since=None
                return hold('RECOVERY_FRAME_GAP')
            if dt>.75:self.blocked_since=None
            if self.intent:self.distance+=ego.speed_mps*dt
        self.previous_time=now
        tracks=prediction.get('tracks',[])
        modes=prediction.get('control_trajectories',prediction.get('measured_trajectories',prediction.get('trajectories',[])))
        hold_path=np.column_stack((GRID,np.zeros((len(GRID),3))))
        hold_conflicts=assess_conflicts(tracks,modes,[{'intent':'HOLD','points':footprint_centers(hold_path,g),'half':g.half}])
        rear_urgent=any(c['point_m'][0]<-g.rear_m and c['time_s']<=2. for c in hold_conflicts)
        front_blocked=any(t.get('confirmed') and abs(t['position_m'][1])<g.half_width_m+t['half_size_m'][1]+.2 and
            0<t['position_m'][0]-t['half_size_m'][0]-g.front_m<6. and np.linalg.norm(t['velocity_mps'])<.5 for t in tracks)
        # Native route following ignores privileged target actor lists. The
        # independent sensor supervisor may be holding the actual vehicle even
        # while the route controller still requests throttle.
        stopped=ego.speed_mps<.15 and (base.brake>.01 or ego.brake>.01)
        if stopped and front_blocked:
            if self.blocked_since is None:self.blocked_since=now
        elif not self.intent:self.blocked_since=None
        stuck=self.blocked_since is not None and now-self.blocked_since>=self.BLOCKED_SECONDS
        if self.phase=='SETTLE':
            if ego.speed_mps>=.15:return hold('SETTLING_BEFORE_FORWARD_ROUTE')
            self.phase='FOLLOW';self.blocked_since=None
            result.update(action='REPLAN',phase='FOLLOW',reason='RECOVERY_COMPLETE_REPLAN_REQUIRED')
            # Gear changes occur held; the route starts on a subsequent frame.
            return finish(replace(base,source=CommandSource.NAVIGATION,throttle=0.,brake=1.,reverse=False,gear=1,handbrake=False))
        if not self.intent and not (rear_urgent or stuck):return finish()
        if not self.intent and (ego.speed_mps>.5 or now<self.cooldown_until):return finish()
        if self.intent and (self.distance>=self.MAX_DISTANCE_M or now-self.started>=self.MAX_DURATION_S):
            self.intent=None;self.phase='SETTLE';self.cooldown_until=now+2.
            return hold('RECOVERY_LIMIT_REACHED')
        traffic=road.get('traffic_stop')
        exception=bool(traffic and rear_urgent and self.rule_exception_accepted)
        if traffic and not exception:return hold('TRAFFIC_RULE_STOP') if self.intent else finish()
        candidates=[('CLEAR_FORWARD',0.,False)] if rear_urgent else []
        if stuck and not rear_urgent and self.reverse_accepted:candidates.append(('BACK_UP',0.,True))
        if stuck and not rear_urgent and self.reverse_accepted and self.lateral_accepted:
            candidates += [('BACK_LEFT',-.4,True),('BACK_RIGHT',.4,True)]
        for side,steer in (('left',-.65),('right',.65)):
            if self.lateral_accepted and road.get(side+'_allowed'):
                candidates.append(('CLEAR_'+side.upper(),steer,False))
        if self.intent:
            candidates=[c for c in candidates if c[0]==self.intent]
        accepted=[]
        for name,steer,reverse in candidates:
            steer=float(np.clip(steer,ego.steering-.15,ego.steering+.15))
            if reverse and ego.speed_mps>=.15 and not ego.reverse:
                result['rejected'].append({'action':name,'reason':'GEAR_CHANGE_REQUIRES_STOP'});continue
            path,speeds=self._path(ego.speed_mps,steer,reverse)
            from .corridor_uncertainty import uncertain_corridor_tracks
            uncertain = uncertain_corridor_tracks(tracks,modes,path,g)
            if uncertain:
                result['rejected'].append({'action':name,'reason':'RECOVERY_TRACK_UNCERTAINTY','track_ids':uncertain})
                continue
            end=path[-1].copy();direction=(-1 if reverse else 1)
            tail=speeds[-1]**2/(2*3.)+.3
            end[1:3]+=direction*tail*np.array([math.cos(end[3]),math.sin(end[3])])
            certificate=space.certificate(np.vstack((path,end)))
            if not certificate['verified']:
                result['rejected'].append({'action':name,'reason':'SWEPT_SPACE_UNKNOWN_OR_OCCUPIED','space':certificate});continue
            conflicts=assess_conflicts(tracks,modes,[{'intent':name,'points':footprint_centers(path,g),'half':g.half}])
            # Every object and hypothesis matters, including the rear. Never
            # discard the rear collision from the candidate score.
            if conflicts:
                result['rejected'].append({'action':name,'reason':'PREDICTED_INTERSECTION','conflicts':conflicts});continue
            if exception and (reverse or road.get('junction_ahead',True)):
                result['rejected'].append({'action':name,'reason':'TRAFFIC_EXCEPTION_INTERSECTION_UNVERIFIED'});continue
            # All admitted paths are clear. Prefer forward separation; a short
            # reverse wins only when blocked, with no observed closing rear risk.
            score=(2 if reverse else 0)+abs(steer)
            accepted.append((score,name,steer,reverse,path,certificate))
        if not accepted:
            result['reason']='NO_VERIFIED_SAFE_ACTION'
            result['fallback_hold_safe_against_rear_impact']=not rear_urgent
            uncertainty = any(r['reason']=='RECOVERY_TRACK_UNCERTAINTY' for r in result['rejected'])
            return hold('RECOVERY_TRACK_UNCERTAINTY' if uncertainty else 'NO_VERIFIED_SAFE_ACTION') if self.intent else finish()
        _,name,steer,reverse,path,certificate=min(accepted,key=lambda c:c[0])
        if self.intent is None:self.started=now;self.distance=0.
        self.intent=name;self.phase='REVERSING' if reverse else 'CLEARING'
        throttle=min(.2,max(0.,(self.MAX_SPEED_MPS-ego.speed_mps)*.2))
        brake=.35 if ego.speed_mps>self.MAX_SPEED_MPS else 0.
        if ego.reverse!=reverse:
            throttle=0.;brake=1.
        result.update(action=name,phase=self.phase,reason='VERIFIED_REAR_ESCAPE' if rear_urgent else 'VERIFIED_CONGESTION_REPOSITION',
            selected_path=path.tolist(),space=certificate,reverse=reverse,
            target_speed_kmh=self.MAX_SPEED_MPS*3.6,distance_m=self.distance,
            rule_exception={'rule':traffic,'expires_timestamp_s':self.started+self.MAX_DURATION_S,'maximum_distance_m':self.MAX_DISTANCE_M} if exception else None)
        return finish(replace(base,source=CommandSource.NAVIGATION,throttle=throttle if not brake else 0.,brake=brake,
            steering=steer,reverse=reverse,gear=-1 if reverse else 1,handbrake=False))
