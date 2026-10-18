"""Summarize retained native ordinary-mode probes; never tick or move CARLA.

This accepts only the limited low-speed RULE overlay, not full hybrid driving.
Earlier failed revisions remain listed in the evidence instead of disappearing.
"""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
from backend.core.route_bypass import ROOT,REPORT,source_fingerprint


def display_publication_compatible(name,data,expected):
    if name!='backend\\core\\display_prediction.py':return False
    lines=data.splitlines(keepends=True);marker=b"'published_wall_s':time.monotonic(),"
    prior=b''.join(line for line in lines if line.strip()!=marker)
    return sum(line.strip()==marker for line in lines)==1 and hashlib.sha256(prior).hexdigest()==expected


def summarize(path):
    path=Path(path).resolve();raw=path.read_bytes();r=json.loads(raw)
    samples=r.get('samples',[]);fixture=r.get('fixture',{})
    origin=fixture.get('intended_ego_pose',{}).get('position',[0.,0.,0.])
    yaw=math.radians(fixture.get('intended_ego_pose',{}).get('yaw_deg',0.))
    co,si=math.cos(yaw),math.sin(yaw)
    local=[((s['position_m'][0]-origin[0])*co+(s['position_m'][1]-origin[1])*si,
            -(s['position_m'][0]-origin[0])*si+(s['position_m'][1]-origin[1])*co) for s in samples]
    phases=Counter(s.get('maneuver',{}).get('action','UNAVAILABLE') for s in samples)
    completed=sorted({m for s in samples for m in s.get('maneuver',{}).get('completed_maneuvers',[])})
    resumed=[s for i,s in enumerate(samples) if local[i][0]>32. and s.get('maneuver',{}).get('action')=='RULE_FOLLOW']
    signal=[s for s in samples if 'red traffic light' in str(s.get('stop',{}).get('reason','')).lower()]
    last=samples[-1] if samples else {}
    signal_held=bool(last in signal and last.get('speed_kmh',float('inf'))<.54 and last.get('brake',0)>.1)
    differences=[name for name,digest in r.get('source_hashes',{}).items()
        if name.startswith(('backend\\core\\','backend\\carla\\','backend\\computer_vision\\')) and
           hashlib.sha256((ROOT/name).read_bytes()).hexdigest()!=digest]
    # This observer never proposes or applies motion. Its display-publication
    # timestamp repair is verified by the API regression and dense rehearsal;
    # keep its changed source explicit, while every actuation dependency must
    # still match the archived native cohort. Deployment fingerprints continue
    # to include this file, so another edit invalidates the published report.
    display_only=[]
    for name in differences:
        if display_publication_compatible(name,(ROOT/name).read_bytes(),r['source_hashes'][name]):
            display_only.append(name)
    current=not [name for name in differences if name not in display_only]
    common=bool(samples and current and len(r.get('source_hashes',{}))>=80
        and r.get('source')=='LIVE_NATIVE_CARLA' and r.get('mode')=='ROBOSPHERE'
        and r.get('source_unchanged') and not r.get('error') and not r.get('orchestration_error')
        and r.get('scenario_validity',{}).get('valid') and r.get('native_cleanup_confirmed')
        and r.get('restored',{}).get('connected') and r.get('restored',{}).get('continued_ticking')
        and r.get('contacts')==[])
    side=fixture.get('expected_passing_side')
    beside=[y for x,y in local if 13.<x<24.]
    actual_pass=bool(beside and (min(beside)<-2.5 if side=='left' else max(beside)>2.5))
    arrived=r.get('journey',{}).get('status')=='ARRIVED'
    return {'id':r['id'],'scenario':r.get('scenario'),'seed':r.get('seed'),
        'raw_report':str(path.relative_to(ROOT)).replace('\\','/'), 'raw_report_sha256':hashlib.sha256(raw).hexdigest(),
        'source_archive_sha256':r.get('source_archive',{}).get('sha256'),
        'source_matches_current_control':current,'display_source_differences':display_only,
        'native_checks_ok':common,'arrived':arrived,
        'distance_m':r.get('native_planar_distance_m'),'maximum_speed_kmh':r.get('maximum_speed_kmh'),
        'maximum_unexplained_stop_s':r.get('maximum_unexplained_stop_s'),'contacts':len(r.get('contacts',[])),
        'actions':dict(phases),'completed_maneuvers':completed,'actual_passing_side':side if actual_pass else None,
        'ordinary_resumed':bool(resumed),'resumed_maximum_speed_kmh':max((s['speed_kmh'] for s in resumed),default=0.),
        'maximum_forward_m':max((x for x,y in local),default=0.),'maximum_lateral_m':max((abs(y) for x,y in local),default=0.),
        'red_signal_samples':len(signal),'red_signal_stopped_samples':sum(s['speed_kmh']<.54 for s in signal),
        'red_signal_held_at_end':signal_held,
        'scene_usable_fraction':sum(bool((s.get('control_scene') or {}).get('usable')) for s in samples)/max(1,len(samples)),
        'error':r.get('error'),'source_unchanged':r.get('source_unchanged'),
        'restored':r.get('restored'),'charged_working_s':r.get('reservation_working_s')}


def gates(cases):
    def clear(side):
        return any(c['scenario']=='RULE_BYPASS_'+side.upper() and c['native_checks_ok'] and c['arrived']
            and c['actual_passing_side']==side and c['maximum_unexplained_stop_s']<3.
            and c['ordinary_resumed'] and c['resumed_maximum_speed_kmh']>8.2 for c in cases)
    occupied=any(c['scenario']=='RULE_BYPASS_OCCUPIED' and c['native_checks_ok'] and not c['arrived']
        and c['maximum_unexplained_stop_s']>=10. and c['maximum_forward_m']<13.
        and c['maximum_lateral_m']<1. for c in cases)
    signal=any(c['scenario']=='RULE_BYPASS_RED_SIGNAL' and c['native_checks_ok'] and not c['arrived']
        and c['red_signal_stopped_samples']>=40 and c['red_signal_held_at_end']
        and not any(c['actions'].get(x) for x in ('CHANGE_LEFT','CHANGE_RIGHT','EXIT','PASS','RETURN'))
        for c in cases)
    left,right=clear('left'),clear('right')
    return {'clear_left':left,'clear_right':right,'occupied_lane':occupied,'traffic_stop':signal,
            'ordinary_resume':left and right}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('reports',nargs='+');parser.add_argument('--write',action='store_true')
    args=parser.parse_args();cases=[summarize(ROOT/p) for p in args.reports];result=gates(cases)
    report={'version':1,'scope':'Limited stationary-obstacle RULE bypass in Town10HD_Opt; not full hybrid acceptance',
        'source_fingerprint':source_fingerprint(),'accepted':all(result.values()),'gates':result,
        'tested_sides':['left','right'],'maximum_maneuver_speed_mps':2.,'cases':cases,
        'limits':['Maneuvers slow to 2 m/s; requested cruising speed is separate.',
                  'No reverse, opposing-lane passing, or unmeasured-space movement is admitted.',
                  'These scoped cases do not establish dense-city or high-speed autonomous acceptance.']}
    if args.write:
        REPORT.parent.mkdir(parents=True,exist_ok=True);REPORT.write_text(json.dumps(report,indent=2)+'\n')
    print(json.dumps(report,indent=2))
    return 0 if report['accepted'] else 1


if __name__=='__main__':raise SystemExit(main())
