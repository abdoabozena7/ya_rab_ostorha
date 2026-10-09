"""One bounded supervised imitation run, whole episodes, validation early stop.

Uses established PyTorch GRU/Adam/weighted cross entropy. Never runs CARLA,
reinforcement learning, image inference or a hyperparameter search.
"""
import copy
import argparse
import hashlib
import json
import os
from pathlib import Path
import time
import numpy as np
import torch
from torch import nn
from backend.learned.features import VERSION, DIM, DECISIONS

ROOT=Path(__file__).resolve().parents[1]
DATA=ROOT/'output/learned-data'
OUT=ROOT/'artifacts/learned_safety/v1'


class Policy(nn.Module):
    def __init__(self):
        super().__init__();self.gru=nn.GRU(DIM,32,batch_first=True);self.head=nn.Linear(32,3)
    def forward(self,x):return self.head(self.gru(x)[0])


def metrics(logits,y):
    prediction=logits.argmax(-1).cpu().numpy(); truth=y.cpu().numpy()
    mask=truth>=0; p=prediction[mask]; t=truth[mask]
    cm=np.zeros((3,3),int)
    np.add.at(cm,(t,p),1)
    f1=[2*cm[i,i]/max(1,cm[i,:].sum()+cm[:,i].sum()) for i in range(3)]
    return {'accuracy':float((p==t).mean()),'macro_f1':float(np.mean(f1)), 'class_f1':f1,'confusion':cm.tolist()}


