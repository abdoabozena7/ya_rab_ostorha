"""Synthetic sensor-contract fixtures only: no CARLA, ONNX inference or native claims.

The in-memory filesystem exercises real ReplayReader/read_asset/gzip interfaces.
The scene builder, driver, prediction and shield are not mocked.
"""
import builtins
import copy
from contextlib import ExitStack
import gzip
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

import numpy as np
from PIL import Image

from backend.core.contracts import (
    AssetReference, CommandSource, ControlCommand, DataOrigin, ExperimentMetadata,
    RotationRad, SensorFrame, SensorKind, SimulationFrame, Transform, VehicleState,
    WorldState, to_dict,
)
from backend.core.motion_geometry import VehicleGeometry
from scripts import compare_perception_replay as study
from scripts.replay_urban_control import canonical, compare_reports, deterministic_replay, digest, read_control_history


class MemoryFiles:
    """Only paths below this explicitly synthetic root are virtualized."""
    def __init__(self):
        self.base = (Path.cwd() / 'tests' / '_in_memory_perception_fixture').absolute()
        self.files = {}

    def key(self, path):
        return str(Path(path).absolute())

    def owns(self, path):
        return not isinstance(path, int) and Path(path).absolute().is_relative_to(self.base)

    def put(self, path, value):
        self.files[self.key(path)] = value if isinstance(value, bytes) else value.encode('utf8')

    def read(self, path):
        return self.files[self.key(path)]

    def open(self, path, mode='r', *args, **kwargs):
        key = self.key(path)
        writing = 'w' in mode or 'x' in mode
        if 'x' in mode and key in self.files:
            raise FileExistsError(key)
        if not writing and key not in self.files:
            raise FileNotFoundError(key)
        owner = self

        class Buffer(io.BytesIO):
            def close(self):
                if writing and not self.closed:
                    owner.files[key] = self.getvalue()
                super().close()

        buffer = Buffer(b'' if writing else self.files[key])
        return buffer if 'b' in mode else io.TextIOWrapper(buffer, encoding=kwargs.get('encoding') or 'utf8')

    def __enter__(self):
        self.stack = ExitStack()
        original_open, original_builtin = Path.open, builtins.open
        original_file, original_exists, original_mkdir = Path.is_file, Path.exists, Path.mkdir
        owner = self
        self.stack.enter_context(patch.object(Path, 'open', lambda path, *a, **k:
            owner.open(path, *a, **k) if owner.owns(path) else original_open(path, *a, **k)))
        self.stack.enter_context(patch('builtins.open', lambda path, *a, **k:
            owner.open(path, *a, **k) if owner.owns(path) else original_builtin(path, *a, **k)))
        self.stack.enter_context(patch.object(Path, 'is_file', lambda path:
            owner.key(path) in owner.files if owner.owns(path) else original_file(path)))
        self.stack.enter_context(patch.object(Path, 'exists', lambda path:
            owner.key(path) in owner.files if owner.owns(path) else original_exists(path)))
        self.stack.enter_context(patch.object(Path, 'mkdir', lambda path, *a, **k:
            None if owner.owns(path) else original_mkdir(path, *a, **k)))
        return self

    def __exit__(self, *args):
        return self.stack.__exit__(*args)


