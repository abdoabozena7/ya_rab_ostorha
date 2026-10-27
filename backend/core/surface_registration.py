"""Bounded translation ICP with the original NumPy path as an exact oracle."""
import math
import numpy as np
from numba import njit


@njit(cache=True, nogil=True, fastmath=False)
def _registered_translations(cloud, old, sizes, old_sizes, prior, centers, enhanced):
    result = prior.copy()
    for i in range(len(cloud)):
        best = math.inf
        n, m = sizes[i], old_sizes[i]
        residual = np.empty((n, 2))
        norms = np.empty(n)
        inliers = np.empty((n, 2))
        for seed in range(2 if enhanced else 1):
            tx = prior[i, 0] if seed == 0 else centers[i, 0]
            ty = prior[i, 1] if seed == 0 else centers[i, 1]
            count = 0
            for _ in range(3 if enhanced else 2):
                for j in range(n):
                    nearest = math.inf
                    for k in range(m):
                        dx = cloud[i, j, 0] - (old[i, k, 0] + tx)
                        dy = cloud[i, j, 1] - (old[i, k, 1] + ty)
                        squared = dx*dx + dy*dy
                        if squared < nearest:
                            nearest = squared
                            residual[j, 0], residual[j, 1] = dx, dy
                    norms[j] = math.sqrt(nearest)
                cutoff = .65
                if enhanced and n >= 6:
                    ordered = np.sort(norms)
                    rank = (n-1)*.7
                    low, high = int(math.floor(rank)), int(math.ceil(rank))
                    cutoff = min(.65, max(.12, ordered[low] + (ordered[high]-ordered[low])*(rank-low)))
                selected = 0
                for j in range(n):
                    if norms[j] <= cutoff:
                        inliers[selected] = residual[j]
                        selected += 1
                if selected < 3:
                    break
                count = selected
                tx += np.median(inliers[:selected, 0])
                ty += np.median(inliers[:selected, 1])
            if count >= 3:
                for j in range(n):
                    nearest = math.inf
                    for k in range(m):
                        dx = cloud[i, j, 0] - (old[i, k, 0] + tx)
                        dy = cloud[i, j, 1] - (old[i, k, 1] + ty)
                        nearest = min(nearest, math.sqrt(dx*dx + dy*dy))
                    norms[j] = nearest
                dx, dy = tx-prior[i, 0], ty-prior[i, 1]
                score = np.median(norms) + .01*math.sqrt(dx*dx + dy*dy)
                if score < best:
                    best = score
                    result[i, 0], result[i, 1] = tx, ty
    return result


def warm_surface_registration():
    cloud = np.zeros((1, 3, 2))
    sizes = np.array([3], dtype=np.int64)
    _registered_translations(cloud, cloud, sizes, sizes, np.zeros((1, 2)), np.zeros((1, 2)), True)


def register_surfaces(current,previous,prior,center_displacement,*,enhanced):
    n=len(current)
    if not n:return np.empty((0,2))
    prior=np.asarray(prior,float)
    centers=np.asarray(center_displacement,float) if enhanced else np.zeros_like(prior)
    if len(previous)!=n or prior.shape!=(n,2) or centers.shape!=(n,2):
        raise ValueError('Surface registration needs paired clouds and two-dimensional motion seeds')
    sizes=np.array([len(p) for p in current],dtype=np.int64)
    old_sizes=np.array([len(p) for p in previous],dtype=np.int64)
    if np.any(sizes<1) or np.any(old_sizes<1):
        raise ValueError('Surface registration needs nonempty measured clouds')
    cloud=np.zeros((n,int(sizes.max()),2));old=np.zeros((n,int(old_sizes.max()),2))
    for i,(a,b) in enumerate(zip(current,previous)):
        if np.shape(a)!=(sizes[i],2) or np.shape(b)!=(old_sizes[i],2):
            raise ValueError('Surface registration requires two-dimensional points')
        cloud[i,:sizes[i]]=a;old[i,:old_sizes[i]]=b
    if not all(np.isfinite(a).all() for a in (cloud,old,prior,centers)):
        raise ValueError('Surface registration inputs must be finite')
    return _registered_translations(cloud,old,sizes,old_sizes,prior,centers,enhanced)


