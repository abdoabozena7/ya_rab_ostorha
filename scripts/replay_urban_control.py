"""Profile recorded Egypt control inputs offline, never issuing native commands."""
import argparse
import cProfile
import hashlib
import json
from pathlib import Path
import pstats
import sys
import time
from contextlib import ExitStack
from types import SimpleNamespace
from unittest.mock import patch

# Install a preserved, complete contract module before any runtime imports.
if __name__ == '__main__' and '--contracts-oracle' in sys.argv:
    import importlib.util
    oracle = Path(sys.argv[sys.argv.index('--contracts-oracle') + 1])
    spec = importlib.util.spec_from_file_location('backend.core.contracts', oracle)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)

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


def canonical(value):
    return json.dumps(to_dict(value), sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def restore_frozen_sequence(values):
    from backend.core.contracts import _FrozenJSONSequence
    return tuple.__new__(_FrozenJSONSequence, values)


def restore_frozen_mapping(values):
    from backend.core.contracts import _FrozenJSONMapping
    from types import MappingProxyType
    result = object.__new__(_FrozenJSONMapping)
    object.__setattr__(result, '_data', MappingProxyType(values))
    return result


def capture_live_prediction(value, path):
    """Trusted local pickle preserves frozen types and shared trajectory objects."""
    import pickle
    from backend.core.contracts import _FrozenJSONMapping, _FrozenJSONSequence
    from scripts.replay_urban_control import restore_frozen_mapping, restore_frozen_sequence

    class GraphPickler(pickle.Pickler):
        def reducer_override(self, obj):
            if type(obj) is _FrozenJSONSequence:
                return restore_frozen_sequence, (tuple(obj),)
            if type(obj) is _FrozenJSONMapping:
                return restore_frozen_mapping, (dict(obj),)
            return NotImplemented

    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('wb') as stream:
        GraphPickler(stream, protocol=5).dump(value)


def compare_reports(baseline, candidate):
    """Compare exact canonical values as well as hashes, never timing speedups."""
    keys = ('recording', 'first', 'last', 'clock', 'history_sha256', 'expected_frames')
    differences = [key for key in keys if canonical(baseline[key]) != canonical(candidate[key])]
    if baseline.get('script_sha256') != candidate.get('script_sha256'):
        differences.append('script_sha256')
    if baseline.get('source_unchanged') is False or candidate.get('source_unchanged') is False:
        differences.append('source_changed_during_replay')
    old = {row['frame']: row for row in baseline['rows']}
    new = {row['frame']: row for row in candidate['rows']}
    if old.keys() != new.keys():
        differences.append('frame_set')
    for frame in sorted(old.keys() & new.keys()):
        for key in ('payload', 'output_sha256'):
            if canonical(old[frame][key]) != canonical(new[frame][key]):
                differences.append(f'frame:{frame}:{key}')
    return {'equivalent': not differences, 'differences': differences,
            'baseline_rows': len(old), 'candidate_rows': len(new)}


def deterministic_replay(root, *, first, last, wall_age_ms, shield_age_ms, live_sample=None):
    """Replay full sensor/semantic/driver history using explicit synthetic ages."""
    from backend.core import contracts, control_scene, prediction, urban_driver
    from backend.core.egypt_urban import source_manifest
    from backend.core.measured_rays import warm_measured_rays
    from threadpoolctl import threadpool_limits
    if first > last or not 0 <= wall_age_ms <= shield_age_ms:
        raise ValueError('Ordered frames and nonnegative increasing wall ages required')
    warm_measured_rays()
    decisions, detections = {}, {}
    with open_recorded(root / 'telemetry' / 'comparison-controls.jsonl', 'rt') as stream:
        for line in stream:
            row = json.loads(line)
            if row.get('kind') == 'HYBRID_DECISION':
                decisions[row['frame_id']] = row
            elif row.get('kind') == 'CAMERA_DETECTIONS':
                detections[row['evaluation_frame']] = row['result']
    expected = sorted(frame for frame in decisions if first <= frame <= last)
    if not expected or not detections:
        raise ValueError('Recorded decisions and camera semantics are required')
    reader = ReplayReader(root)
    geometry = VehicleGeometry(**dict(reader.metadata.config['vehicle_geometry']))
    builder = ControlSceneBuilder(next(iter(decisions.values()))['road_context']['session_id'], geometry)
    driver = UrbanManeuverDriver(geometry)
    contract_sha = hashlib.sha256(Path(contracts.__file__).read_bytes()).hexdigest()

    def effective_source():
        manifest = source_manifest()
        manifest['backend/core/contracts.py'] = contract_sha
        return hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()

    source = effective_source()
    rows, history = [], []
    semantic, semantic_frame = None, None
    semantic_ids = iter(sorted(detections))
    next_semantic = next(semantic_ids, None)
    clock = [100.]
    fake_time = SimpleNamespace(perf_counter=lambda: clock[0], thread_time=lambda: clock[0])
    original_freeze = control_scene.freeze_json
    captured = False

    def freeze_with_sample(value, *args, **kwargs):
        nonlocal captured
        if (live_sample and not captured and isinstance(value, dict)
                and value.get('source') == 'CONTROL_SENSOR_PIPELINE'
                and value.get('evaluation_frame', -1) >= first):
            capture_live_prediction(value, live_sample)
            captured = True
        return original_freeze(value, *args, **kwargs)

    try:
        with ExitStack() as stack:
            stack.enter_context(threadpool_limits(limits=1, user_api='blas'))
            stack.enter_context(patch.object(control_scene, 'time', fake_time))
            stack.enter_context(patch.object(control_scene, 'monotonic', lambda: clock[0]))
            stack.enter_context(patch.object(urban_driver, 'time', fake_time))
            stack.enter_context(patch.object(prediction, 'time', fake_time))
            stack.enter_context(patch.object(control_scene, 'freeze_json', freeze_with_sample))
            for frame in reader.frames():
                if frame.frame_id > last:
                    break
                if frame.frame_id % 100 == 0:
                    print(f'replaying full history: {frame.frame_id}', flush=True)
                while next_semantic is not None and next_semantic <= frame.frame_id:
                    semantic_frame, semantic = next_semantic, detections[next_semantic]
                    next_semantic = next(semantic_ids, None)
                history.append({'frame': to_dict(frame), 'semantic_frame': semantic_frame,
                                'semantic_sha256': digest(semantic),
                                'decision_sha256': digest(decisions.get(frame.frame_id))})
                if not frame.complete:
                    continue
                assets = {s.asset.path: read_asset(root, s.asset) for s in frame.sensors if s.asset}
                history[-1]['asset_sha256'] = {name: hashlib.sha256(data).hexdigest()
                                             for name, data in assets.items()}
                road = (contracts.freeze_json(decisions[frame.frame_id]['road_context'])
                        if frame.frame_id in decisions else None)
                scope = driver.coverage_path(frame.vehicle.speed_mps, road) if road is not None else None
                clock[0] = 100. + frame.frame_id
                began = time.perf_counter()
                scene = builder.build(sensor_observation(frame), lambda a: assets[a.path],
                                      received_wall_s=clock[0], semantic_result=semantic, space_scope_path=scope)
                built = time.perf_counter()
                if road is None:
                    continue
                base = from_dict(ControlCommand, decisions[frame.frame_id]['base_command'])
                command, behavior = driver.evaluate(scene, base, road, 60. / 3.6,
                                                     wall=clock[0] + wall_age_ms / 1000.)
                planned = time.perf_counter()
                forecast = urban_forecast(scene, scene.prediction['horizon_s'])
                path = signed_path(scene.observation.ego.speed_mps, command.steering,
                                   command.throttle * 2.5 - command.brake * 5., geometry,
                                   command.reverse, bounded=command.reverse)
                shield = ExecutionShield().check(forecast, path, command, road,
                    timestamp_s=frame.timestamp_s, wall_s=clock[0] + shield_age_ms / 1000.,
                    forward_recovery=behavior.get('action') in ('FOLLOW', 'SLOW'))
                finished = time.perf_counter()
                if first <= frame.frame_id:
                    payload = to_dict({'command': command, 'behavior': behavior,
                                       'prediction': scene.prediction, 'forecast': forecast.prediction,
                                       'shield': shield, 'road': road})
                    rows.append({'frame': frame.frame_id, 'payload': payload,
                                 'output_sha256': digest(payload),
                                 'scene_ms': (built - began) * 1000,
                                 'behavior_ms': (planned - built) * 1000,
                                 'shield_ms': (finished - planned) * 1000,
                                 'total_ms': (finished - began) * 1000})
    finally:
        builder.close()
    actual = [row['frame'] for row in rows]
    if actual != expected:
        raise ValueError(f'Missing recorded decisions (not excluded from gate): expected {expected}, got {actual}')
    if live_sample and not captured:
        raise ValueError('Requested live prediction sample was not captured')
    return {'source': 'DETERMINISTIC_SAVED_INPUT_CONTINUATION', 'native_acceptance': False,
            'source_sha256': source, 'source_unchanged': effective_source() == source,
            'contracts_sha256': contract_sha,
            'script_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'recording': str(root.resolve()), 'first': first, 'last': last,
            'clock': {'received': '100 + frame_id', 'build_elapsed_s': 0,
                      'planning_elapsed_s': 0, 'behavior_age_ms': wall_age_ms, 'shield_age_ms': shield_age_ms},
            'semantic_alignment': 'LATEST_RECORDED_EVALUATION_FRAME_NOT_NATIVE_ASYNC',
            'history_frames': len(history), 'history_sha256': digest(history),
            'expected_frames': expected, 'rows': rows}


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
    parser.add_argument('--deterministic', action='store_true')
    parser.add_argument('--first', type=int, default=900)
    parser.add_argument('--last', type=int, default=920)
    parser.add_argument('--wall-age-ms', type=float, default=100.)
    parser.add_argument('--shield-age-ms', type=float, default=150.)
    parser.add_argument('--baseline', type=Path)
    parser.add_argument('--contracts-oracle', type=Path)
    parser.add_argument('--live-sample', type=Path)
    args = parser.parse_args()
    if args.deterministic:
        report = deterministic_replay(args.recording, first=args.first, last=args.last,
                                      wall_age_ms=args.wall_age_ms, shield_age_ms=args.shield_age_ms,
                                      live_sample=args.live_sample)
        if args.baseline:
            report['comparison'] = compare_reports(json.loads(args.baseline.read_text(encoding='utf8')), report)
        save_json(args.output, report)
        print(json.dumps({'output': str(args.output), 'frames': len(report['rows']),
                          'comparison': report.get('comparison'), 'contracts_sha256': report['contracts_sha256']}))
        if not report['source_unchanged'] or report.get('comparison', {}).get('equivalent') is False:
            raise SystemExit(1)
        return
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
