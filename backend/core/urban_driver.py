"""Sensor-only moving-traffic maneuvers; no scenario or native actor inputs."""
from dataclasses import replace
import math
import time
import numpy as np
from .contracts import freeze_json, freeze_float_rows
from .egypt_urban import DRIVER_ID
from .hybrid_driver import HybridDriver
from .kinematic_prediction import kinematic_modes
from .maneuver import spatial_route
from .maneuver_candidates import signed_path, stopping_tail
from .motion_geometry import path_coordinates
from .prediction import rotation
from .route_terminal import terminal_speed_mps


def urban_forecast(scene, horizon_s):
    """Recompute bounded physical alternatives from this same measured frame."""
    grid = np.round(np.arange(int(math.ceil(max(3., horizon_s) / .1)) + 1) * .1, 6)
    identity = f'URBAN_BOUNDED_V2:{grid[-1]}'
    if scene.prediction.get('hypothesis_set_id') == identity:
        return scene
    # The behavior owner and independent veto use the same immutable measured
    # frame. Share only its forecast calculation; both still check their own
    # command, path, current time and clearance proof.
    cache = scene.space.urban_forecasts
    key = (id(scene.prediction), len(grid))
    cached = cache.get(key)
    if cached is not None and cached[0] is scene.prediction:
        return replace(scene, prediction=cached[1])
    tracks = scene.prediction['tracks']
    modes = (list(scene.prediction['control_trajectories'])
             if scene.prediction.get('source') == 'CONTROL_SENSOR_PIPELINE'
             and scene.prediction.get('horizon_s') == float(grid[-1])
             and not scene.prediction.get('hypothesis_set_id')
             else kinematic_modes(tracks, grid=grid, frozen_points=True))
    for track in tracks:
        p = np.asarray(track['position_m'], float)
        v = np.asarray(track['velocity_mps'], float)
        speed = float(np.linalg.norm(v))
        if speed < .3:
            continue
        person = str(track.get('class', '')).lower() in ('person', 'pedestrian')
        direction = v / speed
        braking = np.minimum(grid, speed / 3.)
        distance = speed * braking - 1.5 * braking ** 2
        alternatives = [('POSSIBLE_BRAKING', p + distance[:, None] * direction)]
        if person:
            retreat = distance - np.minimum(1.5, speed) * np.maximum(0., grid - speed / 3. - .6)
            alternatives.append(('POSSIBLE_HESITATION_RETREAT', p + retreat[:, None] * direction))
        else:
            accelerating = np.minimum(grid, max(0., (22. - speed) / 2.))
            accelerated_distance = speed * grid + 2. * accelerating * (grid - .5 * accelerating)
            accelerated = p + accelerated_distance[:, None] * direction
            alternatives.append(('POSSIBLE_ACCELERATION', accelerated))
            for sign in (-1., 1.):
                xy = p + grid[:, None] * v
                xy[:, 1] += sign * np.minimum(3.5, .35 * grid ** 2)
                alternatives.append(('POSSIBLE_LATERAL_INGRESS', xy))
                combined = accelerated.copy()
                combined[:, 1] += sign * np.minimum(3.5, .35 * grid ** 2)
                alternatives.append(('POSSIBLE_ACCELERATING_INGRESS', combined))
        for index, (source, xy) in enumerate(alternatives):
            modes.append({'track_id': track['id'], 'mode': 100 + index, 'source': source,
                          'selected': False, 'probability': None, 'rank': 100 + index,
                          'weight_kind': 'UNRANKED_PHYSICAL_ALTERNATIVE',
                          'points': freeze_float_rows(np.column_stack((grid, xy)))})
    prediction = {**dict(scene.prediction), 'control_trajectories': modes, 'horizon_s': float(grid[-1]),
                  'hypothesis_set_id': identity}
    prediction = freeze_json(prediction)
    cache[key] = (scene.prediction, prediction)
    while len(cache) > 4:
        cache.popitem(last=False)
    return replace(scene, prediction=prediction)


