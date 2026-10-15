"""Replay recorded LiDAR/ego measurements; never connects to CARLA or controls it."""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import subprocess
import time
import types
import numpy as np
from backend.core.active_safety import _mount
from backend.core.contracts import SimulationFrame, SensorKind, from_dict
from backend.core.motion_geometry import VehicleGeometry
from backend.core.path_conflicts import LidarPathConflicts, PATH_CONFLICT_POLICY
from backend.core.safety_policy import sensor_observation


def replay(run, baseline):
    telemetry=run/'telemetry'
    decisions={r['evaluation_frame']:r for r in map(json.loads,(telemetry/'safety-v2.jsonl').open())}
    geometry=VehicleGeometry(**next(r['vehicle_geometry'] for r in decisions.values() if r.get('vehicle_geometry')))
    trackers=[baseline.LidarPathConflicts(),LidarPathConflicts()]
    conflicts=[[],[]];evidence=Counter();durations=[];frames=0
    for line in (telemetry/'frames.jsonl').open():
        raw=json.loads(line)
        o=sensor_observation(from_dict(SimulationFrame,raw))
        channel=next(c for c in o.channels if c.kind==SensorKind.LIDAR)
        data=(run/channel.asset.path).read_bytes()
        if hashlib.sha256(data).hexdigest()!=channel.asset.sha256:
            raise ValueError('Recorded LiDAR checksum mismatch: '+channel.asset.path)
        points=np.frombuffer(data,'<f4').reshape(-1,4)[:,:3]+_mount(channel)[0]
        frame_results=[]
        for i,tracker in enumerate(trackers):
            began=time.perf_counter();result=tracker.assess(points,o,geometry=geometry)
            if i:durations.append((time.perf_counter()-began)*1000)
            frame_results.append(result)
            if result['conflict']:conflicts[i].append({'frame':o.frame_id,'timestamp_s':o.timestamp_s,'conflict':result['conflict']})
        evidence.update(v['motion_evidence']['state'] for v in frame_results[1]['observations'])
        frames+=1
    return {'recording':run.as_posix(),'frames':frames,
        'original_applied_crossing_frames':[f for f,r in decisions.items() if r.get('safety',{}).get('path_conflict')],
        'baseline_replay':conflicts[0],'repaired_replay':conflicts[1],
        'motion_evidence_counts':dict(evidence),
        'repaired_tracker_ms':{'median':float(np.median(durations)),'p95':float(np.quantile(durations,.95)),'max':max(durations)}}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('runs',nargs='+',type=Path)
    parser.add_argument('--baseline-ref',default='cbb862e')
    parser.add_argument('--output',type=Path,default=Path('output/path-conflict-repair/replay.json'))
    args=parser.parse_args()
    original=subprocess.check_output(['git','show',args.baseline_ref+':backend/core/path_conflicts.py'])
    baseline=types.ModuleType('backend.core._recorded_baseline');baseline.__package__='backend.core'
    exec(compile(original,'<recorded baseline '+args.baseline_ref+'>','exec'),baseline.__dict__)
    result={'source':'OFFLINE_REPLAY_OF_RECORDED_NATIVE_SENSORS','native_acceptance':False,
        'scope':'Crossing tracker only, using recorded ego commands and paths inferred from steering. Does not simulate counterfactual physics.',
        'baseline_ref':args.baseline_ref,'baseline_sha256':hashlib.sha256(original).hexdigest(),
        'policy':PATH_CONFLICT_POLICY,'runs':[]}
    for run in args.runs:
        result['runs'].append(replay(run,baseline))
        print(json.dumps({'recording':str(run),'frames':result['runs'][-1]['frames'],
            'before':len(result['runs'][-1]['baseline_replay']),'after':len(result['runs'][-1]['repaired_replay'])}),flush=True)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(result,indent=2),encoding='utf8')


if __name__=='__main__':main()