def fixture(files):
    root = files.base / 'recording'
    session = 'synthetic-perception-test-not-native'
    model = b'SYNTHETIC CONSTRUCTOR TEST BYTES - NOT AN ONNX MODEL'
    profile = {'id': study.PROFILE_ID, 'input_size': 640, 'model_sha256': hashlib.sha256(model).hexdigest()}
    pose = Transform((0., 0., 0.), RotationRad(0., 0., 0.), 'TEST_FIXTURE')
    mount = {'position_m': [1.5, 0., 1.6], 'rotation_deg': {'roll': 0., 'pitch': 0., 'yaw': 0.}}
    image = io.BytesIO()
    Image.fromarray(np.full((360, 640, 3), 24, np.uint8)).save(image, format='PNG')
    depth = io.BytesIO()
    np.save(depth, np.full((45, 80), 12., np.float32), allow_pickle=False)
    points = np.array([[x, y, -1.9, .5] for x in np.arange(2.5, 15., 1.)
                       for y in np.arange(-1.5, 1.6, .5)], dtype='<f4').tobytes()
    frames = []
    for frame_id in (2, 3, 4):
        stamp = frame_id * .05
        sensors = []
        for name, kind, raw, media, calibration in (
                ('frontCamera', SensorKind.RGB, image.getvalue(), 'image/png',
                 {'width': 640, 'height': 360, 'fov_deg': 90., 'mount_transform': mount}),
                ('depth', SensorKind.DEPTH, depth.getvalue(), 'application/x-npy',
                 {'width': 80, 'height': 45, 'fov_deg': 90., 'mount_transform': mount}),
                ('lidar', SensorKind.LIDAR, points, 'application/octet-stream',
                 {'mount_transform': {'position_m': [0., 0., 1.9],
                                      'rotation_deg': {'roll': 0., 'pitch': 0., 'yaw': 0.}}})):
            relative = f'assets/{name}-{frame_id}.bin'
            asset = AssetReference(relative, media, len(raw), hashlib.sha256(raw).hexdigest())
            files.put(root / relative, raw)
            sensors.append(SensorFrame(name, kind, frame_id, stamp, stamp, pose, 'test-fixture',
                                       asset=asset, metadata=calibration))
        sensors.append(SensorFrame('radar', SensorKind.RADAR, frame_id, stamp, stamp, pose,
            'test-fixture', data={'detections': []}, units={'depth_m': 'm'}))
        sensors.append(SensorFrame('imu', SensorKind.IMU, frame_id, stamp, stamp, pose,
            'test-fixture', data={'gyroscope_radps': [0., 0., 0.]}, units={'gyroscope_radps': 'rad/s'}))
        vehicle = VehicleState(frame_id, stamp, pose, (0., 0., 0.), (0., 0., 0.),
                               (0., 0., 0.), 0., 0., .2, 0., 1, False, False, 'test-fixture')
        frames.append(SimulationFrame(frame_id, stamp,
            WorldState(frame_id, stamp, 'test-fixture', fixed_delta_seconds=.05),
            vehicle, tuple(sensors)))
    metadata = ExperimentMetadata('synthetic_perception_fixture', 'SYNTHETIC OFFLINE UNIT FIXTURE',
        'test-fixture', DataOrigin.TEST_FIXTURE, config={
            'scenario_id': 'EGYPT_URBAN_CHAOS_V1', 'seed_partition': 'DEVELOPMENT',
            'session_id': session, 'perception_profile': profile,
            'vehicle_geometry': to_dict(VehicleGeometry())})
    files.put(root / 'metadata.json', canonical(metadata))
    files.put(root / 'telemetry' / 'frames.jsonl.gz',
              gzip.compress(''.join(canonical(frame) + '\n' for frame in frames).encode()))
    records = []
    for evaluation, source in ((1, 1), (3, 2), (4, 3)):
        result = {'status': 'RUNNING', 'session_id': session, 'frame_id': source, 'timestamp_s': source * .05,
                  'detector_profile': profile, 'detector_runtime': {
                      'execution_provider': 'TEST_FIXTURE_NO_INFERENCE', 'onnxruntime_version': 'FIXTURE'},
                  'width': 640, 'height': 360, 'detector_ms': 12., 'published_at': 1000. + source,
                  'source_sensor': 'frontCamera', 'semantic_coverage': 'FRONT_CAMERA_ONLY',
                  'source_image_sha256': hashlib.sha256(image.getvalue()).hexdigest(), 'detections': []}
        records.append({'kind': 'CAMERA_DETECTIONS', 'session_id': session,
                        'evaluation_frame': evaluation, 'timestamp_s': evaluation * .05, 'result': result})
    road = {'session_id': session, 'centerline': [[0., 0.], [50., 0.]], 'lane_width_m': 3.5,
            'junction_ahead': False, 'left_allowed': False, 'right_allowed': False, 'remaining_m': 50.}
    for frame in frames[1:]:
        command = ControlCommand(frame.frame_id, frame.timestamp_s, .2, 0., 0., False, False, CommandSource.SYSTEM, 1)
        records.append({'kind': 'HYBRID_DECISION', 'frame_id': frame.frame_id,
                        'timestamp_s': frame.timestamp_s, 'road_context': road,
                        'base_command': to_dict(command), 'prediction': {'source': 'SYNTHETIC_RECORDED_FIELD'}})
    files.put(root / 'telemetry' / 'comparison-controls.jsonl.gz',
              gzip.compress(''.join(canonical(row) + '\n' for row in records).encode()))
    files.put(files.base / 'fixture-model.bin', model)
    return root, records


