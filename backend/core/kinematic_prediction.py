"""Bounded measured-motion hypotheses. No privileged targets or eye direction."""
import math
import numpy as np
from .motion_geometry import GRID


def kinematic_modes(tracks, *, grid=GRID):
    grid=np.asarray(grid,float)
    if grid.ndim!=1 or len(grid)<2 or grid[0]!=0 or np.any(np.diff(grid)<=0):
        raise ValueError('Physical forecast needs an increasing time grid starting at zero')
    modes=[]
    for tr in tracks:
        p=np.asarray(tr['position_m'],float); v=np.asarray(tr['velocity_mps'],float)
        speed=float(np.linalg.norm(v)); a=np.asarray(tr.get('acceleration_mps2',[0.,0.]),float)
        a=np.clip(a,-3.,2.); quality=float(tr.get('quality',0.))
        if speed<.3:
            modes.append(_mode(tr,0,'STATIONARY',p+grid[:,None]*np.zeros(2),0,grid))
            if tr.get('class','UNKNOWN').upper() in ('PERSON','PEDESTRIAN'):
                # Observable person, unknown intent: waiting, starting toward
                # the corridor, or retreating remain separate possibilities.
                toward=np.array([0.,-1. if p[1]>=0 else 1.])
                distance=np.minimum(1.5*grid, .75*grid**2)
                modes.append(_mode(tr,1,'PEDESTRIAN_POSSIBLE_START',p+distance[:,None]*toward,1,grid))
                modes.append(_mode(tr,2,'PEDESTRIAN_POSSIBLE_RETREAT',p-distance[:,None]*toward,2,grid))
                # Preserve walking alternatives and include a sudden run.
                # Bound speed to 3.5 m/s and initial acceleration to 6 m/s².
                # This is an unranked possibility, never known future intent.
                accelerating=np.minimum(grid,3.5/6.)
                running=3.*accelerating**2+3.5*np.maximum(0.,grid-3.5/6.)
                modes.append(_mode(tr,3,'PEDESTRIAN_POSSIBLE_RUN',p+running[:,None]*toward,3,grid))
            continue
        cv=p+grid[:,None]*v
        modes.append(_mode(tr,0,'CONSTANT_VELOCITY',cv,0,grid))
        if quality>=.7 and tr.get('motion_observations',tr.get('consecutive_observations',0))>=5:
            direction=v/speed; longitudinal=float(np.dot(a,direction))
            if abs(longitudinal)>.2:
                vel=np.maximum(0.,speed+longitudinal*grid)
                distance=np.r_[0.,np.cumsum((vel[:-1]+vel[1:])*np.diff(grid)/2)]
                modes.append(_mode(tr,1,'CONSTANT_ACCELERATION',p+distance[:,None]*direction,1,grid))
            rate=float(np.clip(tr.get('turn_rate_radps',0.),-.7,.7))
            if abs(rate)>.04:
                heading=math.atan2(v[1],v[0]); angles=heading+rate*grid
                step=np.diff(grid)[:,None]*speed*np.column_stack((np.cos((angles[:-1]+angles[1:])/2),np.sin((angles[:-1]+angles[1:])/2)))
                xy=p+np.vstack((np.zeros(2),np.cumsum(step,axis=0)))
                modes.append(_mode(tr,2,'COORDINATED_TURN',xy,2,grid))
    return modes


def _mode(tr,index,source,xy,rank,grid):
    return {'track_id':tr['id'],'source':source,'mode':index,'rank':rank,'selected':rank==0,
        'probability':None,'weight_kind':'UNRANKED_PHYSICAL_ALTERNATIVE',
        'uncertainty_bounds':{'kind':'UNCALIBRATED_METRIC_MARGIN','times_s':grid.tolist(),
            'radius_m':(float(tr.get('uncertainty_m',.15))+.12*grid).tolist()},
        'points':np.column_stack((grid,xy)).tolist()}


def rank_learned_modes(modes, tracks):
    """Rank by measured continuity; score is not a collision probability.

    A remote mode cannot certify free space or displace the physical baseline.
    At rest only a stationary measured hypothesis is credible.
    """
    indexed={t['id']:t for t in tracks}; accepted=[]; rejected=[]
    for mode in modes:
        tr=indexed.get(mode['track_id']); p=np.asarray(mode['points'],float)
        reason=None
        if tr is None or not tr['confirmed'] or tr.get('occlusion_s',0)>.1: reason='UNCONFIRMED_OR_OCCLUDED_TRACK'
        elif len(p)<3 or p.shape[1]!=3 or not np.isfinite(p).all() or np.any(np.diff(p[:,0])<=0): reason='INVALID_TIME_OR_COORDINATES'
        else:
            v=np.asarray(tr['velocity_mps']); speed=np.linalg.norm(v)
            dt=np.diff(p[:,0]); pv=np.diff(p[:,1:3],axis=0)/dt[:,None]
            if np.linalg.norm(p[0,1:3]-tr['position_m'])>1.: reason='SOURCE_ALIGNMENT_ERROR'
            elif speed<.3 and np.linalg.norm(p[-1,1:3]-p[0,1:3])>.5: reason='MEASURED_STATIONARY_OBJECT'
            elif np.max(np.linalg.norm(pv,axis=1))>(5. if tr.get('class')=='person' else 22.): reason='PHYSICAL_SPEED_LIMIT'
            elif np.linalg.norm(pv[0]-v)>max(1.5,speed*.4): reason='MEASURED_VELOCITY_DISAGREEMENT'
        if reason: rejected.append({'track_id':mode['track_id'],'mode':mode['mode'],'reason':reason}); continue
        error=float(np.linalg.norm(pv[0]-v)+.2*np.mean(np.linalg.norm(np.diff(pv,axis=0),axis=1)))
        accepted.append({**mode,'continuity_error':error,'probability':None,'weight_kind':'CONTINUITY_SCORE_NOT_PROBABILITY'})
    result=[]
    for key in indexed:
        ranked=sorted([m for m in accepted if m['track_id']==key],key=lambda m:m['continuity_error'])[:3]
        result.extend({**m,'rank':i,'selected':i==0} for i,m in enumerate(ranked))
    return result,rejected
