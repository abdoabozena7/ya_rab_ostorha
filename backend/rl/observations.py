"""Fixed-size projections of the audited sensor-only boundary.

Only SensorObservation and an asset reader enter this module. Scenario geometry,
reward context and SimulationFrame cannot be passed into observation assembly.
"""
import base64
from collections import deque
from dataclasses import dataclass
import io
import numpy as np
from PIL import Image
from gymnasium import spaces
from ..core.contracts import SensorKind
from ..core.safety_policy import SensorObservation
from .radar import validate_radar_calibration
from .radar_retention import retain_detections


@dataclass(frozen=True)
class ObservationConfig:
    name: str
    history: int = 4
    radar_points: int = 32
    width: int = 0
    height: int = 0
    lidar_points: int = 0


CONFIGS = {
    'lightweight': ObservationConfig('lightweight'),
    'multimodal': ObservationConfig('multimodal', width=160, height=90, lidar_points=512),
    'evaluation': ObservationConfig('evaluation', width=320, height=180, lidar_points=2048),
}


def observation_space(config):
    h, n = config.history, config.radar_points
    fields = {
        'ego': spaces.Box(np.tile([0., -100., -100., -100.], (h,1)).astype(np.float32),
                          np.full((h,4),100.,np.float32)),
        'imu': spaces.Box(-1000., 1000., (h, 6), np.float32),
        'previous_action': spaces.Box(np.tile([-1., 0., 0.], (h, 1)).astype(np.float32),
                                    np.ones((h, 3), np.float32)),
        'radar': spaces.Box(np.broadcast_to(np.array([0., -np.pi, -np.pi/2, -100.], np.float32), (h,n,4)).copy(),
                            np.broadcast_to(np.array([100., np.pi, np.pi/2, 100.], np.float32), (h,n,4)).copy()),
        'radar_valid': spaces.MultiBinary((h,n)),
        'history_valid': spaces.MultiBinary(h),
        'frame_time': spaces.Box(0., np.finfo(np.float64).max, (h,2), np.float64),
    }
    if config.width:
        fields.update(rgb=spaces.Box(0,255,(h,config.height,config.width,3),np.uint8),
                      depth=spaces.Box(0.,1000.,(h,config.height,config.width),np.float32),
                      lidar=spaces.Box(np.tile([-100.,-100.,-100.,0.], (h,config.lidar_points,1)).astype(np.float32),
                                       np.tile([100.,100.,100.,1.], (h,config.lidar_points,1)).astype(np.float32)),
                      lidar_valid=spaces.MultiBinary((h,config.lidar_points)))
    return spaces.Dict(fields)


class ObservationAssembler:
    def __init__(self, config, asset_reader):
        self.config, self.asset_reader = config, asset_reader
        self.space = observation_space(config)
        self.history = deque(maxlen=config.history)

    def clear(self):
        self.history.clear()

    def append(self, observation, previous_action):
        if not isinstance(observation, SensorObservation):
            raise ValueError('Assembly accepts only the sensor-only observation contract')
        if self.history and (observation.frame_id <= self.history[-1]['frame_time'][0] or
                             observation.timestamp_s <= self.history[-1]['frame_time'][1]):
            raise ValueError('Observation did not advance')
        if self.history and observation.timestamp_s-self.history[-1]['frame_time'][1] > .15:
            self.history.clear()
        channels = {c.kind:c for c in observation.channels}
        if any(abs(c.sensor_timestamp_s-observation.timestamp_s)>1e-6 for c in observation.channels):
            raise ValueError('Stale sensor timestamp')
        validate_radar_calibration(channels[SensorKind.RADAR].calibration)
        imu = channels[SensorKind.IMU].data
        row = {
            'ego':np.clip([observation.ego.speed_mps,*observation.ego.angular_velocity_radps], [0,-100,-100,-100],100).astype(np.float32),
            'imu':np.clip([*imu['accelerometer_mps2'],*imu['gyroscope_radps']],-1000,1000).astype(np.float32),
            'previous_action':np.asarray(previous_action,np.float32),
            'radar':np.zeros((self.config.radar_points,4),np.float32),
            'radar_valid':np.zeros(self.config.radar_points,np.int8),
            'history_valid':np.array(1,np.int8),
            'frame_time':np.array([observation.frame_id,observation.timestamp_s],np.float64),
        }
        detections = retain_detections(channels[SensorKind.RADAR].data['detections'], self.config.radar_points)
        for i,d in enumerate(detections):
            row['radar'][i] = np.clip([d['depth_m'],d['azimuth_rad'],d['altitude_rad'],d['velocity_mps']],
                                      [0,-np.pi,-np.pi/2,-100],[100,np.pi,np.pi/2,100])
            row['radar_valid'][i] = 1
        if self.config.width:
            size=(self.config.width,self.config.height)
            row['rgb']=np.asarray(Image.open(io.BytesIO(self.asset_reader(channels[SensorKind.RGB].asset))).convert('RGB').resize(size),np.uint8)
            depth=np.load(io.BytesIO(self.asset_reader(channels[SensorKind.DEPTH].asset)),allow_pickle=False)
            row['depth']=np.clip(np.asarray(Image.fromarray(depth).resize(size,Image.Resampling.NEAREST)),0,1000).astype(np.float32)
            points=np.frombuffer(self.asset_reader(channels[SensorKind.LIDAR].asset),dtype='<f4').reshape(-1,4)
            # Uniform deterministic subsampling retains coverage; no actor labels.
            points=points[np.linspace(0,len(points)-1,min(len(points),self.config.lidar_points),dtype=int)] if len(points) else points
            row['lidar']=np.zeros((self.config.lidar_points,4),np.float32)
            row['lidar_valid']=np.zeros(self.config.lidar_points,np.int8)
            row['lidar'][:len(points)]=np.clip(points,[-100,-100,-100,0],[100,100,100,1])
            row['lidar_valid'][:len(points)]=1
        if any(not np.isfinite(a).all() for a in row.values()):
            raise ValueError('Nonfinite native observation')
        self.history.append(row)
        result={k:np.zeros(s.shape,s.dtype) for k,s in self.space.spaces.items()}
        for i,item in enumerate(self.history,start=self.config.history-len(self.history)):
            for k,v in item.items(): result[k][i]=v
        if not self.space.contains(result):
            raise ValueError('Observation violates declared space')
        return result


def pack_observation(observation):
    return {k:{'dtype':a.dtype.str,'shape':list(a.shape),
               'bytes':base64.b64encode(a.tobytes()).decode('ascii')} for k,a in observation.items()}


def unpack_observation(payload, space):
    if set(payload)!=set(space.spaces):raise ValueError('Undeclared observation fields')
    result={}
    for k,item in payload.items():
        target=space[k]
        if item['shape']!=list(target.shape) or np.dtype(item['dtype'])!=target.dtype:
            raise ValueError('Observation transport shape/dtype mismatch')
        result[k]=np.frombuffer(base64.b64decode(item['bytes'],validate=True),target.dtype).reshape(target.shape).copy()
    if not space.contains(result):raise ValueError('Invalid transported observation')
    return result
