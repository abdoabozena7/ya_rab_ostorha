"""Four native VALIDATION episodes, only after the offline reliability gate."""
import time
from collections import Counter,defaultdict
from dataclasses import replace
from datetime import datetime,timezone
import json
from pathlib import Path
import random
import subprocess
import numpy as np
import psutil
from backend.core.contracts import to_dict,SensorKind
from backend.core.safety_policy import sensor_observation
from backend.rl.env import YaRabOstorhaEnv
from backend.rl.teacher import YaRabOstorhaSafetyTeacher
from backend.rl.radar import foreground_index
from backend.rl.radar_retention import retained_radar_observation,retention_indices,RETENTION_VERSION,COLUMNS
from backend.rl.supervisor import decide_intervention,policy_features
from .experiment2b_common import ROOT,write,read_frame,base_command
from .run_experiment2b import state,digest,used_seeds,MODEL,CONFIG

DEST=ROOT/'docs/evidence/experiment2c'


def resources():
    result=[]
    for p in psutil.process_iter(['pid','name','cmdline']):
        try:
            command=' '.join(p.info['cmdline'] or [])
            if p.pid==psutil.Process().pid or 'experiment2c_backend' in command or 'backend.server' in command or 'CarlaUE4-Win64-Shipping' in p.info['name']:
                m=p.memory_info();c=p.cpu_times()
                result.append({'pid':p.pid,'name':p.info['name'],'runner':p.pid==psutil.Process().pid,
                    'private_mib':m.private/2**20,'working_set_mib':m.rss/2**20,'cpu_s':c.user+c.system})
        except (psutil.AccessDenied,psutil.NoSuchProcess):pass
    return result


