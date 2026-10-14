"""Optional supervised ranking/correction head; never admitted by its own fit."""
import numpy as np

def features(track):
    v=np.asarray(track['velocity_mps']);a=np.asarray(track.get('acceleration_mps2',[0.,0.]))
    return np.array([1.,*v/10.,*a/3.,float(track.get('turn_rate_radps',0.)),
        float(track.get('quality',0.)),np.linalg.norm(v)/10.,*np.asarray(track['half_size_m'])/3.])

def fit(train_x,train_y,validation_x,validation_y):
    """TRAIN determines weights; VALIDATION alone chooses regularization."""
    x,y,vx,vy=map(lambda a:np.asarray(a,float),(train_x,train_y,validation_x,validation_y))
    if min(len(x),len(vx))<20:raise ValueError('Insufficient independent TRAIN/VALIDATION motion samples')
    if not all(np.isfinite(a).all() for a in (x,y,vx,vy)):raise ValueError('Nonfinite measured motion dataset')
    options=[]
    for strength in (.1,1.,10.,100.):
        w=np.linalg.solve(x.T@x+np.eye(x.shape[1])*strength,x.T@y)
        loss=float(np.mean((vx@w-vy)**2));options.append((loss,strength,w))
    loss,strength,w=min(options,key=lambda a:a[0]);return w,{'validation_mse':loss,'regularization':strength}

def apply(weights,track,modes):
    """Separate ranked physical alternatives and bounded metric correction."""
    if not modes:return []
    output=features(track)@weights;logits=output[:3];correction=np.clip(output[3:5],-1.,1.)
    ranked=sorted(modes,key=lambda m:float(logits[min(2,m['mode'])]),reverse=True);result=[]
    for rank,mode in enumerate(ranked[:3]):
        points=np.asarray(mode['points']).copy()
        # Correction remains a distinct learned hypothesis, never an average of
        # different physical alternatives or a collision probability.
        if rank==0:points[:,1:3]+=(points[:,0]/3.)[:,None]**2*correction
        result.append({**mode,'points':points.tolist(),'rank':rank,'selected':rank==0,
            'probability':None,'source':'SUPERVISED_SELECTION_CORRECTION','control_accepted':False})
    return result
