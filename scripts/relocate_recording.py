"""Explicit offline closed-recording relocation; never starts the simulator."""
import argparse
import json
from pathlib import Path

from backend.core.recording_relocation import relocate_recording, release_staged_recording, restore_recording


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('recording', type=Path)
    parser.add_argument('--destination', type=Path)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--release-verified-source', action='store_true')
    actions.add_argument('--restore-original', action='store_true')
    args = parser.parse_args()
    if args.release_verified_source or args.restore_original:
        if args.destination is not None:
            parser.error('Release uses the existing verified destination, not a new one')
        action = release_staged_recording if args.release_verified_source else restore_recording
        result = action(args.recording.name)
    else:
        if args.destination is None:
            parser.error('Copy/activation requires an explicit destination')
        result = relocate_recording(args.recording, args.destination)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
