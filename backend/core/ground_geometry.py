"""Robust measured ground plane in ego coordinates, including suspension tilt."""
import numpy as np


def measured_ground_plane(points,geometry):
    xyz=np.asarray(points,float)
    radius=np.linalg.norm(xyz[:,:2],axis=1)
    selected=xyz[(radius>geometry.front_m+.3)&(radius<20.)&
                 (np.abs(xyz[:,1])<=geometry.half_width_m+.15)&
                 (xyz[:,2]>-.6)&(xyz[:,2]<.6)]
    if len(selected)<12:return np.array([0.,0.,0.]),0
    selected=selected[::max(1,len(selected)//512)]
    design=np.column_stack((selected[:,:2],np.ones(len(selected))))
    rng=np.random.default_rng(0);options=[]
    for _ in range(32):
        indices=rng.choice(len(selected),3,replace=False)
        try:plane=np.linalg.solve(design[indices],selected[indices,2])
        except np.linalg.LinAlgError:continue
        if np.linalg.norm(plane[:2])>.12 or abs(plane[2])>.4:continue
        residual=np.abs(design@plane-selected[:,2]);inliers=residual<.04
        options.append((int(inliers.sum()),float(np.median(residual)),plane,inliers))
    if not options:return np.array([0.,0.,0.]),0
    count,_,plane,inliers=max(options,key=lambda x:(x[0],-x[1]))
    if count<12 or count<len(selected)*.4:return np.array([0.,0.,0.]),0
    plane=np.linalg.lstsq(design[inliers],selected[inliers,2],rcond=None)[0]
    return plane,count
