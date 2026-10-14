"""Fit an unadmitted correction candidate to independent TRAIN future positions."""
import argparse
import hashlib
import json
from pathlib import Path
import time
import numpy as np
from backend.learning.pilot_budget import PilotBudget,DEFAULT_ROOT
from backend.learning.independent_prediction import examples
from scripts.run_core_repair_pilot import historical_hashes


def main():
    p=argparse.ArgumentParser();p.add_argument('--train',type=Path,nargs='+',required=True)
    p.add_argument('--validation',type=Path,nargs='+',required=True);p.add_argument('--seconds',type=float,default=120.)
    args=p.parse_args();sources={}
    for split,paths in [('TRAIN',args.train),('VALIDATION',args.validation)]:
        for path in paths:
            manifest=json.loads((path.parent/'manifest.json').read_text())
            if path.parent.parent.name!=split:raise ValueError('Future-label split mismatch: '+str(path))
            if not (0<=manifest['seed']<=999 if split=='TRAIN' else 1000<=manifest['seed']<=1999):
                raise ValueError('Reserved split seed mismatch')
            sources[str(path)]={'split':split,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
                                'condition_hash':manifest['condition_hash']}
    budget=PilotBudget();reservation=budget.reserve('scenario_prediction',args.seconds)
    report={'trained':False,'control_admitted':False,'sources':sources,'historical_before':historical_hashes(),
            'labels':'INDEPENDENT_FUTURE_NATIVE_ACTOR_POSITIONS','hypothesis':'SELECTED_MEASURED_KINEMATIC_MODE'}
    try:
        import torch
        torch.set_num_threads(1);torch.manual_seed(73)
        train=[];validation=[];coverage=[]
        for paths,target in ((args.train,train),(args.validation,validation)):
            for path in paths:
                values,count=examples(path);target.extend(values);coverage.append({'source':str(path),'horizons':count})
        if len(train)<30 or len(validation)<10:raise ValueError('Insufficient independent associated future labels')
        model=torch.nn.Sequential(torch.nn.Linear(13,64),torch.nn.Tanh(),torch.nn.Linear(64,32),torch.nn.Tanh(),torch.nn.Linear(32,2))
        x=torch.tensor(np.array([v['features'] for v in train]));y=torch.tensor(np.array([v['residual_m'] for v in train]),dtype=torch.float32)
        optimizer=torch.optim.Adam(model.parameters(),lr=3e-4);epochs=0
        for epoch in range(300):
            if time.monotonic()>=reservation[1]+args.seconds-10.:break
            order=torch.randperm(len(x))
            for indices in order.split(32):
                optimizer.zero_grad();loss=torch.nn.functional.smooth_l1_loss(model(x[indices]),y[indices]);loss.backward();optimizer.step()
            epochs+=1
        if not epochs:raise TimeoutError('No prediction parameter updates completed')
        with torch.no_grad():correction=model(torch.tensor(np.array([v['features'] for v in validation]))).numpy()
        scores={}
        for h in (1,2,3):
            indices=[i for i,v in enumerate(validation) if v['horizon_s']==h]
            if not indices:
                scores[h]={'scored':0,'baseline_fde_m':None,'candidate_fde_m':None,'relative_improvement':None};continue
            baseline=np.array([validation[i]['residual_m'] for i in indices]);candidate=baseline-correction[indices]
            old=float(np.linalg.norm(baseline,axis=1).mean());new=float(np.linalg.norm(candidate,axis=1).mean())
            scores[h]={'scored':len(indices),'baseline_fde_m':old,'candidate_fde_m':new,'relative_improvement':(old-new)/old if old else None}
        destination=Path(__file__).resolve().parents[1]/'artifacts/learned_safety/independent_prediction_v1'/reservation[0]
        destination.mkdir(parents=True,exist_ok=False);checkpoint=destination/'residual-mlp.pt'
        torch.save({'state_dict':model.state_dict(),'architecture':[13,64,32,2],'feature_version':1},checkpoint)
        report.update(trained=True,checkpoint=str(checkpoint),sha256=hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
                      epochs=epochs,train_examples=len(train),validation_examples=len(validation),coverage=coverage,scores=scores,
                      reason='Supplementary candidate only; all-actor coverage, matched driving and TEST gates remain required')
    except Exception as error:report['error']=str(error)
    finally:
        budget.finish(reservation);report['budget']=budget.status();report['historical_after']=historical_hashes()
        report['historical_ledgers_unchanged']=report['historical_before']==report['historical_after']
        if report.get('checkpoint'):(Path(report['checkpoint']).parent/'metadata.json').write_text(json.dumps(report,indent=2),encoding='utf8')
        (DEFAULT_ROOT/('prediction-training-'+reservation[0]+'.json')).write_text(json.dumps(report,indent=2),encoding='utf8')
        print(json.dumps(report),flush=True)
    return 0 if report['trained'] else 1


if __name__=='__main__':raise SystemExit(main())
