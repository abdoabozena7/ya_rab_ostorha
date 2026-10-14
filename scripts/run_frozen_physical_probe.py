"""Replay frozen cases with an identified scripted probe and the same shield."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
from backend.learning.pilot_budget import PilotBudget,DEFAULT_ROOT
from backend.learning.pilot_provenance import control_hashes
from scripts.run_core_repair_pilot import request,take_control_and_hold,physical_choice,historical_hashes


def main():
    parser=argparse.ArgumentParser();parser.add_argument('manifest',type=Path)
    parser.add_argument('--episodes',type=int,default=12);parser.add_argument('--seconds',type=float,default=1000.)
    args=parser.parse_args();manifest=json.loads(args.manifest.read_text(encoding='utf8'))
    if not 30.<=args.seconds<=3600.:parser.error('Invalid evaluation allowance')
    cases=manifest['cases'][:args.episodes]
    if not cases or len(cases)!=args.episodes or any(c['split']!='TEST' for c in cases):raise ValueError('Frozen TEST cases required')
    if manifest['implementation_sha256']!=control_hashes():raise ValueError('Frozen control implementation differs')
    report={'source':'LIVE_NATIVE_CARLA','policy_id':'PHYSICAL_BASELINE','kind':'SCRIPTED_PHYSICAL_PROBE',
        'manifest_sha256':hashlib.sha256(args.manifest.read_bytes()).hexdigest(),'implementation_sha256':control_hashes(),
        'outcomes':[],'accepted':False,'historical_before':historical_hashes(),
        'matched_comparison_admitted':False,
        'matching_limitation':'Initial traffic-light phases and complete sensor attributes are not bound by condition identity'}
    budget=PilotBudget();reservation=budget.reserve('evaluation',args.seconds);budget.publish_ticket(reservation)
    deadline=reservation[1]+args.seconds-30.;token=None
    try:
        take_control_and_hold();token=request('maneuver_acquire',split='TEST',max_steps=600,policy_id='PHYSICAL_BASELINE')['token']
        for case in cases:
            if time.monotonic()>=deadline:raise TimeoutError('Frozen physical probe incomplete at independent budget deadline')
            started=time.monotonic()
            try:
                value=request('maneuver_reset',token=token,seed=case['seed'],scenario=case['scenario'],mode=case['mode'],
                    parameters={**case['parameters'],'expected_map':case['map']})
                while time.monotonic()<deadline:
                    bundle=value['bundle'];action=physical_choice(bundle,case['mode'],case['scenario'])
                    value=request('maneuver_step',token=token,action=action,snapshot_hash=bundle['snapshot_hash'],
                        frame_id=bundle['frame_id'],timestamp_s=bundle['timestamp_s'])
                    if value['terminated'] or value['truncated']:break
                else:raise TimeoutError('Incomplete physical episode at deadline')
                directory=Path(value['info']['recording_path'])
                episode_manifest=json.loads((directory/'manifest.json').read_text(encoding='utf8'))
                report['outcomes'].append({**value['info'],'case_id':case['case_id'],
                    'condition_hash':episode_manifest['condition_hash'],'wall_seconds':time.monotonic()-started,
                    'driver_trace_verified':episode_manifest['driver_trace']==case['parameters'].get('driver_trace',[])})
            except Exception as error:
                report['outcomes'].append({'case_id':case['case_id'],'outcome':'INFRASTRUCTURE_OR_SCENARIO_FAILURE',
                    'error':str(error),'wall_seconds':time.monotonic()-started})
                if time.monotonic()>=deadline:raise
    except Exception as error:report['error']=str(error)
    finally:
        if token:
            try:report['restoration']=request('maneuver_close',token=token)
            except Exception as error:report['restoration_error']=str(error)
        try:budget.finish(reservation)
        except Exception as error:report['budget_error']=str(error)
        report['budget']=budget.status();report['historical_after']=historical_hashes()
        report['historical_ledgers_unchanged']=report['historical_before']==report['historical_after']
        report['implementation_hash_verified']=report['implementation_sha256']==control_hashes()
        report['manifest_hash_verified']=report['manifest_sha256']==hashlib.sha256(args.manifest.read_bytes()).hexdigest()
        ordinary_ids={c['case_id'] for c in cases if c.get('group')=='ordinary'}
        ordinary=[v for v in report['outcomes'] if v['case_id'] in ordinary_ids]
        passed=[v for v in ordinary if v.get('outcome')=='SUCCESS' and v.get('scenario_validity',{}).get('valid') and
            v.get('metrics',{}).get('collisions')==0 and v['metrics'].get('native_distance_m',0.)>=5. and
            v['metrics'].get('maximum_clear_path_stop_s',float('inf'))<=3.]
        report['ordinary_completions']=len(passed)
        report['ordinary_gate']=len(ordinary_ids)>=10 and len(passed)==len(ordinary_ids)
        path=DEFAULT_ROOT/('physical-frozen-'+reservation[0]+'.json')
        path.write_text(json.dumps(report,indent=2,allow_nan=False),encoding='utf8')
        print(json.dumps({'report':str(path),'outcomes':[{k:e.get(k) for k in ('case_id','outcome','error')} for e in report['outcomes']],
            'error':report.get('error'),'accepted':False}))
    return 1


if __name__=='__main__':sys.exit(main())
