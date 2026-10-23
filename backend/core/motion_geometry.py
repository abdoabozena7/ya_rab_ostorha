"""Onboard dimensions and equal-time ego motion; metres, seconds, right-positive.

The default is retained for old recordings. Native driving supplies measured
vehicle specifications, never another actor's box or pose.
"""
from dataclasses import dataclass, asdict
from functools import lru_cache
import math
import numpy as np

GRID = np.round(np.arange(31)*.1, 6)


@dataclass(frozen=True)
class VehicleGeometry:
    front_m: float = 2.5
    rear_m: float = 2.5
    half_width_m: float = 1.15
    wheelbase_m: float = 2.8
    max_steer_rad: float = .6
    source: str = 'LEGACY_RECORDING_DEFAULT'

    def __post_init__(self):
        values = [self.front_m, self.rear_m, self.half_width_m, self.wheelbase_m, self.max_steer_rad]
        if not np.isfinite(values).all() or min(values)<=0 or self.max_steer_rad>=math.pi/2:
            raise ValueError('Invalid onboard vehicle geometry')

    @property
    def half(self): return np.array([(self.front_m+self.rear_m)/2, self.half_width_m])

    @property
    def center_offset(self): return (self.front_m-self.rear_m)/2

    def snapshot(self): return asdict(self)


def integrate(speed, steering, acceleration=0., geometry=None, *, cap_mps=None,grid=GRID):
    g = geometry or VehicleGeometry()
    grid=np.asarray(grid,float)
    v = np.maximum(0., float(speed)+float(acceleration)*grid)
    if cap_mps is not None: v = np.minimum(v, max(float(speed), float(cap_mps)))
    ds = (v[:-1]+v[1:])*.5*np.diff(grid)
    arc = np.r_[0., np.cumsum(ds)]
    yaw = arc*math.tan(float(steering)*g.max_steer_rad)/g.wheelbase_m
    mid = (yaw[:-1]+yaw[1:])*.5
    xy = np.vstack((np.zeros(2), np.cumsum(ds[:,None]*np.column_stack((np.cos(mid),np.sin(mid))),axis=0)))
    return np.column_stack((grid,xy,yaw))


def path_coordinates(x, y, path):
    """Projection onto finite ordered segments, with distance along the path."""
    xy = np.column_stack((np.asarray(x).reshape(-1), np.asarray(y).reshape(-1)))
    p = np.asarray(path, float)
    if p.ndim!=2 or p.shape[1]!=4 or not np.isfinite(p).all(): raise ValueError('Invalid ego path')
    starts=p[:-1,1:3]; segments=np.diff(p[:,1:3],axis=0); lengths=np.linalg.norm(segments,axis=1)
    valid=lengths>1e-6
    if not valid.any(): return xy[:,0], np.abs(xy[:,1])
    arc=np.r_[0.,np.cumsum(lengths)][:-1][valid]; starts=starts[valid]; segments=segments[valid]; lengths=lengths[valid]
    delta=xy[:,None,:]-starts[None,:,:]
    fraction=np.clip(np.sum(delta*segments[None,:,:],axis=2)/lengths[None,:]**2,0.,1.)
    residual=delta-fraction[:,:,None]*segments[None,:,:]
    squared=np.sum(residual**2,axis=2); index=np.argmin(squared,axis=1); rows=np.arange(len(xy))
    along=arc[index]+fraction[rows,index]*lengths[index]
    # Points beyond the terminal segment must not look like close obstacles.
    return along, np.sqrt(squared[rows,index])


def footprint_centers(path, geometry):
    p=np.asarray(path,float).copy()
    p[:,1]+=geometry.center_offset*np.cos(p[:,3]); p[:,2]+=geometry.center_offset*np.sin(p[:,3])
    return p


@lru_cache(maxsize=16)
def _disk_offsets(reach, limit_cells):
    grid=np.arange(-reach,reach+1);i,j=np.meshgrid(grid,grid,indexing='ij');mask=np.hypot(i,j)<=limit_cells
    return np.column_stack((i[mask],j[mask]))


