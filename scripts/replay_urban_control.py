"""Profile recorded Egypt control inputs offline, never issuing native commands."""
import argparse
import cProfile
import hashlib
import json
from pathlib import Path
import pstats
import time

import numpy as np

from backend.core.contracts import ControlCommand, from_dict, to_dict
from backend.core.control_scene import ControlSceneBuilder
from backend.core.maneuver_candidates import ExecutionShield, signed_path
from backend.core.motion_geometry import VehicleGeometry
from backend.core.recording import read_asset
from backend.core.recording_storage import open_recorded
from backend.core.replay import ReplayReader
from backend.core.safety_policy import sensor_observation
from backend.core.urban_driver import UrbanManeuverDriver, urban_forecast
from backend.learning.egypt_budget import save_json


def replay(root, *, prepare_space=False):
    from backend.core.measured_rays import warm_measured_rays
    warm_measured_rays()
    reader = ReplayReader(root)
    with open_recorded(root / 'telemetry' / 'comparison-controls.jsonl', 'rt') as stream:
        decisions = {row['frame_id']: row for line in stream
                     if (row := json.loads(line)).get('kind') == 'HYBRID_DECISION'}
    if not decisions:
        raise ValueError('A recorded Egypt protected control decision is required')
    geometry = VehicleGeometry(**dict(reader.metadata.config['vehicle_geometry']))
    builder = ControlSceneBuilder(next(iter(decisions.values()))['road_context']['session_id'], geometry)
    driver = UrbanManeuverDriver(geometry)
    rows = []
    for frame in reader.frames():
        if frame.frame_id > max(decisions):
            break
        if not frame.complete:
            continue
        assets = {s.asset.path: read_asset(root, s.asset) for s in frame.sensors if s.asset}
        began = time.perf_counter()
        scope = (driver.coverage_path(frame.vehicle.speed_mps, decisions[frame.frame_id]['road_context'])
                 if prepare_space and frame.frame_id in decisions else None)
        scene = builder.build(sensor_observation(frame), lambda asset: assets[asset.path], received_wall_s=100.,
                              space_scope_path=scope)
        built = time.perf_counter()
        if frame.frame_id not in decisions:
            continue
        recorded = decisions[frame.frame_id]
        base = from_dict(ControlCommand, recorded['base_command'])
        road = recorded['road_context']
        command, behavior = driver.evaluate(scene, base, road, 60. / 3.6, wall=100. + built - began)
        planned = time.perf_counter()
        forecast = urban_forecast(scene, scene.prediction['horizon_s'])
        path = signed_path(scene.observation.ego.speed_mps, command.steering,
                           command.throttle * 2.5 - command.brake * 5., geometry, command.reverse, bounded=command.reverse)
        accepted, reason, _ = ExecutionShield().check(forecast, path, command, road,
            timestamp_s=frame.timestamp_s, wall_s=100. + time.perf_counter() - began,
            forward_recovery=behavior.get('action') in ('FOLLOW', 'SLOW'))
        finished = time.perf_counter()
        semantic = {'frame': frame.frame_id, 'command': to_dict(command), 'action': behavior['action'],
                    'reason': behavior['reason'], 'shield_accepted': accepted, 'shield_reason': reason,
                    'prediction': to_dict(forecast.prediction['control_trajectories'])}
        rows.append({'frame': frame.frame_id, 'scene_ms': (built - began) * 1000,
                     'behavior_ms': (planned - built) * 1000, 'shield_ms': (finished - planned) * 1000,
                     'total_ms': (finished - began) * 1000, 'action': behavior['action'],
                     'reason': behavior['reason'], 'shield_reason': reason,
                     'output_sha256': hashlib.sha256(json.dumps(semantic, sort_keys=True).encode()).hexdigest()})
    builder.close()
    return rows


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('recording', type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--prepare-space', action='store_true')
    args = parser.parse_args()
    profiler = cProfile.Profile()
    profiler.enable()
    rows = replay(args.recording, prepare_space=args.prepare_space)
    profiler.disable()
    if not rows:
        raise ValueError('No complete recorded Egypt control frames')
    stats = pstats.Stats(profiler)
    hotspots = sorted([{'function': f'{Path(file).name}:{line}:{name}', 'self_s': tt, 'cumulative_s': ct, 'calls': nc}
                       for (file, line, name), (_, nc, tt, ct, _) in stats.stats.items()], key=lambda r: -r['self_s'])[:20]
    report = {'source': 'OFFLINE_PRELOADED_SENSOR_REPLAY', 'native_acceptance': False,
              'recording': str(args.recording.resolve()), 'frames': rows, 'hotspots': hotspots,
              'timings': {key: {'p50': float(np.percentile([r[key] for r in rows], 50)),
                               'p95': float(np.percentile([r[key] for r in rows], 95)),
                               'p99': float(np.percentile([r[key] for r in rows], 99))}
                          for key in ('scene_ms', 'behavior_ms', 'shield_ms', 'total_ms')}}
    save_json(args.output, report)
    print(json.dumps({'output': str(args.output), 'frames': len(rows), 'timings': report['timings']}))


if __name__ == '__main__':
    main()
