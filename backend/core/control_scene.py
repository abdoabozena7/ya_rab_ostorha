"""Versioned sensor-only control scene, published at synchronized sensor cadence.

The sensor owner alone updates tracking. Expensive occupancy is constructed only
when a candidate requires it. Semantic/model results are supplementary evidence;
their absence cannot turn unobserved space into free space.
"""
from dataclasses import dataclass, replace
import time
import threading
import numpy as np
from .active_safety import _mount
from .contracts import CommandSource, ControlCommand, SensorKind, freeze_json, to_dict
from .motion_geometry import VehicleGeometry
from .prediction import PredictionEngine
from .safety_policy import SensorObservation
from collections import deque
from .control_semantics import SemanticAssociator


class MeasuredSpace:
    """Lazy map from immutable calibrated measurements, with their original age."""
    def __init__(self, points, geometry, observation, depth_assets):
        self.points, self.geometry, self.observation = points, geometry, observation
        self.depth_assets = depth_assets
        self._map = None
        self._lock = threading.Lock()

    def certificate(self, path):
        from .maneuver import ObservedSpace
        from .recovery_depth import depth_surfaces
        with self._lock:
            if self._map is None:
                sources = depth_surfaces(self.observation, lambda a: self.depth_assets[a.path])
                speed=self.observation.ego.speed_mps
                scope=max(6.,self.geometry.front_m+speed*.45+speed**2/6.+3.)
                self._map = ObservedSpace(self.points, self.geometry, measured_surfaces=sources,scope_m=scope)
        return {**self._map.certificate(path), 'measurement_frame': self.observation.frame_id,
                'measurement_timestamp_s': self.observation.timestamp_s}

    def continuous_coverage(self,path):
        self.certificate(np.asarray(path)[:1])
        return self._map.continuous_coverage(path)


@dataclass(frozen=True)
class ControlScene:
    version: int
    session_id: str
    observation: SensorObservation
    geometry: VehicleGeometry
    points: np.ndarray
    prediction: object
    space: MeasuredSpace
    received_wall_s: float
    published_wall_s: float
    build_ms: float
    semantic_coverage: object

    def usable(self, timestamp_s, wall_s, *, max_sim_age_s=.1, max_wall_age_s=.25):
        return (0 <= timestamp_s-self.observation.timestamp_s <= max_sim_age_s+1e-6
                and 0 <= wall_s-self.received_wall_s <= max_wall_age_s)

    def legacy_scene(self):
        return self.observation, self.points, to_dict(self.prediction), self.space

    def snapshot(self, timestamp_s, wall_s):
        return {'version': self.version, 'session_id': self.session_id,
                'source_frame': self.observation.frame_id,
                'measurement_timestamp_s': self.observation.timestamp_s,
                'simulation_age_s': timestamp_s-self.observation.timestamp_s,
                'wall_age_s': wall_s-self.received_wall_s,
                'usable': self.usable(timestamp_s, wall_s), 'build_ms': self.build_ms,
                'track_count': len(self.prediction['tracks']),
                'coordinate_frame': 'EGO_AT_MEASUREMENT_X_FORWARD_Y_RIGHT_Z_UP',
                'space_states': ['FREE', 'OCCUPIED', 'UNKNOWN'],
                'occlusion_policy': 'UNOBSERVED_CELLS_UNKNOWN',
                'drivable_boundaries': 'NOT_YET_ADMITTED',
                'semantic_coverage': to_dict(self.semantic_coverage)}


class ControlSceneBuilder:
    def __init__(self, session_id, geometry=None):
        self.session_id = session_id
        self.geometry = geometry or VehicleGeometry()
        self.engine = PredictionEngine(session_id, enhanced=True, geometry=self.geometry)
        self.last_frame = -1
        self.poses=deque(maxlen=80);self.semantics=SemanticAssociator()

    def build(self, observation, asset_reader, *, received_wall_s, semantic_result=None):
        began = time.perf_counter()
        if not isinstance(observation, SensorObservation):
            raise ValueError('ControlScene accepts sensor observations only')
        if observation.frame_id <= self.last_frame:
            raise ValueError('ControlScene frames must advance')
        if any(c.frame_id != observation.frame_id or
               abs(c.sensor_timestamp_s-observation.timestamp_s) > 1e-6 for c in observation.channels):
            raise ValueError('ControlScene requires synchronized measurements')
        lidar = next(c for c in observation.channels if c.kind == SensorKind.LIDAR)
        position, angles = _mount(lidar)
        if np.any(np.abs(angles) > 1e-4):
            raise ValueError('Control LiDAR must have a calibrated level mount')
        samples = np.frombuffer(asset_reader(lidar.asset), dtype='<f4')
        if samples.size % 4 or not np.isfinite(samples).all():
            raise ValueError('Invalid control LiDAR samples')
        points = samples.reshape(-1, 4)[:, :3] + position
        points.flags.writeable = False
        ego = observation.ego
        base = ControlCommand(observation.frame_id, observation.timestamp_s,
                              ego.throttle, ego.brake, ego.steering, ego.reverse,
                              ego.handbrake, CommandSource.SYSTEM, ego.gear)
        prediction = self.engine.evaluate(points, observation, base)
        self.poses.append((observation.timestamp_s,*prediction['odometry_origin_m'],prediction['odometry_yaw_rad']))
        semantics=self.semantics.apply(prediction,observation,self.poses,semantic_result)
        from .kinematic_prediction import kinematic_modes
        prediction['trajectories']=kinematic_modes(prediction['tracks'])
        published = time.monotonic()
        prediction.update(published_wall_s=received_wall_s, publication_wall_s=published,
                          control_trajectories=prediction['trajectories'],
                          scene_version=1, source='CONTROL_SENSOR_PIPELINE')
        assets = {c.asset.path: asset_reader(c.asset) for c in observation.channels
                  if c.kind == SensorKind.DEPTH and c.asset}
        coverage = {'front': 'GEOMETRY_ONLY', 'left': 'GEOMETRY_ONLY',
                    'right': 'GEOMETRY_ONLY', 'rear': 'GEOMETRY_ONLY',
                    'classified': False, 'segmentation_admitted': False,
                    'depth_sensor_ids': [c.sensor_id for c in observation.channels if c.kind == SensorKind.DEPTH]}
        coverage.update(semantics)
        self.last_frame = observation.frame_id
        return ControlScene(1, self.session_id, observation, self.geometry, points,
                            freeze_json(prediction), MeasuredSpace(points, self.geometry, observation, assets),
                            received_wall_s, published, (time.perf_counter()-began)*1000,
                            freeze_json(coverage))