class PathCorridorIndex:
    """Exact ``path_coordinates`` for points that can lie within ``width`` of a long path.

    A raster stamped around densified path samples selects candidate points
    conservatively (any point within ``width`` of the polyline falls in a
    stamped cell). Each candidate is projected exactly onto the segments whose
    arc range lies near its stamping sample; when the path approaches itself
    the full projection is used instead. Non-candidates are farther than
    ``width`` from the path and get infinite along/lateral values.
    """
    def __init__(self, path, width, *, resolution=.25):
        p=np.asarray(path,float)
        if p.ndim!=2 or p.shape[1]!=4 or len(p)<2 or not np.isfinite(p).all():raise ValueError('Invalid ego path')
        self.path=p;self.width=float(width);r=float(resolution);self.res=r
        xy=p[:,1:3];seg=np.diff(xy,axis=0);lengths=np.linalg.norm(seg,axis=1)
        arc=np.r_[0.,np.cumsum(lengths)]
        counts=np.maximum(1,np.ceil(lengths/r).astype(int));seg_index=np.repeat(np.arange(len(seg)),counts)
        within=(np.arange(counts.sum())-np.repeat(np.cumsum(counts)-counts,counts)+1)/np.repeat(counts,counts)
        samples=np.vstack((xy[:1],xy[:-1][seg_index]+seg[seg_index]*within[:,None]))
        sample_s=np.r_[0.,arc[:-1][seg_index]+lengths[seg_index]*within]
        radius=self.width+1.5*r
        self.origin=samples.min(axis=0)-radius-2*r
        self.shape=(np.ceil((samples.max(axis=0)+radius+2*r-self.origin)/r).astype(int)+1)
        offsets=_disk_offsets(int(np.ceil(radius/r))+1,round((radius+r)/r,9))
        cells=np.floor((samples-self.origin)/r).astype(int)
        stamped=(cells[:,None,:]+offsets[None,:,:]).reshape(-1,2);owner=np.repeat(sample_s,len(offsets))
        keep=np.all((stamped>=0)&(stamped<self.shape),axis=1)
        self.near=np.zeros(tuple(self.shape),bool);self.owner=np.full(tuple(self.shape),np.nan)
        self.near[stamped[keep,0],stamped[keep,1]]=True;self.owner[stamped[keep,0],stamped[keep,1]]=owner[keep]
        valid=lengths>1e-6
        self.starts=xy[:-1][valid];self.segments=seg[valid];self.lengths=lengths[valid];self.seg_s=arc[:-1][valid]
        self.window=2.*(radius+1.5*r)+.5
        span=self.lengths.min() if len(self.lengths) else 1.
        self.k=int(np.ceil(2*self.window/max(span,1e-3)))+2
        # Points close in space must be close along the path for the windowed
        # projection to equal the global one; otherwise project globally.
        far=np.abs(sample_s[:,None]-sample_s[None,::4])>self.window
        close=np.linalg.norm(samples[:,None,:]-samples[None,::4,:],axis=2)<2.*(radius+2*r)
        self.windowed=bool(len(self.lengths)) and not np.any(far&close) and self.k<=48
        self._cache=None

    def coordinates(self, x, y):
        if self._cache is not None and self._cache[0] is x and self._cache[1] is y:return self._cache[2]
        xs=np.asarray(x,float).reshape(-1);ys=np.asarray(y,float).reshape(-1)
        along=np.full(len(xs),np.inf);lateral=np.full(len(xs),np.inf)
        if len(xs):
            cells=np.floor((np.column_stack((xs,ys))-self.origin)/self.res).astype(int)
            inside=np.all((cells>=0)&(cells<self.shape),axis=1)
            candidate=np.zeros(len(xs),bool);candidate[inside]=self.near[cells[inside,0],cells[inside,1]]
            idx=np.flatnonzero(candidate)
            if len(idx):
                if not self.windowed:
                    along[idx],lateral[idx]=path_coordinates(xs[idx],ys[idx],self.path)
                else:
                    s0=self.owner[cells[idx,0],cells[idx,1]]
                    first=np.clip(np.searchsorted(self.seg_s+self.lengths,s0-self.window),0,max(0,len(self.lengths)-1))
                    window=np.clip(first[:,None]+np.arange(self.k)[None,:],0,len(self.lengths)-1)
                    point=np.column_stack((xs[idx],ys[idx]))
                    delta=point[:,None,:]-self.starts[window]
                    segments=self.segments[window];lengths=self.lengths[window]
                    fraction=np.clip(np.sum(delta*segments,axis=2)/lengths**2,0.,1.)
                    residual=delta-fraction[:,:,None]*segments
                    squared=np.sum(residual**2,axis=2);best=np.argmin(squared,axis=1);rows=np.arange(len(idx))
                    along[idx]=self.seg_s[window[rows,best]]+fraction[rows,best]*lengths[rows,best]
                    lateral[idx]=np.sqrt(squared[rows,best])
        self._cache=(x,y,(along,lateral))
        return along,lateral


