import argparse
import json
from pathlib import Path
import sys
from backend.learning.pilot_acceptance import validate


def main():
    parser=argparse.ArgumentParser();parser.add_argument('manifest',type=Path);parser.add_argument('results',type=Path)
    args=parser.parse_args()
    report=validate(json.loads(args.manifest.read_text()),json.loads(args.results.read_text()))
    print(json.dumps(report,indent=2));return 0 if report['accepted'] else 1


if __name__=='__main__':sys.exit(main())
