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
    rng=np.random.default_rng(0)
    indices=np.array([rng.choice(len(selected),3,replace=False) for attempt in range(32)])
    systems=design[indices];targets=selected[indices,2]
    try:planes=np.linalg.solve(systems,targets[:,:,None])[:,:,0]
    except np.linalg.LinAlgError:
        candidates=[]
        for system,target in zip(systems,targets):
            try:candidates.append(np.linalg.solve(system,target))
            except np.linalg.LinAlgError:continue
        if not candidates:return np.array([0.,0.,0.]),0
        planes=np.asarray(candidates)
    planes=planes[(np.linalg.norm(planes[:,:2],axis=1)<=.12)&(np.abs(planes[:,2])<=.4)]
    if not len(planes):return np.array([0.,0.,0.]),0
    residual=np.abs(np.einsum('ij,kj->ki',design,planes)-selected[None,:,2])
    masks=residual<.04;counts=masks.sum(axis=1);medians=np.median(residual,axis=1)
    chosen=max(range(len(planes)),key=lambda index:(counts[index],-medians[index]))
    count=int(counts[chosen]);inliers=masks[chosen]
    if count<12 or count<len(selected)*.4:return np.array([0.,0.,0.]),0
    plane=np.linalg.lstsq(design[inliers],selected[inliers,2],rcond=None)[0]
    return plane,count
