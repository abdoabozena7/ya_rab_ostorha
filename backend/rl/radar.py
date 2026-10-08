"""Experimental radar feature screening; no actor/world/reward dependencies.

The mount is calibrated by the native sensor suite. A bounded consensus fit
uses measured low returns to compensate road/body pitch relative to that mount.
This is not semantic classification; missing foreground is not free space.
"""
from dataclasses import dataclass
import numpy as np


@dataclass(frozen=True)
class RadarFeatureConfig:
    version: str = 'RADAR_FOREGROUND_V2'
    mount_position_m: tuple = (2.5, 0., .65)
    mount_rotation_deg: tuple = (0., 0., 0.)  # roll, pitch, yaw
    minimum_height_m: float = .25
    max_azimuth_rad: float = .12
    max_altitude_rad: float = .15
    plane_residual_m: float = .08
    max_plane_slope: float = .15
    min_plane_support: int = 6
    min_plane_span_m: float = 2.

    def __post_init__(self):
        if (not self.version or len(self.mount_position_m)!=3 or len(self.mount_rotation_deg)!=3 or
                not np.isfinite([*self.mount_position_m,*self.mount_rotation_deg,
                    self.minimum_height_m,self.max_azimuth_rad,self.max_altitude_rad,
                    self.plane_residual_m,self.max_plane_slope,self.min_plane_span_m]).all() or
                self.mount_position_m[2]<=0 or not 0<=self.minimum_height_m<2 or
                not 0<self.max_azimuth_rad<=np.pi or not 0<self.max_altitude_rad<=np.pi/2 or
                not 0<self.plane_residual_m<=.2 or not 0<self.max_plane_slope<=.3 or
                type(self.min_plane_support) is not int or not 3<=self.min_plane_support<=32 or
                not 0<self.min_plane_span_m<=10):
            raise ValueError('Invalid radar feature calibration/configuration')
        if any(self.mount_rotation_deg):
            raise ValueError('This profile requires the audited level radar mount')


RADAR_FEATURES = RadarFeatureConfig()


def validate_radar_calibration(calibration, config=RADAR_FEATURES):
    """Accept only local mount metadata, never the sensor's world pose."""
    mount=calibration.get('mount_transform',{})
    rotation=mount.get('rotation_deg',{})
    position=np.asarray(mount.get('position_m',[]),dtype=float)
    angles=np.asarray([rotation.get(k,np.nan) for k in ('roll','pitch','yaw')],dtype=float)
    if (position.shape!=(3,) or not np.isfinite(position).all() or not np.isfinite(angles).all() or
            not np.allclose(position,config.mount_position_m,atol=1e-5,rtol=0) or
            not np.allclose(angles,config.mount_rotation_deg,atol=1e-5,rtol=0)):
        raise ValueError('Radar mount is missing or differs from the audited foreground calibration')


def local_points(points, config=RADAR_FEATURES):
    """Measured coordinates in calibrated local axes, without a world pose."""
    depth,azimuth,altitude=points[:,0],points[:,1],points[:,2]
    return (depth*np.cos(altitude)*np.cos(azimuth)+config.mount_position_m[0],
            depth*np.cos(altitude)*np.sin(azimuth)+config.mount_position_m[1],
            depth*np.sin(altitude)+config.mount_position_m[2])


def estimate_ground_plane(points, config=RADAR_FEATURES):
    """Existing bounded V2 consensus fit: (a,b) for z=a*x+b*y, or None."""
    if len(points)>32:
        raise ValueError('Foreground profile supports at most 32 retained returns')
    x,y,z=local_points(points,config)
    if len(points)<config.min_plane_support:
        return None
    i,j=np.triu_indices(len(points),1)
    determinant=x[i]*y[j]-x[j]*y[i]
    usable=np.abs(determinant)>.1
    i,j,determinant=i[usable],j[usable],determinant[usable]
    a=(z[i]*y[j]-z[j]*y[i])/determinant
    b=(x[i]*z[j]-x[j]*z[i])/determinant
    bounded=np.hypot(a,b)<=config.max_plane_slope
    a,b=a[bounded],b[bounded]
    if not len(a):return None
    residual=np.abs(z[None,:]-a[:,None]*x-b[:,None]*y)
    support=residual<=config.plane_residual_m
    counts=support.sum(axis=1)
    span=np.max(np.where(support,x[None,:],-np.inf),axis=1)-np.min(np.where(support,x[None,:],np.inf),axis=1)
    qualified=(counts>=config.min_plane_support)&(span>=config.min_plane_span_m)
    if not qualified.any():return None
    # Maximize measured support, then minimize total inlier residual. No labels.
    candidates=np.flatnonzero(qualified)
    best=candidates[np.lexsort(((residual*support).sum(axis=1)[candidates],-counts[candidates]))[0]]
    return a[best],b[best]


def measured_heights(points, config=RADAR_FEATURES):
    """Heights above the unchanged V2 radar-supported, spanning ground plane.

    Insufficient support uses the limited nominal plane. No actor/world data.
    At most 32 returns and 496 pairs keep consensus work bounded.
    """
    x,y,z=local_points(points,config)
    plane=estimate_ground_plane(points,config)
    if plane is None:return z,False
    a,b=plane
    return (z-a*x-b*y)/np.sqrt(1+a**2+b**2),True


def foreground_index(points, config=RADAR_FEATURES):
    """Select a measured foreground candidate, or None without certified space.

    Columns: depth m, azimuth rad, altitude rad, radial velocity m/s.
    No replacement velocities, actor classification, or ground-truth labels.
    """
    points=np.asarray(points)
    if points.ndim!=2 or points.shape[1]!=4 or points.dtype.kind not in 'fiu':
        raise ValueError('Radar points must be a numeric N x 4 array')
    if not np.isfinite(points).all() or np.any(points[:,0]<0):
        raise ValueError('Radar features require finite nonnegative measured ranges')
    height,_=measured_heights(points,config)
    candidates=np.flatnonzero((np.abs(points[:,1])<config.max_azimuth_rad)&
        (np.abs(points[:,2])<config.max_altitude_rad)&(height>config.minimum_height_m))
    return int(candidates[np.argmin(points[candidates,0])]) if len(candidates) else None


def foreground_return(points, config=RADAR_FEATURES):
    index=foreground_index(points,config)
    return points[index] if index is not None else None
