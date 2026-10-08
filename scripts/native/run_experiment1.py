"""ONE bounded CPU SAC experiment; all physics is service-owned native CARLA.

Creates a new immutable run directory. It cannot resume or overwrite a run.
No training extension, search, reward tuning or production integration exists.
"""
import argparse
from collections import Counter, defaultdict
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import statistics
import subprocess
import time
import urllib.request
import gymnasium as gym
import numpy as np
import psutil
import stable_baselines3 as sb3
from stable_baselines3 import SAC
from stable_baselines3.common.callbacks import BaseCallback
from stable_baselines3.common.logger import configure
import torch
from backend.rl.supervisor import SafetySupervisorEnv, rule_intervention

ROOT=Path(__file__).resolve().parents[2]
PARAMETERS={'ego_speed_mps':8.,'following_distance_m':18.,'lead_speed_mps':5.,
            'lead_brake':1.,'trigger_s':2.,'time_limit_s':12.}
TRAIN_SEEDS=[42,43,44,45,46,47,48,49]
VALIDATION_SEEDS=[1042,1043,1044,1045]
TEST_SEEDS=[2042,2043,2044,2045,2046,2047,2048,2049]


def write(path,data):
    path.write_text(json.dumps(data,indent=2,allow_nan=False)+'\n',encoding='utf8')


def append(path,data):
    with path.open('a',encoding='utf8') as stream:
        stream.write(json.dumps(data,allow_nan=False)+'\n')


def state():
    with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/state',timeout=5) as r:
        return json.load(r)


