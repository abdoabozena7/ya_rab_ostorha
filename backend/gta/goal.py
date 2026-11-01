"""GTA asynchronous adapter for the project's measured HybridDriver.

This is a rule baseline, not MaskablePPO training. Map GPS is a navigation
prior. Inputs never include population files, entity handles or actor truth.
The strict synchronous CARLA SensorObservation contract is not fabricated.
"""
from dataclasses import dataclass, replace
import math
import time
from types import SimpleNamespace
import numpy as np
from backend.core.contracts import ControlCommand, CommandSource
from backend.core.safety_policy import EgoMeasurements
from backend.core.motion_geometry import VehicleGeometry
from backend.core.control_scene import MeasuredSpace
from backend.core.hybrid_driver import HybridDriver
from backend.core.prediction import PredictionEngine
from backend.core.kinematic_prediction import kinematic_modes
from backend.core.maneuver_candidates import signed_path
from .provider import latest_json, TICK


@dataclass
class AsyncScene:
    session_id: str
    observation: object
    geometry: object
    points: object
    prediction: object
    space: object
    received_wall_s: float
    build_ms: float
    latest_game_s: float

    def usable(self, timestamp_s, wall_s):
        return (0 <= self.latest_game_s-self.observation.timestamp_s <= .100001
                and 0 <= timestamp_s-self.observation.timestamp_s <= .100001
                and 0 <= wall_s-self.received_wall_s <= .25)


def measured_points(scan, ground_reference_z=0.):
    """Completed real returns only. No-hit, pending and handles are discarded."""
    rows = np.asarray(scan['rays'], dtype=float)
    if rows.shape != (1080, 9) or not np.isfinite(rows).all():
        raise ValueError('Incomplete or nonfinite geometric scan')
    expected = {(a, e) for a in range(0, 360, 3) for e in (-65, -45, -35, -25, -15, -8, -3, 0, 6)}
    if {(r[0], r[1]) for r in rows} != expected or np.any(rows[:, 2] != 2):
        raise ValueError('Missing, duplicate or pending beams')
    if np.any(~np.isin(rows[:, 3], (0, 1))) or np.any((rows[:, 4] < 0) | (rows[:, 4] > 100)):
        raise ValueError('Invalid ray result')
    position = np.asarray(scan['position'], float)
    basis = np.asarray([scan[k] for k in ('forward', 'right', 'up')], float)
    if not np.isfinite(basis).all() or not np.allclose(basis@basis.T, np.eye(3), atol=.02):
        raise ValueError('Invalid measured ego basis')
    points = (rows[rows[:, 3] == 1, 5:8]-position)@basis.T
    origin = (np.asarray(scan['origin_world'])-position)@basis.T
    # GTA's entity origin is above the tyre contact plane. CARLA's canonical
    # ground-centric geometry must receive an explicit measured self transform.
    points[:, 2] -= ground_reference_z
    origin[2] -= ground_reference_z
    return points, origin


def route_context(route, scan, session_id):
    points = np.asarray(route['points'], float)
    if points.ndim != 2 or points.shape[1] != 3 or not np.isfinite(points).all():
        raise ValueError('Invalid map route')
    arc = np.r_[0., np.cumsum(np.linalg.norm(np.diff(points, axis=0), axis=1))]
    if not 600 <= arc[-1] <= 800 or np.max(np.diff(arc)) > 12:
        raise ValueError('Route is not the declared600–800m continuous map prior')
    delta = points-np.asarray(scan['position'])
    local = delta@np.asarray([scan[k] for k in ('forward', 'right', 'up')]).T
    index = int(np.argmin(np.linalg.norm(local[:, :2], axis=1)))
    line = local[max(0, index-1):, :2]
    if len(line) < 2:
        line = local[-2:, :2]
    remaining = float(arc[-1]-arc[index]+np.linalg.norm(local[index, :2]))
    return {'session_id': session_id, 'centerline': line.tolist(), 'remaining_m': remaining,
            'lane_width_m': 2.2, 'adjacent_available': {'left': True, 'right': True},
            'return_allowed': True, 'junction_ahead': False, 'alternatives': [],
            'traffic_stop': False, 'left_allowed': True, 'right_allowed': True,
            'source': 'STATIC_GPS_MAP_PRIOR_NOT_ACTORS'}, float(arc[index])


