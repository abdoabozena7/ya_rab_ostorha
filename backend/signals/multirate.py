"""CARLA 0.9.16 post-physics sensors receive world dt, not sparse sample dt."""
from collections import deque
import math
import numpy as np


class SensorWarmup(ValueError):
    pass


def position(transform):
    p=transform.location
    value=np.array([p.x,p.y,p.z],dtype=float)
    if not np.isfinite(value).all():
        raise ValueError('Invalid onboard sensor position')
    return value


def local_vector(transform, vector):
    matrix=np.asarray(transform.get_inverse_matrix(),dtype=float)
    if matrix.shape!=(4,4) or not np.isfinite(matrix).all():
        raise ValueError('Invalid onboard sensor orientation')
    return matrix[:3,:3]@vector


class SparseSensorTiming:
    def __init__(self,physics_delta,period=.05):
        if not 0<physics_delta<=period:
            raise ValueError('Invalid sparse sensor timing')
        self.physics_delta,self.period=physics_delta,period
        self.radar_history={}
        self.imu_history={}

    def interval_steps(self,elapsed):
        if not math.isfinite(elapsed) or elapsed<=0:
            raise ValueError('Sparse sensor sample interval must advance')
        steps=round(elapsed/self.physics_delta)
        nominal=round(self.period/self.physics_delta)
        if abs(elapsed-steps*self.physics_delta)>1e-5 or not nominal-1<=steps<=nominal+1:
            raise ValueError('Sparse sensor interval indicates a missing or invalid sample')
        return steps

    def seed_radar(self,name,snapshot,transform):
        self.radar_history[name]=(snapshot.frame,snapshot.timestamp.elapsed_seconds,position(transform),True)

    def radar(self,name,native,detections):
        previous=self.radar_history.get(name)
        current=(native.frame,native.timestamp,position(native.transform),False)
        if previous is not None and native.frame<=previous[0]:
            raise ValueError('Radar frames must advance for timestep compensation')
        self.radar_history[name]=current
        if previous is None:
            raise SensorWarmup('Radar timestep compensation needs its previous onboard pose')
        elapsed=native.timestamp-previous[1]
        if elapsed<=0:
            raise ValueError('Radar sample interval must advance')
        steps=round(elapsed/self.physics_delta) if previous[3] else self.interval_steps(elapsed)
        correction=local_vector(native.transform,
            (current[2]-previous[2])*(1/self.physics_delta-1/elapsed))
        corrected=[]
        for row in detections:
            azimuth,altitude=row['azimuth_rad'],row['altitude_rad']
            direction=np.array([math.cos(altitude)*math.cos(azimuth),
                math.cos(altitude)*math.sin(azimuth),math.sin(altitude)])
            corrected.append({**row,'velocity_mps':row['velocity_mps']+float(correction@direction)})
        return corrected,{'rate_compensation':'CARLA_0916_POST_PHYSICS_DT',
            'sample_interval_s':elapsed,'sample_stride':steps,'native_physics_delta_s':self.physics_delta,
            'native_doppler_mps':[row['velocity_mps'] for row in detections],
            'ego_doppler_correction_mps':correction.tolist()}

    def imu(self,name,native):
        history=self.imu_history.setdefault(name,deque(maxlen=3))
        if history and native.frame<=history[-1][0]:
            raise ValueError('IMU frames must advance for timestep compensation')
        history.append((native.frame,native.timestamp,position(native.transform)))
        if len(history)<3:
            raise SensorWarmup('IMU acceleration requires three actual 20 Hz onboard pose samples')
        a,b,c=history
        h1,h2=c[1]-b[1],b[1]-a[1]
        steps=self.interval_steps(h1)
        self.interval_steps(h2)
        acceleration=-2*(b[2]/(h1*h2)-a[2]/(h2*(h1+h2))-c[2]/(h1*(h1+h2)))
        # Official CARLA 0.9.16 game-mode IMU gravity; this profile uses zero
        # accelerometer noise, matching the existing native rig defaults.
        acceleration+=np.array([0.,0.,9.81])
        return local_vector(native.transform,acceleration).tolist(),{
            'rate_compensation':'CARLA_0916_POST_PHYSICS_DT',
            'sample_interval_s':h1,'sample_stride':steps,'native_physics_delta_s':self.physics_delta,
            'native_accelerometer_mps2':[native.accelerometer.x,native.accelerometer.y,native.accelerometer.z],
            'gravity_mps2':9.81}