def _masked_median(values,valid):
    """Finite selected values along axis 2, without masked-array dispatch.

    Registration inputs are finite. Invalid padding sorts after the selected
    samples; even rows retain the same two-middle-values average as nanmedian.
    """
    ordered=np.sort(np.where(valid,values,np.inf),axis=2)
    count=np.sum(valid,axis=2,keepdims=True)
    lower=np.maximum(0,(count-1)//2);upper=count//2
    a=np.take_along_axis(ordered,lower,axis=2).squeeze(axis=2)
    b=np.take_along_axis(ordered,upper,axis=2).squeeze(axis=2)
    return (a+b)*.5


def register_surfaces_reference(current,previous,prior,center_displacement,*,enhanced):
    n=len(current)
    if not n:return np.empty((0,2))
    width=max(map(len,current));old_width=max(map(len,previous))
    cloud=np.zeros((n,width,2));old=np.zeros((n,old_width,2))
    valid=np.zeros((n,width),bool);old_valid=np.zeros((n,old_width),bool)
    for i,(a,b) in enumerate(zip(current,previous)):
        cloud[i,:len(a)]=a;old[i,:len(b)]=b;valid[i,:len(a)]=True;old_valid[i,:len(b)]=True
    prior=np.asarray(prior,float)
    trial=np.stack((prior,np.asarray(center_displacement,float)),axis=1) if enhanced else prior[:,None,:].copy()
    running=np.ones(trial.shape[:2],bool);counts=np.zeros_like(running,int)
    for _ in range(3 if enhanced else 2):
        differences=cloud[:,None,:,None,:]-(old[:,None,None,:,:]+trial[:,:,None,None,:])
        squared=np.sum(differences*differences,axis=-1)
        squared=np.where(old_valid[:,None,None,:],squared,np.inf)
        nearest=np.argmin(squared,axis=3)
        residual=np.take_along_axis(differences,nearest[:,:,:,None,None],axis=3)[:,:,:,0,:]
        norms=np.linalg.norm(residual,axis=-1)
        if enhanced:
            # Linear quantile on each row's finite samples. nanquantile invokes
            # a Python reduction for every surface/seed; bounded sorting keeps
            # the same interpolation in one array operation.
            ordered=np.sort(np.where(valid[:,None,:],norms,np.inf),axis=2)
            rank=(valid.sum(axis=1)-1)*.7
            low=np.floor(rank).astype(int);high=np.ceil(rank).astype(int)
            lower=np.take_along_axis(ordered,low[:,None,None],axis=2)[:,:,0]
            upper=np.take_along_axis(ordered,high[:,None,None],axis=2)[:,:,0]
            cutoff=np.clip(lower+(upper-lower)*(rank-low)[:,None],.12,.65)
            cutoff=np.where(valid.sum(axis=1)[:,None]>=6,cutoff,.65)
        else:cutoff=np.full(trial.shape[:2],.65)
        selected=valid[:,None,:]&(norms<=cutoff[:,:,None])
        active=running&(selected.sum(axis=2)>=3)
        counts=np.where(active,selected.sum(axis=2),counts)
        # Inactive rows receive harmless finite work so nanmedian never needs
        # to reduce an empty array; their translation remains unchanged.
        work=selected|(~active[:,:,None]&valid[:,None,:])
        step=_masked_median(residual,work[:,:,:,None])
        trial+=np.where(active[:,:,None],step,0.)
        running=active
    differences=cloud[:,None,:,None,:]-(old[:,None,None,:,:]+trial[:,:,None,None,:])
    distances=np.linalg.norm(differences,axis=-1)
    distances=np.where(old_valid[:,None,None,:],distances,np.inf).min(axis=3)
    fit=_masked_median(distances,valid[:,None,:])
    score=np.where(counts>=3,fit+.01*np.linalg.norm(trial-prior[:,None,:],axis=2),np.inf)
    choice=np.argmin(score,axis=1)
    return np.where(np.isfinite(score.min(axis=1))[:,None],trial[np.arange(n),choice],prior)
