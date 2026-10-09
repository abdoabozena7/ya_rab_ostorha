"""Versioned 13-value onboard/radar projection. Gym/SAC's 47 values are unchanged.

speed /15 m/s; longitudinal IMU /20 m/s²; yaw rate /2 rad/s;
previous applied steer/throttle/brake; measured foreground range /50 m,
radial velocity /20 m/s, TTC /10 s, foreground mask; proposed base controls.
Clipped to [-1,1]. Missing range is masked, never evidence of clear space.
Absolute times are freshness checks, not neural inputs. No teacher state/GT.
"""
import numpy as np
from ..core.contracts import ControlCommand, SensorKind
from ..core.safety_policy import SensorObservation
from ..rl.radar import foreground_return, validate_radar_calibration
from ..rl.radar_retention import retain_detections

VERSION = 'YA_RAB_OSTORHA_BC_SENSOR13_V1'
DIM = 13
DECISIONS = ('NO_INTERVENTION', 'BRAKE_INTERVENTION', 'RELEASE_TO_BASE_DRIVER')


def features(observation, base, previous_action):
    if not isinstance(observation, SensorObservation) or not isinstance(base, ControlCommand):
        raise ValueError('Learned inputs require sensor-only observation and proposed control')
    if base.frame_id != observation.frame_id or abs(base.timestamp_s-observation.timestamp_s)>1e-6:
        raise ValueError('Misaligned base control')
    if any(c.frame_id!=observation.frame_id or abs(c.sensor_timestamp_s-observation.timestamp_s)>1e-6 for c in observation.channels):
        raise ValueError('Unsynchronized learned input')
    channels = {c.kind:c for c in observation.channels}
    radar = channels[SensorKind.RADAR]
    validate_radar_calibration(radar.calibration)
    points = np.asarray([[d[k] for k in ('depth_m','azimuth_rad','altitude_rad','velocity_mps')]
                         for d in retain_detections(radar.data['detections'],32)],np.float32).reshape(-1,4)
    p = foreground_return(points)
    distance, velocity = (float(p[0]),float(p[3])) if p is not None else (50.,0.)
    previous = np.asarray(previous_action,float)
    if previous.shape!=(3,) or not np.isfinite(previous).all(): raise ValueError('Invalid previous action')
    row = [observation.ego.speed_mps/15., channels[SensorKind.IMU].data['accelerometer_mps2'][0]/20.,
        observation.ego.angular_velocity_radps[2]/2., *previous, distance/50., velocity/20.,
        min(10.,distance/max(.1,-velocity))/10., float(p is not None), base.steering,base.throttle,base.brake]
    result = np.clip(np.asarray(row,np.float32),-1,1)
    if result.shape!=(DIM,) or not np.isfinite(result).all(): raise ValueError('Nonfinite learned inputs')
    return result
