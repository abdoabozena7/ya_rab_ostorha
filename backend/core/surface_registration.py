"""Batch the existing bounded translation ICP without changing its gates."""
import numpy as np


def register_surfaces(current,previous,prior,center_displacement,*,enhanced):
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
        step=np.nanmedian(np.where(work[:,:,:,None],residual,np.nan),axis=2)
        trial+=np.where(active[:,:,None],step,0.)
        running=active
    differences=cloud[:,None,:,None,:]-(old[:,None,None,:,:]+trial[:,:,None,None,:])
    distances=np.linalg.norm(differences,axis=-1)
    distances=np.where(old_valid[:,None,None,:],distances,np.inf).min(axis=3)
    fit=np.nanmedian(np.where(valid[:,None,:],distances,np.nan),axis=2)
    score=np.where(counts>=3,fit+.01*np.linalg.norm(trial-prior[:,None,:],axis=2),np.inf)
    choice=np.argmin(score,axis=1)
    return np.where(np.isfinite(score.min(axis=1))[:,None],trial[np.arange(n),choice],prior)
