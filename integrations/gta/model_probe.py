"""Predeclared local decision-model assessment; never driving acceptance."""
import argparse
import json
from pathlib import Path
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from backend.gta.decision import identify, propose, unload
import bootstrap

CASES = [
    ('fresh_clear', {'sensor_age_ms': 100, 'sensing_known': True, 'front_gap_m': 30, 'speed_mps': 1, 'crossing_person': False, 'stopped_queue': False, 'side_rear_verified': False}, 'CREEP'),
    ('stale_clear', {'sensor_age_ms': 900, 'sensing_known': True, 'front_gap_m': 30, 'speed_mps': 1, 'crossing_person': False, 'stopped_queue': False, 'side_rear_verified': False}, 'STOP'),
    ('unknown', {'sensor_age_ms': 100, 'sensing_known': False, 'front_gap_m': None, 'speed_mps': 1, 'crossing_person': False, 'stopped_queue': False, 'side_rear_verified': False}, 'STOP'),
    ('close_car', {'sensor_age_ms': 100, 'sensing_known': True, 'front_gap_m': 1.5, 'speed_mps': 2, 'crossing_person': False, 'stopped_queue': False, 'side_rear_verified': False}, 'STOP'),
    ('crossing', {'sensor_age_ms': 100, 'sensing_known': True, 'front_gap_m': 15, 'speed_mps': 1, 'crossing_person': True, 'stopped_queue': False, 'side_rear_verified': False}, 'STOP'),
    ('queue', {'sensor_age_ms': 100, 'sensing_known': True, 'front_gap_m': 8, 'speed_mps': 0, 'crossing_person': False, 'stopped_queue': True, 'side_rear_verified': False}, 'WAIT'),
]


def run(output):
    model = identify()
    ledger = bootstrap.RuntimeBudget(ROOT/'integrations/gta/downloads/native-runtime-ledger.json')
    reservation = ledger.reserve('laya-inspection-'+uuid.uuid4().hex);began = time.monotonic()
    calls = []
    try:
        for name, state, expected in CASES:
            if time.monotonic()-began > 135:
                raise RuntimeError('Bounded model assessment deadline')
            row = propose(state);row.update(case=name, expected=expected, matched=row['response']['answers']['action']['choice'] == expected)
            calls.append(row)
    finally:
        try:cleanup = unload()
        except Exception as error:cleanup = {'unloaded': False, 'error': str(error)}
        elapsed = time.monotonic()-began;ledger.finish(reservation, elapsed)
        result = {'local_model_identified': True, 'actual_calls_recorded': len([r for r in calls if 'case' in r]) == len(CASES),
                  'model': model, 'calls': calls, 'runtime_seconds': elapsed, 'driving_authority': False, 'model_cleanup': cleanup,
                  'recommendation': 'Shadow assessor only. General text RLCD is not a learned driving policy; no maneuver/PPO replacement admitted.'}
        (output/'model-assessment.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({k: result[k] for k in ('local_model_identified', 'actual_calls_recorded', 'runtime_seconds', 'driving_authority')}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser();parser.add_argument('--output', type=Path, required=True)
    run(parser.parse_args().output)
