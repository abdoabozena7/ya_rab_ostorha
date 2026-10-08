"""Bounded Experiment 1.1 diagnostics. No model, learning, or runtime changes.

The scripted supervisor sees only current onboard arrays. It initially brakes,
releases to BasicAgent when measured forward space permits, then stops again.
Ground truth remains exclusively in the existing recorder/reward evaluator.
"""
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import subprocess
import time
import urllib.request
import numpy as np
from backend.rl.supervisor import SafetySupervisorEnv

ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT/'runs/experiments/experiment1_20261008T165154Z/final_model.zip'
PARAMETERS = {'ego_speed_mps':8., 'following_distance_m':18., 'lead_speed_mps':5.,
              'lead_brake':1., 'trigger_s':2., 'time_limit_s':12.}
PLAN = [('no_intervention',2042,'TEST'), ('stationary',2042,'TEST'),
        ('late_braking',2042,'TEST'), ('brake_resume_stop',2042,'TEST'),
        ('brake_resume_stop',2043,'TEST'), ('brake_resume_stop',1042,'VALIDATION')]


def write(path, value):
    path.write_text(json.dumps(value, indent=2, allow_nan=False)+'\n', encoding='utf8')


def state():
    with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/state', timeout=5) as r:
        return json.load(r)


class ScriptedBrakeResumeStop:
    """Diagnostic controller, not a learned or production safety policy.

    Height screening is local radar geometry with the audited 0.65 m mounting
    height. It supplies no target identity, world pose, or side-space evidence.
    Flat-road approximation is explicitly limited to this straight prototype.
    """
    def __init__(self):
        self.phase = 'INITIAL_BRAKE'
        self.travel = 0.
        self.previous_speed = None
        self.previous_time = None
        self.initial_time = None

    def action(self, raw):
        speed = float(raw['ego'][-1,0])
        timestamp = float(raw['frame_time'][-1,1])
        if self.initial_time is None:
            self.initial_time = timestamp
        if self.previous_time is not None:
            self.travel += (speed+self.previous_speed)*.5*(timestamp-self.previous_time)
        self.previous_time, self.previous_speed = timestamp, speed
        elapsed = timestamp-self.initial_time
        points = raw['radar'][-1][raw['radar_valid'][-1].astype(bool)]
        elevated = points[(np.abs(points[:,1])<.12) &
                          (.65+points[:,0]*np.sin(points[:,2])>.25)]
        distance = float(elevated[:,0].min()) if len(elevated) else None
        threshold = 3.+speed*.35+speed*speed/(2.*5.)
        safe_to_continue = distance is not None and distance>max(6.,threshold)
        if self.phase == 'INITIAL_BRAKE' and elapsed>=1. and speed<.2 and safe_to_continue:
            self.phase = 'RESUME_BASE'
        if self.phase == 'RESUME_BASE' and (self.travel>=10.75 or not safe_to_continue):
            self.phase = 'FINAL_BRAKE'
        action = [-1.,0.,0.] if self.phase=='RESUME_BASE' else [1.,1.,0.]
        return np.array(action,np.float32), {'script_phase':self.phase, 'onboard_distance_m':self.travel,
            'onboard_elapsed_s':elapsed,'elevated_radar_range_m':distance,
            'sensor_stopping_threshold_m':threshold,'safe_to_continue':safe_to_continue}