def main():
    global OUT
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,default=OUT)
    args=parser.parse_args();OUT=args.output.resolve()
    if OUT.exists() and any(OUT.iterdir()):raise ValueError('Preserve frozen checkpoints: choose a new empty --output directory')
    began=time.monotonic();cpu_start=time.process_time()
    seed=20261009;torch.manual_seed(seed);np.random.seed(seed);torch.set_num_threads(4)
    torch.backends.cudnn.benchmark=False
    manifest=json.loads((DATA/'manifest.json').read_text()); archive=np.load(DATA/'sequences.npz',allow_pickle=False)
    batches={}
    for split in ('TRAIN','VALIDATION'):
        episodes=[e for e in manifest['episodes'] if e['split']==split]
        n=max(e['transitions'] for e in episodes); x=np.zeros((len(episodes),n,DIM),np.float32);y=np.full((len(episodes),n),-100,np.int64)
        for i,e in enumerate(episodes):
            x[i,:e['transitions']]=archive[e['id']+'_x'];y[i,:e['transitions']]=archive[e['id']+'_y']
        batches[split]=(torch.from_numpy(x),torch.from_numpy(y))
    counts=np.bincount(batches['TRAIN'][1].numpy().ravel()[batches['TRAIN'][1].numpy().ravel()>=0],minlength=3)
    weights=torch.tensor(np.sqrt(counts.max()/np.maximum(counts,1)),dtype=torch.float32)
    initial=copy.deepcopy(Policy().state_dict());bench={}
    for device in ('cpu','cuda'):
        if device=='cuda' and not torch.cuda.is_available():continue
        model=Policy().to(device);model.load_state_dict(initial)
        x,y=[v.to(device) for v in batches['TRAIN']];opt=torch.optim.Adam(model.parameters(),lr=.003)
        criterion=nn.CrossEntropyLoss(weight=weights.to(device),ignore_index=-100)
        def batch():
            opt.zero_grad();loss=criterion(model(x).reshape(-1,3),y.reshape(-1));loss.backward();opt.step()
        for _ in range(3):batch()
        if device=='cuda':torch.cuda.synchronize()
        start=time.perf_counter()
        for _ in range(12):batch()
        if device=='cuda':torch.cuda.synchronize()
        bench[device]={'batch_ms':(time.perf_counter()-start)/12*1000}
        if device=='cuda':bench[device]['peak_allocated_mib']=torch.cuda.max_memory_allocated()/2**20
        del model,opt,x,y,criterion
        if device=='cuda':torch.cuda.empty_cache()
    device=min(bench,key=lambda d:bench[d]['batch_ms'])
    model=Policy().to(device);model.load_state_dict(initial)
    train_x,train_y=[v.to(device) for v in batches['TRAIN']];val_x,val_y=[v.to(device) for v in batches['VALIDATION']]
    criterion=nn.CrossEntropyLoss(weight=weights.to(device),ignore_index=-100)
    opt=torch.optim.Adam(model.parameters(),lr=.003,weight_decay=1e-5)
    OUT.mkdir(parents=True,exist_ok=True)
    history=[]; best_score=-1.;best_loss=float('inf');best_epoch=0;train_start=time.monotonic(); stop='MAX_EPOCHS'
    for epoch in range(1,1501):
        if time.monotonic()-train_start>=1200:stop='20_MINUTE_SOFT_LIMIT';break
        model.train();opt.zero_grad();logits=model(train_x);loss=criterion(logits.reshape(-1,3),train_y.reshape(-1));loss.backward()
        nn.utils.clip_grad_norm_(model.parameters(),1.);opt.step()
        if epoch%5==0 or epoch==1:
            model.eval()
            with torch.no_grad():
                vl=model(val_x); val_loss=criterion(vl.reshape(-1,3),val_y.reshape(-1))
                row={'epoch':epoch,'training_loss':float(loss.detach().cpu()),'validation_loss':float(val_loss.cpu()),
                    'training':metrics(logits,train_y),'validation':metrics(vl,val_y),'training_wall_s':time.monotonic()-train_start}
            history.append(row)
            score=row['validation']['macro_f1']
            if score>best_score+1e-5 or abs(score-best_score)<1e-5 and row['validation_loss']<best_loss:
                best_score=score;best_loss=row['validation_loss'];best_epoch=epoch
                torch.save({k:v.detach().cpu() for k,v in model.state_dict().items()},OUT/'checkpoint.pt')
            if epoch%100==0:print(json.dumps(row),flush=True)
            if epoch>=300 and epoch-best_epoch>=150:stop='VALIDATION_EARLY_STOP';break
    train_s=time.monotonic()-train_start
    assert train_s<1800,'Hard training budget exceeded'
    state=torch.load(OUT/'checkpoint.pt',map_location='cpu',weights_only=True);model=Policy();model.load_state_dict(state);model.eval()
    arrays={k:v.numpy() for k,v in state.items()};np.savez_compressed(OUT/'weights.npz',**arrays)
    metadata={'identity':'YA_RAB_OSTORHA_SEQUENCE_BC_V1','method':'SUPERVISED_BEHAVIOR_CLONING_NOT_RL',
        'feature_version':VERSION,'input_dim':DIM,'hidden_dim':32,'decisions':list(DECISIONS),
        'parameters':sum(p.numel() for p in model.parameters()),'seed':seed,'device':device,
        'torch_version':torch.__version__,'cuda_version':torch.version.cuda,
        'gpu_name':torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
        'benchmark':bench,'class_counts':counts.tolist(),'class_weights':weights.tolist(),
        'optimizer':{'name':'Adam','learning_rate':.003,'weight_decay':1e-5,'gradient_clip_norm':1.},
        'epoch_budget':1500,'training_hard_limit_s':1800,'best_epoch':best_epoch,'epochs':epoch,
        'training_wall_s':train_s,'stop_reason':stop,'data':manifest,
        'weights_sha256':hashlib.sha256((OUT/'weights.npz').read_bytes()).hexdigest()}
    (OUT/'metadata.json').write_text(json.dumps(metadata,indent=2))
    from backend.learned.inference import LearnedSafetyPolicy
    runtime=LearnedSafetyPolicy(OUT); parity=[]; replay={}
    for split in batches:
        x,y=batches[split]
        with torch.no_grad():output=model(x)
        replay[split]=metrics(output,y)
        for i in range(len(x)):
            runtime.reset()
            probs=torch.softmax(output[i],-1).numpy()
            for j in range(int((y[i]>=0).sum())):
                _,np_probs=runtime.predict(x[i,j].numpy());parity.append(float(np.max(np.abs(probs[j]-np_probs))))
    assert max(parity)<1e-5, 'Export disagrees with trained PyTorch'
    import psutil
    result={'training':metadata,'frozen_replay':replay,'numpy_export_max_probability_error':max(parity),
        'cpu_seconds':time.process_time()-cpu_start,'wall_s':time.monotonic()-began,
        'process_rss_mib':psutil.Process().memory_info().rss/2**20,
        'gpu_peak_allocated_mib':torch.cuda.max_memory_allocated()/2**20 if torch.cuda.is_available() else 0,
        'model_bytes':sum(p.stat().st_size for p in OUT.iterdir() if p.is_file())}
    (OUT/'learning_curves.json').write_text(json.dumps(history,indent=2))
    (OUT/'training_result.json').write_text(json.dumps(result,indent=2))
    print(json.dumps({k:v for k,v in result.items() if k!='training'}),flush=True)

if __name__=='__main__':main()