class UrbanManeuverDriver(HybridDriver):
    DRIVER_ID = DRIVER_ID
    OPTIONAL_MANEUVER_START_AGE_S = .1
    MANEUVER_START_MAX_AGE_S = .2

    def __init__(self, geometry, *, deadline=float('inf')):
        super().__init__(geometry, deadline=deadline, allow_reverse=False)
        self.completed_maneuvers = []
        self.maneuver_id = 0
        self.return_required = False
        self.clearance_proof = None
        self.cooldown_until = 0.
        self.lead_seen_since = None
        self.lead_id = None
        self.selected_side = None
        self.wait_reason = None

    def _hold(self, scene, base, result, reason, *, forward_gear=False):
        command, status = super()._hold(scene, base, result, reason, forward_gear=forward_gear)
        status['fallback_hold_safe_against_rear_impact'] = None
        status['fallback_hold_status'] = 'UNVERIFIED_EMERGENCY_HOLD'
        return command, status

    def _curve(self, scene, road, offset, target):
        transition = max(12., target * 4., abs(offset + road['centerline'][0][1]) * 4.)
        local = spatial_route(offset, {**road, 'lane_transition_m': transition},
                              np.arange(0., transition + 4.01, .25))
        origin = np.asarray(scene.prediction['odometry_origin_m'])
        yaw = scene.prediction['odometry_yaw_rad']
        return {'kind': self.phase, 'points': local[:, 1:3] @ rotation(yaw).T + origin,
                'yaw': local[:, 3] + yaw, 'transition_m': transition,
                'transition_index': int(math.ceil(transition / .25))}

    def _alignment(self, scene, road, offset):
        if self.maneuver_curve is None:
            return None
        origin = np.asarray(scene.prediction['odometry_origin_m'])
        nearest = int(np.argmin(np.linalg.norm(self.maneuver_curve['points'] - origin, axis=1)))
        line = np.asarray(road['centerline'], float)
        segments = np.diff(line, axis=0)
        supported = np.flatnonzero(np.linalg.norm(segments, axis=1) > .5)
        if not len(supported):
            return None
        direction = segments[supported[0]]
        heading = abs(math.atan2(direction[1], direction[0]))
        error = abs(line[0, 1] + offset)
        body = self.geometry.half_width_m * abs(math.cos(heading)) + max(
            self.geometry.front_m, self.geometry.rear_m) * abs(math.sin(heading))
        if (nearest < self.maneuver_curve['transition_index'] or heading > .1 or error > .3
                or error + body > road['lane_width_m'] / 2. - .1):
            return None
        return {'frame_id': scene.observation.frame_id, 'timestamp_s': scene.observation.timestamp_s,
                'center_error_m': float(error), 'heading_error_rad': heading,
                'body_inside_lane': True, 'curve_progress_m': nearest * .25,
                'required_curve_progress_m': self.maneuver_curve['transition_m']}

    def _complete_path(self, scene, curve, target):
        local = self._local_curve(scene, curve)
        speed = scene.observation.ego.speed_mps
        if target < .5:
            return None
        duration = local[-1, 0] / max(.5, target) + max(0., target - speed) / 2. + 2.
        if duration > 12.:
            return None
        times = np.arange(0., duration + .051, .05)
        acceleration = 2. if target >= speed else -3.
        velocities = np.clip(speed + acceleration * times, min(speed, target), max(speed, target))
        distance = np.r_[0., np.cumsum((velocities[:-1] + velocities[1:]) * .025)]
        ends = np.flatnonzero(distance >= local[-1, 0])
        if not len(ends):
            return None
        end = int(ends[0])
        distance = distance[:end + 1]
        path = np.column_stack((times[:end + 1], *(np.interp(distance, local[:, 0], local[:, i])
                                                  for i in (1, 2, 3))))
        path[0] = [0., 0., 0., 0.]
        return stopping_tail(path, float(velocities[end]), self.geometry, False)

    def _proof(self, scene, path, command, road, began, wall, *, complete=False):
        if path is None:
            return False, 'COMPLETE_MANEUVER_HORIZON_UNAVAILABLE', {}
        if complete:
            from .corridor_uncertainty import uncertain_corridor_tracks
            if not scene.usable(command.timestamp_s, wall + time.perf_counter() - began):
                return False, 'STALE_CONTROL_SCENE', {}
            uncertain = uncertain_corridor_tracks(scene.prediction['tracks'],
                scene.prediction['control_trajectories'], path, scene.geometry, retained_forecasts=True)
            if uncertain:
                return False, 'REACHABLE_CORRIDOR_UNCERTAINTY', {'track_ids': uncertain}
        forecast = urban_forecast(scene, float(path[-1, 0]) if complete else scene.prediction['horizon_s'])
        return self.shield.check(forecast, path, command, road, timestamp_s=command.timestamp_s,
                                 wall_s=wall + time.perf_counter() - began, full_maneuver=complete)

    def coverage_path(self, speed, road):
        # Grow the measured-road query with current reaction/braking distance.
        # A stopped car starts with 6 m of measured road; query farther as its
        # current reaction and braking distance grows.
        # The shorter query conservatively caps target speed; complete maneuver
        # and independent stopping-tail proofs still expand their own scope.
        lookahead = min(75., max(6., speed * .5 + speed ** 2 / 6. + 4.))
        return spatial_route(self.offset, road, np.arange(0., lookahead + .01, .5))

    def _speed(self, scene, road, cap):
        from .launch_alignment import curvature_speed_limit
        probe = self.coverage_path(scene.observation.ego.speed_mps, road)
        scene.space.ensure_scope(probe)
        visible = scene.space.continuous_coverage(probe)
        usable = max(0., visible - 1.)
        visibility_cap = max(0., math.sqrt(1.35 ** 2 + 6. * usable) - 1.35)
        target = min(58. / 3.6, cap, visibility_cap)
        curve_cap = curvature_speed_limit((0., 0.), road['centerline'])
        if curve_cap is not None:
            target = min(target, curve_cap)
        if road.get('remaining_m') is not None:
            target = min(target, terminal_speed_mps(road['remaining_m']))
        return target, visible

    def evaluate(self, scene, base, road, cap_mps, *, wall):
        began = time.perf_counter()
        self.sequence += 1
        result = {'version': 2, 'driver_id': self.DRIVER_ID,
                  'decision_id': f'{road.get("session_id")}:{base.frame_id}:{self.sequence}',
                  'source_frame': scene.observation.frame_id if scene else None,
                  'timestamp_s': base.timestamp_s, 'phase': self.phase, 'rejected': [],
                  'completed_maneuvers': list(self.completed_maneuvers), 'learned_control_used': False,
                  'request_replan': False, 'request_alternative': False}
        if wall >= self.deadline:
            return self._hold(scene, base, result, 'URBAN_VALIDATION_EXPIRED')
        if (scene is None or scene.session_id != road.get('session_id')
                or not scene.usable(base.timestamp_s, wall)):
            return self._hold(scene, base, result, 'STALE_CONTROL_SCENE')
        if scene.observation.frame_id != base.frame_id or not scene.prediction.get('motion_tracking_complete'):
            return self._hold(scene, base, result, 'AWAITING_CURRENT_MOTION_FRAME')
        self._observe_motion(scene)
        now = scene.observation.timestamp_s
        self.previous_stamp = now
        ego = scene.observation.ego
        if ego.reverse or road.get('traffic_stop') or base.handbrake:
            return self._hold(scene, base, result, 'TRAFFIC_RULE_STOP' if road.get('traffic_stop')
                              else 'FORWARD_GEAR_OR_HANDBRAKE_HOLD')
        if 'drivable_strips' not in road:
            return self._hold(scene, base, result, 'DRIVABLE_BODY_COVERAGE_UNAVAILABLE')
        age=wall+time.perf_counter()-began-scene.received_wall_s
        if age>=self.MANEUVER_START_MAX_AGE_S:
            # The independent brake-path veto and native submission still need
            # time inside the unchanged 250 ms lease.
            result.update(scene_wall_age_s=age,scene_sim_age_s=base.timestamp_s-now,
                          planning_ms=(time.perf_counter()-began)*1000)
            self.wait_reason='CONTROL_APPLICATION_HEADROOM'
            result['wait_reason']=self.wait_reason
            return self._hold(scene,base,result,self.wait_reason)
        tracks = scene.prediction['tracks']
        probe = spatial_route(self.offset, road, np.arange(0., 70.01, .5))
        front = []
        positions = np.asarray([track['position_m'] for track in tracks], float).reshape(-1, 2)
        along, lateral = path_coordinates(positions[:, 0], positions[:, 1], probe) if len(positions) else ((), ())
        for index, track in enumerate(tracks):
            x = track['position_m'][0]
            if (track.get('confirmed') and x > self.geometry.front_m
                    and lateral[index] < self.geometry.half_width_m + track['half_size_m'][1] + .3):
                front.append((max(0., float(along[index]) - track['half_size_m'][0] - self.geometry.front_m), track))
        nearest = min(front, key=lambda row: row[0]) if front else None
        result['front_blocker'] = {'track_id': nearest[1]['id'], 'gap_m': nearest[0]} if nearest else None
        target, visible = self._speed(scene, road, max(0., cap_mps))
        result.update(observed_road_range_m=visible, scene_wall_age_s=wall - scene.received_wall_s,
                      scene_sim_age_s=base.timestamp_s - now, selected_side=self.selected_side)
        if ego.speed_mps >= 60. / 3.6 - .15:
            target = min(target, 58. / 3.6)
        if nearest and nearest[1]['id'] != self.lead_id:
            self.lead_id = nearest[1]['id']
            self.lead_seen_since = now
        if self.phase == 'CHANGE' and self._alignment(scene, road, self.offset):
            self.phase = 'PASS'
            self.maneuver_curve = None
        if self.phase == 'PASS' and self.clearance_proof is None:
            lead = next((t for t in tracks if t['id'] == self.blocker and t.get('confirmed')
                         and t.get('occlusion_s', 1.) <= .1), None)
            if lead is not None and lead['position_m'][0] + lead['half_size_m'][0] < -self.geometry.rear_m - 2.:
                self.clearance_proof = {'frame_id': base.frame_id, 'timestamp_s': now, 'track_id': lead['id'],
                                        'rear_clearance_m': -self.geometry.rear_m - lead['position_m'][0] - lead['half_size_m'][0]}
        returned = self._alignment(scene, road, 0.) if self.phase == 'RETURN' else None
        if returned and self.clearance_proof:
            self.completed_maneuvers.append({'id': self.maneuver_id, 'kind': 'OVERTAKE', 'status': 'COMPLETED',
                                            'measured_clearance': True, 'clearance_proof': self.clearance_proof,
                                            'return_required': True, 'returned': True,
                                            'return_proof': returned,
                                            'completion_frame': base.frame_id, 'timestamp_s': now})
            self.phase = 'FOLLOW'
            self.offset = 0.
            self.blocker = self.selected_side = self.maneuver_curve = self.clearance_proof = None
            self.cooldown_until = now + 2.

        proposals = []
        if self.phase == 'PASS' and self.clearance_proof and road.get('return_allowed') and not road.get('junction_ahead'):
            return_speed = min(target, 8.)
            return_curve = self._curve(scene, road, 0., return_speed)
            side = 'right' if self.offset < 0 else 'left'
            if road.get(side + '_clear_distance_m', 0.) >= return_curve['transition_m'] + 4. + return_speed * .35 + return_speed ** 2 / 6.:
                proposals.append(('START_RETURN', 0., return_speed, return_curve))
            else:
                result['rejected'].append({'action': 'START_RETURN', 'reason': 'COMPLETE_LEGAL_RETURN_UNAVAILABLE'})
        lead_speed = max(0., nearest[1]['velocity_mps'][0]) if nearest else target
        person = nearest and str(nearest[1].get('class', '')).lower() in ('person', 'pedestrian')
        useful = bool(nearest and not person and target - lead_speed >= 1.5
                      and nearest[0] < max(45., ego.speed_mps * 4.)
                      and nearest[1].get('occlusion_s', 1.) <= .1
                      and now - self.lead_seen_since >= .4)
        if self.phase in ('FOLLOW', 'WAIT') and useful and now >= self.cooldown_until and not road.get('junction_ahead'):
            passing_speed = min(target, max(4., lead_speed + 3.), 10.)
            for side, sign in (('left', -1.), ('right', 1.)):
                if not road.get(side + '_allowed'):
                    continue
                offset = sign * road['lane_width_m']
                curve = self._curve(scene, road, offset, passing_speed)
                if road.get(side + '_clear_distance_m', 0.) < curve['transition_m'] + 4. + passing_speed * .35 + passing_speed ** 2 / 6.:
                    result['rejected'].append({'action': 'CHANGE_' + side.upper(), 'reason': 'COMPLETE_LEGAL_LANE_UNAVAILABLE'})
                    continue
                proposals.append(('CHANGE_' + side.upper(), offset, passing_speed, curve))
        follow_target = target
        if nearest:
            follow_target = min(target, max(0., lead_speed + (nearest[0] - 4. - ego.speed_mps) / 2.))
        if person:
            follow_target = min(follow_target, 2.)
        curve = self.maneuver_curve
        if self.phase == 'PASS':
            curve = self._curve(scene, road, self.offset, max(.5, follow_target))
        proposals.append((self.phase if self.phase in ('CHANGE', 'PASS', 'RETURN') else 'FOLLOW',
                          self.offset, min(follow_target, 10.) if self.phase != 'FOLLOW' else follow_target, curve))
        for action, offset, desired, curve in proposals:
            if wall+time.perf_counter()-began-scene.received_wall_s>=self.MANEUVER_START_MAX_AGE_S:
                self.wait_reason='CONTROL_APPLICATION_HEADROOM'
                result['wait_reason']=self.wait_reason
                return self._hold(scene,base,result,self.wait_reason)
            if action.startswith('CHANGE_') or action == 'START_RETURN':
                age = wall + time.perf_counter() - began - scene.received_wall_s
                if age >= self.OPTIONAL_MANEUVER_START_AGE_S:
                    result['rejected'].append({'action': action, 'reason': 'OPTIONAL_PLANNING_HEADROOM',
                                               'sensor_wall_age_s': age})
                    continue
            command, path = self._proposal(scene, base, road, desired, offset, self.control_dt, maneuver_curve=curve)
            complete = action.startswith('CHANGE_') or action in ('CHANGE', 'START_RETURN', 'RETURN')
            if complete:
                full = self._complete_path(scene, curve, desired)
                ok, reason, evidence = self._proof(scene, full, command, road, began, wall, complete=True)
                if not ok:
                    result['rejected'].append({'action': action, 'reason': reason, 'evidence': evidence})
                    continue
                result['maneuver_proof'] = {**evidence, 'complete_stopping_tail_verified': True,
                                            'stopping_tail_included_in_intended_path': True}
            if ego.speed_mps >= 59. / 3.6:
                command = replace(command, throttle=0., brake=max(command.brake, .35))
                path = signed_path(ego.speed_mps, command.steering, -command.brake * 5., self.geometry)
            ok, reason, evidence = self._proof(scene, path, command, road, began, wall)
            if not ok:
                result['rejected'].append({'action': action, 'reason': reason, 'evidence': evidence})
                continue
            if not scene.usable(base.timestamp_s,wall+time.perf_counter()-began):
                return self._hold(scene,base,result,'CONTROL_PROCESSING_DEADLINE')
            if action.startswith('CHANGE_'):
                self.phase = 'CHANGE'
                self.offset = offset
                self.blocker = nearest[1]['id']
                self.selected_side = action.split('_', 1)[1].lower()
                self.maneuver_curve = curve
                self.clearance_proof = None
                self.return_required = True
                self.maneuver_id += 1
            elif action == 'START_RETURN':
                self.phase = 'RETURN'
                self.maneuver_curve = curve
            elif self.phase == 'WAIT':
                self.phase = 'FOLLOW'
            self._pedals(desired, ego.speed_mps, self.control_dt, commit=True)
            self.wait_reason = ('WAITING_FOR_SAFE_GAP' if useful and self.phase == 'FOLLOW'
                                else 'WAITING_FOR_VERIFIED_RETURN' if self.clearance_proof and self.phase == 'PASS'
                                else 'FOLLOWING_LEAD' if nearest else None)
            result.update(action=action, phase=self.phase, reason=self.wait_reason or 'VERIFIED_MEASURED_MOTION',
                          wait_reason=self.wait_reason, selected_path=path.tolist(), space=evidence,
                          target_speed_kmh=desired * 3.6, selected_side=self.selected_side,
                          completed_maneuvers=list(self.completed_maneuvers),
                          planning_ms=(time.perf_counter() - began) * 1000)
            self.previous_command = command
            self.last = result
            return command, result
        self.wait_reason = 'NO_COMPLETE_SAFE_CORRIDOR'
        result['wait_reason'] = self.wait_reason
        return self._hold(scene, base, result, self.wait_reason)
