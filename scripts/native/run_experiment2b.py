"""Bounded YA RAB OSTORHA native teacher validation; no training/CARLA client.

Four VALIDATION attempts gate a frozen four-seed, three-controller TEST pilot.
The existing service alone applies/advances/records the real CARLA world.
"""
import time
from collections import Counter,defaultdict
from dataclasses import replace
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import random
import statistics
import subprocess
import urllib.request
import psutil
import numpy as np
from backend.core.contracts import to_dict
from backend.core.safety_policy import sensor_observation
from backend.rl.env import YaRabOstorhaEnv
from backend.rl.teacher import YaRabOstorhaSafetyTeacher,TeacherConfig
from backend.rl.supervisor import decide_intervention,rule_intervention,policy_features
from .experiment2b_common import ROOT,write,read_frame,base_command

MODEL=ROOT/'runs/experiments/experiment1_20261008T165154Z/final_model.zip'
CONFIG=ROOT/'backend/rl/teacher_config_v1.json'
DEST=ROOT/'docs/evidence/experiment2b'
LIMIT_EPISODES=16;LIMIT_SECONDS=900


def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def state():
    with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/state',timeout=5) as response:return json.load(response)


def used_seeds(split):
    return {json.loads(p.read_text())['seed'] for p in (ROOT/'runs/rl'/split).glob('*/metadata.json')}


def conditions(seeds,parameters):
    return [{'seed':seed,'parameters':dict(lead_speed_mps=5.,time_limit_s=12.,**params)} for seed,params in zip(seeds,parameters)]


def memory():
    result=[]
    for p in psutil.process_iter(['pid','name','cmdline']):
        try:
            command=' '.join(p.info['cmdline'] or [])
            if p.pid==psutil.Process().pid or 'backend.server' in command or 'CarlaUE4-Win64-Shipping' in p.info['name']:
                m=p.memory_info();result.append({'pid':p.pid,'name':p.info['name'],
                    'private_mib':getattr(m,'private',m.rss)/2**20,'rss_mib':m.rss/2**20,
                    'experiment_runner':p.pid==psutil.Process().pid})
        except (psutil.NoSuchProcess,psutil.AccessDenied):pass
    return result