def rectangle_clearances(centers,half,ego,ego_half):
    """Exact per-time edge distances of oriented ego and measured rectangles."""
    from .prediction import occupied_overlap
    centers=np.asarray(centers,float);ego=np.asarray(ego,float)
    half=np.broadcast_to(np.asarray(half,float),(len(ego),2))
    overlap=occupied_overlap(centers,half,ego,ego_half,np.zeros(len(ego)),padding=0.)
    signs=np.array([[-1,-1],[1,-1],[1,1],[-1,1]])
    body=signs*np.asarray(ego_half);co=np.cos(ego[:,3]);si=np.sin(ego[:,3])
    corners=ego[:,None,1:3]+np.stack((co[:,None]*body[None,:,0]-si[:,None]*body[None,:,1],
                                     si[:,None]*body[None,:,0]+co[:,None]*body[None,:,1]),axis=2)
    other=centers[:,None,:]+signs[None,:,:]*half[:,None,:]
    def distances(vertices,polygon):
        edges=np.roll(polygon,-1,axis=1)-polygon;delta=vertices[:,:,None,:]-polygon[:,None,:,:]
        fraction=np.clip(np.sum(delta*edges[:,None,:,:],axis=-1)/np.maximum(1e-8,np.sum(edges**2,axis=-1))[:,None,:],0.,1.)
        return np.linalg.norm(delta-fraction[:,:,:,None]*edges[:,None,:,:],axis=-1).min(axis=(1,2))
    return np.where(overlap,0.,np.minimum(distances(corners,other),distances(other,corners)))


def minimum_clearance(centers,half,ego,ego_half,margin=0.):
    """Minimum edge-to-edge distance of entire rectangles at equal times."""
    from .prediction import occupied_overlap
    centers=np.asarray(centers);ego=np.asarray(ego)
    margins=np.broadcast_to(np.asarray(margin),len(ego))
    if occupied_overlap(centers,half,ego,ego_half,margins).any():return 0.
    signs=np.array([[-1,-1],[1,-1],[1,1],[-1,1]])
    body=signs*np.asarray(ego_half);co=np.cos(ego[:,3]);si=np.sin(ego[:,3])
    corners=ego[:,None,1:3]+np.stack((co[:,None]*body[None,:,0]-si[:,None]*body[None,:,1],si[:,None]*body[None,:,0]+co[:,None]*body[None,:,1]),axis=2)
    other=centers[:,None,:]+signs[None,:,:]*(np.asarray(half)[None,None,:]+margins[:,None,None]+.2)
    def distances(vertices,polygon):
        edges=np.roll(polygon,-1,axis=1)-polygon;delta=vertices[:,:,None,:]-polygon[:,None,:,:]
        fraction=np.clip(np.sum(delta*edges[:,None,:,:],axis=-1)/np.maximum(1e-8,np.sum(edges**2,axis=-1))[:,None,:],0,1)
        return np.linalg.norm(delta-fraction[:,:,:,None]*edges[:,None,:,:],axis=-1).min()
    return float(min(distances(corners,other),distances(other,corners)))


def object_assessments(tracks,modes,path,geometry,conflicts=(),*,centered=False):
    ego=np.asarray(path) if centered else footprint_centers(path,geometry);result={}
    for tr in tracks:
        if not tr['confirmed']:continue
        values=[]
        for mode in modes:
            if mode['track_id']!=tr['id']:continue
            p=np.asarray(mode['points']);centers=np.column_stack([np.interp(GRID,p[:,0],p[:,i]) for i in (1,2)])
            values.append(minimum_clearance(centers,tr['half_size_m'],ego,geometry.half,tr['uncertainty_m']+.12*GRID))
        result[tr['id']]={'minimum_clearance_m':min(values) if values else None,
            'intersection_time_s':min((c['time_s'] for c in conflicts if c['track_id']==tr['id']),default=None),
            'status':'INSUFFICIENT_DATA' if tr.get('occlusion_s',0)>.1 or not values else 'POSSIBLE_INTERSECTION' if values and min(values)==0 else 'NO_PREDICTED_INTERSECTION'}
    return result
