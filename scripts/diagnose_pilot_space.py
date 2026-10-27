"""Reconstruct measured coverage from a completed native recording."""
import argparse
import json
from pathlib import Path
from dataclasses import replace
import numpy as np
from backend.core.replay import ReplayReader
from backend.core.recording import read_asset
from backend.core.control_scene import ControlSceneBuilder
from backend.core.safety_policy import sensor_observation
from backend.core.motion_geometry import VehicleGeometry
from backend.core.maneuver_candidates import CandidateGenerator
from backend.core.contracts import ControlCommand,CommandSource


def main():
    p=argparse.ArgumentParser();p.add_argument('episode',type=Path);p.add_argument('--geometry',type=Path)
    args=p.parse_args();manifest=json.loads((args.episode/'manifest.json').read_text())
    geometry=json.loads(args.geometry.read_text())['ego_geometry'] if args.geometry else manifest.get('ego_geometry')
    if not geometry:raise ValueError('Recorded native geometry is required; no default-body substitution')
    reader=ReplayReader(args.episode/'sensors');frame=reader.frame_at(len(reader.index)-1)
    scene=ControlSceneBuilder('offline',VehicleGeometry(**geometry)).build(sensor_observation(frame),
        lambda asset:read_asset(reader.root,asset),received_wall_s=100.)
    row=json.loads((args.episode/'transitions.jsonl').read_text().splitlines()[-1])
    base=ControlCommand(frame.frame_id,frame.timestamp_s,.75,0.,row['applied'][0]['command']['steering'],False,False,CommandSource.TRAINING,1)
    road={'centerline':[[0.,0.],[50.,0.]],'junction_ahead':False,'lane_width_m':3.5}
    bundle=CandidateGenerator().build(scene,base,road,'AUTONOMOUS',4.,wall_s=100.)
    print(json.dumps([{'id':c['id'],'admitted':c['admitted'],'reason':c['reason'],'evidence':dict(c['evidence'])}
                     for c in bundle.candidates if c['id'] in ('CONTINUE','FORWARD_LEFT','FORWARD_RIGHT')],default=list,indent=2))
    scene.space.certificate(np.array([[0.,0.,0.,0.]]));s=scene.space._map
    np.savez_compressed(args.episode/'offline-space.npz',free=s.free,occupied=s.occupied,plane=s.ground_plane,
                        points=scene.points,geometry=np.array(list(geometry.values())[:-1],float))


if __name__=='__main__':main()