def model_hash(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def memory():
    values=[]
    for p in psutil.process_iter(['pid','name','cmdline']):
        try:
            cmd=' '.join(p.info['cmdline'] or [])
            if p.pid==psutil.Process().pid or ('backend.server' in cmd and 'python' in p.info['name'].lower()) or 'CarlaUE4-Win64-Shipping' in p.info['name']:
                m=p.memory_info()
                values.append({'pid':p.pid,'name':p.info['name'],'private_mib':getattr(m,'private',m.rss)/2**20,
                               'rss_mib':m.rss/2**20,'training_process':p.pid==psutil.Process().pid})
        except (psutil.AccessDenied,psutil.NoSuchProcess):pass
    return values


class BudgetReached(RuntimeError):pass


def require_observation(env,obs,info,previous=None):
    if not env.observation_space.contains(obs) or not info['observation_valid']:
        raise RuntimeError('Invalid sensor-derived policy observation: '+str(info.get('error')))
    if info['tick_owner']!='simulation-worker':raise RuntimeError('Unexpected tick owner')
    if previous is not None and info['frame_id']!=previous+1:raise RuntimeError('Native step did not advance exactly one frame')
    if info.get('applied_action') is not None:
        np.testing.assert_allclose(info['applied_action'],info['native_applied_action'],atol=1e-5,rtol=0)


def require_reset(info):
    if not info['reset_cleanup_verified'] or info['actor_inventory']!={'vehicles':2,'sensors':7,'walkers':0,'controllers':0}:
        raise RuntimeError('Native reset inventory/cleanup mismatch')


def trace_row(info,reward,latency,phase,training_step=None,inference_ms=None):
    keys=('episode_id','seed','frame_id','timestamp_s','step','recording_path','base_proposed_action',
          'proposed_action','applied_action','native_applied_action','applied_command','intervention',
          'reward_components','reward_measurements','collision_events','outcome',
          'termination_reason','truncation_reason')
    return {**{key:info.get(key) for key in keys},'reward':reward,'phase':phase,
            'training_step':training_step,'step_wall_ms':latency,'inference_ms':inference_ms}


def outcome(info):
    return json.loads((Path(info['recording_path'])/'outcome.json').read_text(encoding='utf8'))


def summary(rows):
    n=len(rows)
    if not n:return {}
    collisions=sum(r['outcome']['outcome']=='COLLISION' for r in rows)
    successes=sum(r['outcome']['outcome']=='SUCCESS' for r in rows)
    def mean(key):
        vals=[r['outcome']['metrics'][key] for r in rows if r['outcome']['metrics'][key] is not None]
        return statistics.mean(vals) if vals else None
    return {'episodes':n,'collisions':collisions,'collision_rate':collisions/n,
            'scenario_completions':successes,'completion_rate':successes/n,
            'mean_reward':statistics.mean(r['outcome']['reward'] for r in rows),
            'mean_collision_peak_impulse_ns':mean('collision_peak_impulse_ns'),
            'mean_forward_progress_m':mean('forward_progress_m'),
            'mean_minimum_clearance_m':mean('minimum_clearance_m'),
            'minimum_clearance_m':min(r['outcome']['metrics']['minimum_clearance_m'] for r in rows),
            'mean_unnecessary_intervention_count':mean('unnecessary_intervention_count'),
            'mean_speed_mps':mean('average_speed_mps'),
            'mean_hard_braking_frequency_hz':mean('hard_braking_frequency_hz'),
            'mean_intervention_step_fraction':statistics.mean(r['intervention_steps']/r['outcome']['steps'] for r in rows),
            'mean_inference_ms':statistics.mean(r['inference_ms_mean'] for r in rows),
            'mean_step_wall_ms':statistics.mean(r['step_wall_ms_mean'] for r in rows),
            'outcomes':dict(Counter(r['outcome']['outcome'] for r in rows))}


def evaluate(root,name,split,seeds,controller,model=None,deadline=None):
    rows=[]
    model_id=name
    with SafetySupervisorEnv(split=split,parameters=PARAMETERS,policy_id=model_id) as env:
        for seed in seeds:
            if deadline and time.monotonic()>deadline:raise BudgetReached('Wall-clock budget reached during validation')
            obs,initial=env.reset(seed=seed);require_reset(initial);require_observation(env,obs,initial)
            previous=initial['frame_id'];latencies=[];inference=[];interventions=0;component_sums=defaultdict(float)
            spec=initial['initial_configuration']['scenario_spec']
            while True:
                if deadline and time.monotonic()>deadline:raise BudgetReached('Wall-clock budget reached during validation')
                started=time.perf_counter()
                if controller=='NONE':action=np.array([-1.,0.,0.],np.float32)
                elif controller=='RULE':action=rule_intervention(env.raw_observation)
                elif controller=='ALWAYS_BRAKE':action=np.array([1.,1.,0.],np.float32)
                elif controller=='CONSTANT_STEER':action=np.array([1.,0.,1.],np.float32)
                else:action,_=model.predict(obs,deterministic=True)
                infer=(time.perf_counter()-started)*1000;inference.append(infer)
                started=time.perf_counter();obs,reward,t,tr,info=env.step(action)
                latency=(time.perf_counter()-started)*1000;latencies.append(latency)
                require_observation(env,obs,info,previous);previous=info['frame_id']
                interventions+=int(info['intervention']['accepted'])
                for key,value in info['reward_components'].items():component_sums[key]+=value
                append(root/(name+'-steps.jsonl'),trace_row(info,reward,latency,name,inference_ms=infer))
                if t or tr:break
            row={'seed':seed,'split':split,'controller':name,'outcome':outcome(info),
                 'recording_path':info['recording_path'],'scenario_spec':spec,
                 'initial_states':initial['initial_configuration']['intended_initial_states'],
                 'actual_velocity_initialization':initial['initial_configuration']['actual_velocity_initialization'],
                 'condition_hash':hashlib.sha256(json.dumps(spec,sort_keys=True).encode()).hexdigest(),
                 'reward_components':dict(component_sums),'intervention_steps':interventions,
                 'inference_ms_mean':statistics.mean(inference),'inference_ms_max':max(inference),
                 'step_wall_ms_mean':statistics.mean(latencies),'step_wall_ms_max':max(latencies)}
            rows.append(row);append(root/'evaluation-episodes.jsonl',row)
            print(json.dumps({'evaluation':name,'seed':seed,'outcome':info['outcome'],
                              'progress_m':row['outcome']['metrics']['forward_progress_m']}),flush=True)
    result={'name':name,'split':split,'summary':summary(rows),'episodes':rows}
    write(root/(name+'.json'),result)
    return result


class TrainingEnv(gym.Env):
    metadata={'render_modes':[]}
    render_mode=None

    def __init__(self,root,counters,deadline):
        self.native=SafetySupervisorEnv(parameters=PARAMETERS,policy_id='SAC_EXPERIMENT1_TRAINING')
        self.observation_space=self.native.observation_space;self.action_space=self.native.action_space
        self.root,self.counters,self.deadline=root,counters,deadline
        self.previous=None;self.component_sums=defaultdict(float)

    def reset(self,*,seed=None,options=None):
        super().reset(seed=seed)
        if time.monotonic()>self.deadline:raise BudgetReached('Wall-clock training budget reached')
        chosen=TRAIN_SEEDS[self.counters['resets']%len(TRAIN_SEEDS)];self.counters['resets']+=1
        obs,info=self.native.reset(seed=chosen);require_reset(info);require_observation(self.native,obs,info)
        self.previous=info['frame_id'];self.component_sums=defaultdict(float)
        append(self.root/'training-resets.jsonl',{'training_step':self.counters['steps'],'info':info})
        return obs,info

    def step(self,action):
        if time.monotonic()>self.deadline or self.counters['steps']>=self.counters['max_steps']:
            raise BudgetReached('Bounded training budget reached before issuing physics step')
        started=time.perf_counter();obs,reward,t,tr,info=self.native.step(action)
        latency=(time.perf_counter()-started)*1000
        require_observation(self.native,obs,info,self.previous);self.previous=info['frame_id']
        self.counters['steps']+=1
        for key,value in info['reward_components'].items():self.component_sums[key]+=value
        append(self.root/'training-steps.jsonl',trace_row(info,reward,latency,'TRAIN',self.counters['steps']))
        if t or tr:
            row={'training_step':self.counters['steps'],'outcome':outcome(info),'reward_components':dict(self.component_sums)}
            append(self.root/'training-episodes.jsonl',row)
        if self.counters['steps']%500==0:
            print(json.dumps({'training_steps':self.counters['steps'],'reward':reward,'episode_outcome':info['outcome']}),flush=True)
        return obs,reward,t,tr,info

    def close(self):self.native.close()


class BudgetCallback(BaseCallback):
    def __init__(self,root,deadline,max_steps):
        super().__init__();self.root,self.deadline,self.max_steps=root,deadline,max_steps
    def _on_step(self):
        if self.num_timesteps%500==0:
            append(self.root/'performance.jsonl',{'training_step':self.num_timesteps,'time':time.time(),
                   'memory':memory(),'runtime':state()['rlRuntime']})
        return self.num_timesteps<self.max_steps and time.monotonic()<self.deadline


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--steps',type=int,default=10000)
    parser.add_argument('--seconds',type=int,default=3600)
    args=parser.parse_args()
    if not 1<=args.steps<=10000 or not 90<=args.seconds<=3600:raise ValueError('Experiment 1 budget exceeds authorization')
    # One user-authorized experiment. A saved marker prevents accidental reruns.
    guard=ROOT/'runs/experiments/experiment1-training-started.json'
    if guard.exists():raise RuntimeError('Experiment 1 already started; no further training is authorized')
    root=ROOT/'runs/experiments'/datetime.now(timezone.utc).strftime('experiment1_%Y%m%dT%H%M%SZ')
    root.mkdir(parents=True,exist_ok=False)
    torch.set_num_threads(2);torch.set_num_interop_threads(1)
    seed=12345
    hyper={'learning_rate':3e-4,'buffer_size':10000,'learning_starts':500,'batch_size':64,
           'tau':.005,'gamma':.99,'train_freq':1,'gradient_steps':1,'ent_coef':'auto_0.1'}
    config={'experiment':'ONE_BOUNDED_EXPERIMENT1','created_at_utc':datetime.now(timezone.utc).isoformat(),
            'git_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
            'device':'cpu','torch':torch.__version__,'stable_baselines3':sb3.__version__,'gymnasium':gym.__version__,
            'algorithm':'SAC','architecture':[64,64],'activation':'ReLU','observation_dim':47,'action_dim':3,
            'actions':['gate [-1,1]; <=0 NO_INTERVENTION','extra brake [0,1]','steering delta [-1,1] * .15; rejected without side evidence'],
            'seed':seed,'scenario':'SUDDEN_BRAKING','parameters':PARAMETERS,'train_seeds':TRAIN_SEEDS,
            'validation_seeds':VALIDATION_SEEDS,'test_seeds':TEST_SEEDS,'hyperparameters':hyper,
            'training_step_limit':args.steps,'wall_clock_limit_s':args.seconds,
            'reward':'GATE6_UNCHANGED','checkpoint_selection':'LAST_CHECKPOINT; no selection using TEST',
            'production_policy_enabled':False,'initial_memory':memory()}
    write(root/'config.json',config)
    source_files=sorted((ROOT/'backend').rglob('*.py'))+[Path(__file__).resolve()]
    write(root/'source-hashes.json',{str(path.relative_to(ROOT)).replace('\\','/'):
          hashlib.sha256(path.read_bytes()).hexdigest() for path in source_files})
    (root/'working-tree.patch').write_bytes(subprocess.check_output(['git','diff','--binary'],cwd=ROOT))
    (root/'supervisor.py').write_bytes((ROOT/'backend/rl/supervisor.py').read_bytes())
    (root/'run_experiment1.py').write_bytes(Path(__file__).read_bytes())
    # Evaluate diagnostic reward-hacking strategies before learning; no tuning.
    evaluate(root,'diagnostic_always_brake','VALIDATION',[1042],'ALWAYS_BRAKE')
    evaluate(root,'diagnostic_constant_steer','VALIDATION',[1042],'CONSTANT_STEER')
    counters={'steps':0,'resets':0,'max_steps':args.steps}
    started=time.monotonic();deadline=started+args.seconds-65
    write(guard,{'run':str(root),'started_utc':datetime.now(timezone.utc).isoformat(),'limits':config['training_step_limit']})
    env=TrainingEnv(root,counters,deadline)
    model=SAC('MlpPolicy',env,policy_kwargs={'net_arch':[64,64]},seed=seed,device='cpu',verbose=0,**hyper)
    model.set_logger(configure(str(root/'sb3'),['csv']))
    model.save(root/'initial_model')
    initial_weights=torch.cat([p.detach().flatten().cpu() for p in model.actor.parameters()]).numpy().copy()
    checkpoints=[];stop_reason='STEP_LIMIT';error=None
    try:
        while model.num_timesteps<args.steps and time.monotonic()<deadline:
            target=min(args.steps,((model.num_timesteps//2500)+1)*2500)
            model.learn(total_timesteps=target-model.num_timesteps,reset_num_timesteps=False,
                        callback=BudgetCallback(root,deadline,args.steps),log_interval=1)
            env.close()
            path=root/f'model_{model.num_timesteps}'
            model.save(path)
            checkpoint={'steps':model.num_timesteps,'path':str(path)+'.zip','sha256':model_hash(path.with_suffix('.zip')),
                        'elapsed_s':time.monotonic()-started}
            checkpoints.append(checkpoint);write(root/'checkpoints.json',checkpoints)
            if time.monotonic()<deadline:
                evaluate(root,f'validation_{model.num_timesteps}','VALIDATION',VALIDATION_SEEDS,'SAC',model,deadline)
            if model.num_timesteps<args.steps and time.monotonic()<deadline:
                env=TrainingEnv(root,counters,deadline);model.set_env(env)
        if model.num_timesteps<args.steps:stop_reason='WALL_CLOCK_LIMIT'
    except BudgetReached as exc:stop_reason='WALL_CLOCK_LIMIT';error=str(exc)
    except Exception as exc:stop_reason='INFRASTRUCTURE_FAILURE';error=repr(exc)
    finally:
        elapsed=time.monotonic()-started
        model.save(root/'final_model');model.save_replay_buffer(root/'replay_buffer.pkl')
        env.close()
        final_weights=torch.cat([p.detach().flatten().cpu() for p in model.actor.parameters()]).numpy()
        train_result={'steps':model.num_timesteps,'physics_training_steps':counters['steps'],'duration_s':elapsed,
                      'stop_reason':stop_reason,'error':error,'model':str(root/'final_model.zip'),
                      'model_sha256':model_hash(root/'final_model.zip'),
                      'actor_parameter_count':len(final_weights),'actor_parameter_change_l2':float(np.linalg.norm(final_weights-initial_weights)),
                      'checkpoints':checkpoints,'final_memory':memory()}
        write(root/'training-result.json',train_result)
    if error and stop_reason=='INFRASTRUCTURE_FAILURE':raise RuntimeError('Training stopped safely: '+error)
    # Final TEST evaluation occurs after all weights and selection are frozen.
    initial=SAC.load(root/'initial_model.zip',device='cpu')
    final=SAC.load(root/'final_model.zip',device='cpu')
    comparisons={}
    for name,controller,policy in [('basic_agent','NONE',None),('rule_safety','RULE',None),
                                    ('untrained_sac','SAC',initial),('trained_sac','SAC',final)]:
        identity=name+'_'+(model_hash(root/'final_model.zip')[:16] if name=='trained_sac' else 'EXPERIMENT1')
        result=evaluate(root,identity,'TEST',TEST_SEEDS,controller,policy)
        comparisons[name]=result
    for index,seed in enumerate(TEST_SEEDS):
        hashes={result['episodes'][index]['condition_hash'] for result in comparisons.values()}
        if len(hashes)!=1:raise RuntimeError('Held-out comparison configurations do not match')
    restored=state()
    assert restored['connected'] and not restored['rlRuntime']['active'] and restored['mode']=='PAUSED'
    final_result={'run':str(root),'training':train_result,'comparisons':comparisons,
                  'matched_test_configurations':True,'final_memory':memory(),
                  'normal_runtime_restored':True,'production_policy_enabled':False}
    write(root/'result.json',final_result)
    write(ROOT/'output/native-validation/experiment1-run.json',{'run':str(root),'result':str(root/'result.json')})
    print(json.dumps({'run':str(root),'training':train_result,
                      'comparisons':{k:v['summary'] for k,v in comparisons.items()}}),flush=True)


if __name__=='__main__':main()
