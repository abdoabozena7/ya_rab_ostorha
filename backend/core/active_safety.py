"""YA RAB OSTORHA rule-based runtime supervisor. Sensor-only; no CARLA client.

The validated teacher is unchanged. Explicit measured free-road support resolves
its diagnostic missing-radar stop on empty roads. Unknown space remains unknown.
No side-space/lane certificate exists, so steering adjustments are unavailable.
"""
from dataclasses import dataclass, replace
import io
import json
from pathlib import Path
import math
import numpy as np
from .contracts import CommandSource, ControlCommand, SensorKind, finite, to_dict
from .safety_policy import SensorObservation, ProposedSafetyAction, FeasibilityEvidence, admit_proposal
from ..rl.teacher import YaRabOstorhaSafetyTeacher, TeacherConfig
from ..rl.radar import validate_radar_calibration, local_points, estimate_ground_plane, RADAR_FEATURES
from ..rl.radar_retention import retained_radar_observation

CONFIG_PATH = Path(__file__).resolve().parents[2] / 'config/ya_rab_ostorha_safety.json'


def coverage_speed_limit(range_m, teacher):
    """Invert the stopping envelope using measured space, without release padding."""
    usable = max(0., finite(range_m, 'observed road range') - teacher.minimum_clearance_m)
    reaction = teacher.assumed_deceleration_mps2 * teacher.reaction_time_s
    return math.sqrt(reaction * reaction + 2 * teacher.assumed_deceleration_mps2 * usable) - reaction


@dataclass(frozen=True)
class RuntimeSafetyConfig:
    version: str
    enabled_by_default: bool
    teacher: TeacherConfig
    ttc_trigger_s: float
    ttc_release_s: float
    minimum_closing_speed_mps: float
    minimum_brake_hold_s: float
    brake_release_rate_per_s: float
    maximum_sensor_wall_age_s: float
    path_half_width_m: float
    ego_front_m: float
    minimum_foreground_height_m: float
    maximum_foreground_height_m: float
    maximum_observed_range_m: float
    maximum_safety_steering_delta: float

    def __post_init__(self):
        limits = {'ttc_trigger_s': (.5, 4), 'ttc_release_s': (1, 8), 'minimum_closing_speed_mps': (.1, 1),
            'minimum_brake_hold_s': (.1, 1), 'brake_release_rate_per_s': (.5, 5),
            'maximum_sensor_wall_age_s': (.1, .35), 'path_half_width_m': (1, 1.8), 'ego_front_m': (2, 3),
            'minimum_foreground_height_m': (.15, .4), 'maximum_foreground_height_m': (2, 4),
            'maximum_observed_range_m': (20, 90)}
        if not self.version or type(self.enabled_by_default) is not bool:
            raise ValueError('Invalid active safety identity/default')
        for key, (lo, hi) in limits.items():
            if not lo <= finite(getattr(self, key), key) <= hi: raise ValueError('Invalid safety parameter: ' + key)
        if self.ttc_release_s <= self.ttc_trigger_s or self.maximum_safety_steering_delta != 0:
            raise ValueError('Release needs hysteresis; steering has no certified side-space coverage')

    @classmethod
    def load(cls, path=CONFIG_PATH):
        data = json.loads(Path(path).read_text())
        data['teacher'] = TeacherConfig(**data['teacher'])
        return cls(**data)


def _mount(channel):
    mount = channel.calibration.get('mount_transform', {})
    position = np.asarray(mount.get('position_m', []), float)
    rotation = mount.get('rotation_deg', {})
    angles = np.asarray([rotation.get(k, np.nan) for k in ('roll', 'pitch', 'yaw')], float)
    if position.shape != (3,) or not np.isfinite([*position, *angles]).all():
        raise ValueError('Missing sensor-local mount calibration')
    return position, angles


