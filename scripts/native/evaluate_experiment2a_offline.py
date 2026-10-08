"""Offline-first radar validation and frozen prediction replay. No training/ticks.

Only VALIDATION is read before locking the screening configuration. Historical
TEST is an audit, not a tuning set or fresh safety-performance evaluation.
Recorded rewards belong to the recorded controls, never counterfactual outputs.
"""
import time
START=time.perf_counter()
import ast
from collections import Counter, defaultdict
from dataclasses import asdict, replace
import hashlib
import json
from pathlib import Path
import threading
import subprocess
import psutil
PROCESS=psutil.Process();CPU_START=PROCESS.cpu_times()
PEAK={'private_mib':0.,'rss_mib':0.};STOP=threading.Event()


def sample_memory():
    while not STOP.is_set():
        m=PROCESS.memory_info()
        PEAK['private_mib']=max(PEAK['private_mib'],getattr(m,'private',m.rss)/2**20)
        PEAK['rss_mib']=max(PEAK['rss_mib'],m.rss/2**20)
        STOP.wait(.05)


threading.Thread(target=sample_memory,daemon=True).start()
import numpy as np
import torch
from stable_baselines3 import SAC
from backend.core.contracts import SimulationFrame, SensorKind, from_dict
from backend.core.safety_policy import sensor_observation
from backend.rl.observations import ObservationAssembler, CONFIGS
from backend.rl.supervisor import policy_features
from backend.rl.radar import RADAR_FEATURES, foreground_index
from scripts.native.diagnose_experiment1_recordings import world_hits, leader_masks

ROOT=Path(__file__).resolve().parents[2]
RUN=ROOT/'runs/experiments/experiment1_20261008T165154Z'
DEST=ROOT/'docs/evidence/experiment2a'
SENSITIVITY=(.10,.15,.20,.25,.30,.40,.50)


def rows(path):
    with path.open(encoding='utf8') as f:return [json.loads(r) for r in f if r.strip()]


def write(path,value):path.write_text(json.dumps(value,indent=2,allow_nan=False)+'\n',encoding='utf8')


def distribution(values):
    a=np.asarray(values,float)
    return {'n':len(a),'min':float(a.min()),'max':float(a.max()),'mean':float(a.mean()),
            'median':float(np.median(a)),'p95':float(np.percentile(a,95))}


def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def legacy_projection():
    # Pure feature function from the immutable model-run source snapshot.
    source=ast.parse((RUN/'supervisor.py').read_text())
    function=next(n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=='policy_features')
    module=ast.Module(body=[function],type_ignores=[])
    namespace={'np':np,'FEATURE_DIM':47}
    exec(compile(module,str(RUN/'supervisor.py'),'exec'),namespace)
    return namespace['policy_features']


