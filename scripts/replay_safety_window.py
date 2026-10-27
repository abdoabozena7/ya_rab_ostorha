"""Offline replay of a retained safety window, with asset checksum verification."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import types
from backend.core.active_safety import ActiveSafetySupervisor
from backend.core.contracts import SimulationFrame, ControlCommand, from_dict
from backend.core.motion_geometry import VehicleGeometry
from backend.core.safety_policy import sensor_observation
from backend.core.recording import read_asset
from backend.core.storage_retention import open_telemetry


def main():
    parser=argparse.ArgumentParser();parser.add_argument('run',type=Path)
    parser.add_argument('--start-frame',type=int,required=True);parser.add_argument('--end-frame',type=int,required=True)
    parser.add_argument('--baseline-ref',default='cbb862e')
    parser.add_argument('--output',type=Path,default=Path('output/path-conflict-repair/radar-replay.json'))
    args=parser.parse_args();telemetry=args.run/'telemetry'
    rows={a['evaluation_frame']:a for a in map(json.loads,open_telemetry(telemetry/'safety-v2.jsonl'))}
    source=subprocess.check_output(['git','show',args.baseline_ref+':backend/core/active_safety.py'])
    baseline=types.ModuleType('backend.core._baseline_active_safety');baseline.__package__='backend.core'
    baseline.__file__=str(Path('backend/core/active_safety.py').resolve())
    # dataclasses resolves its defining module during class construction.
    import sys
    sys.modules[baseline.__name__]=baseline
    exec(compile(source,'<recorded baseline active_safety>','exec'),baseline.__dict__)
    supervisors=[baseline.ActiveSafetySupervisor(),ActiveSafetySupervisor()]
    report={'source':'OFFLINE_REPLAY_OF_RECORDED_NATIVE_SENSOR_WINDOW','native_acceptance':False,
        'scope':'Forward supervisor over recorded ego commands; both arms use repaired crossing tracker. No counterfactual physics.',
        'recording':args.run.as_posix(),'baseline_ref':args.baseline_ref,
        'baseline_active_safety_sha256':hashlib.sha256(source).hexdigest(),'samples':[]}
    def read(asset):
        return read_asset(args.run, asset)
    for line in open_telemetry(telemetry/'frames.jsonl'):
        raw=json.loads(line);f=raw['frame_id']
        if f<args.start_frame or f>args.end_frame:continue
        audit=rows[f]
        if audit.get('base_command') is None:continue
        o=sensor_observation(from_dict(SimulationFrame,raw));base=from_dict(ControlCommand,audit['base_command'])
        sample={'frame':f,'timestamp_s':o.timestamp_s,'recorded_reason':audit['reason']}
        for name,supervisor in zip(('before','after'),supervisors):
            supervisor.geometry=VehicleGeometry(**audit['vehicle_geometry'])
            command=supervisor.evaluate(o,base,read,as_of_timestamp_s=o.timestamp_s)
            sample[name]={'brake':command.brake if command else base.brake,
                'reason':supervisor.status['reason'],'risk':supervisor.status['risk'],
                'measured_range_m':supervisor.status.get('measured_range_m'),
                'observed_road_range_m':supervisor.status.get('observed_road_range_m')}
        report['samples'].append(sample)
    report['hazard_frames']={k:sum(s[k]['risk']=='FORWARD_COLLISION_RISK' for s in report['samples']) for k in ('before','after')}
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps({'frames':len(report['samples']),'hazard_frames':report['hazard_frames'],'output':str(args.output)}))


if __name__=='__main__':main()
