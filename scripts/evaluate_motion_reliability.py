"""Frozen TEST replay: policy sees sensors; independent labels are evaluator-only."""
import hashlib
import argparse
import json
from pathlib import Path
import time
import numpy as np
from backend.core.contracts import SimulationFrame,SensorKind,from_dict
from backend.core.safety_policy import sensor_observation
from backend.core.prediction import PredictionEngine,rotation
from backend.core.display_prediction import local_modes
from backend.core.kinematic_prediction import rank_learned_modes
from backend.core.recording import resolve_asset
from backend.core.active_safety import _mount
from backend.learning.motion_budget import MotionBudget
from backend.learning.async_worker import AsyncPredictionWorker

ROOT=Path(__file__).resolve().parents[1];OUT=ROOT/'output/motion-reliability'

def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()

def freeze():
    path=OUT/'frozen-test.json'
    if path.exists():return json.loads(path.read_text())
    candidates=[]
    for p in sorted((ROOT/'runs/normal_city').glob('*/metadata.json')):
        metadata=json.loads(p.read_text(encoding='utf-8-sig'));scenario=(metadata['config'].get('environment') or {}).get('scenario') or {}
        frames=p.parent/'telemetry/frames.jsonl';status=p.parent/'recording-status.json'
        if scenario.get('split')!='TEST' or not frames.exists():continue
        if status.exists() and json.loads(status.read_text()).get('incomplete'):continue
        if 2e6<frames.stat().st_size<40e6:candidates.append({'directory':str(p.parent.relative_to(ROOT)),'frames_sha256':digest(frames),'seed':scenario['random_seed']})
        if len(candidates)==3:break
    value={'split':'TEST','selection':'First three lexicographic complete native TEST recordings between 2 and 40 MB, frozen before scoring',
        'not_training_or_tuning':True,'runs':candidates}
    path.write_text(json.dumps(value,indent=2));return value

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--allowance',type=float,default=180.);parser.add_argument('--report',default='frozen-evaluation.json')
    args=parser.parse_args()
    if not 30<=args.allowance<=180:parser.error('Allowance must be 30 to 180 seconds')
    OUT.mkdir(parents=True,exist_ok=True);budget=MotionBudget();ticket=budget.reserve('validation',args.allowance)
    deadline=time.monotonic()+args.allowance-10.;frozen=freeze();worker=AsyncPredictionWorker();report={'frozen':frozen,'runs':[],
        'scope':'Independent native actor motion labels are read only by the evaluator; no target truth enters either tracker or model',
        'sources':['OLD_GEOMETRIC','MEASURED_KINEMATIC','TRAJECTRON_RANKED'],'training_performed':False,
        'learned_control_accepted':False,'supervised_reason':'No native TRAIN motion dataset with independent selection validation has been established in this run'}
    scores={name:{h:[] for h in (1,2,3)} for name in report['sources']};missing={name:0 for name in scores};errors=[];paired={}
    try:
        for entry in frozen['runs']:
            if time.monotonic()>deadline:raise TimeoutError('Frozen replay allowance reached; remaining cases explicitly incomplete')
            directory=ROOT/entry['directory'];file=directory/'telemetry/frames.jsonl'
            if digest(file)!=entry['frames_sha256']:raise ValueError('Frozen TEST recording changed')
            raw=[json.loads(row) for row in file.open(encoding='utf8')];raw=raw[:500]
            truth={}
            for row in raw:
                for a in row['actors']:
                    if not a['class_name'].startswith(('vehicle.','walker.')):continue
                    pose=a['transform'];truth.setdefault(a['actor_id'],[]).append([row['timestamp_s'],*pose['position_m'][:2],pose['rotation_rad']['yaw']])
            truth={k:np.asarray(v) for k,v in truth.items() if len(v)>1}
            recorded={}
            sidecar=directory/'telemetry/safety-v2.jsonl'
            if sidecar.exists():
                for line in sidecar.open():
                    record=json.loads(line);recorded[record['evaluation_frame']]=((record.get('safety') or {}).get('prediction') or {}).get('tracks',[])
            engines={name:PredictionEngine(entry['directory'],enhanced=name!='OLD_GEOMETRIC') for name in scores if name!='TRAJECTRON_RANKED'}
            queries=unmatched=ambiguous=invalid=0;last_query=-1.
            for index,row in enumerate(raw):
                if index%2:continue
                if time.monotonic()>deadline:raise TimeoutError('Replay deadline')
                try:
                    frame=from_dict(SimulationFrame,row);observation=sensor_observation(frame)
                    channel=next(c for c in observation.channels if c.kind==SensorKind.LIDAR)
                    points=np.frombuffer(resolve_asset(directory,channel.asset).read_bytes(),'<f4').reshape(-1,4)[:,:3]+_mount(channel)[0]
                    base=frame.control
                    if base is None:raise ValueError('No recorded base command')
                    predictions={name:engine.evaluate(points,observation,base) for name,engine in engines.items()}
                except (ValueError,KeyError,OSError,TypeError) as error:invalid+=1;errors.append({'run':entry['directory'],'frame':row['frame_id'],'reason':str(error)});continue
                if observation.timestamp_s-last_query<1.:continue
                last_query=observation.timestamp_s;queries+=1
                pred=predictions['MEASURED_KINEMATIC']
                # Only recorded sensor-classification results may label tracks.
                for tr in pred['tracks']:
                    choices=[t for t in recorded.get(frame.frame_id,[]) if t.get('class')!='UNKNOWN' and np.linalg.norm(np.asarray(t['position_m'])-tr['position_m'])<.75]
                    if choices:tr['class']=choices[0]['class']
                classified=[t for t in pred['tracks'] if t['class']!='UNKNOWN' and t['confirmed'] and len(t['history'])>=2]
                learned=[]
                if classified:
                    worker.submit({'session_id':entry['directory'],'frame_id':frame.frame_id,'timestamp_s':frame.timestamp_s,'tracks':classified})
                    until=min(deadline,time.monotonic()+4.)
                    while time.monotonic()<until:
                        if worker.error:break
                        if worker.latest and worker.latest['frame_id']==frame.frame_id:
                            learned,_=rank_learned_modes(local_modes(worker.latest['modes'],pred,frame.timestamp_s),pred['tracks']);break
                        time.sleep(.01)
                predictions['TRAJECTRON_RANKED']={**pred,'trajectories':learned}
                origin=np.asarray(row['vehicle']['transform']['position_m'][:2]);yaw=row['vehicle']['transform']['rotation_rad']['yaw'];r=rotation(yaw)
                for name,prediction in predictions.items():
                    for tr in prediction['tracks']:
                        if not tr['confirmed']:continue
                        modes=sorted([m for m in prediction['trajectories'] if m['track_id']==tr['id']],key=lambda m:m.get('rank',0))
                        world=np.asarray(tr['position_m'])@r.T+origin;choices=[]
                        for ident,actual in truth.items():
                            t=observation.timestamp_s
                            if not actual[0,0]<=t<=actual[-1,0]:continue
                            center=np.array([np.interp(t,actual[:,0],actual[:,i]) for i in (1,2)])
                            gap=np.linalg.norm(world-center)
                            if gap<max(1.,np.linalg.norm(tr['half_size_m'])+1.):choices.append((gap,ident,center))
                        choices.sort(key=lambda a:a[0])
                        if not choices:unmatched+=1;missing[name]+=3;continue
                        if len(choices)>1 and choices[1][0]-choices[0][0]<.35:ambiguous+=1;missing[name]+=3;continue
                        _,ident,center=choices[0];actual=truth[ident];source_yaw=np.interp(t,actual[:,0],np.unwrap(actual[:,3]));anchor=rotation(source_yaw).T@(world-center)
                        for h in (1,2,3):
                            if not modes or actual[-1,0]<t+h or np.max(np.diff(actual[(actual[:,0]>=t)&(actual[:,0]<=t+h),0]),initial=0.)>.15:missing[name]+=1;continue
                            grid=np.arange(h*10+1)*.1;heads=np.interp(t+grid,actual[:,0],np.unwrap(actual[:,3]))
                            labels=np.column_stack([np.interp(t+grid,actual[:,0],actual[:,i]) for i in (1,2)])
                            labels+=np.array([rotation(a)@anchor for a in heads])
                            distances=[]
                            for mode in modes:
                                a=np.asarray(mode['points']);xy=np.column_stack([np.interp(grid,a[:,0],a[:,i]) for i in (1,2)])@r.T+origin
                                distances.append(np.linalg.norm(xy-labels,axis=1))
                            selected=distances[0];metrics=[float(selected.mean()),float(selected[-1]),float(min(d[-1] for d in distances)),bool(selected[-1]<=(.5 if tr['class']=='person' else 1.))]
                            scores[name][h].append(metrics)
                            key=(entry['directory'],frame.frame_id,ident,h)
                            paired.setdefault(key,{}).setdefault(name,[]).append(metrics)
            report['runs'].append({**entry,'frames_considered':len(raw),'queries':queries,'unmatched_associations':unmatched,'ambiguous_associations':ambiguous,'invalid_frames':invalid})
        report['complete']=True
    except Exception as error:report.update(complete=False,error=str(error))
    finally:
        worker.close();report['worker_error']=worker.error;report['invalid_frames']=errors
        report['metrics']={}
        for name,horizons in scores.items():
            report['metrics'][name]={}
            for h,rows in horizons.items():
                a=np.asarray(rows);report['metrics'][name][h]={'samples':len(rows),'selected_ade_m':float(a[:,0].mean()) if len(a) else None,
                    'selected_fde_m':float(a[:,1].mean()) if len(a) else None,'best_alternative_fde_m':float(a[:,2].mean()) if len(a) else None,
                    'inside_bound_percent':float(a[:,3].mean()*100) if len(a) else None}
            report['metrics'][name]['unscored_forecasts']=missing[name]
            n=sum(len(v) for v in horizons.values());report['metrics'][name]['coverage_percent']=100*n/max(1,n+missing[name])
        report['old_ledger_sha256']=digest(ROOT/'output/predictive-v2/budget.sqlite')
        report['paired_comparison']={'scope':'Same recording, query frame, independently associated actor and horizon; duplicate associations excluded from paired means only and retained in all-forecast metrics',
            'horizons':{},'ambiguous_duplicate_pairs':0}
        for h in (1,2,3):
            rows=[]
            for key,value in paired.items():
                if key[-1]!=h or not all(name in value for name in ('OLD_GEOMETRIC','MEASURED_KINEMATIC')):continue
                if any(len(value[name])!=1 for name in ('OLD_GEOMETRIC','MEASURED_KINEMATIC')):
                    report['paired_comparison']['ambiguous_duplicate_pairs']+=1;continue
                rows.append([value['OLD_GEOMETRIC'][0],value['MEASURED_KINEMATIC'][0]])
            data=np.asarray(rows);result={'samples':len(rows)}
            for index,name in enumerate(('OLD_GEOMETRIC','MEASURED_KINEMATIC')):
                result[name]={'selected_ade_m':float(data[:,index,0].mean()) if len(data) else None,
                    'selected_fde_m':float(data[:,index,1].mean()) if len(data) else None}
            report['paired_comparison']['horizons'][h]=result
        budget.finish(ticket);report['budget']=budget.status()
        (OUT/args.report).write_text(json.dumps(report,indent=2));print(json.dumps(report['metrics']),flush=True)

if __name__=='__main__':main()
