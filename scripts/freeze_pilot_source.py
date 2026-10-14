"""Preserve a local source snapshot without committing unrelated workspace edits."""
import argparse
import hashlib
import json
from pathlib import Path
import zipfile
from backend.learning.pilot_provenance import control_hashes

ROOT=Path(__file__).resolve().parents[1]


def main():
    parser=argparse.ArgumentParser();parser.add_argument('output',type=Path);args=parser.parse_args()
    extensions={'.py','.js','.css','.html','.json','.txt','.ps1'}
    paths={p for section in ('backend','frontend','config','scripts','tests') for p in (ROOT/section).rglob('*')
           if p.is_file() and p.suffix in extensions and '__pycache__' not in p.parts}
    for name in ('package.json','package-lock.json','index.html','README.md','Start-YA-RAB-OSTORHA.ps1','docs/CORE_REPAIR_PILOT_20261014.md'):
        path=ROOT/name
        if path.is_file():paths.add(path)
    args.output.parent.mkdir(parents=True,exist_ok=True);records=[]
    with zipfile.ZipFile(args.output,'x',compression=zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(paths):
            relative=path.relative_to(ROOT).as_posix();data=path.read_bytes()
            records.append({'path':relative,'sha256':hashlib.sha256(data).hexdigest(),'bytes':len(data)})
            archive.writestr(relative,data)
    report={'scope':'LOCAL_PILOT_SOURCE_SNAPSHOT','archive':str(args.output),
        'sha256':hashlib.sha256(args.output.read_bytes()).hexdigest(),'implementation_sha256':control_hashes(),'files':records,
        'limitations':'CARLA binaries, virtual environments, checkpoints and native recordings are separate artifacts'}
    with args.output.with_suffix('.json').open('x',encoding='utf8') as stream:json.dump(report,stream,indent=2)
    print(json.dumps({'archive':str(args.output),'sha256':report['sha256'],'files':len(records)}))


if __name__=='__main__':main()
