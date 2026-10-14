"""Package retained motion evidence without replay, training or native mutation."""
import hashlib
import json
from pathlib import Path
import shutil
import math
from backend.learning.motion_budget import MotionBudget
from scripts.final_runtime import state

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'output/motion-reliability'
EVIDENCE=ROOT/'docs/evidence/motion_reliability_20261013'


def read(name):return json.loads((OUT/name).read_text(encoding='utf8'))
def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    EVIDENCE.mkdir(parents=True,exist_ok=True)
    current=state();original=read('operator-original.json');frozen=read('frozen-evaluation-tracker-fix.json')
    budget=MotionBudget().status();(OUT/'budget.json').write_text(json.dumps(budget,indent=2))
    lock=json.loads((ROOT/'config/trajectron-lock.json').read_text())
    metadata=json.loads((ROOT/'artifacts/learned_safety/v1/metadata.json').read_text())
    review={}
    directory=ROOT/'runs/experiments/experiment1_20261008T165154Z'
    for name in ('trained_sac_9b3bceb0c77aaea8','untrained_sac_EXPERIMENT1'):
        path=directory/(name+'.json');value=json.loads(path.read_text())
        review[name]={'source':str(path.relative_to(ROOT)),'sha256':digest(path),'summary':value['summary'],
            'policy_active_episodes':sum(bool(e['outcome'].get('policy_active')) for e in value['episodes'])}
    review['interpretation']='Historical stored reports, not a new paired experiment. The trained report records policy_active=false; its outcomes cannot establish active SAC performance. Existing interface is 47 sensor features and [gate, extra_brake, steering_delta]; the validator admits extra braking only, never acceleration or unverified steering.'
    review['weights']={name:digest(directory/name) for name in ('initial_model.zip','final_model.zip')}
    (OUT/'sac-review.json').write_text(json.dumps(review,indent=2))
    final={'mode':current['mode'],'speed_kmh':current['vehicle']['speedKmh'],'position':current['vehicle']['positionWorldM'],
        'original_position':original['vehicle']['positionWorldM'],
        'position_error_m':math.dist(current['vehicle']['positionWorldM'],original['vehicle']['positionWorldM']),
        'destination_restored':current['route']['destination']['location']==original['destination']['location'],
        'population_restored':current['population']['requested']==original['population'],
        'preferences_semantically_restored':json.loads((ROOT/'config/dashboard-preferences.json').read_text())==json.loads(original['preferences']),
        'display_camera':{k:current['displayCamera'][k] for k in ('width','height','fovDeg','mountTransform')},
        'sensor_errors':current['sensorErrors'],
        'old_ledger_sha256':digest(ROOT/'output/predictive-v2/budget.sqlite'),
        'old_ledger_hash_unchanged':digest(ROOT/'output/predictive-v2/budget.sqlite')==read('frozen-evaluation.json')['old_ledger_sha256'],
        'old_bc_weights_match_metadata':digest(ROOT/'artifacts/learned_safety/v1/weights.npz')==metadata['weights_sha256'],
        'trajectron_weights_match_lock':digest(ROOT/'.cache/trajectron/model_registrar-12.pt')==lock['weights_sha256'],
        'frozen_test_files_unchanged':all(digest(ROOT/r['directory']/'telemetry/frames.jsonl')==r['frames_sha256'] for r in frozen['frozen']['runs']),
        'prototype_config':json.loads((ROOT/'config/motion-reliability.json').read_text()),'budget':budget}
    (OUT/'delivery-state.json').write_text(json.dumps(final,indent=2))
    names=('baseline.json','native-validation.json','native-scenarios.json','native-scenarios-initial-error.json',
        'native-scenarios-tracker-fix.json','frozen-test.json','frozen-evaluation.json','frozen-evaluation-tracker-fix.json',
        'supervised-selector.json','rule-current-validation.json','rule-final-smoke.json','performance-final.json',
        'performance-delivery.json','performance-display-budget.json','performance-display-initial-error.json',
        'operator-restored.json','budget.json','delivery-state.json','sac-review.json')
    manifest=[]
    for name in names:
        path=OUT/name;shutil.copy2(path,EVIDENCE/name);manifest.append({'path':str(path.relative_to(ROOT)),'sha256':digest(path)})
    for name in ('motion-python-tests.log','motion-node-tests.log','motion-browser-tests.log','motion-guided-browser-tests.log'):
        path=ROOT/'output'/name;shutil.copy2(path,EVIDENCE/name);manifest.append({'path':str(path.relative_to(ROOT)),'sha256':digest(path)})
    image=ROOT/'output/playwright/motion-measurements.png'
    if image.exists():shutil.copy2(image,EVIDENCE/image.name)
    (EVIDENCE/'manifest.json').write_text(json.dumps(manifest,indent=2))
    print(json.dumps({k:v for k,v in final.items() if k not in ('display_camera','prototype_config','budget')}))


if __name__=='__main__':main()