def run_episode(root,condition,split,controller,config,ledger):
    if ledger['attempts']>=LIMIT_EPISODES or time.monotonic()>=ledger['deadline']:raise RuntimeError('Native resource budget exhausted')
    ledger['attempts']+=1;write(root/'budget-ledger.json',{k:v for k,v in ledger.items() if k!='deadline'})
    teacher=YaRabOstorhaSafetyTeacher(config);shadow=YaRabOstorhaSafetyTeacher(config)
    env=YaRabOstorhaEnv(profile='lightweight',split=split,scenario='SUDDEN_BRAKING',
        parameters=condition['parameters'],max_steps=240,baseline_id='BASIC_AGENT_WITH_SUPERVISOR',
        supervisor=True,policy_id='YA_RAB_OSTORHA_EXPERIMENT2B_'+controller)
    latencies=[];decision_times=[];sums=defaultdict(float);edges=[];counts=Counter();prior=None
    episode_began=time.perf_counter();stream=None
    try:
        raw,initial=env.reset(seed=condition['seed']);info=initial
        assert info['reset_cleanup_verified'] and info['actor_inventory']=={'vehicles':2,'sensors':7,'walkers':0,'controllers':0}
        assert initial['initial_configuration']['versions']['carla_server']=='0.9.16'
        stream=(Path(info['recording_path'])/'telemetry/frames.jsonl').open(encoding='utf8')
        frame,observation=read_frame(stream,info);counts['complete_recorded_frames']+=1
        with (root/f"{split}_{condition['seed']}_{controller}-steps.jsonl").open('w',encoding='utf8') as trace:
            for _ in range(240):
                if time.monotonic()>=ledger['deadline']:raise RuntimeError('Native wall-clock budget exhausted')
                current_vector=info.get('next_base_proposed_action',info['base_proposed_action'])
                base=base_command(observation,current_vector);features=policy_features(raw,current_vector)
                started=time.perf_counter();decision=None
                if controller=='TEACHER':
                    decision=teacher.propose(observation,base)
                    clean=shadow.propose(sensor_observation(replace(frame,ground_truth=None,actors=())),base)
                    assert to_dict(decision)==to_dict(clean);counts['real_frame_isolation_checks']+=1
                    action=decision.action
                elif controller=='EXISTING_RULE':action=rule_intervention(raw)
                else:action=(-1.,0.,0.)
                inference_ms=(time.perf_counter()-started)*1000;decision_times.append(inference_ms)
                expected,admission=decide_intervention(observation,base,action,'YA_RAB_OSTORHA_EXPERIMENT2B_'+controller)
                if action[0]>0 and admission['decision']=='REJECTED':raise RuntimeError('Unexpected intervention rejection')
                previous_frame=info['frame_id'];previous_time=info['timestamp_s']
                started=time.perf_counter();raw,reward,terminated,truncated,info=env.step(action)
                latency=(time.perf_counter()-started)*1000;latencies.append(latency);ledger['steps']+=1
                assert info['outcome']!='SIMULATOR_FAILURE',info
                assert info['observation_valid'] and env.observation_space.contains(raw)
                assert info['tick_owner']=='simulation-worker' and info['frame_id']==previous_frame+1
                assert abs(info['timestamp_s']-previous_time-.05)<1e-6
                assert info['intervention']['accepted']==admission['accepted']
                np.testing.assert_allclose(info['applied_action'],[expected.steering,expected.throttle,expected.brake],atol=1e-5,rtol=0)
                np.testing.assert_allclose(info['applied_action'],info['native_applied_action'],atol=1e-5,rtol=0)
                assert info['applied_command']['source']==expected.source.value
                assert not info['intervention']['steering_adjustment_rejected']
                counts['verified_native_steps']+=1;counts['accepted']+=int(admission['accepted'])
                counts['positive_proposals']+=int(action[0]>0)
                if decision:
                    counts[decision.decision]+=1
                    if not decision.diagnostics['foreground_valid']:counts['missing_foreground_brakes']+=1
                    if prior!=decision.state:
                        edges.append({'step':info['step'],'elapsed_s':previous_time-initial['timestamp_s'],
                            'state':decision.state,'decision':decision.decision,'diagnostics':decision.diagnostics})
                    prior=decision.state
                for k,v in info['reward_components'].items():sums[k]+=v
                record={'policy_inputs':{'sensor_features_47':features.tolist(),'base_proposed_control':to_dict(base)},
                    'teacher':to_dict(decision) if decision else None,'info':info,'reward':reward,
                    'decision_wall_ms':inference_ms,'capture_step_response_wall_ms':latency,
                    'source_observation_frame_id':previous_frame,'source_observation_timestamp_s':previous_time,
                    'sensor_only_record_ref':{'path':initial['recording_path'],'frame_id':previous_frame}}
                trace.write(json.dumps(record,allow_nan=False)+'\n');trace.flush()
                frame,observation=read_frame(stream,info);counts['complete_recorded_frames']+=1
                if terminated or truncated:break
            else:raise RuntimeError('Episode did not terminate within its existing limit')
        outcome=json.loads((Path(info['recording_path'])/'outcome.json').read_text())
        assert abs(sum(sums.values())-outcome['reward'])<1e-6
        result={'controller':controller,'split':split,**condition,'initial':initial,'outcome':outcome,
            'reward_components':dict(sums),'teacher_transitions':edges,'verification':dict(counts),
            'episode_wall_s':time.perf_counter()-episode_began,
            'decision_wall_ms':{'median':float(np.median(decision_times)),'p95':float(np.percentile(decision_times,95)),'max':max(decision_times)},
            'capture_step_response_wall_ms':{'median':float(np.median(latencies)),'p95':float(np.percentile(latencies,95)),'max':max(latencies)},
            'sensor_age_simulation_s':0.,'recording_path':info['recording_path']}
    finally:
        if stream:stream.close()
        env.close()
        assert env.last_close_info and env.last_close_info.get('restored'),env.last_close_info
        assert env.last_close_info['actor_inventory']=={'vehicles':1,'sensors':7,'walkers':0,'controllers':0}
    result['close_info']=env.last_close_info
    print(json.dumps({'split':split,'seed':condition['seed'],'controller':controller,
        'outcome':outcome['outcome'],'progress_m':outcome['metrics']['forward_progress_m'],
        'clearance_m':outcome['metrics']['minimum_clearance_m'],'episode_wall_s':result['episode_wall_s']}),flush=True)
    return result