def episode(root,condition,ledger):
    assert ledger['attempts']<4 and time.monotonic()<ledger['deadline']
    ledger['attempts']+=1;write(root/'budget-ledger.json',{'attempts':ledger['attempts'],'steps':ledger['steps']})
    teacher=YaRabOstorhaSafetyTeacher();shadow=YaRabOstorhaSafetyTeacher();old=YaRabOstorhaSafetyTeacher()
    env=YaRabOstorhaEnv(profile='lightweight',split='VALIDATION',scenario='SUDDEN_BRAKING',
        parameters=condition['parameters'],max_steps=240,baseline_id='BASIC_AGENT_WITH_SUPERVISOR',
        supervisor=True,policy_id='YA_RAB_OSTORHA_EXPERIMENT2C_'+RETENTION_VERSION)
    began=time.perf_counter();stream=None;counts=Counter();edges={'new':[],'legacy_shadow':[]};previous={'new':False,'legacy_shadow':False};times=[];step_times=[];rewards=defaultdict(float)
    try:
        raw,initial=env.reset(seed=condition['seed']);info=initial
        assert initial['reset_cleanup_verified'] and initial['actor_inventory']=={'vehicles':2,'sensors':7,'walkers':0,'controllers':0}
        stream=(Path(initial['recording_path'])/'telemetry/frames.jsonl').open()
        frame,observation=read_frame(stream,info)
        with (root/f"VALIDATION_{condition['seed']}-steps.jsonl").open('w') as trace:
            for _ in range(240):
                assert time.monotonic()<ledger['deadline'],'Native budget exceeded'
                vector=info.get('next_base_proposed_action',info['base_proposed_action']);base=base_command(observation,vector)
                radar=next(s for s in observation.channels if s.kind==SensorKind.RADAR)
                points=np.array([[d[k] for k in COLUMNS] for d in radar.data['detections']],np.float32).reshape(-1,4)
                retained=points[retention_indices(points)]
                np.testing.assert_array_equal(raw['radar'][-1][raw['radar_valid'][-1].astype(bool)],retained)
                features=policy_features(raw,vector);assert features.shape==(47,) and np.isfinite(features).all()
                started=time.perf_counter();adapted=retained_radar_observation(observation)
                decision=teacher.propose(adapted,base)
                clean=sensor_observation(replace(frame,ground_truth=None,actors=()))
                assert to_dict(decision)==to_dict(shadow.propose(retained_radar_observation(clean),base))
                times.append((time.perf_counter()-started)*1000)
                old_decision=old.propose(observation,base)
                counts['legacy_shadow_decision_differences']+=int(old_decision.decision!=decision.decision)
                counts['legacy_missing_foreground']+=int(not old_decision.diagnostics['foreground_valid'])
                counts['new_missing_foreground']+=int(not decision.diagnostics['foreground_valid'])
                for key,d in (('new',decision),('legacy_shadow',old_decision)):
                    braking=d.action[0]>0
                    if braking!=previous[key]:edges[key].append({'elapsed_s':frame.timestamp_s-initial['timestamp_s'],'braking':braking})
                    previous[key]=braking
                expected,admission=decide_intervention(adapted,base,decision.action,'YA_RAB_OSTORHA_EXPERIMENT2C')
                assert admission['decision']!='REJECTED'
                counts['positive_brake_proposals']+=int(decision.action[0]>0)
                counts['already_matching_base_brake']+=int(decision.action[0]>0 and not admission['accepted'])
                source_frame=frame.frame_id;source_time=frame.timestamp_s
                started=time.perf_counter();raw,reward,terminated,truncated,info=env.step(decision.action)
                step_times.append((time.perf_counter()-started)*1000);ledger['steps']+=1
                assert info['outcome']!='SIMULATOR_FAILURE' and info['observation_valid'] and env.observation_space.contains(raw)
                assert info['tick_owner']=='simulation-worker' and info['frame_id']==source_frame+1
                assert abs(info['timestamp_s']-source_time-.05)<1e-6
                assert info['intervention']['accepted']==admission['accepted']
                assert not info['intervention']['steering_adjustment_rejected']
                np.testing.assert_allclose(info['applied_action'],[expected.steering,expected.throttle,expected.brake],atol=1e-5,rtol=0)
                np.testing.assert_allclose(info['native_applied_action'],info['applied_action'],atol=1e-5,rtol=0)
                assert info['applied_command']['source']==expected.source.value
                counts['verified_native_actions']+=1;counts['isolation_checks']+=1;counts['accepted_brake_proposals']+=int(admission['accepted'])
                counts[decision.decision]+=1
                for k,v in info['reward_components'].items():rewards[k]+=v
                trace.write(json.dumps({'policy_inputs_47':features.tolist(),'source_frame':source_frame,
                    'teacher':to_dict(decision),'legacy_shadow':to_dict(old_decision),'base_proposed_control':to_dict(base),
                    'info':info,'reward':reward},allow_nan=False)+'\n');trace.flush()
                frame,observation=read_frame(stream,info)
                if terminated or truncated:break
            else:raise RuntimeError('No episode completion within limit')
        outcome=json.loads((Path(initial['recording_path'])/'outcome.json').read_text())
        assert abs(sum(rewards.values())-outcome['reward'])<1e-6
        result={'split':'VALIDATION',**condition,'initial':initial,'outcome':outcome,'verification':dict(counts),
            'brake_release_edges':edges,'brief_bout_or_release_count':{k:sum(b['elapsed_s']-a['elapsed_s']<=.150001 for a,b in zip(v,v[1:])) for k,v in edges.items()},
            'reward_components':dict(rewards),'episode_wall_s':time.perf_counter()-began,
            'teacher_wall_ms_including_retention_and_isolation_shadow':{'median':float(np.median(times)),'p95':float(np.percentile(times,95)),'max':max(times)},
            'capture_step_wall_ms':{'median':float(np.median(step_times)),'p95':float(np.percentile(step_times,95)),'max':max(step_times)}}
    finally:
        if stream:stream.close()
        env.close()
        assert env.last_close_info['restored'] and env.last_close_info['actor_inventory']=={'vehicles':1,'sensors':7,'walkers':0,'controllers':0}
    result['close_info']=env.last_close_info
    print(json.dumps({'seed':condition['seed'],'outcome':outcome['outcome'],'progress_m':outcome['metrics']['forward_progress_m'],
        'clearance_m':outcome['metrics']['minimum_clearance_m'],'chatter':result['brief_bout_or_release_count'],'verification':dict(counts)}),flush=True)
    return result


