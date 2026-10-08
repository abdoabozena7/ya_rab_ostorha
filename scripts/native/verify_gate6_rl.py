"""Real service-owned CARLA episode acceptance. No direct client tick/control."""
import argparse
import json
import math
from pathlib import Path
import statistics
import time
import urllib.request
import urllib.error
import numpy as np
from gymnasium.utils.passive_env_checker import env_reset_passive_checker, env_step_passive_checker
from backend.rl.env import YaRabOstorhaEnv, HttpTransport
from backend.core.replay import ReplayReader
from backend.rl.evaluation import summarize
from .stability_run import backend_pid, memory


def state():
    with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/state',timeout=5) as r:return json.load(r)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',default='output/native-validation/gate6-rl.json')
    parser.add_argument('--quick',action='store_true')
    args=parser.parse_args()
    proof={'source':'LIVE_NATIVE_CARLA_0.9.16','checks':{},'episodes':[],'repeated_resets':[],
           'memory':[],'step_wall_ms':[],'reset_wall_s':[]}
    path=Path(args.output);path.parent.mkdir(parents=True,exist_ok=True)
    def save():path.write_text(json.dumps(proof,indent=2,allow_nan=False),encoding='utf8')
    pid=backend_pid(8000)
    before=state();proof['initial_state']={k:before[k] for k in ('mode','synchronization','sensorErrors')}
    seeds=[42] if args.quick else [42,43]
    try:
        with YaRabOstorhaEnv() as env:
            for kind in ('FRONT_OBSTACLE','SUDDEN_BRAKING'):
                for seed in seeds:
                    for outcome in ('TIMEOUT','COLLISION','SUCCESS'):
                        params={'time_limit_s':.3 if outcome=='TIMEOUT' else 12.}
                        start=time.monotonic()
                        observation,info=env.reset(seed=seed,options={'scenario':kind,'parameters':params})
                        proof['reset_wall_s'].append(time.monotonic()-start)
                        assert env.observation_space.contains(observation)
                        assert info['reset_cleanup_verified']
                        assert info['actor_inventory']=={'vehicles':2,'sensors':7,'walkers':0,'controllers':0}
                        initial=info['initial_configuration']
                        initial_sync=state()['synchronization']
                        native_frame=info['frame_id'];native_time=info['timestamp_s']
                        # Coordinated idle must not tick merely to keep cameras alive.
                        time.sleep(.12)
                        assert state()['vehicle']['frame']==native_frame
                        if not proof['checks'].get('exclusive_tick_owner'):
                            try:HttpTransport()('acquire')
                            except RuntimeError:pass
                            else:raise AssertionError('Second lease accepted')
                            try:HttpTransport()('step',token=env.token,action=[0,0,0],frame_id=native_frame-1,timestamp_s=native_time)
                            except ValueError:pass
                            else:raise AssertionError('Stale command accepted')
                            request=urllib.request.Request('http://127.0.0.1:8000/api/simulation/control',
                                json.dumps({'throttle':1.,'brake':0.,'steering':0.,'frame_id':native_frame,'timestamp_s':native_time}).encode(),
                                {'Content-Type':'application/json'})
                            try:urllib.request.urlopen(request,timeout=5)
                            except urllib.error.HTTPError as error:
                                rejection=json.load(error)['error']
                                assert 'Exclusive RL' in rejection or 'Browser connection controls' in rejection,rejection
                                proof['manual_rejection_reason']=rejection
                            else:raise AssertionError('Manual command accepted')
                            for invalid in ([float('nan'),0,0],[0,float('inf'),0]):
                                try:env.step(invalid)
                                except ValueError:pass
                                else:raise AssertionError('Nonfinite action accepted')
                            assert state()['vehicle']['frame']==native_frame
                            proof['checks'].update(exclusive_tick_owner=True,stale_action_rejected=True,invalid_actions_rejected=True)
                        steps=0
                        while not env.done:
                            # Fixed action schedules are diagnostics, not learned safety.
                            braking_at=60 if kind=='FRONT_OBSTACLE' else 48
                            action=[0.,0.,1.] if outcome=='SUCCESS' and steps>=braking_at else [0.,.4,0.]
                            start=time.monotonic()
                            observation,reward,terminated,truncated,info=env.step(action)
                            proof['step_wall_ms'].append((time.monotonic()-start)*1000)
                            assert env.observation_space.contains(observation)
                            assert info['observation_valid'],info
                            assert info['frame_id']==native_frame+1,(native_frame,info)
                            assert abs(info['timestamp_s']-native_time-.05)<1e-5
                            assert abs(reward-sum(info['reward_components'].values()))<1e-6
                            native_frame=info['frame_id'];native_time=info['timestamp_s'];steps+=1
                        recording=Path(info['recording_path'])
                        actual=json.loads((recording/'outcome.json').read_text(encoding='utf8'))
                        final_sync=state()['synchronization']
                        episode_issues={key:final_sync['issues'][key]-initial_sync['issues'][key] for key in final_sync['issues']}
                        assert not any(episode_issues.values()),episode_issues
                        assert final_sync['incompleteFrames']==initial_sync['incompleteFrames']
                        proof['episodes'].append({'kind':kind,'seed':seed,'expected':outcome,'actual':actual,
                                                  'recording_path':str(recording),'initial_configuration':initial,
                                                  'synchronization_issues':episode_issues})
                        print(json.dumps({'kind':kind,'seed':seed,'expected':outcome,'actual':actual['outcome'],
                                          'metrics':actual['metrics']}),flush=True)
                        save()
                        assert info['outcome']==outcome,actual
                        assert terminated==(outcome!='TIMEOUT') and truncated==(outcome=='TIMEOUT')
                        try:env.step([0,1,0])
                        except RuntimeError:pass
                        else:raise AssertionError('Completed episode accepted action')
                        reader=ReplayReader(recording);frames=list(reader.frames());events=list(reader.events())
                        assert len(frames)==steps+1 and all(f.complete for f in frames)
                        assert any('rl_episode_outcome' in e.payload for e in events)
                        assert sum('rl_step' in e.payload for e in events)==steps
                        assert len(list(recording.glob('rgb/*')))==len(frames)
                        for _ in range(2):
                            _,repeat=env.reset(seed=seed,options={'scenario':kind,'parameters':params})
                            a=initial['intended_initial_states']['actors'];b=repeat['initial_configuration']['intended_initial_states']['actors']
                            deviations=[math.dist(x['transform']['position_m'],y['transform']['position_m']) for x,y in zip(a,b)]
                            speeds=[math.dist(x['velocity_mps'],y['velocity_mps']) for x,y in zip(a,b)]
                            assert repeat['initial_configuration']['scenario_spec']==initial['scenario_spec']
                            assert max(deviations)<.3 and max(speeds)<.3,(deviations,speeds)
                            proof['repeated_resets'].append({'kind':kind,'seed':seed,'position_deviation_m':deviations,
                                                            'velocity_deviation_mps':speeds,'cleanup_verified':repeat['reset_cleanup_verified']})
                        proof['memory'].append(memory(pid));save()
            proof['checks'].update(both_native_scenarios=True,reproducible_configuration=True,clean_reset=True,
                                  sensor_count_stable=True,recorded_assets_and_outcomes=True,post_episode_action_rejected=True)
        after=state()
        assert after['connected'] and not after['rlRuntime']['active'] and after['environment']['mode']=='LIVING_CITY'
        assert len(after['sensorRegistry'])==7 and not after['sensorErrors']
        proof['checks']['restored_normal_runtime']=True
        proof['performance']={'step_ms_median':statistics.median(proof['step_wall_ms']),
                              'step_ms_max':max(proof['step_wall_ms']),
                              'reset_s_median':statistics.median(proof['reset_wall_s']),
                              'memory_private_mib_minmax':[min(r['private_mib'] for r in proof['memory']),max(r['private_mib'] for r in proof['memory'])]}
        proof['measured_diagnostic_summary']=summarize([e['recording_path'] for e in proof['episodes']])
        proof['pass']=all(proof['checks'].values());save()
        print(json.dumps({'pass':proof['pass'],'episodes':len(proof['episodes']),'performance':proof['performance']}),flush=True)
    except Exception as error:
        proof['pass']=False;proof['error']=repr(error);save();raise


if __name__=='__main__':main()
