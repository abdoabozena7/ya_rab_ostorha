"""Replay the failed action sequence on repaired native delivery; no learning."""
import json
from pathlib import Path
import numpy as np
from backend.rl.supervisor import SafetySupervisorEnv
from .run_experiment1 import ROOT,PARAMETERS,write,state


def main():
    root=Path(json.loads((ROOT/'runs/experiments/experiment1-training-started.json').read_text())['run'])
    resets=[json.loads(x) for x in (root/'training-resets.jsonl').read_text().splitlines()]
    episode=resets[-1]['info']['episode_id'];seed=resets[-1]['info']['seed']
    rows=[json.loads(x) for x in (root/'training-steps.jsonl').read_text().splitlines() if json.loads(x)['episode_id']==episode]
    events=[json.loads(x) for x in (Path(resets[-1]['info']['recording_path'])/'events/events.jsonl').read_text().splitlines()]
    failed=next(row['payload']['rl_failed_step'] for row in events if 'rl_failed_step' in row['payload'])
    actions=[r['proposed_action'] for r in rows]+[failed['proposed_action']]
    result={'source':'LIVE_NATIVE_CARLA_0.9.16','original_episode':episode,'seed':seed,
            'actions_replayed':len(actions),'training_resumed':False,'frozen_model_used_for_inference':False}
    with SafetySupervisorEnv(parameters=PARAMETERS,policy_id='FAILED_SEQUENCE_DIAGNOSTIC_REPLAY') as env:
        _,initial=env.reset(seed=seed);previous=initial['frame_id']
        for action in actions:
            _,_,terminated,truncated,info=env.step(action)
            assert info['observation_valid'],info.get('error')
            assert info['frame_id']==previous+1;previous=info['frame_id']
            np.testing.assert_allclose(info['native_applied_action'],info['applied_action'],atol=1e-5,rtol=0)
            assert not terminated and not truncated
        result.update(original_attempted_action=failed['attempted_action'],
                      replayed_expected_action=info['applied_action'],native_applied_action=info['native_applied_action'],
                      recording_path=info['recording_path'],reset_cleanup_verified=initial['reset_cleanup_verified'])
    restored=state();assert restored['connected'] and not restored['rlRuntime']['active']
    result['pass']=True;write(ROOT/'output/native-validation/experiment1-failed-sequence-replay.json',result)
    print(json.dumps(result))


if __name__=='__main__':main()
