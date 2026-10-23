"""Independent HOLDOUT partition for the final A-E evaluation (built once, never tuned on).

Locations come from the static map probe and exclude every TRAIN/VALIDATION/TEST
spawn and every road those spawns lie on; one spawn per (town, road, lane).
Seeds use their own namespace (3000-3999). Every journey allows one full signal
cycle (90 s instead of 45 s): a red light or a queue at a red light between the
car and the destination is a legitimate wait rather than a driving failure
(verified on TEST and VALIDATION evidence before this partition was run).
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.core.pedestrian_behaviors import (BEHAVIORS, CONFIG, HOLDOUT, HOLDOUT_SEED_RANGE, holdout_counterfactual,  # noqa: E402
                                               holdout_episode, holdout_ordinary, load_suite)

PARTITION_ID = 'PEDESTRIAN_SUITE_HOLDOUT_20261023'


def holdout_locations(suite, probe):
    rows = {(r['town'], int(r['spawn_index'])): r for town_rows in probe['towns'].values() if isinstance(town_rows, list)
            for r in town_rows}
    used = {(r['town'], int(r['spawn_index'])) for split_rows in suite['locations'].values() for r in split_rows}
    used_roads = set()
    for key in sorted(used):
        row = rows.get(key)
        if row is None or not row.get('accepted'):raise ValueError(f'Used location {key} is missing from the probe')
        used_roads.add((row['town'], row['road_id']))
    chosen = {}
    for (town, spawn), row in sorted(rows.items()):
        if not row.get('accepted') or (town, spawn) in used or (town, row['road_id']) in used_roads:continue
        chosen.setdefault((town, row['road_id'], row['lane_id']), row)
    locations = [{'town': r['town'], 'spawn_index': int(r['spawn_index']), 'road_width_m': float(min(r['road_width_m']))}
                 for r in chosen.values()]
    return locations, sorted(used_roads), used


def build(suite, probe, *, seeds_per_behavior, counterfactual_pairs, ordinary, time_limit_s):
    locations, used_roads, used = holdout_locations(suite, probe)
    if not locations:raise ValueError('No independent locations remain')
    specs = [holdout_episode(suite, locations, i, time_limit_s=time_limit_s)
             for i in range(len(BEHAVIORS)*seeds_per_behavior)]
    for k in range(counterfactual_pairs):specs.extend(holdout_counterfactual(suite, locations, 100+k, time_limit_s=time_limit_s))
    specs += [holdout_ordinary(suite, locations, 200+k, time_limit_s=time_limit_s) for k in range(ordinary)]
    lo, hi = HOLDOUT_SEED_RANGE
    for spec in specs:
        location = (spec['location']['town'], spec['location']['spawn_index'])
        if spec['split'] != HOLDOUT or location in used or not lo <= spec['seed'] <= hi:
            raise ValueError('HOLDOUT spec overlaps an existing partition')
    if len({s['scenario_id'] for s in specs}) != len(specs):raise ValueError('Duplicate HOLDOUT scenario identity')
    return locations, used_roads, specs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--probe', default=str(ROOT/'output/pedestrian-suite/location-probe.json'))
    parser.add_argument('--seeds-per-behavior', type=int, default=2)
    parser.add_argument('--counterfactual-pairs', type=int, default=1)
    parser.add_argument('--ordinary', type=int, default=2)
    parser.add_argument('--time-limit-s', type=float, default=90.)
    parser.add_argument('--out', default=str(ROOT/'config/pedestrian-holdout-partition.json'))
    args = parser.parse_args()
    probe_bytes = Path(args.probe).read_bytes();suite = load_suite()
    locations, used_roads, specs = build(suite, json.loads(probe_bytes), seeds_per_behavior=args.seeds_per_behavior,
                                         counterfactual_pairs=args.counterfactual_pairs, ordinary=args.ordinary,
                                         time_limit_s=args.time_limit_s)
    report = {'id': PARTITION_ID, 'split': HOLDOUT, 'source': 'STATIC_OPENDRIVE_MAP_PROBE',
              'probe_sha256': hashlib.sha256(probe_bytes).hexdigest(),
              'suite_sha256': hashlib.sha256(Path(CONFIG).read_bytes()).hexdigest(),
              'independence': {'excluded_splits': sorted(suite['locations']), 'excluded_roads': [list(r) for r in used_roads],
                               'rule': 'NEW_SPAWN_ON_A_ROAD_WITH_NO_TRAIN_VALIDATION_TEST_SPAWN; ONE_SPAWN_PER_ROAD_AND_LANE',
                               'seed_range': list(HOLDOUT_SEED_RANGE)},
              'time_limit_s': args.time_limit_s, 'locations': locations, 'specs': specs}
    Path(args.out).write_text(json.dumps(report, indent=1), encoding='utf8')
    for s in specs:
        print(s['scenario_id'][:16], s['behavior'], s['location']['town'], s['location']['spawn_index'], s['seed'],
              s['traffic'], s['time_limit_s'], (s.get('counterfactual') or {}).get('arm', ''))
    print(json.dumps({'locations': len(locations), 'specs': len(specs), 'out': args.out}))
    return 0


if __name__ == '__main__':sys.exit(main())
