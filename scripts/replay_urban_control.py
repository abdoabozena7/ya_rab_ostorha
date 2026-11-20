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
from backend.core.recording import read_asset
from backend.core.recording_storage import open_recorded
from backend.core.replay import ReplayReader
from backend.learning.egypt_budget import save_json


def canonical(value):
    return json.dumps(to_dict(value), sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def strict_json(value):
    def pairs(items):
        result = {}
        for key, item in items:
            if key in result:
                raise ValueError(f'Duplicate JSON key: {key}')
            result[key] = item
        return result

    def invalid(value):
        raise ValueError(f'Nonfinite JSON value: {value}')

    result = json.loads(value, object_pairs_hook=pairs, parse_constant=invalid)
    canonical(result)
    return result


class HistoryDigest:
    """Hash a canonical JSON array without retaining sensor history in memory."""
    def __init__(self):
        self.hash = hashlib.sha256(b'[')
        self.count = 0

    def append(self, value):
        if self.count:
            self.hash.update(b',')
        self.hash.update(canonical(value).encode())
        self.count += 1

    def hexdigest(self):
        result = self.hash.copy()
        result.update(b']')
        return result.hexdigest()


def read_control_history(root):
    decisions, decision_hashes, packets = {}, {}, {}
    checksum = hashlib.sha256()
    previous = {'HYBRID_DECISION': -1, 'CAMERA_DETECTIONS': -1}
    with open_recorded(Path(root) / 'telemetry' / 'comparison-controls.jsonl') as stream:
        while raw := stream.readline(32 * 1024 * 1024 + 1):
            if len(raw) > 32 * 1024 * 1024 or not raw.endswith(b'\n'):
                raise ValueError('Oversized or truncated control-log row')
            checksum.update(raw)
            row = strict_json(raw)
            if not isinstance(row, dict):
                raise ValueError('Control-log row must be an object')
            kind = row.get('kind')
            if kind not in previous:
                continue
            frame = row.get('frame_id' if kind == 'HYBRID_DECISION' else 'evaluation_frame')
            if type(frame) is not int or frame <= previous[kind]:
                raise ValueError(f'Duplicate, reordered or invalid {kind} frame: {frame}')
            previous[kind] = frame
            if kind == 'HYBRID_DECISION':
                if not all(isinstance(row.get(key), dict) for key in ('road_context', 'base_command')):
                    raise ValueError('Recorded decision needs road_context and base_command')
                decision_hashes[frame] = digest(row)
                decisions[frame] = {key: row[key] for key in ('road_context', 'base_command')}
            else:
                if not isinstance(row.get('result'), dict):
                    raise ValueError('Recorded camera packet needs a result object')
                packets[frame] = row
            if len(decisions) > 10000 or len(packets) > 10000:
                raise ValueError('Offline replay is bounded to 10000 decisions/camera packets')
    return {'decisions': decisions, 'decision_hashes': decision_hashes, 'packets': packets,
            'control_log_sha256': checksum.hexdigest()}


def report_errors(report, *, complete=False):
    errors = []
    if not isinstance(report, dict):
        return ['report_not_object']
    frames, rows = report.get('expected_frames'), report.get('rows')
    if (not isinstance(frames, list) or not frames
            or any(type(frame) is not int or frame < 0 for frame in frames)
            or frames != sorted(set(frames))):
        errors.append('invalid_expected_frames')
    if not isinstance(rows, list):
        return errors + ['rows_not_array']
    actual = []
    for index, row in enumerate(rows):
        if not isinstance(row, dict) or type(row.get('frame')) is not int:
            errors.append(f'row:{index}:invalid_frame')
            continue
        actual.append(row['frame'])
        payload = row.get('payload')
        try:
            if not isinstance(payload, dict) or row.get('output_sha256') != digest(payload):
                errors.append(f'frame:{row["frame"]}:invalid_output_sha256')
            if complete and (not isinstance(payload, dict) or set(payload) != {
                    'command', 'behavior', 'prediction', 'forecast', 'shield', 'road'}):
                errors.append(f'frame:{row["frame"]}:incomplete_payload')
            elif complete:
                shield = payload['shield']
                if (any(not isinstance(payload[key], dict) for key in
                        ('command', 'behavior', 'prediction', 'forecast', 'road'))
                        or not isinstance(shield, list) or len(shield) != 3
                        or type(shield[0]) is not bool or not isinstance(shield[1], str)
                        or not isinstance(shield[2], dict)):
                    errors.append(f'frame:{row["frame"]}:malformed_complete_payload')
        except (TypeError, ValueError):
            errors.append(f'frame:{row["frame"]}:invalid_payload')
    if actual != frames:
        errors.append('row_inventory')
    return errors


def replay_clock(wall_age_ms, shield_age_ms):
    return {'received': '100 + frame_id', 'build_elapsed_s': 0, 'planning_elapsed_s': 0,
            'behavior_age_ms': wall_age_ms, 'shield_age_ms': shield_age_ms}


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
    differences = [f'{side}:{error}' for side, report in (('baseline', baseline), ('candidate', candidate))
                   for error in report_errors(report)]
    if not isinstance(baseline, dict) or not isinstance(candidate, dict):
        return {'equivalent': False, 'differences': differences, 'baseline_rows': 0, 'candidate_rows': 0}
    differences += [key for key in keys if key not in baseline or key not in candidate
                    or canonical(baseline[key]) != canonical(candidate[key])]
    if baseline.get('script_sha256') != candidate.get('script_sha256'):
        differences.append('script_sha256')
    if baseline.get('source_unchanged') is False or candidate.get('source_unchanged') is False:
        differences.append('source_changed_during_replay')
    old_rows = baseline.get('rows') if isinstance(baseline.get('rows'), list) else []
    new_rows = candidate.get('rows') if isinstance(candidate.get('rows'), list) else []
    old = {row['frame']: row for row in old_rows
           if isinstance(row, dict) and type(row.get('frame')) is int}
    new = {row['frame']: row for row in new_rows
           if isinstance(row, dict) and type(row.get('frame')) is int}
    if old.keys() != new.keys():
        differences.append('frame_set')
    for frame in sorted(old.keys() & new.keys()):
        for key in ('payload', 'output_sha256'):
            try:
                different = canonical(old[frame].get(key)) != canonical(new[frame].get(key))
            except (TypeError, ValueError):
                different = True
            if different:
                differences.append(f'frame:{frame}:{key}')
    return {'equivalent': not differences, 'differences': differences,
            'baseline_rows': len(old), 'candidate_rows': len(new)}


def deterministic_replay(root, *, first, last, wall_age_ms, shield_age_ms, live_sample=None,
                         semantic_bundle=None, row_sink=None, allow_test_data=False):
    """Replay full sensor/semantic/driver history using explicit synthetic ages."""
    from backend.core import contracts, control_scene, prediction, urban_driver
    from backend.core.control_scene import ControlSceneBuilder
    from backend.core.egypt_urban import source_manifest
    from backend.core.maneuver_candidates import ExecutionShield, signed_path
    from backend.core.measured_rays import warm_measured_rays
    from backend.core.motion_geometry import VehicleGeometry
    from backend.core.safety_policy import sensor_observation
    from backend.core.urban_driver import UrbanManeuverDriver, urban_forecast
    from threadpoolctl import threadpool_limits
    if (type(first) is not int or type(last) is not int or first < 0 or first > last
            or not np.isfinite([wall_age_ms, shield_age_ms]).all()
            or not 0 <= wall_age_ms <= shield_age_ms):
        raise ValueError('Ordered frames and nonnegative increasing wall ages required')
    root = Path(root)
    if semantic_bundle is not None:
        from scripts.compare_perception_replay import require_development
        require_development(root, allow_test_data=allow_test_data)
    warm_measured_rays()
    controls = read_control_history(root)
    decisions = controls['decisions']
    original_detections = {frame: row['result'] for frame, row in controls['packets'].items()}
    detections = original_detections
    expected = sorted(frame for frame in decisions if first <= frame <= last)
    if not expected or not detections:
        raise ValueError('Recorded decisions and camera semantics are required')
    reader = ReplayReader(root, allow_test_data=allow_test_data)
    intervention = None
    if semantic_bundle is not None:
        from scripts.compare_perception_replay import verify_bundle
        intervention = verify_bundle(root, semantic_bundle, first=first, last=last,
            wall_age_ms=wall_age_ms, shield_age_ms=shield_age_ms, reader=reader,
            controls=controls, allow_test_data=allow_test_data)
        detections = {**original_detections, **intervention['replacements']}
    geometry = VehicleGeometry(**dict(reader.metadata.config['vehicle_geometry']))
    builder = ControlSceneBuilder(next(iter(decisions.values()))['road_context']['session_id'], geometry)
    driver = UrbanManeuverDriver(geometry)
    contract_sha = hashlib.sha256(Path(contracts.__file__).read_bytes()).hexdigest()
    script_sha = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()

    def effective_source():
        manifest = source_manifest()
        manifest['backend/core/contracts.py'] = hashlib.sha256(Path(contracts.__file__).read_bytes()).hexdigest()
        return hashlib.sha256(json.dumps(manifest, sort_keys=True).encode()).hexdigest()

    source = effective_source()
    rows, actual, history = [], [], HistoryDigest()
    original_history, context_history = HistoryDigest(), HistoryDigest()
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
                entry = {'frame': to_dict(frame), 'semantic_frame': semantic_frame,
                         'semantic_sha256': digest(semantic),
                         'decision_sha256': controls['decision_hashes'].get(frame.frame_id, digest(None))}
                assets = {}
                if frame.complete:
                    assets = {s.asset.path: read_asset(root, s.asset) for s in frame.sensors if s.asset}
                    entry['asset_sha256'] = {name: hashlib.sha256(data).hexdigest()
                                             for name, data in assets.items()}
                history.append(entry)
                context = None
                if intervention is not None:
                    from scripts.compare_perception_replay import immutable_semantic
                    original = original_detections.get(semantic_frame)
                    original_history.append({**entry, 'semantic_sha256': digest(original)})
                    immutable = immutable_semantic(original, intervention['manifest']['allowed_changes'])
                    context_history.append({**entry, 'semantic_sha256': digest(immutable)})
                    context = {'frame_sha256': digest(entry['frame']),
                               'decision_sha256': entry['decision_sha256'],
                               'asset_sha256': entry.get('asset_sha256', {}),
                               'semantic_frame': semantic_frame, 'immutable_semantic': immutable,
                               'original_semantic_sha256': digest(original)}
                if not frame.complete:
                    continue
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
                    row = {'frame': frame.frame_id, 'payload': payload,
                           'output_sha256': digest(payload),
                           'scene_ms': (built - began) * 1000,
                           'behavior_ms': (planned - built) * 1000,
                           'shield_ms': (finished - planned) * 1000,
                           'total_ms': (finished - began) * 1000}
                    if context is not None:
                        row.update(input_context=context, input_context_sha256=digest(context),
                                   semantic_input=semantic, semantic_input_sha256=digest(semantic))
                    actual.append(frame.frame_id)
                    if row_sink is None:
                        rows.append(row)
                    else:
                        row_sink(row)
    finally:
        builder.close()
    if actual != expected:
        raise ValueError(f'Missing recorded decisions (not excluded from gate): expected {expected}, got {actual}')
    if live_sample and not captured:
        raise ValueError('Requested live prediction sample was not captured')
    report = {'source': 'DETERMINISTIC_SAVED_INPUT_CONTINUATION', 'native_acceptance': False,
            'source_sha256': source, 'source_unchanged': effective_source() == source
                and hashlib.sha256(Path(__file__).read_bytes()).hexdigest() == script_sha,
            'contracts_sha256': contract_sha,
            'script_sha256': script_sha,
            'recording': str(root.resolve()), 'first': first, 'last': last,
            'clock': replay_clock(wall_age_ms, shield_age_ms),
            'semantic_alignment': 'LATEST_RECORDED_EVALUATION_FRAME_NOT_NATIVE_ASYNC',
            'history_frames': history.count, 'history_sha256': history.hexdigest(),
            'expected_frames': expected, 'rows': rows}
    if intervention is not None:
        from scripts.compare_perception_replay import verify_recording_unchanged
        verify_recording_unchanged(root, intervention['manifest']['binding'])
        report.update(semantic_intervention=intervention['manifest'],
                      original_history_sha256=original_history.hexdigest(),
                      input_context_history_sha256=context_history.hexdigest())
    return report


def replay(root, *, prepare_space=False):
    from backend.core.control_scene import ControlSceneBuilder
    from backend.core.maneuver_candidates import ExecutionShield, signed_path
    from backend.core.measured_rays import warm_measured_rays
    from backend.core.motion_geometry import VehicleGeometry
    from backend.core.safety_policy import sensor_observation
    from backend.core.urban_driver import UrbanManeuverDriver, urban_forecast
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
