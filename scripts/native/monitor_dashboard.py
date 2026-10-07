"""Capture actual application telemetry while a human/native browser operates keys."""
import argparse
import json
import time
import urllib.request
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--seconds', type=float, default=60)
    parser.add_argument('--output', default='output/native-validation/browser-controls.jsonl')
    args = parser.parse_args()
    path = Path(args.output); path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic()+args.seconds
    with path.open('w') as output:
        while time.monotonic() < deadline:
            with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/state', timeout=2) as response:
                value = json.load(response)
            output.write(json.dumps({'wall_time': time.monotonic(), **value})+'\n')
            output.flush()
            time.sleep(.025)
    print(str(path))


if __name__ == '__main__':
    main()
