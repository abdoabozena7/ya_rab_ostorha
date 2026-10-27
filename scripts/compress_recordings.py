"""Verify lossless compression of explicit closed project recordings with CARLA stopped."""
import argparse
import json
from pathlib import Path

from backend.core.recording_storage import compress_recording
from backend.learning.egypt_budget import save_json

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('recordings', nargs='+', type=Path)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    if args.report.exists():
        raise FileExistsError('Compression evidence reports are never overwritten')
    result = {'source': 'LOSSLESS_CLOSED_RECORDING_COMPRESSION', 'recordings': [], 'native_acceptance': False}
    try:
        for root in args.recordings:
            result['recordings'].append(compress_recording(root, ROOT))
            save_json(args.report, result)
    except (OSError, ValueError, RuntimeError, EOFError) as error:
        result['error'] = str(error)
        save_json(args.report, result)
        raise
    print(json.dumps({'report': str(args.report), 'saved_bytes': sum(r['saved_bytes'] for r in result['recordings'])}))


if __name__ == '__main__':
    main()