def assess_forward_space(observation, asset_reader, config, *, steering=None, geometry=None, forward_path=None, measured_space=None):
    """Fuse measured local radar/LiDAR/depth surfaces, never actor identities.

    Ground slope comes from the existing bounded radar consensus. CARLA depth
    is an axial z-buffer: K^-1*[u,v,1]*depth, without unit-ray normalization.
    The recorded native ground plane verifies this projection. Only level forward cameras
    certify road support; other camera views retain fixed forward LiDAR.
    """
    channels = {s.kind: s for s in observation.channels}
    radar = next((s for s in observation.channels if s.kind==SensorKind.RADAR and s.sensor_id=='radar'),channels[SensorKind.RADAR])
    validate_radar_calibration(radar.calibration)
    columns = ('depth_m', 'azimuth_rad', 'altitude_rad', 'velocity_mps')
    points = np.asarray([[d[k] for k in columns] for d in radar.data['detections']], np.float32).reshape(-1, 4)
    if not np.isfinite(points).all(): raise ValueError('Invalid native radar values')
    nearest = points[np.argsort(points[:, 0], kind='stable')[:32]]
    plane = estimate_ground_plane(nearest)
    a, b = plane if plane is not None else (0., 0.)
    front=geometry.front_m if geometry else config.ego_front_m
    width=geometry.half_width_m+.2 if geometry else config.path_half_width_m
    if forward_path is not None:
        forward_path=np.asarray(forward_path,float)
        length=np.linalg.norm(np.diff(forward_path[:,1:3],axis=0),axis=1).sum()
        required=max(10.,front+config.teacher.minimum_clearance_m+observation.ego.speed_mps*.35+observation.ego.speed_mps**2/10+config.teacher.release_hysteresis_m)
        if length<required:
            end=forward_path[-1].copy();end[0]+=.1
            end[1:3]+=(required-length)*np.array([math.cos(end[3]),math.sin(end[3])])
            forward_path=np.vstack((forward_path,end))
    x, y, z = local_points(points)
    heights = (z - a*x - b*y) / math.sqrt(1+a*a+b*b)
    def corridor(xx, yy):
        if forward_path is not None:
            from .motion_geometry import path_coordinates
            along,lateral=path_coordinates(xx,yy,forward_path)
            return (along>front)&(lateral<=width)
        if steering is None: return (xx > front) & (np.abs(yy) <= width)
        # Steering-derived circular centerline. Width includes ego dimensions,
        # speed-dependent uncertainty; ground/curb filtering remains independent.
        curvature = math.tan(float(steering)*(geometry.max_steer_rad if geometry else .6))/(geometry.wheelbase_m if geometry else 2.8)
        if abs(curvature) < 1e-4: lateral = np.abs(yy)
        else: lateral = np.abs(np.hypot(xx, yy-1/curvature)-abs(1/curvature))
        return (xx > front) & (lateral <= width)
    path = corridor(x, y)
    def ranges(xx,yy):
        if forward_path is not None:
            from .motion_geometry import path_coordinates
            return path_coordinates(xx,yy,forward_path)[0]
        if steering is not None:
            curvature = math.tan(float(steering)*(geometry.max_steer_rad if geometry else .6))/(geometry.wheelbase_m if geometry else 2.8)
            if abs(curvature)>=1e-4:
                # Circular-corridor distance is the ordered arc from ego.
                # The far side of a turn can share a small x coordinate with
                # nearby foreground; x alone must not become a near hazard.
                return np.arctan2(curvature*xx,1-curvature*yy)/curvature
        return xx
    foreground = path & (heights > config.minimum_foreground_height_m) & (heights < config.maximum_foreground_height_m)
    central = foreground & (np.abs(points[:, 1]) < RADAR_FEATURES.max_azimuth_rad) & (np.abs(points[:, 2]) < RADAR_FEATURES.max_altitude_rad)
    radar_index = int(np.flatnonzero(central)[np.argmin(points[central, 0])]) if central.any() else None
    radar_along=ranges(x,y)
    candidates = [(float(radar_along[i] - front), 'RADAR', max(0., -float(points[i, 3])),
                   int(np.sum(foreground & (np.abs(x-x[i])<.5) & (np.abs(y-y[i])<.5))))
                  for i in np.flatnonzero(foreground)]
    # Keep real ground support and relevant real foreground for teacher V1.
    selected = (~((heights > config.minimum_foreground_height_m) & ~path))
    filtered = replace(radar, data={'detections': [d for d, keep in zip(radar.data['detections'], selected) if keep]})
    # The byte-preserved legacy teacher accepts one front radar and indexes by
    # kind. Keep surround measurements in the real scene/recording, but do not
    # let their different mounts replace that audited input inside its adapter.
    # Its retention adapter validates that same front mount, so filter before
    # retention as well as before the teacher itself.
    teacher_observation=retained_radar_observation(replace(observation,
        channels=tuple(filtered if s.sensor_id==radar.sensor_id else s for s in observation.channels
            if s.kind!=SensorKind.RADAR or s.sensor_id==radar.sensor_id)))
    road_support = []; lidar_observed = False; depth_observed = False

    def surfaces(xyz, source):
        xx, yy, zz = xyz.T
        hh = (zz-a*xx-b*yy)/math.sqrt(1+a*a+b*b)
        within = corridor(xx, yy)
        fg = within & (hh > config.minimum_foreground_height_m) & (hh < config.maximum_foreground_height_m)
        # Unknown target motion: stationary-target envelope, no invented radar velocity.
        if fg.any():
            along=ranges(xx,yy);near=float(np.min(along[fg]))
            candidates.append((near-front, source, None, int(np.sum(fg & (along<=near+.5)))))
        ground = within & (np.abs(hh) <= .15)
        if ground.sum() >= 2 and np.ptp(yy[ground]) >= .25:
            road_support.append(float(np.max(ranges(xx[ground],yy[ground]))-front))

    lidar = channels[SensorKind.LIDAR]
    position, angles = _mount(lidar)
    if np.any(np.abs(angles) > 1e-4): raise ValueError('Forward LiDAR mount must be level')
    lidar_points = np.frombuffer(asset_reader(lidar.asset), dtype='<f4')
    if len(lidar_points) % 4 or not np.isfinite(lidar_points).all(): raise ValueError('Invalid real LiDAR asset')
    lidar_points = lidar_points.reshape(-1, 4)
    if len(lidar_points):
        lidar_observed = True; surfaces(lidar_points[:, :3] + position, 'LIDAR')

    # Supplementary rear/side cameras must never replace the fixed forward
    # depth used by the existing independent collision supervisor.
    depth = next((s for s in observation.channels if s.sensor_id=='depth'), channels[SensorKind.DEPTH])
    position, angles = _mount(depth)
    if np.all(np.abs(angles) < 1e-4) and position[0] > 0:
        cached=getattr(measured_space,'depth_images',{}).get(depth.asset.path)
        values = cached if cached is not None else np.load(io.BytesIO(asset_reader(depth.asset)), allow_pickle=False)
        if values.ndim != 2 or not np.isfinite(values).all() or np.any(values < 0): raise ValueError('Invalid real depth asset')
        h, w = values.shape
        if depth.calibration.get('width') != w or depth.calibration.get('height') != h:
            raise ValueError('Depth dimensions differ from calibrated sensor')
        fov = finite(depth.calibration.get('fov_deg'))
        focal = w/(2*math.tan(math.radians(fov)/2))
        # Four-pixel vertical and two-pixel horizontal sampling catches narrow
        # road strips and enough lateral support near the far-road horizon.
        # Each sample remains a real calibrated camera depth return.
        vv, uu = np.mgrid[h//3:h:4, 0:w:2]
        rays = np.stack((np.ones(uu.shape), (uu-(w-1)/2)/focal, -(vv-(h-1)/2)/focal), axis=-1)
        xyz = rays * values[vv, uu, None] + position
        surfaces(xyz.reshape(-1, 3), 'DEPTH'); depth_observed = True
    candidates = [item for item in candidates if 0 <= item[0] <= config.maximum_observed_range_m]
    target = min(candidates, default=None, key=lambda item: item[0])
    # The old farthest-ground heuristic could certify space across unseen gaps.
    # Use the entire swept body and stop at the first unknown/occupied slice.
    from .maneuver import ObservedSpace
    from .motion_geometry import VehicleGeometry
    from .recovery_depth import depth_surfaces
    g=geometry or VehicleGeometry(front_m=front,half_width_m=width-.2)
    if measured_space is None:
        measured_space=ObservedSpace(lidar_points[:,:3]+_mount(lidar)[0],g,
            measured_surfaces=depth_surfaces(observation,asset_reader) if depth_observed else ())
    distance=np.arange(0.,min(45.,config.maximum_observed_range_m)+.25,.5)
    if forward_path is not None:
        p=np.asarray(forward_path)
        arc=np.r_[0.,np.cumsum(np.linalg.norm(np.diff(p[:,1:3],axis=0),axis=1))]
        keep=np.r_[True,np.diff(arc)>1e-6]
        arc=arc[keep];p=p[keep]
        covered=distance[distance<=arc[-1]]
        probe=np.column_stack((covered,*(np.interp(covered,arc,p[:,i]) for i in (1,2,3))))
    else:
        curvature=math.tan((steering or 0.)*g.max_steer_rad)/g.wheelbase_m
        yaw=distance*curvature
        xx=np.sin(yaw)/curvature if abs(curvature)>1e-5 else distance
        yy=(1-np.cos(yaw))/curvature if abs(curvature)>1e-5 else np.zeros_like(distance)
        probe=np.column_stack((distance,xx,yy,yaw))
    clear_range=measured_space.continuous_coverage(probe)
    return {'target_range_m': target[0] if target else None, 'target_source': target[1] if target else None,
        'target_support_points': target[3] if target else 0,
        'closing_speed_mps': target[2] if target else None, 'radar_range_m': float(points[radar_index, 0]) if radar_index is not None else None,
        'radar_closing_speed_mps': max(0., -float(points[radar_index, 3])) if radar_index is not None else None,
        'observed_road_range_m': clear_range, 'ground_plane_supported': plane is not None,
        'lidar_observed': lidar_observed, 'depth_observed': depth_observed,
        'teacher_observation': teacher_observation,'lidar_surfaces':lidar_points[:,:3]+_mount(lidar)[0],
        'lidar_ground_plane':measured_space.ground_plane}


class RuntimeSafetyFeasibilityValidator:
    """Existing SafetyFeasibilityValidator protocol; additional braking only."""
    def validate(self, history, base_command, proposal):
        observation = history[-1]
        fresh = all(s.frame_id == observation.frame_id and abs(s.sensor_timestamp_s-observation.timestamp_s) <= 1e-6 for s in observation.channels)
        checked = fresh and {SensorKind.RADAR, SensorKind.LIDAR, SensorKind.DEPTH, SensorKind.IMU} <= {s.kind for s in observation.channels}
        if checked:
            channels={s.kind:s for s in observation.channels}
            gyro=np.asarray(channels[SensorKind.IMU].data.get('gyroscope_radps',[]),float)
            checked=(gyro.shape==(3,) and np.isfinite(gyro).all() and
                all(np.isfinite([d[k] for k in ('depth_m','azimuth_rad','altitude_rad','velocity_mps')]).all()
                    and d['depth_m']>=0 and abs(d['azimuth_rad'])<=np.pi and abs(d['altitude_rad'])<=np.pi/2
                    for d in channels[SensorKind.RADAR].data['detections']))
        c = proposal.command
        physical = (c.brake >= base_command.brake and c.throttle <= base_command.throttle and
            c.steering == base_command.steering and c.gear==1 and not c.reverse and not c.handbrake)
        return FeasibilityEvidence(observation.frame_id, observation.timestamp_s, physical, checked,
            False, False, False, 0., base_command.throttle, 'YA_RAB_OSTORHA_RUNTIME_BRAKING_V1',
            'SENSOR_DERIVED_AND_ONBOARD_LIMITS')


class ActiveSafetySupervisor:
    def __init__(self, config=None, *, anticipation_enabled=True):
        self.config = config or RuntimeSafetyConfig.load()
        self.anticipation_enabled = anticipation_enabled
        self.enabled = self.config.enabled_by_default
        self.teacher = YaRabOstorhaSafetyTeacher(self.config.teacher)
        self.validator = RuntimeSafetyFeasibilityValidator()
        self.interventions = 0; self.reset()

    def reset(self):
        from .path_conflicts import LidarPathConflicts, PATH_CONFLICT_POLICY
        self.path_conflicts=LidarPathConflicts()
        self.teacher.reset(); self.active = False; self.brake = 0.; self.started_s = None; self.previous_s = None
        self.last_fault = getattr(self, 'last_fault', None)
        self.status = {'type': 'RULE_BASED_SAFETY', 'version': self.config.version,
            'path_conflict_policy': PATH_CONFLICT_POLICY,
            'status': 'STANDBY', 'risk': 'UNKNOWN', 'active': False, 'reason': 'Waiting for forward driving',
            'steering_available': False, 'rejected_interventions': 0}

    def snapshot(self):
        return {**self.status, 'enabled': self.enabled, 'intervention_count': self.interventions}

    def evaluate(self, observation, base, asset_reader, *, as_of_timestamp_s):
        if not isinstance(observation, SensorObservation): raise ValueError('Runtime safety accepts sensor-only observations')
        c = self.config; t = c.teacher
        if not 0 <= finite(as_of_timestamp_s)-observation.timestamp_s <= t.maximum_observation_age_s:
            raise ValueError('Safety sensor simulation age exceeded')
        if base.frame_id != observation.frame_id or abs(base.timestamp_s-observation.timestamp_s)>1e-6:
            raise ValueError('Base command must reference the current observation')
        if any(s.frame_id != observation.frame_id or abs(s.sensor_timestamp_s-observation.timestamp_s)>1e-6 for s in observation.channels):
            raise ValueError('Safety sensors are stale or unsynchronized')
        if base.reverse or base.gear != 1 or base.handbrake or observation.ego.reverse or observation.ego.handbrake:
            self.reset(); self.status.update(status='FORWARD_ONLY', reason='Reverse, neutral or handbrake: forward supervisor unavailable')
            return None
        scene = assess_forward_space(observation, asset_reader, c,
            steering=base.steering if abs(base.steering)>=.05 else None,
            geometry=getattr(self,'geometry',None),forward_path=getattr(self,'forward_path',None),
            measured_space=getattr(self,'measured_space',None))
        crossing=(self.path_conflicts.assess(scene['lidar_surfaces'],observation,geometry=getattr(self,'geometry',None),
            forward_path=getattr(self,'forward_path',None),ground_plane=scene['lidar_ground_plane'])
            if self.anticipation_enabled else {'conflict':None,'coverage':{},'observations':[]})
        conflict=crossing['conflict']
        from .pedestrian_anticipation import crossing_forecast
        from .motion_geometry import VehicleGeometry
        pedestrian=(crossing_forecast(getattr(self,'control_prediction',None),observation,base,
            getattr(self,'geometry',None) or VehicleGeometry()) if self.anticipation_enabled else None)
        speed = observation.ego.speed_mps
        envelope = t.minimum_clearance_m + speed*t.reaction_time_s + speed*speed/(2*t.assumed_deceleration_mps2)
        distance = scene['target_range_m']
        # Only matched measured radar Doppler supplies relative motion/TTC.
        # LiDAR/depth motion is unknown, handled by the stationary-target envelope.
        closing = (scene['radar_closing_speed_mps'] if scene['radar_range_m'] is not None and distance is not None
                   and abs(scene['radar_range_m']-distance) <= 1. else None)
        ttc = distance/closing if distance is not None and closing is not None and closing >= c.minimum_closing_speed_mps else None
        road_range = scene['observed_road_range_m']
        clear = distance is None and road_range >= envelope
        release_clear = distance is None and road_range >= envelope+t.release_hysteresis_m
        hazard = distance is not None and (distance <= envelope or ttc is not None and ttc <= c.ttc_trigger_s)
        decision = None
        if scene['radar_range_m'] is not None and distance is not None:
            candidate = self.teacher.propose(scene['teacher_observation'], base, as_of_timestamp_s=as_of_timestamp_s)
            # The legacy nearest-32 filter can disagree with the full calibrated
            # scene (or retain a return beyond its usable range). Its missing-
            # target fallback is not a measured obstacle. Current fused space
            # already handles unknown coverage with a stopping speed/hold.
            if candidate.diagnostics['foreground_valid']:
                decision=candidate
                hazard = hazard or decision.action[0] > 0
            else:self.teacher.reset()
        coverage_limited = distance is None or distance > road_range
        unknown = coverage_limited and road_range < envelope
        target_speed = coverage_speed_limit(road_range, t)
        coverage_brake = (min(1., max(0., speed-target_speed)/t.assumed_deceleration_mps2)
                          if coverage_limited else 0.)
        # No usable stopping space calls for a hold. A shorter visible horizon
        # with usable space calls for a bounded speed, not an emergency brake.
        if coverage_limited and target_speed <= t.stopped_speed_mps:
            coverage_brake = t.additional_brake
        requested = hazard or conflict is not None or pedestrian is not None
        reason = decision.diagnostics['reason'] if decision and decision.action[0]>0 else ('Measured obstacle inside braking envelope/TTC limit' if hazard
            else 'Insufficient measured forward road coverage; missing targets are not clear space' if unknown else 'Observed forward stopping corridor is clear')
        if conflict:reason='Measured moving object approaches the driving path; object type unconfirmed'
        if pedestrian:reason='Braking for a person who may cross the driving path'
        now = observation.timestamp_s
        dt = .05 if self.previous_s is None else min(.15, max(0., now-self.previous_s))
        if self.previous_s is not None and now <= self.previous_s: raise ValueError('Safety observation did not advance')
        self.previous_s = now
        if requested:
            if self.brake <= 0 or self.started_s is None: self.started_s = now
            desired = t.additional_brake
        elif self.brake > 0 and self.started_s is not None and (now-self.started_s < c.minimum_brake_hold_s or
                              distance is not None and (distance <= t.minimum_clearance_m+t.release_hysteresis_m or
                                                        ttc is not None and ttc < c.ttc_release_s)):
            desired = t.additional_brake; reason = 'Holding measured clearance/TTC hysteresis'
        else:
            desired = max(coverage_brake, self.brake-c.brake_release_rate_per_s*dt, 0.)
            if decision is None: self.teacher.reset()
            if desired: reason = 'Risk cleared; releasing brake smoothly to base driver'
        self.brake = desired
        was_active = self.active
        proposed = None
        throttle = (min(base.throttle, max(0., (target_speed-speed)*.28))
                    if coverage_limited else base.throttle)
        if not requested and not (desired > coverage_brake):
            if coverage_brake:
                reason = f'Braking toward measured coverage speed limit {target_speed:.2f} m/s'
            elif throttle < base.throttle:
                reason = f'Limiting acceleration to stop within {road_range:.2f} m of measured road'
        if desired > base.brake or desired > 0 and base.throttle > 0 or throttle < base.throttle:
            command = replace(base, source=CommandSource.SAFETY,
                              throttle=0. if max(base.brake, desired) > 0 else throttle,
                              brake=max(base.brake, desired))
            proposal = ProposedSafetyAction(command, c.version, observation.frame_id, observation.timestamp_s, True, reason)
            evidence = self.validator.validate((observation,), base, proposal)
            admitted = admit_proposal(observation, base, proposal, evidence)
            if not admitted.accepted: raise ValueError('Safety feasibility rejected: ' + admitted.reason)
            proposed = admitted.command
        self.active = proposed is not None
        self.last_fault = None
        if self.active and not was_active: self.interventions += 1
        self.status.update(status='BRAKING' if self.active and requested else 'COVERAGE_LIMITED' if self.active and desired <= coverage_brake else 'RELEASING' if self.active else 'MONITORING',
            type='RULE_BASED_SAFETY' if self.anticipation_enabled else 'REACTIVE_SENSOR_SAFETY',
            actual_generator=('RULE' if self.anticipation_enabled else 'REACTIVE_SENSORS') if self.active else 'BASE_DRIVER',
            motion_prediction_used=self.anticipation_enabled, learned_control_used=False,
            reactive_risk='FORWARD_COLLISION_RISK' if hazard else 'UNKNOWN_SPACE' if unknown else 'FORWARD_CLEAR_SIDE_REAR_UNVERIFIED',
            risk='POSSIBLE_PEDESTRIAN_CROSSING' if pedestrian else 'PATH_CONFLICT' if conflict else 'FORWARD_COLLISION_RISK' if hazard else 'UNKNOWN_SPACE' if unknown else 'FORWARD_CLEAR_SIDE_REAR_UNVERIFIED',
            active=self.active, reason=reason, frame_id=observation.frame_id, timestamp_s=now,
            stopping_envelope_m=envelope, release_envelope_m=envelope+t.release_hysteresis_m,
            forward_release_clear=release_clear, coverage_speed_limit_mps=target_speed,
            measured_range_m=distance, closing_speed_mps=closing, ttc_s=ttc,
            observed_road_range_m=scene['observed_road_range_m'], target_source=scene['target_source'],
            teacher_state=self.teacher.state.value, ground_plane_supported=scene['ground_plane_supported'],
            feasibility_validator='YA_RAB_OSTORHA_RUNTIME_BRAKING_V1' if proposed else None,
            depth_observed=scene['depth_observed'], lidar_observed=scene['lidar_observed'],
            base_driver_brake=base.brake, base_command=to_dict(base), proposed_safety_brake=desired,
            path_conflict=conflict,pedestrian_prediction=pedestrian,side_rear_coverage=crossing['coverage'],
            side_rear_observations=crossing['observations'],
            side_rear_free_space_verified=False)
        return proposed
