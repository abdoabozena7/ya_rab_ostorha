"""Fit only new measured TRAIN tracks, select on VALIDATION; never reads TEST."""
import hashlib
import json
from pathlib import Path
import numpy as np
from backend.learning.motion_budget import MotionBudget
from backend.learning.motion_selector import features,fit
from backend.core.prediction import rotation

ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'output/motion-reliability'

def dataset(split):
    if split not in ('TRAIN','VALIDATION'):raise ValueError('TEST is evaluation only')
    x=[];y=[];sources=[];missing=0;moving=0
    for path in sorted(OUT.glob('fixture-'+split+'-*.json')):
        value=json.loads(path.read_text());assert value['split']==split
        forecasts=value['forecasts'];measured={}
        for prediction in forecasts:
            r=rotation(prediction['odometry_yaw_rad']);origin=np.asarray(prediction['odometry_origin_m'])
            for tr in prediction['tracks']:
                if tr['confirmed'] and tr.get('occlusion_s',0)<.1:
                    measured.setdefault(tr['id'],{})[prediction['timestamp_s']]=np.asarray(tr['position_m'])@r.T+origin
        last={}
        for p in forecasts:
            stamp=p['timestamp_s'];r=rotation(p['odometry_yaw_rad']);origin=np.asarray(p['odometry_origin_m'])
            for tr in p['tracks']:
                if not tr['confirmed'] or stamp-last.get(tr['id'],-1)<.5:continue
                last[tr['id']]=stamp;history=measured.get(tr['id'],{});times=np.array(sorted(history))
                if len(times)<2 or times[-1]<stamp+3. or not history:missing+=1;continue
                relevant=times[(times>=stamp)&(times<=stamp+3.)]
                if len(relevant)<2 or np.max(np.diff(relevant))>.35:missing+=1;continue
                future=np.array([history[t] for t in times]);actual=np.array([np.interp(stamp+3.,times,future[:,i]) for i in (0,1)])
                modes=p.get('measured_trajectories',[]);modes=[m for m in modes if m['track_id']==tr['id']]
                if not modes:missing+=1;continue
                errors=[]
                for mode in modes:
                    endpoint=np.asarray(mode['points'][-1][1:3])@r.T+origin;errors.append(np.linalg.norm(actual-endpoint))
                selected=modes[int(np.argmin(errors))];best=selected['mode']
                baseline=np.asarray(selected['points'][-1][1:3])@r.T+origin;residual=r.T@(actual-baseline)
                label=np.r_[np.eye(3)[min(2,best)],np.clip(residual,-1.,1.)]
                x.append(features(tr));y.append(label);moving+=np.linalg.norm(tr['velocity_mps'])>.5
        sources.append({'path':str(path.relative_to(ROOT)),'sha256':hashlib.sha256(path.read_bytes()).hexdigest()})
    return np.asarray(x),np.asarray(y),{'samples':len(x),'moving_samples':int(moving),'unobservable':missing,'sources':sources}

def main():
    report={'type':'SUPERVISED_SELECTION_CORRECTION','control_accepted':False,'test_read':False,
        'labels':'Subsequently measured tracks; sensor consistency labels, not independent simulator truth','rl_training':False}
    # Dataset extraction is bounded development; only the actual fit uses the
    # separately capped supervised training allowance.
    tx,ty,train=dataset('TRAIN');vx,vy,valid=dataset('VALIDATION');report.update(train=train,validation=valid)
    if train['moving_samples']<100 or valid['moving_samples']<30:
        report.update(trained=False,reason='Insufficient measured moving trajectories; refusing a stationary-dominated fit')
    else:
        budget=MotionBudget();ticket=budget.reserve('training',60.)
        try:
            weights,metrics=fit(tx,ty,vx,vy);destination=ROOT/'artifacts/motion-reliability'
            destination.mkdir(parents=True,exist_ok=True);path=destination/'selector-v1.npz'
            if path.exists():raise ValueError('Preserve old weights; choose a new checkpoint name')
            np.savez(path,weights=weights);report.update(trained=True,weights=str(path.relative_to(ROOT)),metrics=metrics,
                sha256=hashlib.sha256(path.read_bytes()).hexdigest(),reason='Independent TEST and native safety admission remain required')
        finally:budget.finish(ticket);report['budget']=budget.status()
    (OUT/'supervised-selector.json').write_text(json.dumps(report,indent=2));print(json.dumps(report),flush=True)

if __name__=='__main__':main()
