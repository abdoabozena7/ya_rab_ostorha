"""Build TRAIN/VALIDATION/TEST path-entry datasets from native episode logs.

Each split only reads episodes whose manifest split matches; mixing raises.
"""
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.learning.path_entry_dataset import build_split  # noqa: E402


def episodes(roots, split, configuration):
    found = []
    for root in roots:
        for manifest in Path(root).rglob('manifest.json'):
            directory = manifest.parent
            if not (directory/'episode.jsonl.gz').exists():continue
            data = json.loads(manifest.read_text(encoding='utf8'))
            if data.get('split') != split:continue
            if configuration and (data.get('admission') or {}).get('configuration') != configuration:continue
            found.append(directory)
    return found


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--roots', required=True, help='Comma-separated harness output folders')
    parser.add_argument('--split', choices=('TRAIN', 'VALIDATION', 'TEST', 'HOLDOUT'), required=True)
    parser.add_argument('--configuration', default='B_PHYSICAL_PREDICTIVE')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    directories = episodes(args.roots.split(','), args.split, args.configuration)
    summary = build_split(directories, args.out, split=args.split)
    printable = {k: v for k, v in summary.items() if k != 'episodes'}
    printable['episodes'] = len(summary['episodes'])
    printable['episode_errors'] = [e for e in summary['episodes'] if 'error' in e]
    print(json.dumps(printable, indent=1))
    return 0


if __name__ == '__main__':sys.exit(main())
