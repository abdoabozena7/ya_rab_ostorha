"""Freeze/replay the first behavior-proposal package without starting CARLA."""
import argparse
from dataclasses import replace
from datetime import datetime, timezone
import hashlib
from importlib import metadata as packages
import json
from pathlib import Path
import platform
import subprocess
import sys
import time
from types import SimpleNamespace
from unittest.mock import patch
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
PROTOCOL = ROOT / 'config' / 'behavior-proposals-v1.json'


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, allow_nan=False).encode()).hexdigest()


def save(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf8') as stream:
        json.dump(value, stream, indent=2, allow_nan=False)
        stream.write('\n')


def runtime_environment():
    versions = {}
    for name in ('numpy', 'Pillow', 'scipy', 'carla'):
        try:
            versions[name] = {'status': 'INSTALLED', 'version': packages.version(name)}
        except packages.PackageNotFoundError:
            versions[name] = {'status': 'NOT_INSTALLED', 'version': None}
    return {'python': sys.version, 'platform': platform.platform(), 'packages': versions}


def control_input_identity(recording):
    from backend.core.recording_storage import open_recorded
    logical_path = 'telemetry/comparison-controls.jsonl'
    checksum, size = hashlib.sha256(), 0
    with open_recorded(Path(recording) / logical_path, 'rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            checksum.update(chunk)
            size += len(chunk)
    return {'path': logical_path, 'logical_sha256': checksum.hexdigest(), 'logical_bytes': size}


def source_manifest():
    from backend.core.egypt_urban import source_manifest as runtime_manifest
    paths = runtime_manifest()
    for path in [ROOT / 'package.json', ROOT / 'package-lock.json',
                 *sorted((ROOT / 'backend').glob('requirements*.txt')),
                 ROOT / 'scripts' / 'profile_control_pipeline.py',
                 ROOT / 'scripts' / 'replay_urban_control.py',
                 Path(__file__).resolve()]:
        if path.is_file():
            paths[path.relative_to(ROOT).as_posix()] = hashlib.sha256(path.read_bytes()).hexdigest()
    return dict(sorted(paths.items()))


def verify_archive(path, manifest, expected_sha256=None):
    checksum = hashlib.sha256(Path(path).read_bytes()).hexdigest()
    if expected_sha256 is not None and checksum != expected_sha256:
        raise ValueError('Frozen source archive checksum changed')
    with zipfile.ZipFile(path) as bundle:
        if (set(bundle.namelist()) != set(manifest) or bundle.testzip() is not None
                or any(hashlib.sha256(bundle.read(n)).hexdigest() != h for n, h in manifest.items())):
            raise ValueError('Frozen source archive contents do not match the manifest')
    return checksum


def replay_inputs(recording, frame_limit):
    from backend.core.contracts import to_dict
    from backend.core.recording import read_asset
    from backend.core.replay import ReplayReader
    from backend.core.safety_policy import sensor_observation
    if type(frame_limit) is not int or frame_limit < 1:
        raise ValueError('Replay frame limit must be a positive integer')
    root = Path(recording).resolve()
    metadata = json.loads((root / 'metadata.json').read_text(encoding='utf-8-sig'))
    config = metadata.get('config') or {}
    partition = str(config.get('seed_partition', '')).upper()
    if partition in ('TEST', 'HOLDOUT', 'ACCEPTANCE'):
        raise ValueError('Reserved evaluation recordings cannot be development replay inputs')
    if partition != 'DEVELOPMENT':
        raise ValueError('An explicit DEVELOPMENT partition is required for this diagnostic')
    status = json.loads((root / 'recording-status.json').read_text(encoding='utf8'))
    if status.get('finalized') is not True or status.get('incomplete'):
        raise ValueError('Replay requires a finalized, complete recording')
    reader = ReplayReader(root)
    selected, excluded, asset_hashes = [], [], {}
    for frame in reader.frames():
        if len(selected) >= frame_limit:
            break
        if not frame.complete:
            excluded.append({'frame_id': frame.frame_id, 'reason': 'INCOMPLETE_SENSOR_FRAME'})
            continue
        sensor_observation(frame)
        for sensor in frame.sensors:
            if sensor.asset:
                raw = read_asset(root, sensor.asset)
                checksum = hashlib.sha256(raw).hexdigest()
                if checksum != sensor.asset.sha256:
                    raise ValueError('Replay sensor checksum mismatch: ' + sensor.asset.path)
                asset_hashes[sensor.asset.path] = checksum
        selected.append(frame)
    if not selected:
        raise ValueError('No complete replayable sensor frames')
    identity = {'metadata_sha256': digest(metadata), 'frame_limit': frame_limit,
                'frames_sha256': digest([to_dict(f) for f in selected]),
                'assets': asset_hashes, 'excluded_frames': excluded,
                'recorded_controls': control_input_identity(root)}
    return reader, selected, {**identity, 'input_sha256': digest(identity),
                              'frame_ids': [f.frame_id for f in selected]}


def urban_replay(recording, frames, *, shadow=False):
    from backend.core import urban_driver
    from backend.core.contracts import CommandSource, ControlCommand, finite, from_dict, to_dict
    from backend.core.control_scene import ControlSceneBuilder
    from backend.core.maneuver_candidates import ExecutionShield, signed_path
    from backend.core.motion_geometry import VehicleGeometry
    from backend.core.recording import read_asset
    from backend.core.recording_storage import open_recorded
    from backend.core.safety_policy import sensor_observation
    root = Path(recording)
    metadata = json.loads((root / 'metadata.json').read_text(encoding='utf-8-sig'))
    geometry = VehicleGeometry(**metadata['config']['vehicle_geometry'])
    decisions = {}
    with open_recorded(root / 'telemetry' / 'comparison-controls.jsonl', 'rt') as stream:
        for line in stream:
            row = json.loads(line)
            if row.get('kind') == 'HYBRID_DECISION':
                if row['frame_id'] in decisions:
                    raise ValueError('Duplicate recorded behavior decision')
                decisions[row['frame_id']] = row
    if not decisions:
        raise ValueError('No recorded urban behavior decisions')
    session = next(iter(decisions.values()))['road_context']['session_id']
    builder = ControlSceneBuilder(session, geometry)
    driver = urban_driver.UrbanManeuverDriver(geometry)
    gate = None
    if shadow:
        from backend.core.behavior_proposals import BehaviorProposalShadow
        gate = BehaviorProposalShadow()
    rows, outputs = [], []
    # Replace only this driver's module clock, not Python's process-wide clock.
    # Real computation is measured outside the deterministic decision lease.
    with patch.object(urban_driver, 'time', SimpleNamespace(perf_counter=lambda: 0.)):
        for frame in frames:
            if frame.frame_id > max(decisions):
                break
            wall = 100. + frame.timestamp_s
            began = time.perf_counter()
            scene = builder.build(sensor_observation(frame), lambda a: read_asset(root, a), received_wall_s=wall)
            built = time.perf_counter()
            recorded = decisions.get(frame.frame_id)
            if recorded is None:
                continue
            road = recorded['road_context']
            if road['session_id'] != session:
                raise ValueError('Replay decisions cross session boundaries')
            base = from_dict(ControlCommand, recorded['base_command'])
            if base.frame_id != frame.frame_id or base.timestamp_s != frame.timestamp_s:
                raise ValueError('Recorded command and measured frame do not match')
            cap = finite(recorded.get('speed_cap_mps', 60. / 3.6), 'replay speed cap')
            if not 0. <= cap <= 60. / 3.6:
                raise ValueError('Replay speed cap is outside the urban protocol')
            command, behavior = driver.evaluate(scene, base, road, cap, wall=wall + .05)
            planned = time.perf_counter()
            forecast = urban_driver.urban_forecast(scene, scene.prediction['horizon_s'])
            path = signed_path(scene.observation.ego.speed_mps, command.steering,
                               command.throttle * 2.5 - command.brake * 5., geometry,
                               command.reverse, bounded=command.reverse)
            accepted, reason, evidence = ExecutionShield().check(
                forecast, path, command, road, timestamp_s=frame.timestamp_s, wall_s=wall + .06,
                forward_recovery=behavior.get('action') in ('FOLLOW', 'SLOW'))
            final = command if accepted else replace(command, source=CommandSource.SAFETY, throttle=0., brake=1.)
            finished = time.perf_counter()
            semantic = {
                'frame_id': frame.frame_id, 'command': to_dict(command), 'final_command': to_dict(final),
                'behavior': {k: to_dict(behavior.get(k)) for k in (
                    'action', 'phase', 'reason', 'front_blocker', 'target_speed_kmh', 'selected_side',
                    'selected_path', 'rejected', 'completed_maneuvers', 'request_replan', 'request_alternative')},
                'tracks': to_dict(forecast.prediction['tracks']),
                'forecasts': to_dict(forecast.prediction['control_trajectories']),
                'shield': {'accepted': accepted, 'reason': reason, 'evidence': to_dict(evidence)},
            }
            shadow_status = None
            if gate is not None:
                shadow_status = gate.observe(scene, road, behavior, wall_s=wall + .07)
                request = gate.take_request()
                if request:
                    gate.fail(request['request_id'], 'MODEL_UNAVAILABLE', 'No model is loaded in first-package replay')
                    shadow_status = gate.observe(scene, road, behavior, wall_s=wall + .08)
            outputs.append(semantic)
            rows.append({'frame_id': frame.frame_id, 'output_sha256': digest(semantic),
                         'speed_cap_mps': cap,
                         'speed_cap_source': 'RECORDED' if 'speed_cap_mps' in recorded else 'DECLARED_LEGACY_REPLAY_CAP',
                         'scene_ms': (built-began)*1000, 'behavior_ms': (planned-built)*1000,
                         'shield_ms': (finished-planned)*1000, 'total_ms': (finished-began)*1000,
                         'shadow_ms': (time.perf_counter()-finished)*1000 if gate else None,
                         'shadow': shadow_status})
    if not outputs:
        raise ValueError('Selected replay prefix contains no urban decisions')
    return {'decision_clock': 'FIXED_REPLAY_CLOCK', 'native_acceptance': False,
            'original_native_application_reproduced': False,
            'decision_wall_age_s': .05, 'shield_wall_age_s': .06,
            'output_sha256': digest(outputs), 'rows': rows}


def freeze(recording, frame_limit, archive, output):
    from scripts.profile_control_pipeline import run
    from backend.core.motion_geometry import VehicleGeometry
    before = source_manifest()
    reader, frames, inputs = replay_inputs(recording, frame_limit)
    urban = urban_replay(recording, frames)
    geometry = VehicleGeometry(**dict(reader.metadata.config['vehicle_geometry']))
    timings, rule_digest, count = run(str(recording), frame_limit, geometry)
    if before != source_manifest() or control_input_identity(recording) != inputs['recorded_controls']:
        raise RuntimeError('Source or recorded controls changed while freezing A; no baseline was published')
    archive = Path(archive)
    if Path(output).exists():
        raise FileExistsError('Baseline output already exists')
    archive.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive, 'x', compression=zipfile.ZIP_DEFLATED) as bundle:
        for name, expected in before.items():
            path = ROOT / name
            raw = path.read_bytes()
            if hashlib.sha256(raw).hexdigest() != expected:
                raise RuntimeError('Source changed while archiving A: ' + name)
            bundle.writestr(name, raw)
    archive_hash = verify_archive(archive, before)
    if before != source_manifest():
        raise RuntimeError('Source changed during archive verification; no baseline was published')
    report = {'version': 2, 'arm': 'A', 'created_at_utc': datetime.now(timezone.utc).isoformat(),
              'source_kind': 'EFFECTIVE_WORKING_TREE_NOT_HEAD_ONLY',
              'git_head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT).decode().strip(),
              'git_status': subprocess.check_output(['git', 'status', '--porcelain=v1'], cwd=ROOT).decode().splitlines(),
              'source_sha256': digest(before), 'source_manifest': before,
              'protocol_sha256': hashlib.sha256(PROTOCOL.read_bytes()).hexdigest(),
              'source_archive': str(archive.resolve()),
              'source_archive_sha256': archive_hash,
              'environment': runtime_environment(),
              'recording': str(Path(recording).resolve()), 'inputs': inputs,
              'rule_replay': {'frames': count, 'output_sha256': rule_digest, 'timings_ms': timings},
              'urban_replay': urban, 'native_run': False, 'native_acceptance': False,
              'limitations': ['Development diagnostic prefix, not independent test data',
                              'No native timing improvement or VLM benefit is established']}
    save(output, report)
    return {'output': str(output), 'source_sha256': report['source_sha256'],
            'sensor_frames': len(frames), 'urban_decisions': len(urban['rows']),
            'urban_output_sha256': urban['output_sha256'], 'native_run': False}


def verify_replay(baseline_path, output):
    from scripts.profile_control_pipeline import run
    from backend.core.motion_geometry import VehicleGeometry
    baseline = json.loads(Path(baseline_path).read_text(encoding='utf8'))
    if digest(baseline['source_manifest']) != baseline['source_sha256']:
        raise ValueError('Frozen source manifest checksum changed')
    verify_archive(baseline['source_archive'], baseline['source_manifest'], baseline['source_archive_sha256'])
    if hashlib.sha256(PROTOCOL.read_bytes()).hexdigest() != baseline['protocol_sha256']:
        raise ValueError('Measurement protocol changed from frozen A')
    recording = Path(baseline['recording'])
    reader, frames, inputs = replay_inputs(recording, baseline['inputs']['frame_limit'])
    if inputs != baseline['inputs']:
        raise ValueError('Replay input identity changed from frozen A')
    before = source_manifest()
    plain = urban_replay(recording, frames)
    shadow = urban_replay(recording, frames, shadow=True)
    rule_timings, rule_digest, rule_count = run(str(recording), baseline['inputs']['frame_limit'],
        VehicleGeometry(**dict(reader.metadata.config['vehicle_geometry'])))
    if before != source_manifest() or control_input_identity(recording) != inputs['recorded_controls']:
        raise RuntimeError('Source or recorded controls changed during replay verification')
    passed = (plain['output_sha256'] == shadow['output_sha256'] == baseline['urban_replay']['output_sha256']
              and rule_digest == baseline['rule_replay']['output_sha256']
              and rule_count == baseline['rule_replay']['frames'])
    report = {'version': 1, 'passed': passed, 'source_sha256': digest(before),
              'baseline_source_sha256': baseline['source_sha256'], 'input_sha256': inputs['input_sha256'],
              'environment': runtime_environment(),
              'plain': plain, 'shadow_model_unavailable': shadow,
              'rule_replay': {'frames': rule_count, 'output_sha256': rule_digest, 'timings_ms': rule_timings},
              'native_run': False,
              'native_acceptance': False, 'benefit_claim': False}
    save(output, report)
    if not passed:
        raise ValueError('Commands, behavior, forecasts or shield decisions differ from frozen A')
    return {'output': str(output), 'passed': True, 'decisions': len(plain['rows']),
            'output_sha256': plain['output_sha256'], 'native_run': False}


def report_timing(recording, output):
    from backend.core.pipeline_timing import summarize_timing
    from backend.core.recording_storage import open_recorded
    with open_recorded(Path(recording) / 'telemetry' / 'comparison-controls.jsonl', 'rt') as stream:
        summary = summarize_timing(json.loads(line) for line in stream)
    report = {'recording': str(Path(recording).resolve()), **summary}
    save(output, report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='operation', required=True)
    capture = commands.add_parser('freeze')
    capture.add_argument('--recording', type=Path, required=True)
    capture.add_argument('--frames', type=int, default=150)
    capture.add_argument('--archive', type=Path, required=True)
    capture.add_argument('--output', type=Path, required=True)
    check = commands.add_parser('replay')
    check.add_argument('--baseline', type=Path, required=True)
    check.add_argument('--output', type=Path, required=True)
    timing = commands.add_parser('timing')
    timing.add_argument('--recording', type=Path, required=True)
    timing.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.operation == 'freeze':
        result = freeze(args.recording, args.frames, args.archive, args.output)
    elif args.operation == 'replay':
        result = verify_replay(args.baseline, args.output)
    else:
        result = report_timing(args.recording, args.output)
    print(json.dumps(result, indent=2, allow_nan=False))


if __name__ == '__main__':
    main()
