"""Reproduce one retained rear-corner forecast; never owns native actors/ticks."""
import json
import argparse
import hashlib
import time
from pathlib import Path
import numpy as np
from backend.core.motion_geometry import VehicleGeometry,footprint_centers,rectangle_clearances,GRID
from backend.core.kinematic_prediction import kinematic_modes
from backend.core.prediction import assess_conflicts
from backend.core.recording import read_asset
from backend.core.storage_retention import open_telemetry


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--full-scene',action='store_true')
    parser.add_argument('--output',type=Path,default=Path('output/reliable-driving/rear-scene.json'))
    args=parser.parse_args()
    root=Path(__file__).resolve().parents[1]
    case=json.loads((root/'docs/evidence/route-bypass-20261016/rear-corner-replay.json').read_text())
    track=case['track'];geometry=VehicleGeometry(**case['geometry'])
    hold=np.column_stack((GRID,np.zeros((len(GRID),3))))
    footprint=footprint_centers(hold,geometry)
    conflicts=assess_conflicts([track],kinematic_modes([track]),
        [{'intent':'HOLD','points':footprint,'half':geometry.half}])
    clearance=rectangle_clearances(np.tile(track['position_m'],(len(GRID),1)),
        track['half_size_m'],footprint,geometry.half)
    if not conflicts or abs(float(clearance.min())-case['measured_rectangle_clearance_m'])>1e-6:
        raise RuntimeError('Recorded rear-corner reproduction changed; inspect the geometry before claiming repair')
    print(json.dumps({'source':'OFFLINE_RECORDED_SURFACE_GEOMETRY','native_frame':case['frame_id'],
        'measured_rectangle_clearance_m':float(clearance.min()),
        'padded_hold_conflict_time_s':conflicts[0]['time_s'],
        'dense_recovery_accepted':False,'note':case['interpretation']}))
    if args.full_scene:full_scene(root,case,args.output)


def full_scene(root,case,output):
    from backend.core.contracts import SimulationFrame,from_dict,to_dict
    from backend.core.safety_policy import sensor_observation
    from backend.core.control_scene import ControlSceneBuilder
    from backend.core.rear_separation import forward_separation
    run=root/'runs/normal_city/run_335ef662531a4317aa76c98b752bd302'
    builder=ControlSceneBuilder('retained-replay',VehicleGeometry(**case['geometry']))
    durations=[];count=0
    def read(asset):
        return read_asset(run, asset)
    # Rebuild from the recording start: identity/history cannot be fabricated
    # by seeding just the problematic object into an otherwise empty scene.
    for line in open_telemetry(run/'telemetry/frames.jsonl'):
        raw=json.loads(line)
        if raw['frame_id']>case['frame_id']:break
        frame=from_dict(SimulationFrame,raw)
        if not frame.complete:continue
        began=time.perf_counter()
        scene=builder.build(sensor_observation(frame),read,received_wall_s=0.,track_motion=True)
        durations.append((time.perf_counter()-began)*1000);count+=1
    original=None
    for line in open_telemetry(run/'telemetry/comparison-controls.jsonl'):
        row=json.loads(line)
        if row.get('frame_id')==case['frame_id'] and row.get('kind')=='HYBRID_DECISION':original=row;break
    tracks=to_dict(scene.prediction['tracks']);modes=to_dict(scene.prediction['control_trajectories'])
    forward=np.column_stack((GRID,GRID*.2,np.zeros((len(GRID),2))))
    proofs=[p for tr in tracks if (p:=forward_separation(tr,[m for m in modes if m['track_id']==tr['id']],forward,scene.geometry))]
    result={'source':'OFFLINE_FULL_SENSOR_HISTORY_REPLAY','native_acceptance':False,'frames_rebuilt':count,
        'target_frame':case['frame_id'],'rebuilt_frame':scene.observation.frame_id,'original_decision':original,
        'replayed_tracks':tracks,'forward_separation_certificates':proofs,
        'timing_ms':{'p50':float(np.quantile(durations,.5)),'p95':float(np.quantile(durations,.95)),'p99':float(np.quantile(durations,.99))},
        'note':'Rebuilt sensor history includes every retained object. No camera semantics are fabricated. Replay IDs may differ after tracking changes; original decision retains 383 and 393.'}
    output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(result,indent=2),encoding='utf8')
    print(json.dumps({'frames_rebuilt':count,'tracks':len(tracks),'output':str(output),'timing_ms':result['timing_ms']}))


if __name__=='__main__':main()
