"""Route-reproduction specs for failing native routes (diagnostic, not a claim partition).

Recorded failing scenarios are re-labelled DIAGNOSTIC with their original
construction (location, route length, walkers, seed). Additional seeds are
ordinary journeys on the same route with seed-sampled background traffic and
target speed. Every spec keeps an explicit identity.
"""
import argparse
import copy
import json
from pathlib import Path
import random
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.core.pedestrian_behaviors import CATALOGUE_ID, ORDINARY, identity, load_suite, validate_spec  # noqa: E402


def recorded(roots, town, spawn):
    found = {}
    for root in roots:
        for path in Path(root).rglob('manifest.json'):
            spec = json.loads(path.read_text(encoding='utf8')).get('spec') or {}
            location = spec.get('location') or {}
            if location.get('town') == town and location.get('spawn_index') == spawn:found[spec['scenario_id']] = spec
    return [found[k] for k in sorted(found)]


def relabel(spec, split):
    result = copy.deepcopy(spec);result.pop('scenario_id', None)
    result['reproduces'] = spec['scenario_id'];result['split'] = split
    validate_spec(result, allow_counterfactual=True, allow_ordinary=True)
    result['scenario_id'] = identity(result)
    return result


def derived(base, seed, suite, split):
    ranges = suite['ranges']
    rng = random.Random(f"{CATALOGUE_ID}:ROUTE_REPRODUCTION:{base['location']['town']}:{base['location']['spawn_index']}:{seed}")
    spec = {'version': 1, 'catalogue': CATALOGUE_ID, 'split': split, 'seed': seed, 'index': seed, 'behavior': ORDINARY,
            'location': copy.deepcopy(base['location']), 'route_length_m': base['route_length_m'],
            'ego': {'target_speed_kmh': rng.choice(ranges['ego_target_speed_kmh'])}, 'pedestrians': [], 'occluder': None,
            'traffic': {'vehicles': rng.randint(*ranges['traffic_vehicles']), 'pedestrians': rng.randint(*ranges['traffic_pedestrians'])},
            'time_limit_s': float(suite['time_limit_s']), 'counterfactual': None, 'route_of': base['scenario_id']}
    validate_spec(spec, allow_ordinary=True)
    spec['scenario_id'] = identity(spec)
    return spec


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--roots', required=True, help='Comma-separated earlier harness folders')
    parser.add_argument('--route', action='append', required=True,
                        help='TOWN:SPAWN:MAX_RECORDED:EXTRA_SEEDS (e.g. Town02_Opt:25:3:1)')
    parser.add_argument('--behaviors', default='', help='Optional recorded behaviors to keep')
    parser.add_argument('--split', default='DIAGNOSTIC');parser.add_argument('--out', required=True)
    args = parser.parse_args()
    suite = load_suite();specs = [];wanted = set(filter(None, args.behaviors.split(',')))
    for item in args.route:
        town, spawn, count, extra = item.split(':');spawn = int(spawn)
        originals = [s for s in recorded(args.roots.split(','), town, spawn) if not wanted or s['behavior'] in wanted]
        if not originals:raise ValueError(f'No recorded scenario at {town}:{spawn}')
        chosen = originals[:int(count)]
        specs += [relabel(s, args.split) for s in chosen]
        specs += [derived(chosen[0], 9000+i, suite, args.split) for i in range(int(extra))]
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(specs, indent=1), encoding='utf8')
    for s in specs:print(s['scenario_id'][:16], s['behavior'], s['location'], s['seed'], s['traffic'], s.get('reproduces', s.get('route_of', ''))[:16])
    return 0


if __name__ == '__main__':sys.exit(main())
