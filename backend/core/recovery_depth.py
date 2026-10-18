"""Project synchronized native axial depth using each actual sensor mount."""
import io
import math
import numpy as np
from .active_safety import _mount
from .contracts import SensorKind


def depth_surfaces(observation, asset_reader, *, decoded=None):
    sources=[]
    for channel in observation.channels:
        if channel.kind!=SensorKind.DEPTH:continue
        if channel.frame_id!=observation.frame_id or abs(channel.timestamp_s-observation.timestamp_s)>1e-6:
            raise ValueError('Recovery depth frame differs from synchronized observation')
        values=np.load(io.BytesIO(asset_reader(channel.asset)),allow_pickle=False)
        if decoded is not None:
            values.flags.writeable=False
            decoded[channel.asset.path]=values
        h,w=values.shape
        if (channel.calibration.get('width'),channel.calibration.get('height'))!=(w,h) or not np.isfinite(values).all() or np.any(values<0):
            raise ValueError('Invalid calibrated recovery depth')
        focal=w/(2*math.tan(math.radians(channel.calibration['fov_deg'])/2))
        vv,uu=np.mgrid[0:h:2,0:w:2]
        rays=np.stack((np.ones(uu.shape),(uu-(w-1)/2)/focal,-(vv-(h-1)/2)/focal),axis=-1)
        position,angles=_mount(channel)
        roll,pitch,yaw=np.radians(angles)
        cr,sr,cp,sp,cy,sy=math.cos(roll),math.sin(roll),math.cos(pitch),math.sin(pitch),math.cos(yaw),math.sin(yaw)
        # CARLA x-forward, y-right, z-up mount rotation.
        rotation=np.array([[cp*cy,cy*sp*sr-sy*cr,-cy*sp*cr-sy*sr],
            [cp*sy,sy*sp*sr+cy*cr,-sy*sp*cr+cy*sr],[sp,-cp*sr,cp*cr]])
        xyz=np.einsum('ij,kj->ki',rotation,(rays*values[vv,uu,None]).reshape(-1,3))+position
        sources.append((xyz,position))
    return sources