class PerceptionReplayTests(unittest.TestCase):
    def setUp(self):
        self.files = self.enterContext(MemoryFiles())
        self.root, self.records = fixture(self.files)
        self.options = {'first': 3, 'last': 4, 'wall_age_ms': 100., 'shield_age_ms': 150.,
                        'allow_test_data': True}
        self.bundle_path = self.files.base / 'recorded-bundle.json.gz'
        self.bundle = study.export_bundle(self.root, self.bundle_path, activation=3, **self.options)

    def replay(self, name='baseline.jsonl.gz', bundle=None):
        path = self.files.base / name
        study.replay_to_artifact(self.root, self.bundle if bundle is None else bundle, path, **self.options)
        return path

    def read_report(self, path):
        with study.ArtifactReader(path) as reader:
            rows = list(reader.rows())
            return {**reader.metadata, 'rows': rows}

    def save_report(self, name, report):
        path = self.files.base / name
        metadata = {key: value for key, value in report.items() if key not in ('rows', 'artifact_row_count')}
        with study.ArtifactWriter(path) as writer:
            for row in report['rows']:
                writer.append(row)
            writer.finish(metadata)
        return path

    def compare(self, baseline, candidate, name='diff.jsonl.gz'):
        output = self.files.base / name
        result = study.compare_artifacts(baseline, candidate, output)
        with study.ArtifactReader(output, schema=study.DIFF_SCHEMA, list_key='differences') as reader:
            differences = list(reader.rows())
        self.assertEqual(len(differences), sum(result['difference_counts'].values()))
        return result, differences

    def test_recorded_warmup_and_verified_source_identities_are_explicit(self):
        self.assertEqual(study.load_bundle(self.bundle_path), self.bundle)
        self.assertEqual(self.bundle['binding']['data_origin'], 'TEST_FIXTURE')
        self.assertEqual(self.bundle['warmup']['evaluation_frames'], [1])
        self.assertFalse(self.bundle['warmup']['replacement_from_native_startup'])
        checked = study.verify_bundle(self.root, self.bundle_path, **self.options)
        self.assertEqual(list(checked['replacements']), [3, 4])
        self.assertEqual(self.bundle['packets'][0]['source']['rgb']['asset']['path'], 'assets/frontCamera-2.bin')
        self.assertEqual(self.bundle['packets'][0]['source']['depth']['frame_id'], 2)
        self.assertEqual(self.bundle['packets'][0]['source']['rgb_pixels_sha256'],
                         hashlib.sha256(np.full((360, 640, 3), 24, np.uint8).tobytes()).hexdigest())
        with self.assertRaisesRegex(ValueError, 'Missing retained RGB/depth source frames'):
            study.export_bundle(self.root, self.files.base / 'no-warmup.json', activation=1, **self.options)
        malformed = copy.deepcopy(self.bundle)
        malformed['warmup']['replacement_from_native_startup'] = True
        with self.assertRaisesRegex(ValueError, 'Warmup'):
            study.verify_bundle(self.root, malformed, **self.options)

    def test_actual_complete_replay_repeat_and_ordinary_json_match_exactly(self):
        baseline = self.replay()
        repeat = self.replay('repeat.json')
        result, differences = self.compare(baseline, repeat)
        self.assertTrue(result['equivalent'], differences[:3])
        self.assertTrue(result['valid'])
        self.assertEqual(result['comparison_kind'], 'RECORDED_SEMANTICS_REPEAT')
        self.assertEqual(result['baseline_perception']['runtimes'][0]['onnxruntime_version'], 'FIXTURE')
        self.assertEqual(result['difference_counts'], {key: 0 for key in result['difference_counts']})
        report = self.read_report(baseline)
        self.assertEqual(report['evidence_class'], 'SYNTHETIC_TEST_FIXTURE')
        self.assertEqual(report['expected_frames'], [3, 4])
        self.assertEqual(report['history_frames'], 3)
        self.assertFalse(report['native_acceptance'])
        self.assertEqual(set(report['rows'][0]['payload']), {'command', 'behavior', 'prediction', 'forecast', 'shield', 'road'})
        self.assertEqual(report['rows'][0]['payload']['command']['frame_id'], 3)
        self.assertEqual(report['rows'][0]['input_context']['semantic_frame'], 3)
        self.assertEqual(report['rows'][1]['input_context']['semantic_frame'], 4)
        self.assertEqual(report['history_sha256'], report['original_history_sha256'])
        default = deterministic_replay(self.root, **self.options)
        self.assertTrue(compare_reports(default, report)['equivalent'])
        for left, right in zip(default['rows'], report['rows']):
            self.assertEqual(canonical(left['payload']), canonical(right['payload']))

    def test_semantic_intervention_keeps_context_but_never_weakens_old_history_oracle(self):
        baseline = self.replay()
        candidate = copy.deepcopy(self.bundle)
        candidate['producer']['kind'] = 'DECLARED_SEMANTIC_INTERVENTION'
        candidate['packets'][0]['result']['detections'] = [
            {'class': 'car', 'confidence': .65000000001, 'classification_status': 'SUPPORTED',
             'xyxy': [20., 100., 80., 180.]}]
        path = self.replay('semantic.jsonl.gz', candidate)
        result, differences = self.compare(baseline, path)
        self.assertTrue(result['valid'], differences[:3])
        self.assertGreater(result['difference_counts']['declared_semantics'], 0)
        self.assertEqual(result['difference_counts']['input_context'], 0)
        self.assertFalse(compare_reports(self.read_report(baseline), self.read_report(path))['equivalent'])
        self.assertTrue(any('/detections' in row['path'] for row in differences))

    def test_real_driver_receives_changed_semantics_and_retains_exact_nested_confidence(self):
        from backend.computer_vision.depth_evidence import attach_depth
        baseline = self.replay()
        candidate = copy.deepcopy(self.bundle)
        candidate['producer']['kind'] = 'DECLARED_SEMANTIC_INTERVENTION'
        result = candidate['packets'][0]['result']
        result['detections'] = [{'class': 'person', 'confidence': .70000000000001,
                                 'classification_status': 'SUPPORTED', 'xyxy': [200., 100., 400., 300.]}]
        attach_depth(result['detections'], np.full((45, 80), 12., np.float32),
                     result['frame_id'], result['timestamp_s'], rgb_size=(640, 360))
        path = self.replay('measured-person.jsonl.gz', candidate)
        report = self.read_report(path)
        for row in report['rows']:
            people = [track for track in row['payload']['prediction']['tracks'] if track['class'] == 'person']
            self.assertEqual(len(people), 1)
            self.assertEqual(people[0]['semantic_evidence']['confidence'], .70000000000001)
            self.assertEqual(people[0]['semantic_evidence']['source_frame'], 2)
            self.assertEqual(people[0]['measurement_evidence']['frame_id'], row['frame'])
            self.assertEqual(people[0]['measurement_evidence']['source'], 'CURRENT_DEPTH_BODY_CORE')
        summary, differences = self.compare(baseline, path)
        self.assertTrue(summary['valid'], differences[:3])
        self.assertFalse(summary['equivalent'])
        self.assertGreater(summary['difference_counts']['output'], 0)
        self.assertEqual(summary['difference_counts']['input_context'], 0)
        self.assertTrue(any('/payload/prediction/' in row['path'] for row in differences if row['category'] == 'output'))

    def test_nested_payload_mutation_is_invalid_with_stale_hash_and_unequal_with_valid_hash(self):
        baseline = self.replay()
        for key in ('command', 'behavior', 'prediction', 'forecast', 'shield', 'road'):
            with self.subTest(payload=key):
                report = self.read_report(baseline)
                value = report['rows'][0]['payload'][key]
                if isinstance(value, dict):
                    value['synthetic_nested_negative_control'] = {'value': [1.00000000001]}
                else:
                    value[2]['synthetic_nested_negative_control'] = [1.00000000001]
                stale = self.save_report(f'{key}-stale.json.gz', report)
                result, differences = self.compare(baseline, stale, f'{key}-stale-diff.jsonl.gz')
                self.assertFalse(result['valid'])
                self.assertTrue(any('invalid_output_sha256' in row.get('error', '') for row in differences))
                report['rows'][0]['output_sha256'] = digest(report['rows'][0]['payload'])
                changed = self.save_report(f'{key}-changed.jsonl.gz', report)
                result, differences = self.compare(baseline, changed, f'{key}-changed-diff.jsonl.gz')
                self.assertTrue(result['valid'], differences[:3])
                self.assertFalse(result['equivalent'])
                self.assertTrue(any(row['category'] == 'output' and f'/payload/{key}/' in row['path'] for row in differences))

    def test_packet_inventory_and_malformed_bundles_never_fall_back(self):
        for value in ([], self.bundle['packets'][:1], self.bundle['packets'][::-1],
                      self.bundle['packets'] + [self.bundle['packets'][-1]],
                      [self.bundle['packets'][0]] * 2, [None]):
            with self.subTest(packets=repr(value)[:50]):
                candidate = copy.deepcopy(self.bundle)
                candidate['packets'] = value
                with self.assertRaisesRegex(ValueError, 'packet|Replacement'):
                    study.verify_bundle(self.root, candidate, **self.options)
        for mutate in (lambda b: b.update(schema='OTHER'), lambda b: b.update(debug=True),
                       lambda b: b.update(allowed_changes=['clock']),
                       lambda b: b.update(warmup=None), lambda b: b.update(packets='not an array')):
            candidate = copy.deepcopy(self.bundle)
            mutate(candidate)
            with self.assertRaises(ValueError):
                study.verify_bundle(self.root, candidate, **self.options)
        path = self.files.base / 'duplicate-key.json'
        self.files.put(path, '{"schema":1,"schema":2}')
        with self.assertRaisesRegex(ValueError, 'Duplicate JSON key'):
            study.load_bundle(path)

    def test_clocks_model_context_and_source_changes_are_rejected_before_driver(self):
        changes = (
            lambda b: b['binding']['clock'].update(behavior_age_ms=101.),
            lambda b: b['binding'].update(control_log_sha256='0' * 64),
            lambda b: b['binding']['source'].update(driving_sha256='0' * 64),
            lambda b: b['binding']['model_profile'].update(model_sha256='0' * 64),
            lambda b: b['packets'][0]['source']['rgb']['asset'].update(sha256='0' * 64),
            lambda b: b['packets'][0]['result'].update(published_at=1009.),
            lambda b: b['packets'][0]['result'].update(source_image_sha256='0' * 64),
            lambda b: b['packets'][0]['result'].update(timestamp_s=.11),
            lambda b: b['packets'][0]['result']['detector_profile'].update(input_size=320),
        )
        for mutate in changes:
            candidate = copy.deepcopy(self.bundle)
            candidate['producer']['kind'] = 'DECLARED_SEMANTIC_INTERVENTION'
            mutate(candidate)
            with patch('backend.core.control_scene.ControlSceneBuilder') as builder:
                with self.assertRaisesRegex(ValueError, 'binding|identity|context|model|profile|source'):
                    deterministic_replay(self.root, semantic_bundle=candidate, **self.options)
                builder.assert_not_called()

    def test_missing_corrupt_or_unsynchronized_images_are_errors(self):
        source = self.root / 'assets' / 'frontCamera-2.bin'
        original = self.files.read(source)
        for value in (None, b'corrupt pixels'):
            if value is None:
                self.files.files.pop(self.files.key(source))
            else:
                self.files.put(source, value)
            with self.assertRaisesRegex(ValueError, 'Missing recorded asset|length mismatch|checksum'):
                study.verify_bundle(self.root, self.bundle, **self.options)
        self.files.put(source, original)
        candidate = copy.deepcopy(self.bundle)
        candidate['packets'][0]['result']['detections'] = [{
            'class': 'person', 'confidence': .9, 'classification_status': 'SUPPORTED', 'xyxy': [1., 1., 20., 50.],
            'depth_evidence': {'source_sensor': 'depth', 'frame_id': 3, 'timestamp_s': .15}}]
        with self.assertRaisesRegex(ValueError, 'depth association'):
            study.verify_bundle(self.root, candidate, **self.options)

    def test_holdout_debug_and_unacknowledged_test_data_fail_before_reading_frames(self):
        metadata_path = self.root / 'metadata.json'
        original = json.loads(self.files.read(metadata_path))
        for partition in ('HOLDOUT', 'DEBUG', None):
            metadata = copy.deepcopy(original)
            metadata['config']['seed_partition'] = partition
            self.files.put(metadata_path, canonical(metadata))
            with patch.object(study, 'ReplayReader') as reader:
                with self.assertRaisesRegex(ValueError, 'HOLDOUT/DEBUG'):
                    study.verify_bundle(self.root, self.bundle, **self.options)
                reader.assert_not_called()
        self.files.put(metadata_path, canonical(original))
        with self.assertRaisesRegex(ValueError, 'TEST_FIXTURE'):
            study.verify_bundle(self.root, self.bundle, **{**self.options, 'allow_test_data': False})
        with self.assertRaisesRegex(ValueError, 'original recording'):
            study.export_bundle(self.root, self.root / 'forbidden.json', activation=3, **self.options)
        with self.assertRaisesRegex(ValueError, 'overwrite'):
            study.export_bundle(self.root, self.bundle_path, activation=3, **self.options)

    def test_report_inventory_and_control_log_duplicates_are_rejected(self):
        baseline = self.replay()
        report = self.read_report(baseline)
        row_sets = ([], report['rows'][:1], report['rows'][::-1], report['rows'] + [report['rows'][1]],
                    [report['rows'][0], report['rows'][0]])
        for index, rows in enumerate(row_sets):
            candidate = self.save_report(f'inventory-{index}.jsonl.gz', {**report, 'rows': rows})
            result, _ = self.compare(baseline, candidate, f'inventory-diff-{index}.jsonl.gz')
            self.assertFalse(result['valid'])
            self.assertFalse(result['equivalent'])
        records = self.records + [self.records[-1]]
        self.files.put(self.root / 'telemetry' / 'comparison-controls.jsonl.gz',
            gzip.compress(''.join(canonical(row) + '\n' for row in records).encode()))
        with self.assertRaisesRegex(ValueError, 'Duplicate, reordered'):
            read_control_history(self.root)

    def test_comparator_reports_context_and_source_clock_differences_separately(self):
        baseline = self.replay()
        report = self.read_report(baseline)
        report['clock']['behavior_age_ms'] = 101.
        report['source_sha256'] = '0' * 64
        report['rows'][0]['input_context']['decision_sha256'] = '1' * 64
        report['rows'][0]['input_context_sha256'] = digest(report['rows'][0]['input_context'])
        candidate = self.save_report('context.jsonl.gz', report)
        result, differences = self.compare(baseline, candidate)
        self.assertFalse(result['valid'])
        self.assertGreater(result['difference_counts']['input_context'], 0)
        self.assertEqual(result['difference_counts']['output'], 0)
        self.assertTrue(any('/clock/' in row['path'] for row in differences))

    def test_rehashed_packet_clocks_and_delivery_cannot_masquerade_as_declared_semantics(self):
        baseline = self.replay()
        for field in ('published_at', 'timestamp_s', 'frame_id'):
            report = self.read_report(baseline)
            manifest = report['semantic_intervention']
            manifest['packets'][0]['result'][field] += 1
            packet = manifest['packets'][0]['result']
            report['rows'][0]['semantic_input'] = packet
            report['rows'][0]['semantic_input_sha256'] = digest(packet)
            manifest['bundle_sha256'] = digest({key: value for key, value in manifest.items() if key != 'bundle_sha256'})
            candidate = self.save_report(f'packet-clock-{field}.jsonl.gz', report)
            result, differences = self.compare(baseline, candidate, f'packet-clock-diff-{field}.jsonl.gz')
            self.assertFalse(result['valid'])
            self.assertEqual(result['difference_counts']['output'], 0)
            self.assertGreater(result['difference_counts']['input_context'], 0)
            self.assertTrue(any(row.get('error') == 'undeclared_semantic_context_or_clock_change' for row in differences))
        report = self.read_report(baseline)
        report['rows'][0]['input_context']['semantic_frame'] = 1
        report['rows'][0]['input_context_sha256'] = digest(report['rows'][0]['input_context'])
        candidate = self.save_report('delivery.jsonl.gz', report)
        result, differences = self.compare(baseline, candidate, 'delivery-diff.jsonl.gz')
        self.assertFalse(result['valid'])
        self.assertTrue(any('changed_semantics_or_delivery_schedule' in row.get('error', '') for row in differences))

    def test_malformed_report_manifest_or_payload_cannot_crash_into_equivalence(self):
        baseline = self.replay()
        for index, value in enumerate((None, {}, {'packets': None})):
            report = self.read_report(baseline)
            report['semantic_intervention'] = value
            candidate = self.save_report(f'manifest-{index}.jsonl.gz', report)
            result, differences = self.compare(baseline, candidate, f'manifest-diff-{index}.jsonl.gz')
            self.assertFalse(result['equivalent'])
            self.assertGreater(result['difference_counts']['validation'], 0)
        report = self.read_report(baseline)
        report['rows'][0].pop('payload')
        candidate = self.save_report('missing-payload.json', report)
        result, differences = self.compare(baseline, candidate, 'missing-payload-diff.json')
        self.assertFalse(result['valid'])
        self.assertTrue(any('incomplete_payload' in row.get('error', '') for row in differences))
        report = self.read_report(baseline)
        report['rows'][0]['payload'] = {key: None for key in report['rows'][0]['payload']}
        report['rows'][0]['output_sha256'] = digest(report['rows'][0]['payload'])
        candidate = self.save_report('malformed-payload.json', report)
        result, differences = self.compare(candidate, candidate, 'malformed-payload-diff.json')
        self.assertFalse(result['valid'])
        self.assertTrue(any('malformed_complete_payload' in row.get('error', '') for row in differences))

    def test_recorded_repeat_rejects_rehashed_semantic_mutation_even_if_outputs_match(self):
        baseline = self.replay()
        report = self.read_report(baseline)
        manifest = report['semantic_intervention']
        packet = manifest['packets'][0]['result']
        packet['detector_runtime']['process_id'] = 99999
        report['rows'][0]['semantic_input'] = packet
        report['rows'][0]['semantic_input_sha256'] = digest(packet)
        manifest['bundle_sha256'] = digest({key: value for key, value in manifest.items() if key != 'bundle_sha256'})
        candidate = self.save_report('false-recorded-repeat.jsonl.gz', report)
        result, differences = self.compare(baseline, candidate)
        self.assertFalse(result['valid'])
        self.assertFalse(result['equivalent'])
        self.assertEqual(result['difference_counts']['output'], 0)
        self.assertTrue(any('recorded_semantics_not_original' in row.get('error', '') for row in differences))

    def test_recorded_history_must_equal_original_even_for_self_comparison(self):
        baseline = self.replay()
        report = self.read_report(baseline)
        self.assertEqual(report['semantic_intervention']['warmup']['evaluation_frames'], [1])
        self.assertEqual(report['semantic_intervention']['binding']['frame_inventory'][0][0], 2)
        self.assertNotIn(2, report['expected_frames'])
        # All scored rows stay identical; the false claim concerns the full warmup/history.
        report['history_sha256'] = digest({'synthetic_fault': 'changed_unscored_warmup_history'})
        self.assertNotEqual(report['history_sha256'], report['original_history_sha256'])
        candidate = self.save_report('false-recorded-history.jsonl.gz', report)
        for index, left in enumerate((baseline, candidate)):
            result, differences = self.compare(left, candidate, f'false-history-diff-{index}.jsonl.gz')
            self.assertFalse(result['valid'])
            self.assertFalse(result['equivalent'])
            self.assertEqual(result['difference_counts']['output'], 0)
            self.assertTrue(any(row.get('error') == 'recorded_history_not_original' for row in differences))

    def test_identical_effective_semantics_requires_history_despite_producer_metadata(self):
        report = self.read_report(self.replay())
        manifest = report['semantic_intervention']
        manifest['producer']['kind'] = 'DECLARED_SEMANTIC_INTERVENTION'
        manifest['bundle_sha256'] = digest({key: value for key, value in manifest.items() if key != 'bundle_sha256'})
        baseline = self.save_report('declared-original-history.jsonl.gz', report)
        manifest['producer']['fixture_note'] = 'Different producer metadata, identical effective packets'
        manifest['bundle_sha256'] = digest({key: value for key, value in manifest.items() if key != 'bundle_sha256'})
        provenance_only = self.save_report('producer-metadata-only.jsonl.gz', report)
        result, differences = self.compare(baseline, provenance_only, 'producer-only-diff.jsonl.gz')
        self.assertTrue(result['equivalent'], differences)
        self.assertTrue(result['identical_effective_semantic_history'])
        report['history_sha256'] = digest({'synthetic_fault': 'unscored_history_changed'})
        candidate = self.save_report('producer-and-history.jsonl.gz', report)
        result, differences = self.compare(baseline, candidate, 'producer-history-diff.jsonl.gz')
        self.assertFalse(result['valid'])
        self.assertFalse(result['equivalent'])
        self.assertTrue(result['identical_effective_semantic_history'])
        self.assertEqual(result['difference_counts']['validation'], 0)
        self.assertEqual(result['difference_counts']['output'], 0)
        self.assertTrue(any(row['category'] == 'input_context' and row['path'] == '/metadata/history_sha256'
                            for row in differences))

    def test_declared_unscored_semantics_change_is_not_masked_by_identical_scored_inputs(self):
        earlier = copy.deepcopy(self.records[1])
        earlier.update(evaluation_frame=2, timestamp_s=.1)
        records = [self.records[0], earlier, *self.records[1:]]
        self.files.put(self.root / 'telemetry' / 'comparison-controls.jsonl.gz',
            gzip.compress(''.join(canonical(row) + '\n' for row in records).encode()))
        bundle = study.export_bundle(self.root, self.files.base / 'unscored.bundle.json.gz',
                                     activation=2, **self.options)
        baseline = self.replay('unscored-baseline.jsonl.gz', bundle)
        candidate = copy.deepcopy(bundle)
        candidate['producer']['kind'] = 'DECLARED_SEMANTIC_INTERVENTION'
        self.assertEqual(candidate['packets'][0]['evaluation_frame'], 2)
        candidate['packets'][0]['result']['detector_runtime']['fixture_note'] = 'Declared unscored input change'
        changed = self.replay('unscored-semantic-change.jsonl.gz', candidate)
        old, new = self.read_report(baseline), self.read_report(changed)
        self.assertEqual([row['semantic_input'] for row in old['rows']],
                         [row['semantic_input'] for row in new['rows']])
        self.assertNotEqual(old['history_sha256'], new['history_sha256'])
        result, differences = self.compare(baseline, changed)
        self.assertTrue(result['valid'], differences)
        self.assertTrue(result['equivalent'], differences)
        self.assertFalse(result['identical_effective_semantic_history'])
        self.assertEqual(result['difference_counts']['input_context'], 0)
        self.assertGreater(result['difference_counts']['declared_semantics'], 0)
        self.assertFalse(any(row['path'] == '/metadata/history_sha256' for row in differences))

    def test_comparison_source_stamp_preserves_immutable_older_producer_artifact(self):
        report = self.read_report(self.replay())
        manifest = report['semantic_intervention']
        historical_sha = '1' * 64  # Synthetic historical producer identity, not a native artifact.
        manifest['binding']['source']['comparison_script_sha256'] = historical_sha
        manifest['bundle_sha256'] = digest({key: value for key, value in manifest.items() if key != 'bundle_sha256'})
        older = self.save_report('historical-producer.jsonl.gz', report)
        original_bytes = self.files.read(older)
        result, differences = self.compare(older, older)
        current_sha = hashlib.sha256(Path(study.__file__).read_bytes()).hexdigest()
        self.assertTrue(result['equivalent'], differences)
        self.assertEqual(result['comparator_source_sha256'], current_sha)
        self.assertNotEqual(result['comparator_source_sha256'], historical_sha)
        self.assertEqual(self.files.read(older), original_bytes)
        self.assertEqual(self.read_report(older)['semantic_intervention']['binding']['source']['comparison_script_sha256'],
                         historical_sha)

    def test_compressed_artifact_truncation_summary_hash_and_bounds_fail(self):
        baseline = self.replay()
        data = gzip.decompress(self.files.read(baseline)).decode()
        lines = data.splitlines(keepends=True)
        malformed = self.files.base / 'truncated.jsonl.gz'
        self.files.put(malformed, gzip.compress(''.join(lines[:-1]).encode()))
        with self.assertRaisesRegex(ValueError, 'Missing final summary'):
            self.compare(baseline, malformed)
        footer = json.loads(lines[-1])
        footer['metadata_sha256'] = '0' * 64
        self.files.put(malformed, gzip.compress((''.join(lines[:-1]) + canonical(footer) + '\n').encode()))
        with self.assertRaisesRegex(ValueError, 'metadata hash'):
            self.compare(baseline, malformed, 'hash-diff.jsonl.gz')
        with patch.object(study, 'MAX_ROW_BYTES', 10):
            with self.assertRaisesRegex(ValueError, 'Oversized'):
                with study.ArtifactReader(baseline) as reader:
                    list(reader.rows())

    def test_model_export_orchestration_uses_source_frame_parity_and_real_depth_association(self):
        class FixtureDetector:
            """Constructor boundary stub: no ONNX model or inference is executed."""
            def __init__(self, profile):
                self.profile = profile
                self.runtime = {'execution_provider': 'CPUExecutionProvider', 'onnxruntime_version': 'FIXTURE'}
                self.frames = []
                self.closed = False

            def predict(self, rgb, *, frame_id):
                self.frames.append((frame_id, rgb.shape, int(rgb[0, 0, 0])))
                return [{'class': 'person', 'confidence': .9, 'classification_status': 'SUPPORTED',
                         'xyxy': [200., 100., 400., 300.]}]

            def close(self):
                self.closed = True

        detector = FixtureDetector(copy.deepcopy(self.bundle['binding']['model_profile']))
        model = self.files.base / 'fixture-model.bin'
        with patch('backend.computer_vision.detector.RoadDetector', return_value=detector) as constructor:
            candidate = study.export_bundle(self.root, self.files.base / 'constructor-test.json.gz',
                activation=3, provider='CPU', model=model, **self.options)
        constructor.assert_called_once_with(model, profile_id=study.PROFILE_ID, execution_provider='CPU')
        self.assertEqual(detector.frames, [(2, (360, 640, 3), 24), (3, (360, 640, 3), 24)])
        self.assertTrue(detector.closed)
        depth = candidate['packets'][0]['result']['detections'][0]['depth_evidence']
        self.assertEqual((depth['frame_id'], depth['timestamp_s'], depth['axial_m']), (2, .1, 12.))
        self.assertEqual(candidate['packets'][0]['result']['published_at'], self.bundle['packets'][0]['result']['published_at'])
        study.verify_bundle(self.root, candidate, **self.options)
        with patch('backend.computer_vision.detector.RoadDetector', return_value=detector):
            with self.assertRaisesRegex(ValueError, 'fallback is forbidden'):
                study.export_bundle(self.root, self.files.base / 'no-fallback.json', activation=3,
                    provider='DML', model=model, **self.options)

    def test_export_checks_all_images_and_model_bytes_before_allocating_detector(self):
        model = self.files.base / 'fixture-model.bin'
        with patch('backend.computer_vision.detector.RoadDetector') as constructor:
            with self.assertRaisesRegex(ValueError, 'Missing retained RGB/depth source frames'):
                study.export_bundle(self.root, self.files.base / 'bad-start.json', activation=1,
                                    provider='CPU', model=model, **self.options)
            constructor.assert_not_called()
            self.files.put(model, b'DIFFERENT SYNTHETIC MODEL')
            with self.assertRaisesRegex(ValueError, 'model bytes differ'):
                study.export_bundle(self.root, self.files.base / 'bad-model.json', activation=3,
                                    provider='CPU', model=model, **self.options)
            constructor.assert_not_called()

    def test_exact_value_diffs_retain_tiny_float_signed_zero_and_provenance(self):
        old = {'confidence': .7, 'origin': {'provider': 'CPU'}, 'zero': 0., 'integer': 1}
        new = {'confidence': .70000000000001, 'origin': {'provider': 'DML'}, 'zero': -0., 'integer': 1.}
        differences = list(study.value_differences(old, new))
        self.assertEqual({row['path'] for row in differences},
                         {'/confidence', '/origin/provider', '/zero', '/integer'})
        self.assertEqual(next(row['candidate'] for row in differences if row['path'] == '/confidence'), .70000000000001)

    def test_cli_compare_returns_nonzero_for_actual_full_payload_inequality(self):
        baseline = self.replay()
        report = self.read_report(baseline)
        report['rows'][0]['payload']['prediction']['source'] = 'SYNTHETIC_NEGATIVE_PROVENANCE'
        report['rows'][0]['output_sha256'] = digest(report['rows'][0]['payload'])
        candidate = self.save_report('changed-provenance.jsonl.gz', report)
        with patch('sys.stdout', new=io.StringIO()) as output:
            status = study.main(['compare', str(baseline), str(candidate),
                                 '--output', str(self.files.base / 'cli-differences.jsonl.gz')])
        self.assertEqual(status, 1)
        self.assertFalse(json.loads(output.getvalue())['equivalent'])

    def test_export_cli_import_does_not_require_the_driving_numba_environment(self):
        code = (
            "import importlib.abc, sys\n"
            "class NoDrivingJIT(importlib.abc.MetaPathFinder):\n"
            "    def find_spec(self, fullname, path, target=None):\n"
            "        if fullname == 'numba': raise ModuleNotFoundError('no driving JIT in perception environment')\n"
            "sys.meta_path.insert(0, NoDrivingJIT())\n"
            "from scripts.compare_perception_replay import main\n"
            "main(['export', '--help'])\n"
        )
        result = subprocess.run([sys.executable, '-B', '-c', code], cwd=Path.cwd(),
                                capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('--activation-evaluation-frame', result.stdout)
        self.assertIn('--provider {recorded,CPU,DML}', result.stdout)


if __name__ == '__main__':
    unittest.main()
