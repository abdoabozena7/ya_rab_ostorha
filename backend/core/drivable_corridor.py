"""Whole-body admission against map road strips, separate from free space."""
import numpy as np


def certificate(path,geometry,strips):
    if len(strips)==0:return {'verified':False,'reason':'ROAD_GEOMETRY_UNAVAILABLE'}
    rows=np.asarray(strips,float)
    starts=rows[:,:2];delta=rows[:,2:4]-starts
    length2=np.sum(delta*delta,axis=1)
    # Include the interior as well as the four corners; a body must not bridge
    # a pavement island merely because its corners occupy two legal strips.
    xx=np.linspace(-geometry.rear_m,geometry.front_m,11)
    yy=np.linspace(-geometry.half_width_m,geometry.half_width_m,5)
    local=np.array(np.meshgrid(xx,yy)).reshape(2,-1).T
    p=np.asarray(path,float);co=np.cos(p[:,3]);si=np.sin(p[:,3])
    points=(p[:,None,1:3]+np.stack((co[:,None]*local[:,0]-si[:,None]*local[:,1],
                                  si[:,None]*local[:,0]+co[:,None]*local[:,1]),axis=2)).reshape(-1,2)
    low,high=points.min(axis=0),points.max(axis=0)
    keep=np.all(np.maximum(starts,starts+delta)+rows[:,4,None]+.05>=low,axis=1)&\
         np.all(np.minimum(starts,starts+delta)-rows[:,4,None]-.05<=high,axis=1)
    rows=rows[keep];starts=starts[keep];delta=delta[keep];length2=length2[keep]
    if not len(rows):return {'verified':False,'reason':'BODY_OUTSIDE_DRIVING_LANES'}
    headings=np.repeat(np.column_stack((co,si)),len(local),axis=0)
    valid=[]
    for indices in np.array_split(np.arange(len(points)),max(1,int(np.ceil(len(points)/256)))):
        chunk=points[indices]
        offset=chunk[:,None,:]-starts
        along=np.sum(offset*delta,axis=2)/np.maximum(length2,1e-8)
        nearest=starts+np.clip(along,0.,1.)[:,:,None]*delta
        distance=np.linalg.norm(chunk[:,None,:]-nearest,axis=2)
        # 5 cm numerical allowance at segment joins, without widening lanes.
        supported=(distance<=rows[:,4]+.05)&(along>=-.025)&(along<=1.025)
        if rows.shape[1]>=7:
            supported&=headings[indices]@rows[:,5:7].T>.25
        valid.extend(supported.any(axis=1).tolist())
    return {'verified':all(valid),'source':'OPENDRIVE_DRIVING_LANES',
            'outside_body_samples':int(len(valid)-sum(valid)),'body_samples':len(valid)}
