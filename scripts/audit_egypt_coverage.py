"""Reconstruct retained Normal coverage holds without changing sensor evidence."""
import argparse
import hashlib
import json
import math
from pathlib import Path

import numpy as np

from backend.core.active_safety import RuntimeSafetyConfig, assess_forward_space, coverage_probe, coverage_speed_limit
from backend.core.camera_geometry import mount_rotation
from backend.core.control_scene import ControlSceneBuilder
from backend.core.motion_geometry import VehicleGeometry
from backend.core.recording import read_asset
from backend.core.replay import ReplayReader
from backend.core.safety_policy import sensor_observation
from backend.learning.egypt_budget import save_json


def audit(root):
    reader = ReplayReader(root)
    frame = reader.frame_at(max(0, len(reader.index)-2))
    geometry = VehicleGeometry(**dict(reader.metadata.config['vehicle_geometry']))
    assets = {s.asset.path: read_asset(root, s.asset) for s in frame.sensors if s.asset}
    measured = sensor_observation(frame)
    scene = ControlSceneBuilder('OFFLINE_EGYPT_COVERAGE', geometry).build(
        measured, lambda asset: assets[asset.path], received_wall_s=0., track_motion=False)
    config = RuntimeSafetyConfig.load()
    forward = assess_forward_space(measured, lambda asset: assets[asset.path], config,
                                   geometry=geometry, measured_space=scene.space)
    probe = coverage_probe(frame.vehicle.speed_mps, config, geometry.front_m, geometry)
    original = scene.space.continuous_coverage(probe)
    original_scope = scene.space._map.scope_m
    scene.space.ensure_scope(probe[:21])
    expanded = scene.space.continuous_coverage(probe)
    known, blocked = scene.space._map._footprint_status(probe)
    failed = np.flatnonzero(~known.all(axis=1) | blocked.any(axis=1))
    first = int(failed[0]) if len(failed) else None
    angles = frame.vehicle.transform.rotation_rad
    rotation = mount_rotation({key: math.degrees(getattr(angles, key)) for key in ('roll', 'pitch', 'yaw')})
    transform_errors = {}
    for sensor in frame.sensors:
        mount = sensor.metadata.get('mount_transform')
        if mount:
            expected = np.asarray(frame.vehicle.transform.position_m) + rotation @ np.asarray(mount['position_m'])
            transform_errors[sensor.sensor_id] = float(np.linalg.norm(expected - sensor.transform.position_m))
    front = next(s for s in frame.sensors if s.sensor_id == 'frontCamera')
    classification = ('PROCESSING_SCOPE_TRUNCATION' if expanded > original else
                      'REAL_OCCUPIED_BODY_CORRIDOR' if first is not None and blocked[first].any() else
                      'UNOBSERVED_CORRIDOR' if first is not None else 'MEASURED_CLEAR_CORRIDOR')
    return {'recording': str(root.resolve()), 'frame_id': frame.frame_id, 'timestamp_s': frame.timestamp_s,
            'ego_position_m': list(frame.vehicle.transform.position_m), 'geometry': geometry.snapshot(),
            'original_asset_checksums_verified': all(s.asset.sha256 is not None for s in frame.sensors if s.asset),
            'metadata_sha256': hashlib.sha256((root / 'metadata.json').read_bytes()).hexdigest(),
            'front_camera': {'path': front.asset.path, 'sha256': front.asset.sha256},
            'sensor_mount_position_errors_m': transform_errors,
            'mount_positions_match_native_transforms': max(transform_errors.values(), default=math.inf) <= .03,
            'ground_plane': scene.space.ground_plane.tolist(), 'ground_support': scene.space._map.ground_support,
            'original_processing_scope_m': original_scope, 'expanded_processing_scope_m': scene.space._map.scope_m,
            'original_observed_road_range_m': original, 'expanded_observed_road_range_m': expanded,
            'coverage_speed_limit_mps': coverage_speed_limit(original, config.teacher),
            'nearest_foreground_gap_m': forward['target_range_m'], 'foreground_source': forward['target_source'],
            'first_unverified_pose_distance_m': float(probe[first, 0]) if first is not None else None,
            'unknown_body_samples': int((~known[first]).sum()) if first is not None else 0,
            'occupied_body_samples': int(blocked[first].sum()) if first is not None else 0,
            'classification': classification,
            'unknown_space_policy': 'UNCHANGED; NO UNOBSERVED CELL DECLARED FREE'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('recordings', nargs='+', type=Path)
    parser.add_argument('--report', required=True, type=Path)
    args = parser.parse_args()
    result = {'source': 'OFFLINE_RETAINED_NATIVE_SENSOR_GEOMETRY', 'native_acceptance': False,
              'recordings': [audit(root) for root in args.recordings]}
    save_json(args.report, result)
    print(json.dumps({'report': str(args.report), 'findings': [
        {key: row[key] for key in ('recording', 'frame_id', 'classification', 'original_observed_road_range_m',
                                  'expanded_observed_road_range_m', 'coverage_speed_limit_mps', 'nearest_foreground_gap_m')}
        for row in result['recordings']]}))


if __name__ == '__main__':
    main()
