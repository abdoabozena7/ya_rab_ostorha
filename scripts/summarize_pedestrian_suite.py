"""Summarize native pedestrian-suite collection runs into a compact evidence record."""
import argparse
import collections
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]


def summarize(folder):
    outcomes = [json.loads(p.read_text(encoding='utf8')) for p in Path(folder).rglob('outcome.json')]
    realized = collections.defaultdict(collections.Counter)
    for o in outcomes:
        for role, r in (o.get('realization') or {}).items():
            truncated = o.get('outcome') == 'COLLECTION_END_PASSED_PEDESTRIANS' and not r.get('realized')
            realized[o['behavior']]['realized' if r.get('realized') else 'truncated_by_collection_end' if truncated else 'not_realized'] += 1
    sources = collections.Counter(json.dumps(o.get('source_sha256') or o.get('control_source_sha256'), sort_keys=True) for o in outcomes)
    return {'folder': str(folder), 'episodes': len(outcomes),
            'outcomes': dict(collections.Counter(o.get('outcome') for o in outcomes)),
            'by_behavior': {b: dict(collections.Counter(o.get('outcome') for o in outcomes if o['behavior'] == b))
                            for b in sorted({o['behavior'] for o in outcomes})},
            'towns': dict(collections.Counter(o['location']['town'] for o in outcomes)),
            'locations': sorted({f"{o['location']['town']}:{o['location']['spawn_index']}" for o in outcomes}),
            'scripted_walker_realization': {b: dict(c) for b, c in sorted(realized.items())},
            'construction_errors': [{'behavior': o['behavior'], 'location': o['location'], 'error': o.get('error')}
                                    for o in outcomes if str(o.get('outcome', '')).startswith('INVALID')],
            'simulated_s': round(sum(o.get('simulated_s') or 0. for o in outcomes), 2),
            'wall_s': round(sum(o.get('wall_s') or 0. for o in outcomes), 2),
            'source_identities': len(sources),
            'source_identity_sha256': [hashlib.sha256(k.encode()).hexdigest()[:16] for k in sources]}


def main():
    parser = argparse.ArgumentParser();parser.add_argument('--folders', required=True);parser.add_argument('--datasets', default='')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    result = {'source': 'LIVE_NATIVE_CARLA_HARNESS', 'runs': [summarize(f) for f in args.folders.split(',')], 'datasets': {}}
    for path in filter(None, args.datasets.split(',')):
        summary = json.loads(Path(path).with_suffix('.summary.json').read_text(encoding='utf8'))
        result['datasets'][summary['split']] = {k: summary[k] for k in ('samples', 'coverage', 'prediction_coverage', 'label_counts',
                                                                       'positives', 'negatives', 'sha256', 'feature_version')}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(result, indent=1), encoding='utf8')
    print(json.dumps({r['folder']: {'episodes': r['episodes'], 'outcomes': r['outcomes']} for r in result['runs']}, indent=1))
    return 0


if __name__ == '__main__':sys.exit(main())
