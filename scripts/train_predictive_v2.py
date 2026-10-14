"""One bounded offline fit, preserving the original GRU and protecting TEST."""
import argparse
import hashlib
import json
from pathlib import Path
import time
import numpy as np
import torch
from torch import nn
from backend.learning.experiment_budget import ExperimentBudget
from backend.learning.supervised.inference import LearnedSafetyPolicy
from backend.learning.supervised.motion import speed_features

ROOT = Path(__file__).resolve().parents[1]


def planner(speed, distance, conflict_time, conflict, free_range, cap):
    target = np.minimum(cap, np.sqrt(np.maximum(0., 2*3.*(distance-3.))))
    target = np.minimum(target, np.where(conflict, np.maximum(0., speed*(conflict_time-.8)/np.maximum(.1,conflict_time)), cap))
    return np.minimum(target, np.sqrt(np.maximum(0., 2*3.*(free_range-3.))))/15.


def main():
    p=argparse.ArgumentParser(); p.add_argument('--seconds',type=int,default=360)
    p.add_argument('--output',type=Path,default=ROOT/'artifacts/learned_safety/predictive_v2')
    args=p.parse_args()
    if not 1<=args.seconds<=900: raise ValueError('Training maximum is 15 minutes')
    if args.output.exists(): raise ValueError('Preserve weights: choose a new output directory')
    budget=ExperimentBudget(); reservation=budget.reserve('training', args.seconds)
    began=time.monotonic(); torch.set_num_threads(2); torch.manual_seed(20261011)
    rng=np.random.default_rng(20261011)
    model=LearnedSafetyPolicy(); data=ROOT/'output/learned-data'
    manifest=json.loads((data/'manifest.json').read_text())
    archive=np.load(data/'sequences.npz',allow_pickle=False)
    rows={s:[] for s in ('TRAIN','VALIDATION')}; labels={s:[] for s in rows}; origins=[]
    for ep in manifest['episodes']:
        split=ep['split']
        if split not in rows: raise ValueError('TEST must never enter training/tuning')
        model.reset()
        for x in archive[ep['id']+'_x']:
            model.predict(x)
            speed=float(x[0])*15.; distance=float(x[6])*50. if x[9] else 50.
            cap=20/3.6; free_range=45.; conflict=False; conflict_time=3.
            context=dict(speed=speed,distance=distance,conflict_time=conflict_time,conflict=conflict,free_range=free_range,cap=cap)
            rows[split].append(speed_features(model.hidden,**context))
            labels[split].append(planner(**context))
        origins.append({**ep,'target_origin':'OFFLINE_PHYSICS_PLANNER','input_origin':'ORIGINAL_RECORDED_SENSOR13'})
    if sum(e['split']=='TRAIN' for e in manifest['episodes']) != 11: raise ValueError('Expected eleven original TRAIN trips')
    real_counts={s:len(rows[s]) for s in rows}
    motion_data={}
    for split,n in [('TRAIN',10000),('VALIDATION',2000)]:
        speed=rng.uniform(0,10,n); distance=rng.uniform(.5,50,n); ttc=rng.uniform(0,3,n)
        conflict=rng.random(n)<.5; free=rng.uniform(5,45,n); cap=rng.uniform(1.4,8.3,n)
        hidden=rng.uniform(-1,1,(n,32))*.25
        context=np.column_stack((speed/15,distance/50,ttc/3,conflict,free/45,cap/15))
        synthetic=np.column_stack((hidden,context)).astype(np.float32)
        rows[split].extend(synthetic); labels[split].extend(planner(speed,distance,ttc,conflict,free,cap))
        # Diverse known-physics motion histories. Targets remain synthetic.
        velocity=rng.uniform(-10,10,(n,2)); acceleration=rng.uniform(-3,3,(n,2))
        quality=rng.uniform(.5,1,(n,1)); pedestrian=rng.integers(0,2,(n,1))
        mx=np.column_stack((velocity/15,acceleration/5,quality,pedestrian)).astype(np.float32)
        my=np.column_stack((acceleration/5,np.ones((n,2))*.15)).astype(np.float32)
        motion_data[split]=(torch.tensor(mx),torch.tensor(my))
    tensors={s:(torch.tensor(np.asarray(rows[s],np.float32)),torch.tensor(np.asarray(labels[s],np.float32)[:,None])) for s in rows}
    heads=nn.ModuleDict({'speed':nn.Sequential(nn.Linear(38,32),nn.Tanh(),nn.Linear(32,1)),
                         'motion':nn.Sequential(nn.Linear(6,16),nn.Tanh(),nn.Linear(16,4))})
    optimizer=torch.optim.Adam(heads.parameters(),lr=.003)
    best=float('inf'); best_state=None; best_epoch=0; history=[]
    # Keep a hard monotonic deadline, allowing time for validation/export.
    for epoch in range(1,4001):
        if time.monotonic()-began >= args.seconds-2: break
        heads.train(); optimizer.zero_grad()
        sx,sy=tensors['TRAIN']; mx,my=motion_data['TRAIN']
        loss=((heads['speed'](sx)-sy)**2).mean()+((heads['motion'](mx)-my)**2).mean()
        loss.backward(); optimizer.step()
        if epoch%10==0 or epoch==1:
            with torch.no_grad():
                sx,sy=tensors['VALIDATION']; mx,my=motion_data['VALIDATION']
                score=float(((heads['speed'](sx)-sy)**2).mean()+((heads['motion'](mx)-my)**2).mean())
            history.append({'epoch':epoch,'validation_mse':score,'training_loss':float(loss.detach())})
            if score<best-1e-6:
                best=score;best_epoch=epoch;best_state={k:v.detach().clone() for k,v in heads.state_dict().items()}
            if epoch-best_epoch>=200: break
    if best_state is None: raise ValueError('Training did not produce a validated checkpoint')
    args.output.mkdir(parents=True)
    np.savez_compressed(args.output/'heads.npz',**{k:v.numpy() for k,v in best_state.items()})
    metadata={'version':2,'trained':True,'frozen':True,'method':'OFFLINE_SUPERVISED_PHYSICS_LABELS',
        'base_gru_frozen':True,'original_input_contract':model.metadata['feature_version'],
        'base_weights_sha256':model.metadata['weights_sha256'],
        'weights_sha256':hashlib.sha256((args.output/'heads.npz').read_bytes()).hexdigest(),
        'best_epoch':best_epoch,'validation_mse':best,'train_wall_s':time.monotonic()-began,
        'training_limit_s':args.seconds,'original_episodes':origins,'original_counts':real_counts,
        'synthetic_counts':{'TRAIN':10000,'VALIDATION':2000},'synthetic_seed':20261011,
        'synthetic_target_origin':'KNOWN_ACCELERATION_AND_PHYSICS_SPEED_PLANNER',
        'test_accessed':False,'native_acceptance':False,
        'prediction_calibration':'UNPROVEN_ON_MEASURED_VALIDATION_TRACKS'}
    (args.output/'metadata.json').write_text(json.dumps(metadata,indent=2))
    (args.output/'learning-curves.json').write_text(json.dumps(history,indent=2))
    elapsed=budget.finish(reservation)
    print(json.dumps({'output':str(args.output),'elapsed_s':elapsed,'validation_mse':best,'budget':budget.status()}))

if __name__=='__main__': main()