def main():
    frozen = hashlib.sha256(MODEL.read_bytes()).hexdigest()
    initial_state = state()
    assert initial_state['connected'] and not initial_state['rlRuntime']['active']
    root = ROOT/'runs/diagnostics'/datetime.now(timezone.utc).strftime('experiment1_1_%Y%m%dT%H%M%SZ')
    root.mkdir(parents=True,exist_ok=False)
    write(root/'protocol.json', {'experiment':'EXPERIMENT1.1_DIAGNOSIS_ONLY', 'plan':PLAN,
        'maximum_episodes':6,'maximum_action_steps':1440,'wall_limit_s':900,
        'parameters':PARAMETERS,'reward_changes':False,'success_condition_changes':False,
        'training':False,'model_sha256':frozen,'git_head':subprocess.check_output(
            ['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
        'script_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'initial_runtime_state':initial_state})
    write(ROOT/'output/native-validation/experiment1-1-run.json',{'run':str(root)})
    began=time.monotonic(); deadline=began+900; total_steps=0; episodes=[]
    for name,seed,split in PLAN:
        assert time.monotonic()<deadline and total_steps<1440
        controller=ScriptedBrakeResumeStop(); sums=defaultdict(float); trace=[]; phases=[]
        with SafetySupervisorEnv(split=split,parameters=PARAMETERS,
                policy_id='EXPERIMENT1.1_SCRIPTED_'+name) as env:
            obs,initial=env.reset(seed=seed)
            assert initial['reset_cleanup_verified']
            assert initial['actor_inventory']=={'vehicles':2,'sensors':7,'walkers':0,'controllers':0}
            previous=initial['frame_id']; start_time=initial['timestamp_s']; latencies=[]
            for step in range(240):
                assert time.monotonic()<deadline and total_steps<1440
                diagnostics={}
                if name=='no_intervention': action=np.array([-1.,0.,0.],np.float32)
                elif name=='stationary': action=np.array([1.,1.,0.],np.float32)
                elif name=='late_braking':
                    # Time from real synchronized observation, never actor geometry.
                    elapsed=float(env.raw_observation['frame_time'][-1,1])-start_time
                    action=np.array([1.,1.,0.] if elapsed>=3.25 else [-1.,0.,0.],np.float32)
                else:
                    action,diagnostics=controller.action(env.raw_observation)
                    if not phases or phases[-1]['phase']!=diagnostics['script_phase']:
                        phases.append({'step':step,'phase':diagnostics['script_phase'],**diagnostics})
                started=time.perf_counter(); obs,reward,t,tr,info=env.step(action)
                latencies.append((time.perf_counter()-started)*1000);total_steps+=1
                assert info['observation_valid'] and env.observation_space.contains(obs)
                assert info['frame_id']==previous+1;previous=info['frame_id']
                assert info['tick_owner']=='simulation-worker'
                np.testing.assert_allclose(info['applied_action'],info['native_applied_action'],atol=1e-5,rtol=0)
                for key,value in info['reward_components'].items(): sums[key]+=value
                trace.append({'info':info,'reward':reward,'script':diagnostics})
                if t or tr: break
            assert t or tr
            outcome=json.loads((Path(info['recording_path'])/'outcome.json').read_text())
            result={'name':name,'seed':seed,'split':split,'initial':initial,'outcome':outcome,
                'reward_components':dict(sums),'script_phases':phases,'step_latency_ms':{
                    'median':float(np.median(latencies)),'p95':float(np.percentile(latencies,95))}}
            trace_path=root/f'{name}_{seed}-steps.jsonl'
            with trace_path.open('w',encoding='utf8') as f:
                for row in trace:f.write(json.dumps(row,allow_nan=False)+'\n')
        assert env.native.last_close_info['restored']
        result['close_info']=env.native.last_close_info; episodes.append(result)
        write(root/'episodes.json',episodes)
        print(json.dumps({'name':name,'seed':seed,'outcome':outcome['outcome'],
            'progress_m':outcome['metrics']['forward_progress_m'],'return':outcome['reward'],
            'recording':info['recording_path'],'script_phases':phases}),flush=True)
    restored=state()
    assert restored['connected'] and restored['mode']=='PAUSED' and not restored['rlRuntime']['active']
    assert hashlib.sha256(MODEL.read_bytes()).hexdigest()==frozen
    write(root/'result.json',{'episodes':episodes,'actual_steps':total_steps,
        'duration_wall_s':time.monotonic()-began,'runtime_restored':True,'final_runtime_state':restored,
        'training':False,'unchanged_model_sha256':frozen,'reward_changes':False,'success_changes':False})
    print(json.dumps({'run':str(root),'actual_steps':total_steps,'complete':True}),flush=True)


if __name__=='__main__':main()
