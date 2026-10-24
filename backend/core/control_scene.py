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
from collections import OrderedDict
from .control_semantics import SemanticAssociator
from .measured_rows import unique_row_indices
from .host_clock import monotonic


class MeasuredSpace:
    """Lazy map from immutable calibrated measurements, with their original age."""
    def __init__(self, points, geometry, observation, depth_assets, *, measured_surfaces=None, depth_images=None, visual_points=None):
        self.points, self.geometry, self.observation = points, geometry, observation
        self.depth_assets = depth_assets
        self.measured_surfaces=measured_surfaces
        self.depth_images=depth_images or {}
        # Read-only measured support for presentation after command application.
        # Constructing display boxes cannot consume the control freshness lease.
        self.visual_points=points if visual_points is None else visual_points
        self._map = None
        self._lock = threading.Lock()
        self.build_ms = None
        self.queries = 0
        self.execution_proofs=OrderedDict();self.proof_lock=threading.Lock();self.proof_cache_hits=0
        self.forward_assessments={}
        self.urban_forecasts=OrderedDict()
        self.requested_scope_m = 0.

    def ensure_scope(self, path):
        """Expand ray processing, never measured support or measurement age."""
        path = np.asarray(path, float)
        if path.ndim != 2 or path.shape[1] != 4 or not np.isfinite(path).all():
            raise ValueError('Measured-space scope requires a finite physical path')
        radius = float(np.max(np.abs(path[:, 1:3]))) + max(self.geometry.front_m, self.geometry.rear_m) + 1.
        if radius > 95.:
            raise ValueError('Complete maneuver exceeds measured-space processing range')
        with self._lock:
            if radius > self.requested_scope_m:
                self.requested_scope_m = radius
                if self._map is not None and radius > self._map.scope_m:
                    self._map = None
                    with self.proof_lock:
                        self.execution_proofs.clear()

    def get_execution_proof(self,key):
        with self.proof_lock:
            proof=self.execution_proofs.get(key)
            if proof is not None:self.proof_cache_hits+=1
            return proof

    def put_execution_proof(self,key,proof):
        with self.proof_lock:
            self.execution_proofs[key]=freeze_json(proof)
            while len(self.execution_proofs)>32:self.execution_proofs.popitem(last=False)

    def certificate(self, path):
        from .maneuver import ObservedSpace
        from .recovery_depth import depth_surfaces
        with self._lock:
            if self._map is None:
                began = time.perf_counter()
                sources = self.measured_surfaces if self.measured_surfaces is not None else depth_surfaces(self.observation, lambda a: self.depth_assets[a.path])
                speed=self.observation.ego.speed_mps
                scope=max(6.,self.geometry.front_m+speed*.45+speed**2/6.+3.,self.requested_scope_m)
                self._map = ObservedSpace(self.points, self.geometry, measured_surfaces=sources,scope_m=scope,
                    limit_m=min(100.,scope+self.geometry.front_m+2.))
                self.build_ms = (time.perf_counter()-began)*1000
        self.queries += 1
        return {**self._map.certificate(path), 'measurement_frame': self.observation.frame_id,
                'measurement_timestamp_s': self.observation.timestamp_s}

    def continuous_coverage(self,path):
        self.certificate(np.asarray(path)[:1])
        return self._map.continuous_coverage(path)

    @property
    def ground_plane(self):
        # Forward coverage constructs this map before the crossing tracker
        # runs. Reuse its measured calibration instead of fitting a second plane.
        if self._map is None:
            raise ValueError('Ground calibration requires measured space first')
        return self._map.ground_plane


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
    timings_ms: object = None

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
                'space_build_ms': self.space.build_ms, 'space_queries': self.space.queries,
                'proof_cache_hits':self.space.proof_cache_hits,
                'track_count': len(self.prediction['tracks']),
                'radar_velocity_tracks':self.prediction.get('radar_velocity_tracks',0),
                'radar_velocity_observability':to_dict(self.prediction.get('radar_velocity_observability',{})),
                'timings_ms': to_dict(self.timings_ms),
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
        from .depth_people import DepthPeople
        self.depth_people=DepthPeople()
        from .control_radar import RadarVelocityFusion
        self.radar_velocity=RadarVelocityFusion()

    def build(self, observation, asset_reader, *, received_wall_s, semantic_result=None, track_motion=True):
        began = time.perf_counter()
        began_wall=monotonic()
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
        lidar_ready=time.perf_counter()
        assets = {c.asset.path: asset_reader(c.asset) for c in observation.channels
                  if c.kind == SensorKind.DEPTH and c.asset}
        from .recovery_depth import depth_surfaces
        depth_images={}
        sources=depth_surfaces(observation,lambda a:assets[a.path],decoded=depth_images)
        if not track_motion:
            # RULE consumes current calibrated geometry, not the hybrid motion
            # forecasts. Display tracking runs in its own observer thread.
            self.last_frame=observation.frame_id
            published=monotonic();finished=time.perf_counter()
            prediction=freeze_json({'tracks':[],'trajectories':[], 'motion_tracking_complete':False,
                'timestamp_s':observation.timestamp_s, 'frame_id':observation.frame_id,
                'source':'RULE_GEOMETRY_ONLY'})
            timing=freeze_json({'input_wait_before_build':(began_wall-received_wall_s)*1000,
                'lidar_decode':(lidar_ready-began)*1000,
                'depth_decode_and_fusion':(finished-lidar_ready)*1000, 'tracking_and_forecasts':0.})
            return ControlScene(1,self.session_id,observation,self.geometry,points,prediction,
                MeasuredSpace(points,self.geometry,observation,assets,measured_surfaces=sources,depth_images=depth_images),
                received_wall_s,published,(finished-began)*1000,
                freeze_json({'motion_tracking':'DISPLAY_OBSERVER_ONLY','classified':False}),timing)
        # Tracking and space use the same synchronized surround measurements.
        # Sparse LiDAR alone repeatedly split parked bodies between rotations.
        # Voxel sampling bounds cost while preserving original sensor evidence.
        measured=[points]
        front=max(45.,min(90.,abs(observation.ego.speed_mps)*.35+observation.ego.speed_mps**2/10.+10.))
        for xyz,_ in sources:
            valid=xyz[(xyz[:,0]>-40.)&(xyz[:,0]<front)&(np.abs(xyz[:,1])<15.)&
                      (xyz[:,2]>-.6)&(xyz[:,2]<3.)]
            if len(valid):
                indices=unique_row_indices(np.floor(valid/.2).astype(int))
                measured.append(valid[indices])
        tracking_points=np.concatenate(measured)
        tracking_points.flags.writeable=False
        depth_ready=time.perf_counter()
        ego = observation.ego
        base = ControlCommand(observation.frame_id, observation.timestamp_s,
                              ego.throttle, ego.brake, ego.steering, ego.reverse,
                              ego.handbrake, CommandSource.SYSTEM, ego.gear)
        prediction = self.engine.evaluate(tracking_points, observation, base, control_only=True)
        tracked=time.perf_counter()
        self.poses.append((observation.timestamp_s,*prediction['odometry_origin_m'],prediction['odometry_yaw_rad'],observation.frame_id))
        radar_tracks=0
        if any(c.kind==SensorKind.RADAR and c.sensor_id!='radar' for c in observation.channels):
            radar_tracks=self.radar_velocity.apply(prediction,observation,self.poses,self.engine.tracker)
        prediction['radar_velocity_tracks']=radar_tracks
        prediction['radar_velocity_observability']={
            'full':sum(t.get('doppler_evidence',{}).get('observable_rank')==2 for t in prediction['tracks']),
            'partial':sum(t.get('doppler_evidence',{}).get('observable_rank')==1 for t in prediction['tracks'])}
        semantics=self.semantics.apply(prediction,observation,self.poses,semantic_result)
        people=self.depth_people.update(prediction,observation,self.poses,semantic_result,depth_images,geometry=self.geometry)
        for track in prediction['tracks']:
            if track.get('class')=='person' and any(np.linalg.norm(np.asarray(track['position_m'])-person['position_m'])<1.5 for person in people):
                # One physical person must not also be an independent merged
                # curb/surface hypothesis with a different crossing history.
                track['class']='UNKNOWN';track.pop('semantic_evidence',None)
        prediction['tracks'].extend(people)
        classified=sum(t.get('class','UNKNOWN')!='UNKNOWN' for t in prediction['tracks'])
        semantics.update(front='PARTIAL_CLASSIFIED' if classified else 'GEOMETRY_ONLY',
            classified=bool(classified),classified_tracks=classified)
        for track in prediction['tracks']:
            prior_evidence=track.get('measurement_evidence',{})
            track['measurement_evidence']={**prior_evidence,'frame_id':observation.frame_id,'timestamp_s':observation.timestamp_s,
                'session_id':self.session_id,'coordinate_frame':'EGO_AT_EVALUATION',
                'sensor_ids':prior_evidence.get('sensor_ids',[c.sensor_id for c in observation.channels if c.kind in (SensorKind.LIDAR,SensorKind.DEPTH)]),
                'support_points':prior_evidence.get('support_points',track.get('support_points')), 'occlusion_s':track.get('occlusion_s'),
                'motion_observations':track.get('motion_observations')}
        from .kinematic_prediction import kinematic_modes
        # Include a complete command lease, reaction and braking tail, even at
        # 50 km/h. The display's historical three-second window is not a limit
        # on the physical hypotheses used to authorize movement.
        horizon=max(3.,.1+.35+(abs(ego.speed_mps)+.25)/3.+.15)
        grid=np.round(np.arange(int(np.ceil(horizon/.1))+1)*.1,6)
        prediction['trajectories']=kinematic_modes(prediction['tracks'],grid=grid,frozen_points=True)
        prediction['horizon_s']=float(grid[-1])
        prediction.update(published_wall_s=received_wall_s, publication_wall_s=monotonic(),
                          motion_tracking_complete=True,
                          control_trajectories=prediction['trajectories'],
                          scene_version=1, source='CONTROL_SENSOR_PIPELINE')
        coverage = {'front': 'GEOMETRY_ONLY', 'left': 'GEOMETRY_ONLY',
                    'right': 'GEOMETRY_ONLY', 'rear': 'GEOMETRY_ONLY',
                    'classified': False, 'segmentation_admitted': False,
                    'depth_sensor_ids': [c.sensor_id for c in observation.channels if c.kind == SensorKind.DEPTH]}
        coverage.update(semantics)
        self.last_frame = observation.frame_id
        frozen_prediction=freeze_json(prediction);frozen_coverage=freeze_json(coverage)
        published=monotonic();finished=time.perf_counter()
        timing={'input_wait_before_build':(began_wall-received_wall_s)*1000,
                'lidar_decode':(lidar_ready-began)*1000,'depth_decode_and_fusion':(depth_ready-lidar_ready)*1000,
                'tracking_and_forecasts':(tracked-depth_ready)*1000,'semantics_and_freezing':(finished-tracked)*1000}
        return ControlScene(1, self.session_id, observation, self.geometry, points,
                            frozen_prediction, MeasuredSpace(points, self.geometry, observation, assets,measured_surfaces=sources,depth_images=depth_images,visual_points=tracking_points),
                            received_wall_s, published, (finished-began)*1000,
                            frozen_coverage,freeze_json(timing))
