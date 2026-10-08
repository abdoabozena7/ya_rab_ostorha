"""Native preflight only. This script performs no gradient updates."""
import json
from pathlib import Path
import urllib.request
import numpy as np
from backend.rl.env import YaRabOstorhaEnv
from backend.rl.supervisor import SafetySupervisorEnv


def state():
    with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/state',timeout=5) as r:
        return json.load(r)


def main():
    result={'source':'LIVE_NATIVE_CARLA_0.9.16','checks':{},'episodes':[]}
    with SafetySupervisorEnv(parameters={'time_limit_s':.5},policy_id='ADAPTER_PREFLIGHT') as env:
        obs,initial=env.reset(seed=42)
        assert obs.shape==(47,) and env.observation_space.contains(obs)
        assert initial['reset_cleanup_verified'] and initial['actor_inventory']=={'vehicles':2,'sensors':7,'walkers':0,'controllers':0}
        other=YaRabOstorhaEnv()
        try:other.reset(seed=42)
        except RuntimeError as error:assert 'exclusive RL session' in str(error)
        else:raise AssertionError('Competing lease admitted')
        finally:other.close()
        base=initial['base_proposed_action'];previous=initial['frame_id']
        for action in ([-1.,1.,1.],[1.,1.,1.],[-1.,0.,0.],[1.,.8,0.],[-1.,0.,0.],[-1.,0.,0.],[-1.,0.,0.],[-1.,0.,0.],[-1.,0.,0.],[-1.,0.,0.]):
            obs,reward,t,tr,info=env.step(action)
            assert info['frame_id']==previous+1;previous=info['frame_id']
            assert env.observation_space.contains(obs) and info['observation_valid']
            np.testing.assert_allclose(info['native_applied_action'],info['applied_action'],atol=1e-5,rtol=0)
            if action[0]<=0:
                assert info['intervention']['decision']=='NO_INTERVENTION'
                np.testing.assert_allclose(info['applied_action'],base,atol=1e-6,rtol=0)
            elif action[2]>0:assert info['intervention']['steering_adjustment_rejected']
            base=info['next_base_proposed_action']
            if t or tr:break
        assert tr and info['outcome']=='TIMEOUT'
        result['episodes'].append(info)
        _,second=env.reset(seed=42)
        assert second['reset_cleanup_verified'] and second['actor_inventory']==initial['actor_inventory']
        assert second['initial_configuration']['scenario_spec']==initial['initial_configuration']['scenario_spec']
        try:env.native.transport('step',token=env.native.token,action=[1,1,0],frame_id=initial['frame_id'],timestamp_s=initial['timestamp_s'])
        except ValueError as error:assert 'latest RL observation' in str(error)
        else:raise AssertionError('Stale intervention admitted')
    after=state()
    assert after['connected'] and not after['rlRuntime']['active'] and after['mode']=='PAUSED'
    result['checks']={key:True for key in ('sensor_only_vector','one_tick_per_step','exclusive_lease',
        'base_proposal_preserved','no_intervention_clears_previous_safety','native_controls_match',
        'steering_rejected_without_side_evidence','stale_intervention_rejected','reset_cleanup','normal_runtime_restored')}
    result['pass']=True
    target=Path('output/native-validation/experiment1-adapter.json')
    target.write_text(json.dumps(result,indent=2),encoding='utf8')
    print(json.dumps({'pass':True,'checks':result['checks']}))


if __name__=='__main__':main()
