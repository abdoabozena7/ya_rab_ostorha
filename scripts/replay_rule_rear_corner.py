"""Reproduce one retained rear-corner forecast; never owns native actors/ticks."""
import json
from pathlib import Path
import numpy as np
from backend.core.motion_geometry import VehicleGeometry,footprint_centers,rectangle_clearances,GRID
from backend.core.kinematic_prediction import kinematic_modes
from backend.core.prediction import assess_conflicts


def main():
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


if __name__=='__main__':main()
