"""Sensor-local measured-point projection; no native world interface."""
import math
import numpy as np


def mount_rotation(angles):
    r,p,y=[math.radians(float(angles.get(k,0))) for k in ('roll','pitch','yaw')]
    cr,sr,cp,sp,cy,sy=math.cos(r),math.sin(r),math.cos(p),math.sin(p),math.cos(y),math.sin(y)
    return np.array([[cp*cy,cy*sp*sr-sy*cr,-cy*sp*cr-sy*sr],
        [cp*sy,sy*sp*sr+cy*cr,-sy*sp*cr+cy*sr],[sp,-cp*sr,cp*cr]])


def project(point, calibration):
    mount=calibration['mount_transform']; xyz=np.array([*point[:2],1.])
    local=mount_rotation(mount['rotation_deg']).T@(xyz-np.asarray(mount['position_m']))
    if local[0]<=.05: return None
    w,h=calibration['width'],calibration['height']; focal=w/(2*math.tan(math.radians(calibration['fov_deg'])/2))
    return [(w-1)/2+focal*local[1]/local[0],(h-1)/2-focal*local[2]/local[0]]