def load_entries(trace,group,legacy):
    """One streaming parse per telemetry frame; history stays bounded at four."""
    episodes=defaultdict(list)
    for row in trace:episodes[row['episode_id']].append(row)
    entries=[];audits=Counter();sensitivity={str(h):Counter() for h in SENSITIVITY}
    for trace_rows in episodes.values():
        path=Path(trace_rows[0]['recording_path']);metadata=json.loads((path/'metadata.json').read_text())
        assembler=ObservationAssembler(CONFIGS['lightweight'],lambda _:b'')
        previous=None;raw=None;initial_time=None
        with (path/'telemetry/frames.jsonl').open(encoding='utf8') as stream:
            for i,line in enumerate(stream):
                frame=from_dict(SimulationFrame,json.loads(line))
                assert frame.complete and all(s.frame_id==frame.frame_id and
                    abs(s.sensor_timestamp_s-frame.timestamp_s)<=1e-6 for s in frame.sensors)
                audits['complete_frames']+=1
                if previous is None:
                    initial_time=frame.timestamp_s
                    raw=assembler.append(sensor_observation(frame),[0.,0.,0.]);previous=frame;continue
                row=trace_rows[i-1]
                assert row['frame_id']==frame.frame_id==previous.frame_id+1
                points=raw['radar'][-1][raw['radar_valid'][-1].astype(bool)]
                indices=np.flatnonzero((np.abs(points[:,1])<.12)&(np.abs(points[:,2])<.15))
                old=int(indices[np.argmin(points[indices,0])]) if len(indices) else None
                new=foreground_index(points)
                before=legacy(raw,row['base_proposed_action']);after=policy_features(raw,row['base_proposed_action'])
                assert before.shape==after.shape==(47,) and np.isfinite(after).all()
                # Only distance, radial velocity, TTC proxy and foreground-valid
                # may change in each of the four history rows.
                allowed=[j*11+k for j in range(4) for k in (6,7,8,9)]
                invariant=np.delete(np.arange(47),allowed)
                np.testing.assert_array_equal(before[invariant],after[invariant])
                radar=next(s for s in previous.sensors if s.kind==SensorKind.RADAR)
                d,hits=world_hits(radar);leader,inside=leader_masks(previous,metadata,d,hits)
                order=np.argsort(d[:,0],kind='stable')[:32]
                np.testing.assert_allclose(points,d[order],atol=1e-5,rtol=0)
                road=(np.abs(hits[:,2])<=.12)&(~inside)
                flags={}
                for name,index in (('before',old),('after',new)):
                    selected=order[index] if index is not None else None
                    flags[name+'_lead_associated']=bool(selected is not None and inside[selected])
                    flags[name+'_road_height']=bool(selected is not None and road[selected])
                    flags[name+'_no_foreground']=index is None
                    audits[name+'_lead_associated']+=int(flags[name+'_lead_associated'])
                    audits[name+'_road_height']+=int(flags[name+'_road_height'])
                    audits[name+'_no_foreground']+=int(index is None)
                audits['policy_observations']+=1
                if group.startswith('VALIDATION'):
                    for height in SENSITIVITY:
                        index=foreground_index(points,replace(RADAR_FEATURES,minimum_height_m=height))
                        c=sensitivity[str(height)];c['observations']+=1
                        c['lead_associated']+=int(index is not None and inside[order[index]])
                        c['road_height']+=int(index is not None and road[order[index]])
                        c['no_foreground']+=int(index is None)
                if i in (1,len(trace_rows)//2,len(trace_rows)):
                    isolated=replace(previous,ground_truth=None,actors=())
                    a=ObservationAssembler(CONFIGS['lightweight'],lambda _:b'')
                    b=ObservationAssembler(CONFIGS['lightweight'],lambda _:b'')
                    left=a.append(sensor_observation(previous),[0,0,0]);right=b.append(sensor_observation(isolated),[0,0,0])
                    np.testing.assert_array_equal(policy_features(left,row['base_proposed_action']),policy_features(right,row['base_proposed_action']))
                    audits['actual_frame_ground_truth_invariance_checks']+=1
                entries.append({'group':group,'seed':row['seed'],'step':row['step'],'episode_id':row['episode_id'],
                    'elapsed_s':previous.timestamp_s-initial_time,'collision_time_s':trace_rows[-1]['timestamp_s']-initial_time,
                    'before_features':before,'after_features':after,'recorded_proposed_action':row['proposed_action'],
                    'before_return':points[old].tolist() if old is not None else None,
                    'after_return':points[new].tolist() if new is not None else None,
                    'ego_speed_mps':float(raw['ego'][-1,0]),'actual_base':row['base_proposed_action'],
                    'actual_applied':row['applied_action'],'reward':row['reward'],
                    'reward_components':row['reward_components'],**flags})
                raw=assembler.append(sensor_observation(frame),row['applied_action']);previous=frame
    return entries,dict(audits),{k:dict(v) for k,v in sensitivity.items()}


def predict(model,entries,check_recorded=False):
    before=np.stack([r['before_features'] for r in entries]);after=np.stack([r['after_features'] for r in entries])
    began=time.perf_counter();old,_=model.predict(before,deterministic=True);new,_=model.predict(after,deterministic=True)
    latency=time.perf_counter()-began
    if check_recorded:
        error=float(np.max(np.abs(old-np.array([r['recorded_proposed_action'] for r in entries]))))
        assert error<2e-6
    else:error=None
    for row,a,b in zip(entries,old,new):row['before_prediction']=a.tolist();row['after_prediction']=b.tolist()
    return {'before_gate':distribution(old[:,0]),'after_gate':distribution(new[:,0]),
        'before_positive_gates':int((old[:,0]>0).sum()),'after_positive_gates':int((new[:,0]>0).sum()),
        'after_brake_head':distribution(new[:,1]),'legacy_prediction_max_error':error,
        'two_batched_prediction_wall_s':latency,'counterfactual_only':True}


def public_entries(entries):
    return [{k:v for k,v in r.items() if k not in ('before_features','after_features')} for r in entries]


def main():
    DEST.mkdir(parents=True,exist_ok=True)
    torch.set_num_threads(2);torch.set_num_interop_threads(1)
    frozen=digest(RUN/'final_model.zip');replay_hash=digest(RUN/'replay_buffer.pkl')
    model=SAC.load(RUN/'final_model.zip',device='cpu');assert model._n_updates==755
    legacy=legacy_projection();groups={};all_entries=[];val_groups=[]
    files=[('VALIDATION_FROZEN_SAC','validation_1255-steps.jsonl'),
           ('VALIDATION_STATIONARY','diagnostic_always_brake-steps.jsonl')]
    for label,name in files:
        entries,audit,sensitivity=load_entries(rows(RUN/name),label,legacy)
        groups[label]={'selection':audit,'height_sensitivity':sensitivity,
            'frozen_predictions':predict(model,entries,check_recorded=label=='VALIDATION_FROZEN_SAC')}
        all_entries+=entries;val_groups.append(label)
    demonstration_root=ROOT/'runs/diagnostics/experiment1_1_20261008T190202Z'
    scripted_rows=rows(demonstration_root/'brake_resume_stop_1042-steps.jsonl')
    script_trace=[{**r['info'],'reward':r['reward']} for r in scripted_rows]
    entries,audit,sensitivity=load_entries(script_trace,'VALIDATION_SCRIPTED_SUCCESS',legacy)
    groups['VALIDATION_SCRIPTED_SUCCESS']={'selection':audit,'height_sensitivity':sensitivity,
        'frozen_predictions':predict(model,entries)}
    all_entries+=entries;val_groups.append('VALIDATION_SCRIPTED_SUCCESS')
    lock={'version':RADAR_FEATURES.version,'config':asdict(RADAR_FEATURES),'calibration_split':'VALIDATION',
        'decision':'Retain the pre-specified 0.25 m foreground height; bounded radar-plane support compensates pitch. No gate/reward optimization',
        'validation_groups':val_groups,'validation_measurements':{k:groups[k]['selection'] for k in val_groups},
        'historical_test_read_in_this_run_before_lock':False,'historical_test_previously_inspected':True,
        'test_use':'Historical audit, not tuning or an untouched safety benchmark',
        'model_sha256':frozen,'reward_or_gate_calibration':False}
    write(DEST/'validation-lock.json',lock)
    # Only now audit the already diagnosed historical TEST recordings.
    entries,audit,sensitivity=load_entries(rows(RUN/'trained_sac_9b3bceb0c77aaea8-steps.jsonl'),'HISTORICAL_TEST_AUDIT',legacy)
    groups['HISTORICAL_TEST_AUDIT']={'selection':audit,'frozen_predictions':predict(model,entries,True)}
    all_entries+=entries
    timing=[]
    for label in ('VALIDATION_FROZEN_SAC','HISTORICAL_TEST_AUDIT'):
        for seed in sorted({r['seed'] for r in all_entries if r['group']==label}):
            current=[r for r in all_entries if r['group']==label and r['seed']==seed]
            first={name:next((r['elapsed_s'] for r in current if r[name+'_lead_associated']),None) for name in ('before','after')}
            timing.append({'group':label,'seed':seed,'first_lead_before_s':first['before'],
                'first_lead_after_s':first['after'],'recorded_collision_time_s':current[0]['collision_time_s'],
                'available_time_after_s':current[0]['collision_time_s']-first['after'] if first['after'] is not None else None})
    # Demonstration summaries use VALIDATION for analysis. TEST demonstrations
    # remain historical descriptive evidence and do not choose parameters.
    demo=next(e for e in json.loads((demonstration_root/'episodes.json').read_text())
        if e['name']=='brake_resume_stop' and e['split']=='VALIDATION')
    actions=[r['info']['proposed_action'] for r in scripted_rows]
    demo_summary={'analysis_split':'VALIDATION','seed':1042,'version':'SCRIPTED_BRAKE_RESUME_STOP_EXPERIMENT1.1',
        'script_phases':demo['script_phases'],'actual_outcome':demo['outcome'],
        'actual_braking_steps':sum(a[0]>0 for a in actions),'actual_base_release_steps':sum(a[0]<=0 for a in actions),
        'ground_truth_policy_input':False,'parameters_selected_from_test':False}
    with (DEST/'prediction-replay.jsonl').open('w',encoding='utf8') as stream:
        for row in public_entries(all_entries):stream.write(json.dumps(row,allow_nan=False)+'\n')
    # Small vectors are saved once; original sensor binaries are never copied.
    np.savez_compressed(DEST/'features.npz',before=np.stack([r['before_features'] for r in all_entries]),
        after=np.stack([r['after_features'] for r in all_entries]))
    assert frozen==digest(RUN/'final_model.zip') and replay_hash==digest(RUN/'replay_buffer.pkl')
    cpu=PROCESS.cpu_times();STOP.set();memory=PROCESS.memory_info()
    resource={'wall_s_including_imports':time.perf_counter()-START,
        'cpu_user_s':cpu.user-CPU_START.user,'cpu_system_s':cpu.system-CPU_START.system,
        'peak_sampled_private_mib':PEAK['private_mib'],'peak_sampled_rss_mib':PEAK['rss_mib'],
        'os_peak_working_set_mib':getattr(memory,'peak_wset',memory.rss)/2**20,
        'torch_threads':2,'torch_interop_threads':1,'device':'cpu','torch_cuda_available':torch.cuda.is_available(),
        'native_episodes':0,'native_action_steps':0,'gpu_model_allocations':0,'training_updates':0}
    result={'experiment':'EXPERIMENT2A_RADAR_FIX_NO_TRAINING','groups':groups,'timing':timing,
        'validation_demonstration':demo_summary,'resource':resource,'features_shape':[len(all_entries),47],
        'model_sha256':frozen,'replay_buffer_sha256':replay_hash,'model_updates_unchanged':model._n_updates,
        'normalization_unchanged':True,'decoder_gate_reward_success_unchanged':True,
        'collision_avoidance_improvement_measured':False,'source_head':subprocess.check_output(
            ['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip()}
    write(DEST/'offline-result.json',result)
    print(json.dumps({'groups':{k:v['selection'] for k,v in groups.items()},
        'gates':{k:v['frozen_predictions']['after_gate'] for k,v in groups.items()},'resource':resource}),flush=True)


if __name__=='__main__':main()