def main():
    offline=json.loads((DEST/'offline.json').read_text());assert offline['offline_pass']
    config=json.loads((ROOT/'docs/evidence/experiment2b/frozen-config.json').read_text())
    assert digest(CONFIG)==config['config_sha256'] and digest(ROOT/'backend/rl/teacher.py')==config['teacher_source_sha256']
    assert state()['connected'] and not state()['rlRuntime']['active']
    used=used_seeds('VALIDATION');seeds=random.Random(314160).sample([s for s in range(1000,2000) if s not in used],4)
    params=[(10.,23.,1.4,.8),(9.25,25.,2.2,.75),(7.25,18.,1.,1.),(8.75,21.5,3.,.65)]
    conditions=[{'seed':s,'parameters':dict(ego_speed_mps=v,following_distance_m=d,trigger_s=t,lead_brake=b,lead_speed_mps=5.,time_limit_s=12.)} for s,(v,d,t,b) in zip(seeds,params)]
    root=ROOT/'runs/diagnostics'/datetime.now(timezone.utc).strftime('experiment2c_%Y%m%dT%H%M%SZ');root.mkdir(exist_ok=False)
    source_hashes={p:digest(ROOT/p) for p in ('backend/rl/teacher.py','backend/rl/teacher_config_v1.json','backend/rl/radar.py','backend/rl/radar_retention.py','backend/rl/observations.py')}
    model_hash=digest(MODEL)
    protocol={'experiment':'YA RAB OSTORHA Experiment 2C','conditions':conditions,'split':'VALIDATION','selection_draw_seed':314160,
        'previous_validation_seeds':sorted(used),'selection_uses_trajectory_data':False,'maximum_episodes':4,'native_wall_limit_s':300,
        'source_hashes_frozen_before_native':source_hashes,'model_sha256':model_hash,'teacher_and_config_changed':False,
        'native_test_seeds_used':False,'production_policy_changed':False,'offline_gate_passed':True,'git_head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()}
    write(root/'protocol.json',protocol);write(DEST/'protocol.json',protocol)
    restart=[str(ROOT/'.venv-carla/Scripts/python.exe'),'-m','scripts.native.restart_experiment2c_backend']
    subprocess.run(restart,cwd=ROOT,check=True)
    initial_state=state();assert not initial_state['rlRuntime']['active']
    began=time.monotonic();ledger={'attempts':0,'steps':0,'deadline':began+300};episodes=[];samples=[resources()];failure=None
    cpu=psutil.Process().cpu_times()
    try:
        for condition in conditions:
            episodes.append(episode(root,condition,ledger));write(root/'episodes.json',episodes);samples.append(resources())
            if episodes[-1]['outcome']['outcome']!='SUCCESS':
                failure='Native condition did not succeed; no further episodes or tuning';break
    except Exception as error:failure=repr(error);print(json.dumps({'stopped':failure}),flush=True)
    finally:
        final_state=state();native_wall=time.monotonic()-began;samples.append(resources());end_cpu=psutil.Process().cpu_times()
        assert not final_state['rlRuntime']['active'] and not final_state['rlRuntime']['policy_active']
        assert source_hashes=={p:digest(ROOT/p) for p in source_hashes} and digest(MODEL)==model_hash
        result={'experiment':'YA RAB OSTORHA Experiment 2C','run':str(root),'episodes':episodes,
            'attempted_episodes':ledger['attempts'],'actual_steps':ledger['steps'],'native_wall_s':native_wall,
            'runner_cpu_s':end_cpu.user+end_cpu.system-cpu.user-cpu.system,'memory_cpu_samples':samples,
            'initial_state':initial_state,'final_state':final_state,'stopped_reason':failure,
            'neural_training':False,'gpu_model_allocations':0,'teacher_and_config_hashes_preserved':True,
            'native_test_seeds_used':False,'run_complete':len(episodes)==4 and failure is None}
        write(root/'result.json',result);write(DEST/'native.json',result)
        write(root/'budget-ledger.json',{'attempts':ledger['attempts'],'steps':ledger['steps'],'native_wall_s':native_wall,'status':'STOPPED'})
        subprocess.run([*restart,'--restore-normal'],cwd=ROOT,check=True)
        restored=state();assert restored['connected'] and not restored['rlRuntime']['active'] and restored['mode']=='PAUSED'
        write(root/'restored-state.json',restored)
        print(json.dumps({'run':str(root),'attempts':ledger['attempts'],'steps':ledger['steps'],'native_wall_s':native_wall,'failure':failure,'normal_host_restored':True}),flush=True)


if __name__=='__main__':main()
