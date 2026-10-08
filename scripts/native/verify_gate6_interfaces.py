"""Native Gymnasium checks, sensor profiles, baselines and abort paths."""
import json
from pathlib import Path
import time
from gymnasium.utils.env_checker import check_env
from backend.rl.env import YaRabOstorhaEnv, HttpTransport
from backend.rl.evaluation import summarize
from .verify_gate6_rl import state


def main():
    proof={'source':'LIVE_NATIVE_CARLA_0.9.16','checks':{},'profiles':[],'baselines':[],'outcomes':[]}
    path=Path('output/native-validation/gate6-interfaces.json')
    def save():path.write_text(json.dumps(proof,indent=2,allow_nan=False),encoding='utf8')
    try:
        with YaRabOstorhaEnv() as env:
            check_env(env,skip_render_check=True,skip_close_check=True)
            proof['checks']['gymnasium_checker']=True
        for profile in ('lightweight','multimodal','evaluation'):
            with YaRabOstorhaEnv(profile=profile,max_steps=1,parameters={'time_limit_s':1.}) as env:
                observation,info=env.reset(seed=42)
                observation,reward,terminated,truncated,info=env.step([2.,1.,.5])
                assert not terminated and truncated and info['truncation_reason']=='maximum_steps'
                assert env.observation_space.contains(observation)
                assert info['applied_action'][1]==0. and abs(info['applied_action'][0])<=.0750001
                proof['profiles'].append({'name':profile,'shapes':{k:list(v.shape) for k,v in observation.items()},
                                          'recording_path':info['recording_path'],'outcome':info['outcome']})
            assert env.last_close_info['restored'];save()
        proof['checks']['all_sensor_profiles']=True
        for split,seed in (('VALIDATION',1042),('TEST',2042)):
            with YaRabOstorhaEnv(split=split,max_steps=1) as env:
                _,info=env.reset(seed=seed)
                _,_,_,_,info=env.step([0,0,1])
                assert f'/{split}/' in info['recording_path'].replace('\\','/')
                proof['outcomes'].append(info)
        proof['checks']['held_out_splits']=True
        for baseline in ('SCRIPTED_DIAGNOSTIC','CONSERVATIVE_RADAR_BRAKING','BASIC_AGENT_NO_SAFETY'):
            for kind in ('FRONT_OBSTACLE','SUDDEN_BRAKING'):
                with YaRabOstorhaEnv(baseline_id=baseline,scenario=kind) as env:
                    observation,initial=env.reset(seed=42)
                    while not env.done:
                        action=env.transport('baseline',token=env.token)['action']
                        observation,_,_,_,info=env.step(action)
                    result=json.loads((Path(info['recording_path'])/'outcome.json').read_text(encoding='utf8'))
                    proof['baselines'].append({'kind':kind,'seed':42,'baseline':baseline,'result':result,
                                              'recording_path':info['recording_path'],
                                              'scenario_spec':initial['initial_configuration']['scenario_spec']})
                    print(json.dumps({'baseline':baseline,'scenario':kind,'outcome':result['outcome']}),flush=True);save()
        proof['checks']['three_real_baselines']=True
        for kind in ('FRONT_OBSTACLE','SUDDEN_BRAKING'):
            rows=[r for r in proof['baselines'] if r['kind']==kind]
            assert all(r['scenario_spec']==rows[0]['scenario_spec'] for r in rows)
        proof['checks']['matched_baseline_configurations']=True
        # External abort uses the already-supported operator emergency request.
        from websockets.sync.client import connect
        with connect('ws://127.0.0.1:8001',max_size=2**23) as ws:
            ws.recv();ws.send(json.dumps({'type':'take_control','sequence':1}))
            while True:
                row=json.loads(ws.recv(timeout=5))
                if row['type']=='error':raise RuntimeError(row['error'])
                if row.get('acknowledged')==1:break
            with YaRabOstorhaEnv() as env:
                env.reset(seed=42)
                ws.send(json.dumps({'type':'emergency_stop','sequence':2}))
                while True:
                    row=json.loads(ws.recv(timeout=5))
                    if row['type']=='error':raise RuntimeError(row['error'])
                    if row.get('acknowledged')==2:break
                observation,_,terminated,truncated,info=env.step([0,.4,0])
                assert not terminated and truncated and info['outcome']=='ABORTED' and not info['observation_valid']
                proof['checks']['external_emergency_abort']=True
                proof['outcomes'].append(info)
            ws.send(json.dumps({'type':'acknowledge_stop','sequence':3}))
            while True:
                row=json.loads(ws.recv(timeout=5))
                if row['type']=='error':raise RuntimeError(row['error'])
                if row.get('acknowledged')==3:break
        # Acknowledge the operator stop through the existing dashboard contract.
        assert state()['connected'] and not state()['rlRuntime']['active']
        proof['checks']['restored_after_abort']=True
        proof['summaries']={b:summarize([r['recording_path'] for r in proof['baselines'] if r['baseline']==b]) for b in
                            ('SCRIPTED_DIAGNOSTIC','CONSERVATIVE_RADAR_BRAKING','BASIC_AGENT_NO_SAFETY')}
        proof['pass']=all(proof['checks'].values());save();print(json.dumps({'pass':proof['pass'],'checks':proof['checks']}),flush=True)
    except Exception as error:
        proof['pass']=False;proof['error']=repr(error);save();raise


if __name__=='__main__':main()
