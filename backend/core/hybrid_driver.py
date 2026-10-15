"""One sensor-only behavioral owner for route driving and bounded recovery.

No simulator actor list, labels, fixture identity, or learned policy is an input.
The independent execution shield checks the *actual pedal/steering proposal*,
not merely the attractive advisory lane-change curve.
"""
from dataclasses import replace
import math
import time
import numpy as np
from .contracts import CommandSource
from .maneuver import route_path
from .maneuver_candidates import ExecutionShield, signed_path
from .motion_geometry import GRID, footprint_centers, path_coordinates
from .prediction import assess_conflicts


class HybridDriver:
    DRIVER_ID = 'ROBOSPHERE_HYBRID_V1'

    def __init__(self, geometry, *, deadline=float('inf'), calibration=None):
        self.geometry = geometry
        self.deadline = deadline
        self.shield = ExecutionShield()
        self.calibration = dict(calibration or {})
        self.phase = 'FOLLOW'
        self.offset = 0.
        self.blocker = None
        self.blocked_since = self.started = self.previous_stamp = None
        self.distance = 0.
        self.previous_command = None
        self.last = None
        self.completed_maneuvers = []
        self.lost_blocker_since = None
        self.alternative_requested = False
        self.sequence = 0
        self.measured_acceleration = 0.
        self.previous_speed = None
        self.ego = None
        self.alternative_started = None
        self.reverse_steering = 0.
        self.reverse_attempts = 0
        self.acceleration_trim = 0.
        self.motion_stamp = None
        self.raw_acceleration = 0.
        self.control_dt = .05

    def _hold(self, scene, base, result, reason, *, forward_gear=False):
        ego = scene.observation.ego if scene else None
        reverse = bool(ego.reverse) if ego else base.reverse
        if forward_gear and ego and ego.speed_mps < .15: reverse = False
        command = replace(base, source=CommandSource.NAVIGATION, throttle=0., brake=1.,
                          reverse=reverse, gear=-1 if reverse else 1)
        result.update(action='HOLD', reason=reason, phase=self.phase, selected_path=None,
                      fallback_hold_safe_against_rear_impact=not result.get('rear_urgent', False))
        self.previous_command = command
        self.last = result
        return command, result

    def _steering(self, path, speed, base, dt):
        distance = np.linalg.norm(path[:, 1:3], axis=1)
        i = min(len(path)-1, int(np.searchsorted(distance, max(3., min(10., speed*.7+2.)))))
        x, y = path[i, 1:3]
        angle = math.atan2(2*self.geometry.wheelbase_m*y, max(.5, x*x+y*y))
        gain = max(.25, min(1.5, self.calibration.get('steering_gain', 1.)))
        desired = float(np.clip(angle/(self.geometry.max_steer_rad*gain), -1., 1.))
        prior = self.ego.steering if self.ego is not None else base.steering
        return float(np.clip(desired, prior-dt*1.5, prior+dt*1.5))

    def _pedals(self, target, speed, dt, *, reverse=False,commit=False):
        error = target-speed
        if target<=.01 and speed<.15:return 0.,1.
        desired=float(np.clip(error*.9,-3.,2.))
        actual=self.ego
        if not reverse:
            # Provisional identification from native moving samples (4–25
            # km/h): a ~= 9*throttle - 3.5 without service brake. Engine drag
            # means a small positive pedal can still request deceleration.
            # These coefficients do not constitute native speed acceptance.
            gain=float(self.calibration.get('throttle_acceleration_gain',9.))
            drag=float(self.calibration.get('coasting_deceleration_mps2',3.5))
            trim=0. if actual and actual.brake>.1 else self.acceleration_trim
            trim=float(np.clip(trim+.02*(desired-self.measured_acceleration)*dt,-.15,.15))
            if commit:self.acceleration_trim=trim
            requested=(desired+drag)/gain+trim+.06*(desired-self.raw_acceleration)
            old=actual.throttle if actual and actual.brake<.01 else 0.
            throttle=float(np.clip(requested,max(0.,old-dt*2.),min(.65,old+dt*.8+.001)))
            brake=float(np.clip(-requested,0.,.2)) if requested<0 else 0.
            return (0.,brake) if brake else (throttle,0.)
        if desired>=0:
            # Back-calculation uses the native pedals, including a veto applied
            # by the independent shield. A rejected .65 proposal must not become
            # the controller's remembered throttle after an actual full stop.
            old=actual.throttle if actual and actual.brake<.01 else 0.
            throttle=old+.08*(desired-self.measured_acceleration)*dt
            if speed<.2 and desired>.5:throttle=max(.16,throttle)
            launch_cap=.25
            throttle=float(np.clip(throttle,0.,min(launch_cap,old+dt*.8+.001)))
            return throttle,0.
        # An emergency pressure is not the next comfort controller's integral.
        # Native measurements showed a full-brake veto otherwise left .6 held
        # for subsequent ticks, with excessive deceleration after the veto.
        old=min(.15,actual.brake) if actual and actual.throttle<.01 else 0.
        brake=old+.03*(-desired+self.measured_acceleration)*dt
        return 0.,float(np.clip(brake,0.,.2))

    def _observe_motion(self,scene):
        ego=scene.observation.ego;now=scene.observation.timestamp_s
        if self.motion_stamp==now:return
        dt=.05 if self.motion_stamp is None else now-self.motion_stamp
        self.control_dt=min(.1,max(.001,dt));self.ego=ego
        if self.previous_speed is not None and 0<dt<=.15:
            self.raw_acceleration=float(np.clip((ego.speed_mps-self.previous_speed)/dt,-12.,8.))
            self.measured_acceleration=.65*self.measured_acceleration+.35*self.raw_acceleration
        else:self.raw_acceleration=self.measured_acceleration=0.
        self.previous_speed=ego.speed_mps;self.motion_stamp=now

    def update_actuation(self,scene,base,steering,*,wall):
        """Same behavior lease, fresh onboard response at native cadence."""
        if (scene is None or scene.observation.frame_id!=base.frame_id
                or not scene.usable(base.timestamp_s,wall) or wall>=self.deadline):return None
        if not self.last or self.last.get('action') not in ('FOLLOW','SLOW','EXIT','PASS','RETURN','REVERSE'):
            return None
        target=self.last.get('target_speed_kmh')
        if target is None:return None
        self._observe_motion(scene)
        throttle,brake=self._pedals(target/3.6,scene.observation.ego.speed_mps,self.control_dt,
                                  reverse=base.reverse,commit=True)
        if base.reverse!=scene.observation.ego.reverse:throttle,brake=0.,1.
        return replace(base,throttle=throttle,brake=brake,steering=self._bounded_steering(steering,scene.observation.ego.speed_mps))

    def _bounded_steering(self, steering, speed):
        # Bicycle-model lateral acceleration is a comfort bound outside an
        # emergency. The physical response still requires native calibration.
        limit=math.atan(2.*self.geometry.wheelbase_m/max(.25,speed**2))/self.geometry.max_steer_rad
        return float(np.clip(steering,-min(1.,limit),min(1.,limit)))

    def _proposal(self, scene, base, road, target, offset, dt, *, reverse=False, steering=None):
        speed = scene.observation.ego.speed_mps
        if steering is None and not reverse and abs(offset)<.01 and self.phase in ('FOLLOW','WAIT'):
            steering=base.steering
        if steering is None:
            desired, _ = route_path(speed, np.clip((target-speed)*.8, -3., 2.),
                                    offset, road, self.geometry, max(speed, target))
            steering = self._steering(desired, speed, base, dt)
        steering=self._bounded_steering(steering,speed)
        throttle, brake = self._pedals(target, speed, self.control_dt, reverse=reverse)
        if scene.observation.ego.reverse != reverse:
            throttle, brake = 0., 1.
        command = replace(base, throttle=float(throttle), brake=float(brake),
                          steering=float(steering), reverse=reverse, gear=-1 if reverse else 1,
                          handbrake=False, source=CommandSource.NAVIGATION)
        path = signed_path(speed, steering, throttle*2.5-brake*5., self.geometry,
                           reverse, bounded=reverse)
        return command, path

    def evaluate(self, scene, base, road, cap_mps, *, wall):
        began = time.perf_counter()
        self.sequence += 1
        result = {'version': 1, 'driver_id': self.DRIVER_ID, 'decision_id': f"{road.get('session_id')}:{base.frame_id}:{self.sequence}",
                  'source_frame': scene.observation.frame_id if scene else None,
                  'timestamp_s': base.timestamp_s, 'phase': self.phase, 'rejected': [],
                  'completed_maneuvers': list(self.completed_maneuvers), 'learned_control_used': False,
                  'request_replan': False, 'request_alternative': False}
        if wall >= self.deadline: return self._hold(scene, base, result, 'HYBRID_VALIDATION_EXPIRED')
        if scene is None or scene.session_id != road.get('session_id') or not scene.usable(base.timestamp_s, wall):
            return self._hold(scene, base, result, 'STALE_CONTROL_SCENE')
        if scene.observation.frame_id!=base.frame_id:
            return self._hold(scene,base,result,'AWAITING_CURRENT_SENSOR_FRAME')
        ego = scene.observation.ego
        self._observe_motion(scene)
        now = scene.observation.timestamp_s
        dt = .05 if self.previous_stamp is None else max(.001, now-self.previous_stamp)
        self.previous_stamp = now
        if dt > .15 and self.phase not in ('FOLLOW', 'WAIT'):
            self.phase = 'SETTLE'
        result.update(scene_wall_age_s=wall-scene.received_wall_s, scene_build_ms=scene.build_ms)
        if road.get('traffic_stop') or base.handbrake:
            self.blocked_since = None
            return self._hold(scene, base, result, 'TRAFFIC_RULE_STOP' if road.get('traffic_stop') else 'HANDBRAKE_HELD')
        prediction = scene.prediction
        tracks, modes = prediction['tracks'], prediction['control_trajectories']
        hold = np.column_stack((GRID, np.zeros((len(GRID), 3))))
        conflicts = assess_conflicts(tracks, modes, [{'intent': 'HOLD', 'points': footprint_centers(hold, self.geometry), 'half': self.geometry.half}])
        rear_urgent = any(c['point_m'][0] < -self.geometry.rear_m and c['time_s'] <= 2. for c in conflicts)
        result['rear_urgent'] = rear_urgent
        line = np.asarray(road['centerline'], float)
        route_probe, _ = route_path(max(ego.speed_mps, 1.), 1., self.offset, road, self.geometry, max(ego.speed_mps, cap_mps))
        front = []
        for track in tracks:
            if not track.get('confirmed'): continue
            x, y = track['position_m']
            along, lateral = path_coordinates([x], [y], route_probe)
            hx, hy = track['half_size_m']
            if x > 0 and lateral[0] < self.geometry.half_width_m+hy+.25:
                front.append((max(0., float(along[0])-hx-self.geometry.front_m), track))
        nearest = min(front, key=lambda p: p[0]) if front else None
        result['front_blocker']={'track_id':nearest[1]['id'],'gap_m':nearest[0]} if nearest else None
        if (nearest and np.linalg.norm(nearest[1]['velocity_mps'])<.3
                and nearest[0]<max(25.,ego.speed_mps*3.) and road.get('alternatives')
                and self.phase in ('FOLLOW','WAIT')):
            result['request_alternative']=True
        stopped = ego.speed_mps < .15
        if stopped and nearest and nearest[0] < 8.:
            if self.blocked_since is None: self.blocked_since = now
        elif self.phase in ('FOLLOW', 'WAIT'): self.blocked_since = None
        blocked = self.blocked_since is not None and now-self.blocked_since >= 2.
        if ego.speed_mps>1. and nearest is None:self.reverse_attempts=0

        if self.phase == 'SETTLE':
            if not stopped or ego.reverse:
                return self._hold(scene, base, result, 'SETTLING_BEFORE_FORWARD_ROUTE', forward_gear=True)
            self.phase = 'FOLLOW'; self.offset = 0.; self.blocked_since = None
            result['request_replan'] = True
            return self._hold(scene, base, result, 'REPLAN_REQUIRED', forward_gear=True)
        if self.phase == 'REVERSE':
            self.distance += ego.speed_mps*dt
            if (self.distance+ego.speed_mps*.35+ego.speed_mps**2/6.+.1 >= 2.
                    or now-self.started+.35+ego.speed_mps/3. >= 4. or ego.speed_mps > 1.):
                self.phase = 'SETTLE'
                if self.distance >= .3: self.completed_maneuvers.append('REVERSE')
                return self._hold(scene, base, result, 'REPOSITION_LEASE_EXHAUSTED')
        if self.phase == 'EXIT' and abs(line[0, 1]+self.offset) < .4:
            self.phase = 'PASS'; self.completed_maneuvers.append('LANE_CHANGE')
        if self.phase == 'PASS':
            blocker = next((t for t in tracks if t['id'] == self.blocker), None)
            passed = blocker is not None and blocker['position_m'][0]+blocker['half_size_m'][0] < -self.geometry.rear_m-2.
            if blocker is None:
                if self.lost_blocker_since is None: self.lost_blocker_since = now
                passed = now-self.lost_blocker_since >= 3.
            else: self.lost_blocker_since = None
            if passed and road.get('return_allowed') and not road.get('junction_ahead'):
                self.phase = 'RETURN'
        if self.phase == 'RETURN' and abs(line[0, 1]) < .35:
            self.phase = 'FOLLOW'; self.offset = 0.; self.blocker = None
            self.completed_maneuvers.append('PASS_RETURN')

        target = max(0., cap_mps)
        if self.phase in ('EXIT','RETURN'):target=min(target,2.)
        if road.get('remaining_m') is not None:
            target=min(target,max(0.,(road['remaining_m']-2.5)/2.))
        # Curvature limits the intended speed before the low-level controller;
        # it is not allowed to rely on emergency braking to negotiate a turn.
        seg = np.diff(line, axis=0)
        lengths = np.linalg.norm(seg, axis=1)
        # Native global plans repeat segment/junction endpoints. Micrometre
        # differences have meaningless headings and must not imply a hairpin.
        supported=lengths>=.25
        seg=seg[supported];lengths=lengths[supported]
        headings = np.unwrap(np.arctan2(seg[:, 1], seg[:, 0]))
        if len(headings) > 1:
            curvature = np.max(np.abs(np.diff(headings))/np.maximum(.5,(lengths[:-1]+lengths[1:])*.5))
            target = min(target, math.sqrt(2./max(.001, curvature)))
        if nearest and self.phase not in ('EXIT', 'PASS', 'RETURN'):
            gap, track = nearest
            target = min(target, max(0., track['velocity_mps'][0]) + max(0., (gap-4.)/2.))
        proposals = []
        if self.phase == 'REVERSE':
            proposals = [('REVERSE', min(1., cap_mps), 0., True, self.reverse_steering)]
        else:
            offset = 0. if self.phase == 'RETURN' else self.offset
            name = self.phase if self.phase in ('EXIT', 'PASS', 'RETURN') else 'FOLLOW'
            proposals.append((name, target, offset, False, None))
            # Stop/creep candidates retain the same route and must independently
            # certify measured motion; slower never means bypassing the shield.
            proposals += [('SLOW', min(target, v), offset, False, None) for v in (3., 1., .35) if 0 < v < target]
            need_pass = nearest and nearest[0] < max(12., ego.speed_mps*2.) and np.linalg.norm(nearest[1]['velocity_mps']) < 1.
            if self.phase in ('FOLLOW', 'WAIT') and (need_pass or blocked or rear_urgent):
                if not road.get('junction_ahead'):
                    for side, sign in (('left', -1.), ('right', 1.)):
                        if road.get(side+'_allowed'):
                            proposals.append(('CHANGE_'+side.upper(), min(cap_mps,2.), sign*road['lane_width_m'], False, None))
                if blocked and not rear_urgent and self.reverse_attempts<2:
                    proposals += [('REVERSE',1.,0.,True,angle) for angle in (0.,-.15,.15)]

        def rank(proposal):
            name,desired,offset,reverse,_=proposal
            return desired-abs(offset)*.1-(2. if reverse else 0.)+\
                (3. if name.startswith('CHANGE_') and blocked else 0.)+\
                (.5 if name==self.phase else 0.)+(2. if reverse and blocked else 0.)
        accepted = []
        for proposal in sorted(proposals,key=rank,reverse=True):
            name, desired, offset, reverse, steering=proposal
            command, path = self._proposal(scene, base, road, desired, offset, min(dt, .1), reverse=reverse, steering=steering)
            if name.startswith('CHANGE_') or name in ('EXIT','RETURN'):
                intended,_=route_path(ego.speed_mps,np.clip((desired-ego.speed_mps)*.8,-3.,2.),
                                      offset,road,self.geometry,max(ego.speed_mps,desired))
                ok,reason,evidence=self.shield.check(scene,intended,command,road,timestamp_s=base.timestamp_s,
                    wall_s=wall+time.perf_counter()-began,full_maneuver=True)
                if not ok:
                    result['rejected'].append({'action':name,'reason':'INTENDED_MANEUVER_'+reason,'evidence':evidence})
                    continue
            ok, reason, evidence = self.shield.check(scene, path, command, road, timestamp_s=base.timestamp_s,
                                                     wall_s=wall+time.perf_counter()-began)
            if not ok:
                result['rejected'].append({'action': name, 'reason': reason, 'evidence': evidence})
                continue
            # A HOLD is never a competing cheap optimum. Safety is a hard gate;
            # among admitted motions prefer route progress and stable intent.
            accepted.append((rank(proposal), name, command, path, evidence, offset, desired))
            # Remaining candidates have lower utility by construction. They
            # cannot change this decision, and rechecking them spends freshness.
            break
        # A threat to the future stopping corridor first requests controlled
        # deceleration. Full braking remains the fallback if none is verified.
        if not accepted and ego.speed_mps>.2:
            for pressure in (.12,.25,.45,.6,1.):
                command=replace(base,throttle=0.,brake=pressure,steering=ego.steering,
                                reverse=ego.reverse,gear=-1 if ego.reverse else 1,source=CommandSource.NAVIGATION)
                path=signed_path(ego.speed_mps,command.steering,-pressure*5.,self.geometry,ego.reverse)
                ok,reason,evidence=self.shield.check(scene,path,command,road,timestamp_s=base.timestamp_s,
                                                     wall_s=wall+time.perf_counter()-began)
                if ok:
                    accepted.append((-pressure,'DECELERATE',command,path,evidence,self.offset,0.));break
                result['rejected'].append({'action':f'DECELERATE_{pressure}','reason':reason,'evidence':evidence})
        result['planning_ms'] = (time.perf_counter()-began)*1000
        if not accepted:
            if blocked and now-self.blocked_since >= 6. and self.phase in ('FOLLOW', 'WAIT'):
                result['request_alternative'] = bool(road.get('alternatives'))
            if self.phase == 'REVERSE': self.phase = 'SETTLE'
            elif self.phase == 'FOLLOW': self.phase = 'WAIT'
            return self._hold(scene, base, result, 'NO_VERIFIED_SAFE_ACTION')
        _, name, command, path, evidence, offset, target = max(accepted, key=lambda r: r[0])
        if name!='DECELERATE':
            self._pedals(target,ego.speed_mps,self.control_dt,reverse=command.reverse,commit=True)
        if name == 'REVERSE' and self.phase != 'REVERSE':
            self.phase = 'REVERSE'; self.started = now; self.distance = 0.
            self.reverse_steering=command.steering;self.reverse_attempts+=1
        elif name.startswith('CHANGE_'):
            self.phase = 'EXIT'; self.offset = offset
            self.blocker = nearest[1]['id'] if nearest else None
        elif self.phase == 'WAIT': self.phase = 'FOLLOW'
        result.update(action=name, phase=self.phase, reason='VERIFIED_MEASURED_MOTION',
                      selected_path=path.tolist(), space=evidence, target_speed_kmh=target*3.6,
                      reverse_distance_m=self.distance, completed_maneuvers=list(self.completed_maneuvers))
        result['longitudinal_control']={'measured_acceleration_mps2':self.measured_acceleration,
            'trim':self.acceleration_trim,'response_calibration':'PROVISIONAL_NATIVE_MOVING_SAMPLES_NOT_ACCEPTED'}
        self.previous_command = command
        self.last = result
        return command, result
