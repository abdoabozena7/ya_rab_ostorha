"""Dry-run by default. Apply only to an idle native host; retain specified incidents."""
import argparse
import json
from pathlib import Path
import time
import urllib.request
from backend.core.storage_retention import recording_roots,archive_recording,contained

ROOT=Path(__file__).resolve().parents[1]


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--apply',action='store_true')
    parser.add_argument('--preserve',action='append',default=[])
    args=parser.parse_args()
    # Every owned writer must be stopped before deleting its original assets.
    try:
        with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/status',timeout=5) as response:status=json.load(response)
        if status.get('connected'):raise RuntimeError('Stop the native simulation before bulk storage maintenance')
    except OSError:pass
    keep={contained(ROOT/p,ROOT) for p in args.preserve}
    report={'applied':args.apply,'preserved':[str(p) for p in keep],'recordings':[],'errors':[]}
    out=ROOT/'output/maintenance';out.mkdir(parents=True,exist_ok=True);began=time.monotonic()
    roots=[root for folder in (ROOT/'runs',ROOT/'output') for root in recording_roots(folder,ROOT)]
    for root in roots:
        if root.resolve() in keep:continue
        if (root/'storage-retention.json').exists() and json.loads((root/'storage-retention.json').read_text())['status']=='ARCHIVED':continue
        try:
            result=archive_recording(root,ROOT,apply=args.apply);report['recordings'].append(result)
            if len(report['recordings'])%10==0:
                print(json.dumps({'recordings':len(report['recordings']),
                    'raw_GiB':sum(r['raw_bytes'] for r in report['recordings'])/1024**3,'elapsed_s':time.monotonic()-began}),flush=True)
        except (OSError,ValueError,RuntimeError) as error:report['errors'].append({'root':str(root),'error':str(error)})
        (out/'recording-retention.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps({'recordings':len(report['recordings']),'raw_GiB':sum(r['raw_bytes'] for r in report['recordings'])/1024**3,'errors':report['errors']}))


if __name__=='__main__':main()
