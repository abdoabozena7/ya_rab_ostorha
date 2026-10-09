"""Single bounded integration repair acceptance. Frozen model; new splits/seeds."""
import hashlib
import json
import time
from . import verify_final_delivery as native
from .verify_urban_world import Session


def main():
    if (native.EVIDENCE/'hybrid-v2.json').exists():
        raise ValueError('Frozen hybrid acceptance evidence is preserved. Use the delivery demonstration command.')
    began=time.monotonic();deadline=began+150
    result={'hybrid_version':'YA_RAB_OSTORHA_RULE_RELEASE_GUARD_V2','cases':[],'model_retrained':False}
    with Session() as s:
        specs=[native.compiled(s,'SUDDEN_BRAKING',1893,'VALIDATION'),native.compiled(s,'FRONT_OBSTACLE',1729,'VALIDATION'),
            native.compiled(s,'SUDDEN_BRAKING',2947,'TEST')]
        protocol={'predeclared_epoch':time.time(),'selections':[(x.scenario_type.value,x.random_seed,x.split.value) for x in specs],
            'weights_sha256':hashlib.sha256((native.ROOT/'artifacts/learned_safety/v1/weights.npz').read_bytes()).hexdigest(),
            'model_and_thresholds_unchanged':True,'change':'Rule release-envelope guard on unsupported learned braking',
            'maximum_additional_episodes':4,'maximum_additional_wall_s':150,
            'previous_test_results_retained':'docs/evidence/final_delivery/native.json','scalar_evidence_only':True}
        (native.EVIDENCE/'hybrid-v2-protocol.json').write_text(json.dumps(protocol,indent=2))
        for spec in specs[:2]:
            row=native.check(s,spec,'HYBRID','AUTOMATIC',deadline,record_images=False);result['cases'].append(row)
            if not row['success'] or not row['resumed_progress'] or row['application_mismatches']:
                result['stopped_reason']='VALIDATION_FAILURE';break
        else:
            result['configuration_frozen_before_fresh_test']=True
            for controller in ('RULE','HYBRID'):
                result['cases'].append(native.check(s,specs[2],controller,'AUTOMATIC',deadline,record_images=False))
        s.send('safety_mode',value={'enabled':True,'controller':'RULE'})
        result['inventory']=s.inventory();result['rl_runtime']=s.state['rlRuntime']
        result['accepted']=len(result['cases'])==4 and all(x['success'] and x['resumed_progress'] and not x['application_mismatches'] and
                x['all_observations_complete'] and not x['sensor_errors'] for x in result['cases'])
    result['wall_s']=time.monotonic()-began
    (native.EVIDENCE/'hybrid-v2.json').write_text(json.dumps(result,indent=2))
    print(json.dumps({'accepted':result['accepted'],'episodes':len(result['cases']),'wall_s':result['wall_s']}),flush=True)

if __name__=='__main__':main()