class GoalDriver:
    def __init__(self, directory, session_id):
        self.directory, self.session_id = directory, session_id
        self.geometry = self.driver = self.engine = None
        self.last_frame = -1
        self.last_scan = None
        self.latest = {'phase': 'WAIT_SENSORS', 'reason': 'NO_MEASURED_SCENE', 'autonomous': True,
                       'controller': 'PROJECT_HYBRID_RULE_BASELINE', 'training': False}
        self.command = self.hold('NO_MEASURED_SCENE')
        self.active = True
        self.scene = None
        self.road = None
        self.sources_healthy = False

    def hold(self, reason):
        return {'steering': 0., 'throttle': 0., 'brake': 1., 'reverse': False, 'reason': reason}

    def stop(self):
        self.active = False
        self.command = self.hold('USER_STOP')

    def step(self, scan, native, capture, vision, *, human=False):
        now = TICK()
        self.sources_healthy = False
        if not self.active:
            return self.hold('USER_STOP')
        sources = ((scan, 'host_ms'), (native, 'host_ms'), (capture, 'native_host_ms'))
        if any(not row or row.get('run_id') != self.session_id or not 0 <= now-row.get(k, -1000000) <= 350 for row, k in sources):
            return self.hold('GOAL_STALE_SENSORS')
        if native.get('stage') == 'DONE' or not native.get('ped_alive'):
            return self.hold('NATIVE_FINISHED')
        if (not capture.get('rgb_ok') or not capture.get('depth_ok') or not vision
                or vision.get('run_id') != self.session_id or vision.get('pid') != native.get('pid')
                or not 0 <= native['game_ms']-vision.get('game_ms', -1000000) <= 350):
            return self.hold('WAIT_REAL_VISION')
        self.sources_healthy = True
        if scan['frame'] == self.last_frame:
            return self.command if now-scan['host_ms'] <= 180 else self.hold('GOAL_DECISION_EXPIRED')
        started = time.monotonic()
        try:
            raw_shape = latest_json(self.directory/'ego-geometry.json')
            route = latest_json(self.directory/'route-map.jsonl')
            if not raw_shape or not route or 'error' in route:
                raise ValueError('GPS_ROUTE_OR_SELF_GEOMETRY_UNAVAILABLE')
            if self.geometry is None:
                self.geometry = VehicleGeometry(**{k: raw_shape[k] for k in ('front_m', 'rear_m', 'half_width_m', 'wheelbase_m')},
                                                max_steer_rad=.6, source=raw_shape['source']+';STEER_RESPONSE_PROVISIONAL')
                self.driver = HybridDriver(self.geometry, allow_reverse=True)
                self.engine = PredictionEngine(self.session_id, enhanced=True, geometry=self.geometry)
            points, origin = measured_points(scan, raw_shape.get('lower_model_z', 0.))
            yaw_rate = 0.
            if self.last_scan:
                dt = (scan['game_ms']-self.last_scan['game_ms'])/1000
                previous, current = np.asarray(self.last_scan['forward']), np.asarray(scan['forward'])
                if dt > 0:
                    yaw_rate = -math.atan2(previous[0]*current[1]-previous[1]*current[0], previous[:2]@current[:2])/dt
            reverse = scan['longitudinal_speed_mps'] < -.05 or (scan['speed_mps'] < .15 and scan['reverse_requested'])
            ego = EgoMeasurements(float(scan['speed_mps']), (0., 0., yaw_rate), 'EGO_Z_RIGHT_YAW',
                                  scan['throttle'], scan['brake'], scan['steering'], -1 if reverse else 1,
                                  bool(reverse), scan['brake'] >= .99, 'GTA_NATIVE_SELF_ODOMETRY_AND_APPLIED_INPUTS',
                                  float(scan['longitudinal_speed_mps']))
            observation = SimpleNamespace(frame_id=int(scan['frame']), timestamp_s=scan['game_ms']/1000,
                                          ego=ego, channels=(), provider='GTA_ASYNCHRONOUS_DECLARED_MEASUREMENTS')
            road, progress = route_context(route, scan, self.session_id)
            look = np.asarray(road['centerline'], float)
            valid = look[look[:, 0] > 2]
            target = valid[min(len(valid)-1, 2)] if len(valid) else look[-1]
            steering = float(np.clip(math.atan2(target[1], max(.5, target[0]))*.9, -.35, .35))
            base = ControlCommand(observation.frame_id, observation.timestamp_s, .25, 0., steering,
                                  False, False, CommandSource.NAVIGATION, 1)
            prediction = self.engine.evaluate(points, observation, base, control_only=True)
            prediction['control_trajectories'] = kinematic_modes(prediction['tracks'])
            space = MeasuredSpace(np.empty((0, 3)), self.geometry, observation, {}, measured_surfaces=[(points, origin)])
            scene = AsyncScene(self.session_id, observation, self.geometry, points, prediction, space,
                               started-(now-scan['host_ms'])/1000, 0., native['game_ms']/1000)
            self.scene, self.road = scene, road
            if human:
                command = replace(base, throttle=0., brake=1., steering=0.)
                result = {'phase': 'HUMAN_DEMO', 'reason': 'WAIT_HUMAN_COMMAND'}
            else:
                command, result = self.driver.evaluate(scene, base, road, 2.2, wall=time.monotonic())
            # Recheck actual bounded pedals/steering after conversion to this bridge.
            command = replace(command, steering=float(np.clip(command.steering, -.35, .35)), throttle=min(.35, command.throttle))
            path = signed_path(ego.speed_mps, command.steering, command.throttle*2.5-command.brake*5., self.geometry, command.reverse)
            ok, reason, evidence = self.driver.shield.check(scene, path, command, road,
                                                           timestamp_s=observation.timestamp_s, wall_s=time.monotonic())
            self.command = ({'steering': command.steering, 'throttle': command.throttle, 'brake': command.brake,
                             'reverse': command.reverse, 'reason': result['reason']} if ok else self.hold(reason))
            destination = route['destination']
            distance = float(np.linalg.norm(np.asarray(destination)-np.asarray(scan['position'])))
            if distance <= 5 and ego.speed_mps <= .2:
                self.command = self.hold('DESTINATION_REACHED')
            self.latest = {**result, 'controller': 'PROJECT_HYBRID_RULE_BASELINE', 'autonomous': True,
                           'training': False, 'native_frame': scan['frame'], 'host_ms': now,
                           'destination_m': destination, 'destination_distance_m': distance,
                           'route_length_m': route['route_length_m'], 'progress_m': progress,
                           'remaining_m': road['remaining_m'], 'actual_command': self.command,
                           'measured_returns': len(points), 'cv_detections': len(vision['detections']),
                           'forecast_source': 'PROJECT_MEASURED_SURFACE_KINEMATIC_MODES_NOT_TRAJECTRON',
                           'steer_response_qualified': False, 'synchronous_step': False}
            self.last_frame, self.last_scan = scan['frame'], scan
        except (ValueError, KeyError, TypeError) as exc:
            self.command = self.hold(str(exc))
            self.latest = {**self.latest, 'reason': str(exc), 'host_ms': now, 'actual_command': self.command}
        with (self.directory/'goal-driver.jsonl').open('a', encoding='utf8') as f:
            import json
            f.write(json.dumps(self.latest, allow_nan=False)+'\n')
        return self.command

    def manual(self, raw, now):
        """Check the user's direction; rejection brakes without opposite steering."""
        if (not self.active or not self.sources_healthy or not raw or raw.get('run_id') != self.session_id
                or not raw.get('focused') or not 0 <= now-raw.get('host_ms', -1000000) <= 150):
            return self.hold('HUMAN_INPUT_UNAVAILABLE'), False
        if self.scene is None or not self.scene.usable(self.scene.observation.timestamp_s, time.monotonic()):
            return self.hold('HUMAN_SCENE_STALE'), False
        ego = self.scene.observation.ego
        w, s = raw['forward'], raw['brake_reverse']
        reverse = s > 0 and ego.longitudinal_speed_mps <= .15
        throttle = min(.35, s if reverse else w)
        brake = 1. if raw['handbrake'] > 0 or w == s or (s > 0 and not reverse) or (w > 0 and ego.longitudinal_speed_mps < -.15) else 0.
        command = ControlCommand(self.scene.observation.frame_id, self.scene.observation.timestamp_s,
                                 0. if brake else throttle, brake, float(np.clip(raw['steering'], -.35, .35)),
                                 reverse, False, CommandSource.NAVIGATION, -1 if reverse else 1)
        path = signed_path(ego.speed_mps, command.steering, command.throttle*2.5-command.brake*5., self.geometry, reverse)
        ok, reason, evidence = self.driver.shield.check(self.scene, path, command, self.road,
                                                       timestamp_s=command.timestamp_s, wall_s=time.monotonic())
        result = ({'steering': command.steering, 'throttle': command.throttle, 'brake': command.brake,
                   'reverse': reverse, 'reason': 'HUMAN_SHIELDED'} if ok else self.hold(reason))
        self.latest = {**self.latest, 'phase': 'HUMAN_DEMO', 'human_requested': dict(raw),
                       'actual_command': result, 'intervention': not ok, 'space': evidence}
        return result, bool(ok)

    def example_proposal(self, values):
        if not self.active or not self.sources_healthy or self.scene is None:
            return None
        observation = self.scene.observation
        command = ControlCommand(observation.frame_id, observation.timestamp_s, min(.35, values['throttle']),
                                 values['brake'], float(np.clip(values['steering'], -.35, .35)),
                                 values['reverse'], False, CommandSource.NAVIGATION, -1 if values['reverse'] else 1)
        path = signed_path(observation.ego.speed_mps, command.steering, command.throttle*2.5-command.brake*5., self.geometry, command.reverse)
        ok, reason, evidence = self.driver.shield.check(self.scene, path, command, self.road,
                                                       timestamp_s=command.timestamp_s, wall_s=time.monotonic())
        if not ok:return None
        return {'steering': command.steering, 'throttle': command.throttle, 'brake': command.brake,
                'reverse': command.reverse, 'reason': 'SHIELDED_HUMAN_EXAMPLE_PROPOSAL'}