def main():
    offline=json.loads((DEST/'offline.json').read_text())
    config=TeacherConfig(**json.loads(CONFIG.read_text()))
    assert offline['config']==to_dict(config) and all(g['rejected_proposals']==0 for g in offline['groups'].values())
    initial_state=state();assert initial_state['connected'] and not initial_state['rlRuntime']['active']
    old_val=used_seeds('VALIDATION');old_test=used_seeds('TEST')
    val_seeds=random.Random(314159).sample([s for s in range(1000,2000) if s not in old_val],4)
    test_seeds=random.Random(271828).sample([s for s in range(2000,3000) if s not in old_test],4)
    validation=conditions(val_seeds,[{'ego_speed_mps':6.,'following_distance_m':20.,'trigger_s':1.4,'lead_brake':.7},
        {'ego_speed_mps':7.5,'following_distance_m':22.,'trigger_s':2.6,'lead_brake':1.},
        {'ego_speed_mps':9.,'following_distance_m':18.,'trigger_s':1.6,'lead_brake':1.},
        {'ego_speed_mps':10.,'following_distance_m':24.,'trigger_s':1.1,'lead_brake':.8}])
    test=conditions(test_seeds,[{'ego_speed_mps':6.5,'following_distance_m':19.,'trigger_s':1.3,'lead_brake':.8},
        {'ego_speed_mps':8.5,'following_distance_m':21.,'trigger_s':2.1,'lead_brake':1.},
        {'ego_speed_mps':9.5,'following_distance_m':23.,'trigger_s':1.7,'lead_brake':.65},
        {'ego_speed_mps':7.,'following_distance_m':20.,'trigger_s':2.8,'lead_brake':.9}])
    orders=[['BASIC_AGENT','EXISTING_RULE','TEACHER'],['EXISTING_RULE','TEACHER','BASIC_AGENT'],
        ['TEACHER','BASIC_AGENT','EXISTING_RULE'],['BASIC_AGENT','TEACHER','EXISTING_RULE']]
    root=ROOT/'runs/diagnostics'/datetime.now(timezone.utc).strftime('experiment2b_%Y%m%dT%H%M%SZ');root.mkdir(exist_ok=False)
    frozen_model=digest(MODEL);config_hash=digest(CONFIG);source_hash=digest(ROOT/'backend/rl/teacher.py')
    protocol={'experiment':'YA RAB OSTORHA Experiment 2B','validation':validation,'held_out_test':test,
        'test_controller_orders':orders,'seed_protocol':{'selection':'Python random.sample over unused reserved split seeds',
            'validation_draw_seed':314159,'test_draw_seed':271828,'previous_validation_seeds':sorted(old_val),
            'previous_test_seeds':sorted(old_test),'selection_uses_trajectory_data':False},
        'config':to_dict(config),'config_sha256':config_hash,'teacher_source_sha256':source_hash,
        'model_sha256':frozen_model,'maximum_native_episodes':LIMIT_EPISODES,'maximum_native_wall_s':LIMIT_SECONDS,
        'freeze_requirement':'All four changed VALIDATION conditions SUCCESS with zero collisions and verified admission/application',
        'test_tuning':False,'training':False,'production_activation':False,'initial_state':initial_state,
        'git_head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()}
    write(root/'protocol.json',protocol);write(DEST/'protocol.json',protocol)
    write(ROOT/'output/native-validation/experiment2b-run.json',{'run':str(root)})
    began=time.monotonic();ledger={'attempts':0,'steps':0,'deadline':began+LIMIT_SECONDS}
    process=psutil.Process();cpu_start=process.cpu_times();initial_memory=memory();memory_samples=[initial_memory]
    episodes=[];failure=None;frozen=False
    try:
        for condition in validation:
            episodes.append(run_episode(root,condition,'VALIDATION','TEACHER',config,ledger))
            write(root/'episodes.json',episodes);memory_samples.append(memory())
        if not all(e['outcome']['outcome']=='SUCCESS' and e['outcome']['metrics']['collision_count']==0 for e in episodes):
            failure='VALIDATION did not satisfy freeze criteria; held-out TEST not executed'
        else:
            assert digest(CONFIG)==config_hash and digest(ROOT/'backend/rl/teacher.py')==source_hash
            lock={'config':to_dict(config),'config_sha256':config_hash,'teacher_source_sha256':source_hash,
                'frozen_before_any_test_reset':True,'validation_episodes':[e['outcome']['episode_id'] for e in episodes],
                'freeze_utc':datetime.now(timezone.utc).isoformat(),'test_seeds':test_seeds}
            write(root/'frozen-config.json',lock);write(DEST/'frozen-config.json',lock);frozen=True
            for condition,order in zip(test,orders):
                for controller in order:
                    assert digest(CONFIG)==config_hash and digest(ROOT/'backend/rl/teacher.py')==source_hash
                    episodes.append(run_episode(root,condition,'TEST',controller,config,ledger))
                    write(root/'episodes.json',episodes);memory_samples.append(memory())
    except Exception as error:
        failure=repr(error);print(json.dumps({'stopped':failure}),flush=True)
    finally:
        final_state=state();assert final_state['connected'] and not final_state['rlRuntime']['active']
        assert final_state['mode']=='PAUSED' and not final_state['rlRuntime']['policy_active']
        assert digest(MODEL)==frozen_model
        cpu=process.cpu_times();memory_samples.append(memory())
        result={'experiment':'YA RAB OSTORHA Experiment 2B','run':str(root),'episodes':episodes,
            'attempted_episodes':ledger['attempts'],'actual_steps':ledger['steps'],'native_wall_s':time.monotonic()-began,
            'runner_cpu_s':cpu.user+cpu.system-cpu_start.user-cpu_start.system,'memory_samples':memory_samples,
            'config_frozen':frozen,'stopped_reason':failure,'runtime_restored':True,'final_state':final_state,
            'model_sha256_unchanged':frozen_model,'neural_training':False,'gpu_model_allocations':0,
            'new_carla_clients':0,'run_complete':len(episodes)==16 and failure is None}
        write(root/'budget-ledger.json',{'attempts':ledger['attempts'],'steps':ledger['steps'],
            'native_wall_s':result['native_wall_s'],'status':'STOPPED_COMPLETE' if result['run_complete'] else 'STOPPED'})
        write(root/'result.json',result);write(DEST/'native.json',result)
        print(json.dumps({'run':str(root),'attempts':ledger['attempts'],'steps':ledger['steps'],
            'native_wall_s':result['native_wall_s'],'stopped_reason':failure,'complete':result['run_complete']}),flush=True)


if __name__=='__main__':main()
