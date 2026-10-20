"""Sequential full native acceptance, with one CARLA owner and retained failures."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time
import uuid
import zipfile
from scripts.validate_hybrid_native import ROOT,source_hashes
from scripts.summarize_crossing_pairs import summarize
from scripts.crossing_user_acceptance import evaluate_user_plan,POLICY


def same_case_sources(report,current,old_catalogue,new_catalogue):
    """An edit to another fixture cannot invalidate an unchanged tested case.

    All executable/control source bytes remain strict. The exact archived
    selected definition, common map/rig setup and library version must match;
    validation booleans are annotations, never driving inputs.
    """
    old={k.replace('\\','/'):v for k,v in report.get('source_hashes',{}).items()}
    current={k.replace('\\','/'):v for k,v in current.items()}
    if old.keys()!=current.keys():return False
    if any(old[k]!=current[k] for k in old if k!='config/crossing-comparison.json'):return False
    def selected(library):
        variants=library['variants'];variant=variants[report['seed']%len(variants)]
        return {**{k:v for k,v in library.items() if k!='variants'},'variant_count':len(variants),
            'selected':{k:v for k,v in variant.items() if k!='validated'}}
    return selected(old_catalogue)==selected(new_catalogue)


def selected_acceptance(report,policy):
    if policy=='before_ingress':return evaluate_user_plan(report)['passed']
    return bool(report.get('native_acceptance') and report.get('critical_prediction_evidence',{}).get('passed'))


def can_reuse(report,current,policy='first_motion'):
    if not (selected_acceptance(report,policy) and report.get('source_unchanged')):return False
    if report.get('source_hashes')==current:return True
    archive=report.get('source_archive') or {};path=Path(archive.get('path',''))
    if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest()!=archive.get('sha256'):return False
    with zipfile.ZipFile(path) as sources:
        old=json.loads(sources.read('config/crossing-comparison.json'))
    new=json.loads((ROOT/'config/crossing-comparison.json').read_text(encoding='utf8'))
    return same_case_sources(report,current,old,new)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--reuse-report',action='append',default=[])
    parser.add_argument('--seconds',type=float,default=900.)
    parser.add_argument('--acceptance-policy',choices=('first_motion','before_ingress'),default='first_motion')
    args=parser.parse_args();pinned=source_hashes();reusable={}
    for value in args.reuse_report:
        path=Path(value).resolve();report=json.loads(path.read_text(encoding='utf8'))
        if not can_reuse(report,pinned,args.acceptance_policy):
            parser.error('A reused report must pass acceptance with identical control bytes and the current selected fixture: '+str(path))
        reusable[report['seed'],report['first_mode']]=path
    folder=ROOT/'output/crossing-matrices'/uuid.uuid4().hex;folder.mkdir(parents=True)
    catalogue_bytes=(ROOT/'config/crossing-comparison.json').read_bytes()
    catalogue_hash=next(value for key,value in pinned.items() if key.replace('\\','/')=='config/crossing-comparison.json')
    if hashlib.sha256(catalogue_bytes).hexdigest()!=catalogue_hash:raise RuntimeError('Scenario catalogue changed before archival')
    (folder/'scenario-catalogue.json').write_bytes(catalogue_bytes)
    analysis=ROOT/'scripts/crossing_user_acceptance.py';analysis_bytes=analysis.read_bytes()
    (folder/'acceptance-review-source.py').write_bytes(analysis_bytes)
    output={'source':'SIX_FULL_NATIVE_PAIRS_BOTH_ORDERS','source_hashes':pinned,'cases':[],'passed':False,
        'acceptance_policy':POLICY if args.acceptance_policy=='before_ingress' else 'STRICT_BEFORE_FIRST_NATIVE_MOTION',
        'review_source_sha256':hashlib.sha256(analysis_bytes).hexdigest(),
        'scenario_catalogue_file':'scenario-catalogue.json',
        'original_strict_first_motion_results_preserved':True}
    print(str(folder),flush=True)
    for seed in (1701,1702,1703):
        for first in ('NORMAL','ROBOSPHERE'):
            if source_hashes()!=pinned:raise RuntimeError('Control sources changed during the matrix; keep its partial evidence')
            if analysis.read_bytes()!=analysis_bytes:raise RuntimeError('Acceptance evaluator changed during the matrix')
            path=reusable.get((seed,first));reused=path is not None
            if path is None:
                before=set((ROOT/'output/crossing-pairs').iterdir())
                result=subprocess.run([sys.executable,'-m','scripts.native.validate_crossing_pair',
                    '--seed',str(seed),'--first',first,'--seconds',str(args.seconds),'--render-profile','LOW'],cwd=ROOT)
                created=set((ROOT/'output/crossing-pairs').iterdir())-before
                if len(created)!=1:raise RuntimeError('Could not identify the single native attempt; inspect retained worker logs')
                path=next(iter(created))/'report.json'
                if not path.is_file():raise RuntimeError('Native attempt has no finalized report: '+str(path))
                # Give Windows/driver contexts time to retire after verified
                # engine exit before constructing the next independent world.
                time.sleep(3.)
            case=summarize(path);case.update(report_path=str(path),reused=reused,
                reuse_scope='IDENTICAL_CONTROL_BYTES_AND_VERIFIED_SELECTED_SCENARIO' if reused else None)
            original=json.loads(path.read_text(encoding='utf8'))
            case['user_plan_review']=evaluate_user_plan(original)
            case['accepted_by_selected_policy']=selected_acceptance(original,args.acceptance_policy)
            output['cases'].append(case)
            output['passed']=len(output['cases'])==6 and all(c['accepted_by_selected_policy'] for c in output['cases'])
            (folder/'report.json').write_text(json.dumps(output,indent=2,ensure_ascii=False),encoding='utf8')
            print(json.dumps({'seed':seed,'first':first,'accepted':case['accepted_by_selected_policy'],
                'strict_first_motion':case['current_acceptance'],'policy':output['acceptance_policy'],'reused':reused}),flush=True)
    return 0 if output['passed'] else 1


if __name__=='__main__':raise SystemExit(main())
