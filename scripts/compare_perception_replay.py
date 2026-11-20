"""Bounded DEVELOPMENT-only semantic interventions, never native acceptance.

Export recorded/CPU/DML packets, replay each bundle at the original delivery
frames, then compare complete outputs. Prefer .jsonl.gz replay/difference files;
ordinary .json (and .json.gz) remains supported for small reports. A declared
recorded prefix is warmup, not replacement of perception from native startup.
"""
import argparse
from contextlib import contextmanager
import copy
import gzip
import hashlib
import io
from itertools import zip_longest
import json
import os
from pathlib import Path

import numpy as np
from PIL import Image

from backend.core.contracts import to_dict
from backend.core.recording import read_asset
from backend.core.recording_storage import open_recorded
from backend.core.replay import ReplayReader
from scripts.replay_urban_control import (
    canonical, deterministic_replay, digest, read_control_history, replay_clock,
    report_errors, strict_json,
)

BUNDLE_SCHEMA = 'PERCEPTION_SEMANTIC_INTERVENTION_V1'
REPORT_SCHEMA = 'COMPLETE_PERCEPTION_REPLAY_V1'
DIFF_SCHEMA = 'COMPLETE_PERCEPTION_DIFFERENCES_V1'
ALLOWED_CHANGES = ('detections', 'detector_runtime', 'detector_profile.execution_provider')
PROFILE_ID = 'YOLOV8S_640_FRONT_AND_FOCUS_V3'
MAX_BUNDLE_BYTES = 32 * 1024 * 1024
MAX_ROW_BYTES = 64 * 1024 * 1024
MAX_JSON_BYTES = 128 * 1024 * 1024
MAX_STREAM_BYTES = 8 * 1024 ** 3
MAX_FRAMES = 10000


@contextmanager
def artifact_open(path, mode='rt'):
    path = Path(path)
    if path.suffix == '.gz':
        with gzip.open(path, mode, encoding='utf8', **({'compresslevel': 1} if mode != 'rt' else {})) as stream:
            yield stream
    elif mode == 'rt':
        with open_recorded(path, mode) as stream:
            yield stream
    else:
        with path.open(mode, encoding='utf8') as stream:
            yield stream


def load_bundle(path):
    with artifact_open(path) as stream:
        value = stream.read(MAX_BUNDLE_BYTES + 1)
    if len(value.encode('utf8')) > MAX_BUNDLE_BYTES:
        raise ValueError('Semantic bundle exceeds the 32 MiB bound')
    return strict_json(value)


def _file_hash(path):
    result = hashlib.sha256()
    with open_recorded(path) as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            result.update(chunk)
    return result.hexdigest()


def _source_identity():
    from backend.core import contracts
    from backend.core.egypt_urban import source_manifest
    from scripts import replay_urban_control
    return {
        'driving_sha256': hashlib.sha256(json.dumps(source_manifest(), sort_keys=True).encode()).hexdigest(),
        'contracts_sha256': hashlib.sha256(Path(contracts.__file__).read_bytes()).hexdigest(),
        'replay_script_sha256': hashlib.sha256(Path(replay_urban_control.__file__).read_bytes()).hexdigest(),
        'comparison_script_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
    }


def require_development(root, *, allow_test_data=False):
    metadata = strict_json((Path(root) / 'metadata.json').read_bytes())
    config = metadata.get('config', {})
    if (config.get('seed_partition') != 'DEVELOPMENT'
            or config.get('scenario_id') != 'EGYPT_URBAN_CHAOS_V1'
            or any(config.get(key) for key in ('debug', 'debug_mode', 'oracle_semantics'))):
        raise ValueError('Only EGYPT_URBAN_CHAOS_V1 DEVELOPMENT is allowed; HOLDOUT/DEBUG are forbidden')
    origin = metadata.get('data_origin')
    if origin != 'REAL_SIMULATION' and not (allow_test_data and origin == 'TEST_FIXTURE'):
        raise ValueError('Expected REAL_SIMULATION; TEST_FIXTURE requires explicit API opt-in')
    return metadata


def _profile(profile):
    if not isinstance(profile, dict):
        raise ValueError('Missing detector model/profile identity')
    result = {key: value for key, value in profile.items() if key != 'execution_provider'}
    if (result.get('id') != PROFILE_ID or result.get('input_size') != 640
            or not _sha256(result.get('model_sha256'))):
        raise ValueError('Expected the recorded V3 640 model/profile')
    return result


def _sha256(value):
    return isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value)


def _validate_result(result, profile):
    if not isinstance(result, dict) or result.get('status') != 'RUNNING':
        raise ValueError('Semantic result must be a complete RUNNING packet')
    if (type(result.get('frame_id')) is not int or result['frame_id'] < 0
            or not isinstance(result.get('session_id'), str)
            or type(result.get('timestamp_s')) not in (int, float) or result['timestamp_s'] < 0
            or result.get('source_sensor') != 'frontCamera'
            or result.get('semantic_coverage') != 'FRONT_CAMERA_ONLY'
            or not _sha256(result.get('source_image_sha256'))
            or any(type(result.get(key)) is not int or result[key] <= 0 for key in ('width', 'height'))):
        raise ValueError('Invalid semantic source/frame/image identity')
    if canonical(_profile(result.get('detector_profile'))) != canonical(_profile(profile)):
        raise ValueError('Detector model/profile differs from original recording')
    runtime = result.get('detector_runtime')
    if (not isinstance(runtime, dict) or not isinstance(runtime.get('execution_provider'), str)
            or not runtime['execution_provider'] or not isinstance(runtime.get('onnxruntime_version'), str)
            or not runtime['onnxruntime_version']):
        raise ValueError('Semantic provider/runtime provenance is required')
    if result['detector_profile'].get('execution_provider', runtime['execution_provider']) != runtime['execution_provider']:
        raise ValueError('Detector profile and runtime provider provenance disagree')
    detections = result.get('detections')
    if not isinstance(detections, list) or len(detections) > 256:
        raise ValueError('Semantic detections must be the complete bounded detector list')
    for detection in detections:
        if (not isinstance(detection, dict) or not isinstance(detection.get('class'), str)
                or type(detection.get('confidence')) not in (int, float)
                or not 0 <= detection['confidence'] <= 1
                or detection.get('classification_status') not in ('SUPPORTED', 'UNCERTAIN')
                or set(detection) - {'class', 'confidence', 'xyxy', 'classification_status', 'depth_evidence'}):
            raise ValueError('Malformed detector observation (debug/truth fields are not permitted)')
        box = detection.get('xyxy')
        if (not isinstance(box, list) or len(box) != 4
                or any(type(value) not in (int, float) for value in box)
                or not 0 <= box[0] < box[2] <= result['width']
                or not 0 <= box[1] < box[3] <= result['height']):
            raise ValueError('Malformed detector box')
        evidence = detection.get('depth_evidence')
        if evidence is not None and (not isinstance(evidence, dict)
                or type(evidence.get('frame_id')) is not int or evidence['frame_id'] != result['frame_id']
                or canonical(evidence.get('timestamp_s')) != canonical(result['timestamp_s'])
                or evidence.get('source_sensor') != 'depth'):
            raise ValueError('Semantic depth association has a different frame/time/source')
    canonical(result)


def immutable_semantic(result, allowed_changes):
    if result is None:
        return None
    value = copy.deepcopy(result)
    for field in allowed_changes:
        if field == 'detector_profile.execution_provider':
            profile = value.get('detector_profile')
            if isinstance(profile, dict):
                profile.pop('execution_provider', None)
        else:
            value.pop(field, None)
    return value


def recording_binding(root, *, first, last, wall_age_ms, shield_age_ms,
                      allow_test_data=False, reader=None, controls=None):
    root = Path(root)
    metadata = require_development(root, allow_test_data=allow_test_data)
    if (type(first) is not int or type(last) is not int or first < 0 or first > last
            or not np.isfinite([wall_age_ms, shield_age_ms]).all()
            or not 0 <= wall_age_ms <= shield_age_ms):
        raise ValueError('Invalid replay bounds or controlled clocks')
    reader = reader or ReplayReader(root, allow_test_data=allow_test_data)
    controls = controls or read_control_history(root)
    inventory = [[frame, stamp] for stamp, _, frame in reader.index if frame <= last]
    if not inventory or len(inventory) > MAX_FRAMES:
        raise ValueError('Recorded frame inventory is empty or exceeds 10000 frames')
    expected = [frame for frame in controls['decisions'] if first <= frame <= last]
    if not expected or expected[0] != first or expected[-1] != last:
        raise ValueError('Requested first/last must be actual recorded decisions')
    if set(expected) - {entry[0] for entry in inventory}:
        raise ValueError('Recorded decisions are missing sensor frames')
    profile = _profile(to_dict(metadata['config'].get('perception_profile')))
    packets = [row for frame, row in controls['packets'].items() if frame <= last]
    if not packets:
        raise ValueError('No original semantic delivery schedule')
    schedule = []
    for packet in packets:
        result = packet['result']
        _validate_result(result, profile)
        if (packet.get('session_id') != metadata['config'].get('session_id')
                or result['session_id'] != packet['session_id']
                or result['frame_id'] > packet['evaluation_frame']
                or result['timestamp_s'] > packet.get('timestamp_s', -1)):
            raise ValueError('Original semantic session/source/delivery schedule is inconsistent')
        schedule.append({
            'evaluation_frame': packet['evaluation_frame'], 'timestamp_s': packet['timestamp_s'],
            'source_frame': result['frame_id'], 'source_timestamp_s': result['timestamp_s'],
            'source_image_sha256': result['source_image_sha256'],
            'original_result_sha256': digest(result),
        })
    binding = {
        'logical_recording': str(root.absolute()), 'run_id': metadata['run_id'],
        'data_origin': metadata['data_origin'], 'partition': 'DEVELOPMENT',
        'scenario_id': metadata['config']['scenario_id'],
        'metadata_sha256': _file_hash(root / 'metadata.json'),
        'control_log_sha256': controls['control_log_sha256'],
        'frame_log_sha256': _file_hash(root / 'telemetry' / 'frames.jsonl'),
        'frame_inventory': inventory, 'expected_frames': expected,
        'first': first, 'last': last, 'clock': replay_clock(wall_age_ms, shield_age_ms),
        'model_profile': profile, 'delivery_schedule': schedule, 'source': _source_identity(),
    }
    return binding, reader, packets


def verify_recording_unchanged(root, binding):
    for key, relative in (
            ('metadata_sha256', Path('metadata.json')),
            ('control_log_sha256', Path('telemetry') / 'comparison-controls.jsonl'),
            ('frame_log_sha256', Path('telemetry') / 'frames.jsonl')):
        if _file_hash(Path(root) / relative) != binding[key]:
            raise ValueError(f'Original recording changed during export/replay: {key}')
    if canonical(_source_identity()) != canonical(binding['source']):
        raise ValueError('Replay/source implementation changed during export/replay')


def _warmup(binding, activation):
    schedule = binding['delivery_schedule']
    if type(activation) is not int or activation not in [row['evaluation_frame'] for row in schedule]:
        raise ValueError('Activation must name an original CAMERA_DETECTIONS evaluation frame')
    prefix = [row for row in schedule if row['evaluation_frame'] < activation]
    return {'mode': 'IDENTICAL_RECORDED_PREFIX', 'activation_evaluation_frame': activation,
            'evaluation_frames': [row['evaluation_frame'] for row in prefix],
            'prefix_schedule_sha256': digest(prefix), 'replacement_from_native_startup': False}


def _sources(root, reader, packets):
    pending = {}
    for packet in packets:
        pending.setdefault(packet['result']['frame_id'], []).append(packet)
    for frame in reader.frames():
        if not pending:
            break
        matching = pending.pop(frame.frame_id, None)
        if matching is None:
            continue
        channels = {sensor.sensor_id: sensor for sensor in frame.sensors}
        rgb_sensor, depth_sensor = channels.get('frontCamera'), channels.get('depth')
        if (rgb_sensor is None or depth_sensor is None
                or rgb_sensor.kind.value != 'RGB' or depth_sensor.kind.value != 'DEPTH'):
            raise ValueError(f'Missing original RGB/depth at source frame {frame.frame_id}')
        for sensor in (rgb_sensor, depth_sensor):
            if (not sensor.asset or not _sha256(sensor.asset.sha256)
                    or type(sensor.asset.byte_count) is not int
                    or sensor.sensor_timestamp_s != frame.timestamp_s):
                raise ValueError('Original RGB/depth needs checked hashes, lengths and synchronized timestamps')
        for key in ('fov_deg', 'mount_transform'):
            if (rgb_sensor.metadata.get(key) is None
                    or canonical(rgb_sensor.metadata.get(key)) != canonical(depth_sensor.metadata.get(key))):
                raise ValueError('Original RGB/depth calibration differs')
        raw_rgb, raw_depth = read_asset(root, rgb_sensor.asset), read_asset(root, depth_sensor.asset)
        with Image.open(io.BytesIO(raw_rgb)) as image:
            rgb = np.asarray(image.convert('RGB'))
        depth = np.load(io.BytesIO(raw_depth), allow_pickle=False)
        if (depth.ndim != 2 or min(depth.shape) <= 0 or depth.dtype.kind not in 'fiu'
                or depth.shape != (depth_sensor.metadata.get('height'), depth_sensor.metadata.get('width'))
                or rgb.shape[:2] != (rgb_sensor.metadata.get('height'), rgb_sensor.metadata.get('width'))
                or abs(rgb.shape[1] / rgb.shape[0] - depth.shape[1] / depth.shape[0]) > 1e-6):
            raise ValueError('Original RGB/depth dimensions differ')
        identity = {'frame_id': frame.frame_id, 'timestamp_s': frame.timestamp_s,
                    'rgb': to_dict(rgb_sensor), 'depth': to_dict(depth_sensor),
                    'rgb_pixels_sha256': hashlib.sha256(rgb.tobytes()).hexdigest(),
                    'depth_values_sha256': hashlib.sha256(depth.tobytes()).hexdigest()}
        for packet in matching:
            result = packet['result']
            if (canonical(result['timestamp_s']) != canonical(frame.timestamp_s)
                    or result['source_image_sha256'] != hashlib.sha256(raw_rgb).hexdigest()
                    or (result['height'], result['width']) != rgb.shape[:2]):
                raise ValueError(f'Original RGB source identity differs at evaluation {packet["evaluation_frame"]}')
            yield packet, identity, rgb, depth
    if pending:
        raise ValueError(f'Missing retained RGB/depth source frames {sorted(pending)}; declare an identical warmup prefix')


def _bundle_shape(bundle):
    if not isinstance(bundle, dict) or set(bundle) != {
            'schema', 'binding', 'warmup', 'allowed_changes', 'producer', 'packets'}:
        raise ValueError('Malformed semantic bundle: required/unknown top-level fields')
    if bundle['schema'] != BUNDLE_SCHEMA:
        raise ValueError('Unsupported semantic bundle schema')
    allowed = bundle['allowed_changes']
    if allowed != list(ALLOWED_CHANGES):
        raise ValueError('The explicit declaration must allow only detections/provider provenance fields')
    if not isinstance(bundle['binding'], dict) or not isinstance(bundle['warmup'], dict):
        raise ValueError('Malformed bundle binding/warmup')
    producer = bundle['producer']
    if (not isinstance(producer, dict) or producer.get('kind') not in
            ('RECORDED_SEMANTICS', 'ROAD_DETECTOR', 'DECLARED_SEMANTIC_INTERVENTION')
            or producer.get('native_acceptance') is not False):
        raise ValueError('Bundle must declare offline recorded/model/intervention provenance')
    if not isinstance(bundle['packets'], list) or len(bundle['packets']) > MAX_FRAMES:
        raise ValueError('Bundle packets must be a bounded ordered array')
    canonical(bundle)


def verify_bundle(root, bundle, *, first, last, wall_age_ms, shield_age_ms,
                  allow_test_data=False, reader=None, controls=None):
    if isinstance(bundle, (str, Path)):
        bundle = load_bundle(bundle)
    _bundle_shape(bundle)
    binding, reader, originals = recording_binding(root, first=first, last=last,
        wall_age_ms=wall_age_ms, shield_age_ms=shield_age_ms, allow_test_data=allow_test_data,
        reader=reader, controls=controls)
    if canonical(bundle['binding']) != canonical(binding):
        raise ValueError('Bundle binding differs: recording/context/source/model/schedule/clock identity')
    warmup = _warmup(binding, bundle['warmup'].get('activation_evaluation_frame'))
    if canonical(bundle['warmup']) != canonical(warmup):
        raise ValueError('Warmup must be an explicitly identical original prefix, not native startup replacement')
    originals = [row for row in originals if row['evaluation_frame'] >= warmup['activation_evaluation_frame']]
    expected = [row['evaluation_frame'] for row in originals]
    for packet in bundle['packets']:
        if not isinstance(packet, dict) or set(packet) != {
                'evaluation_frame', 'original_result_sha256', 'source', 'result'}:
            raise ValueError('Malformed replacement packet')
    actual = [row['evaluation_frame'] for row in bundle['packets']]
    if any(type(frame) is not int for frame in actual) or actual != expected:
        raise ValueError('Replacement packet inventory differs (missing/extra/duplicate/reordered); no fallback')
    candidates = {row['evaluation_frame']: row for row in bundle['packets']}
    for original, identity, _, _ in _sources(root, reader, originals):
        frame = original['evaluation_frame']
        candidate, result = candidates[frame], candidates[frame]['result']
        _validate_result(result, binding['model_profile'])
        if (candidate['original_result_sha256'] != digest(original['result'])
                or canonical(candidate['source']) != canonical(identity)):
            raise ValueError(f'Replacement original RGB/depth/source identity differs at {frame}')
        if canonical(immutable_semantic(result, bundle['allowed_changes'])) != canonical(
                immutable_semantic(original['result'], bundle['allowed_changes'])):
            raise ValueError(f'Undeclared semantic context/clock/model change at {frame}')
        if bundle['producer']['kind'] == 'RECORDED_SEMANTICS' and canonical(result) != canonical(original['result']):
            raise ValueError('Recorded baseline must contain identical original semantics')
        if bundle['producer']['kind'] == 'ROAD_DETECTOR':
            runtime = {key: value for key, value in result['detector_runtime'].items() if key != 'process_id'}
            if (canonical(runtime) != canonical(bundle['producer'].get('runtime'))
                    or result['detector_runtime'].get('process_id') != bundle['producer'].get('process_id')):
                raise ValueError('Export producer/runtime provenance differs from its semantic packets')
    verify_recording_unchanged(root, binding)
    return {'replacements': {frame: row['result'] for frame, row in candidates.items()},
            'manifest': {**copy.deepcopy(bundle), 'bundle_sha256': digest(bundle)}}


def _output_path(root, output):
    if Path(output).resolve().is_relative_to(Path(root).resolve()):
        raise ValueError('Artifacts must not be written into or mutate the original recording')
    if Path(output).exists():
        raise ValueError('Refusing to overwrite an existing artifact; retain earlier attempts')
    Path(output).parent.mkdir(parents=True, exist_ok=True)


def export_bundle(root, output, *, first, last, activation, provider='recorded',
                  wall_age_ms=100., shield_age_ms=150., model=None, allow_test_data=False):
    """Optional model inference is explicit; never changes native defaults."""
    if provider not in ('recorded', 'CPU', 'DML'):
        raise ValueError('Explicit recorded, CPU or DML provider required')
    _output_path(root, output)
    binding, reader, originals = recording_binding(root, first=first, last=last,
        wall_age_ms=wall_age_ms, shield_age_ms=shield_age_ms, allow_test_data=allow_test_data)
    warmup = _warmup(binding, activation)
    originals = [row for row in originals if row['evaluation_frame'] >= activation]
    # Validate the entire requested image set before allocating an inference session.
    for _ in _sources(root, reader, originals):
        pass
    detector = None
    producer = {'kind': 'RECORDED_SEMANTICS', 'native_acceptance': False,
                'delivery': 'ORIGINAL_RECORDED_SCHEDULE_AND_TIMING_FIELDS'}
    packets = {}
    try:
        if provider != 'recorded':
            from backend.computer_vision.detector import RoadDetector, default_model_path
            model = Path(model) if model else default_model_path()
            if hashlib.sha256(model.read_bytes()).hexdigest() != binding['model_profile']['model_sha256']:
                raise ValueError('Export model bytes differ from the original recording')
            detector = RoadDetector(model, profile_id=binding['model_profile']['id'], execution_provider=provider)
            wanted = 'DmlExecutionProvider' if provider == 'DML' else 'CPUExecutionProvider'
            if detector.runtime.get('execution_provider') != wanted:
                raise ValueError('Requested detector provider unavailable; CPU fallback is forbidden')
            if canonical(_profile(detector.profile)) != canonical(binding['model_profile']):
                raise ValueError('Constructed detector model/profile differs from original')
            producer.update(kind='ROAD_DETECTOR', runtime=copy.deepcopy(detector.runtime),
                            process_id=os.getpid(), interpreter=str(Path(os.sys.executable).absolute()),
                            views='V3_FULL_CENTER_ALTERNATING_ROADSIDE_BY_SOURCE_FRAME_PARITY')
        for original, identity, rgb, depth in _sources(root, reader, originals):
            result = copy.deepcopy(original['result'])
            if detector is not None:
                if rgb.shape[1] < 600:
                    raise ValueError('V3 full/center/alternating-roadside export requires width >= 600')
                from backend.computer_vision.depth_evidence import attach_depth
                detections = detector.predict(rgb, frame_id=result['frame_id'])
                attach_depth(detections, depth, result['frame_id'], result['timestamp_s'],
                             rgb_size=(rgb.shape[1], rgb.shape[0]))
                result.update(detections=detections, detector_profile=copy.deepcopy(detector.profile),
                              detector_runtime={**detector.runtime, 'process_id': os.getpid()})
            _validate_result(result, binding['model_profile'])
            packets[original['evaluation_frame']] = {
                'evaluation_frame': original['evaluation_frame'],
                'original_result_sha256': digest(original['result']), 'source': identity, 'result': result}
        bundle = {'schema': BUNDLE_SCHEMA, 'binding': binding, 'warmup': warmup,
                  'allowed_changes': list(ALLOWED_CHANGES), 'producer': producer,
                  'packets': [packets[row['evaluation_frame']] for row in originals]}
        _bundle_shape(bundle)
        verify_recording_unchanged(root, binding)
        if detector is not None and hashlib.sha256(model.read_bytes()).hexdigest() != binding['model_profile']['model_sha256']:
            raise ValueError('Model bytes changed during export')
        text = canonical(bundle) + '\n'
        if len(text.encode('utf8')) > MAX_BUNDLE_BYTES:
            raise ValueError('Semantic bundle exceeds the 32 MiB bound')
        with artifact_open(output, 'xt') as stream:
            stream.write(text)
        return bundle
    finally:
        if detector is not None:
            detector.close()


class ArtifactWriter:
    """One bounded payload at a time; an absent final summary means failure."""
    def __init__(self, path, *, schema=REPORT_SCHEMA, list_key='rows'):
        self.path, self.schema, self.list_key = Path(path), schema, list_key
        self.lines = self.path.name.removesuffix('.gz').endswith('.jsonl')
        self.size, self.count = 0, 0

    def __enter__(self):
        if self.path.exists():
            raise ValueError('Refusing to overwrite an existing artifact')
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.context = artifact_open(self.path, 'xt')
        self.stream = self.context.__enter__()
        self._write(canonical({'kind': 'header', 'schema': self.schema}) + '\n'
                    if self.lines else '{"' + self.list_key + '":[')
        return self

    def _write(self, text):
        size = len(text.encode('utf8'))
        self.size += size
        if size > MAX_ROW_BYTES or self.size > (MAX_STREAM_BYTES if self.lines else MAX_JSON_BYTES):
            raise ValueError('Artifact exceeds bounded row/total size; use .jsonl.gz for large reports')
        self.stream.write(text)

    def append(self, row):
        self._write(canonical({'kind': 'row', 'value': row}) + '\n' if self.lines
                    else (',' if self.count else '') + canonical(row))
        self.count += 1

    def finish(self, metadata):
        self.metadata = {**metadata, 'artifact_row_count': self.count}
        if self.lines:
            self._write(canonical({'kind': 'summary', 'metadata': self.metadata,
                                   'metadata_sha256': digest(self.metadata)}) + '\n')
        else:
            self._write('],' + canonical({**self.metadata, 'artifact_schema': self.schema,
                                         'metadata_sha256': digest(self.metadata)})[1:] + '\n')

    def __exit__(self, *args):
        return self.context.__exit__(*args)


class ArtifactReader:
    def __init__(self, path, *, schema=REPORT_SCHEMA, list_key='rows'):
        self.path, self.schema, self.list_key = Path(path), schema, list_key
        self.metadata = None

    def __enter__(self):
        self.context = artifact_open(self.path)
        self.stream = self.context.__enter__()
        return self

    def rows(self):
        if not self.path.name.removesuffix('.gz').endswith('.jsonl'):
            raw = self.stream.read(MAX_JSON_BYTES + 1)
            if len(raw.encode('utf8')) > MAX_JSON_BYTES:
                raise ValueError('Ordinary JSON exceeds 128 MiB; use .jsonl.gz')
            value = strict_json(raw)
            if not isinstance(value, dict) or value.pop('artifact_schema', None) != self.schema:
                raise ValueError('Missing/incorrect artifact schema')
            rows, checksum = value.pop(self.list_key, None), value.pop('metadata_sha256', None)
            if not isinstance(rows, list) or checksum != digest(value) or value.get('artifact_row_count') != len(rows):
                raise ValueError('Artifact metadata hash/count/rows are invalid')
            self.metadata = value
            yield from rows
            return
        size, count, header = 0, 0, False
        while raw := self.stream.readline(MAX_ROW_BYTES + 1):
            size += len(raw.encode('utf8'))
            if len(raw.encode('utf8')) > MAX_ROW_BYTES or size > MAX_STREAM_BYTES or not raw.endswith('\n'):
                raise ValueError('Oversized or truncated streaming artifact')
            value = strict_json(raw)
            if not isinstance(value, dict):
                raise ValueError('Malformed streaming artifact row')
            if not header:
                if value != {'kind': 'header', 'schema': self.schema}:
                    raise ValueError('Missing/incorrect streaming artifact header')
                header = True
            elif value.get('kind') == 'row' and self.metadata is None and set(value) == {'kind', 'value'}:
                count += 1
                if self.schema == REPORT_SCHEMA and count > MAX_FRAMES:
                    raise ValueError('Replay exceeds 10000 scored decisions')
                yield value['value']
            elif value.get('kind') == 'summary' and self.metadata is None and set(value) == {
                    'kind', 'metadata', 'metadata_sha256'}:
                self.metadata = value['metadata']
                if (not isinstance(self.metadata, dict) or value['metadata_sha256'] != digest(self.metadata)
                        or self.metadata.get('artifact_row_count') != count):
                    raise ValueError('Streaming artifact metadata hash/count is invalid')
            else:
                raise ValueError('Unexpected/duplicate/reordered artifact row after summary')
        if self.metadata is None:
            raise ValueError('Missing final summary: replay artifact is incomplete')

    def __exit__(self, *args):
        return self.context.__exit__(*args)


def replay_to_artifact(root, bundle, output, *, first, last, wall_age_ms=100., shield_age_ms=150.,
                       allow_test_data=False):
    _output_path(root, output)
    with ArtifactWriter(output) as writer:
        report = deterministic_replay(root, first=first, last=last, wall_age_ms=wall_age_ms,
            shield_age_ms=shield_age_ms, semantic_bundle=bundle, row_sink=writer.append,
            allow_test_data=allow_test_data)
        report.pop('rows')
        report['evidence_class'] = ('SYNTHETIC_TEST_FIXTURE' if
            report['semantic_intervention']['binding']['data_origin'] == 'TEST_FIXTURE'
            else 'OFFLINE_CONTROLLED_RECORDED_REPLAY')
        writer.finish(report)
    return writer.metadata


def value_differences(baseline, candidate, path=''):
    """Exact JSON values, including provenance, signed zero and numeric types."""
    if type(baseline) is dict and type(candidate) is dict:
        for key in sorted(baseline.keys() | candidate.keys()):
            child = path + '/' + key.replace('~', '~0').replace('/', '~1')
            if key not in baseline:
                yield {'path': child, 'change': 'added', 'candidate': candidate[key]}
            elif key not in candidate:
                yield {'path': child, 'change': 'removed', 'baseline': baseline[key]}
            else:
                yield from value_differences(baseline[key], candidate[key], child)
    elif type(baseline) is list and type(candidate) is list:
        missing = object()
        for index, (old, new) in enumerate(zip_longest(baseline, candidate, fillvalue=missing)):
            child = path + '/' + str(index)
            if old is missing:
                yield {'path': child, 'change': 'added', 'candidate': new}
            elif new is missing:
                yield {'path': child, 'change': 'removed', 'baseline': old}
            else:
                yield from value_differences(old, new, child)
    elif canonical(baseline) != canonical(candidate):
        yield {'path': path, 'change': 'changed', 'baseline': baseline, 'candidate': candidate}


def _metadata_errors(metadata, frames, receipts):
    errors = []
    if not isinstance(metadata, dict):
        return ['missing_metadata']
    if (metadata.get('native_acceptance') is not False or metadata.get('source_unchanged') is not True
            or metadata.get('semantic_alignment') != 'LATEST_RECORDED_EVALUATION_FRAME_NOT_NATIVE_ASYNC'):
        errors.append('invalid_scope_or_source_changed')
    expected = metadata.get('expected_frames')
    if (not isinstance(expected, list) or not expected or any(type(x) is not int for x in expected)
            or expected != sorted(set(expected)) or frames != expected):
        errors.append('missing_extra_duplicate_or_reordered_decisions')
    manifest = copy.deepcopy(metadata.get('semantic_intervention'))
    if not isinstance(manifest, dict):
        return errors + ['missing_semantic_manifest']
    checksum = manifest.pop('bundle_sha256', None)
    try:
        _bundle_shape(manifest)
        if checksum != digest(manifest):
            errors.append('invalid_bundle_sha256')
        binding = manifest['binding']
        if binding.get('partition') != 'DEVELOPMENT' or binding.get('scenario_id') != 'EGYPT_URBAN_CHAOS_V1':
            errors.append('holdout_or_debug_context')
        origin = binding.get('data_origin')
        if (origin not in ('REAL_SIMULATION', 'TEST_FIXTURE')
                or metadata.get('evidence_class') != ('SYNTHETIC_TEST_FIXTURE' if origin == 'TEST_FIXTURE'
                                                       else 'OFFLINE_CONTROLLED_RECORDED_REPLAY')):
            errors.append('invalid_evidence_class')
        warmup = _warmup(binding, manifest['warmup'].get('activation_evaluation_frame'))
        if canonical(warmup) != canonical(manifest['warmup']):
            errors.append('invalid_warmup')
        expected_packets = [row['evaluation_frame'] for row in binding['delivery_schedule']
                            if row['evaluation_frame'] >= warmup['activation_evaluation_frame']]
        if [row['evaluation_frame'] for row in manifest['packets']] != expected_packets:
            errors.append('invalid_packet_inventory')
        schedule = {row['evaluation_frame']: row for row in binding['delivery_schedule']}
        if list(schedule) != sorted(schedule) or len(schedule) != len(binding['delivery_schedule']):
            errors.append('invalid_delivery_schedule')
        for key in ('first', 'last', 'clock', 'expected_frames'):
            if canonical(metadata.get(key)) != canonical(binding[key]):
                errors.append('binding_' + key)
        for key, source_key in (('source_sha256', 'driving_sha256'),
                                ('script_sha256', 'replay_script_sha256'), ('contracts_sha256', 'contracts_sha256')):
            if metadata.get(key) != binding['source'][source_key]:
                errors.append('binding_' + key)
        for key in ('history_sha256', 'original_history_sha256', 'input_context_history_sha256'):
            if not _sha256(metadata.get(key)):
                errors.append('missing_' + key)
        if (manifest['producer']['kind'] == 'RECORDED_SEMANTICS'
                and metadata.get('history_sha256') != metadata.get('original_history_sha256')):
            errors.append('recorded_history_not_original')
        packets = {}
        for packet in manifest['packets']:
            _validate_result(packet['result'], binding['model_profile'])
            frame = packet['evaluation_frame']
            original = schedule[frame]
            result = packet['result']
            if manifest['producer']['kind'] == 'RECORDED_SEMANTICS' and digest(result) != original['original_result_sha256']:
                errors.append(f'recorded_semantics_not_original:{frame}')
            if (packet['original_result_sha256'] != original['original_result_sha256']
                    or result['frame_id'] != original['source_frame']
                    or canonical(result['timestamp_s']) != canonical(original['source_timestamp_s'])
                    or result['source_image_sha256'] != original['source_image_sha256']
                    or packet['source']['frame_id'] != result['frame_id']
                    or canonical(packet['source']['timestamp_s']) != canonical(result['timestamp_s'])
                    or packet['source']['rgb']['asset']['sha256'] != result['source_image_sha256']
                    or not _sha256(packet['source'].get('rgb_pixels_sha256'))
                    or not _sha256(packet['source'].get('depth_values_sha256'))):
                errors.append(f'invalid_packet_source:{frame}')
            for name in ('rgb', 'depth'):
                sensor = packet['source'][name]
                if (sensor['frame_id'] != result['frame_id']
                        or canonical(sensor['sensor_timestamp_s']) != canonical(result['timestamp_s'])
                        or not _sha256(sensor['asset']['sha256'])):
                    errors.append(f'invalid_packet_{name}:{frame}')
            packets[frame] = packet
        for frame, semantic_frame, semantic_sha, original_sha in receipts:
            eligible = [key for key in schedule if key <= frame]
            selected = max(eligible) if eligible else None
            original = schedule.get(selected)
            expected_original = original['original_result_sha256'] if original else digest(None)
            expected_semantic = digest(packets[selected]['result']) if selected in packets else expected_original
            if semantic_frame != selected or semantic_sha != expected_semantic or original_sha != expected_original:
                errors.append(f'changed_semantics_or_delivery_schedule:{frame}')
    except (ValueError, KeyError, TypeError) as error:
        errors.append('malformed_manifest:' + str(error))
    return errors


def _effective_semantic_history(manifest):
    """Include every replayed frame's packet, including unscored recorded warmup."""
    binding = manifest['binding']
    inventory, schedule = binding['frame_inventory'], binding['delivery_schedule']
    if not isinstance(inventory, list) or not inventory or len(inventory) > MAX_FRAMES:
        raise ValueError('Invalid full replay frame inventory')
    if not isinstance(schedule, list) or not schedule or len(schedule) > MAX_FRAMES:
        raise ValueError('Invalid semantic delivery schedule')
    previous = -1
    for row in schedule:
        frame = row['evaluation_frame']
        if type(frame) is not int or frame <= previous or not _sha256(row['original_result_sha256']):
            raise ValueError('Invalid semantic delivery identity/order')
        previous = frame
    replacements = {row['evaluation_frame']: digest(row['result']) for row in manifest['packets']}
    activation = manifest['warmup']['activation_evaluation_frame']
    history, index, previous = [], 0, -1
    selected, semantic_sha = None, digest(None)
    for entry in inventory:
        if (not isinstance(entry, list) or len(entry) != 2
                or type(entry[0]) is not int or entry[0] <= previous):
            raise ValueError('Invalid full replay frame identity/order')
        frame = previous = entry[0]
        while index < len(schedule) and schedule[index]['evaluation_frame'] <= frame:
            packet = schedule[index]
            selected = packet['evaluation_frame']
            semantic_sha = (packet['original_result_sha256'] if selected < activation else replacements[selected])
            index += 1
        history.append((frame, selected, semantic_sha))
    return history


def _perception_provenance(manifest):
    packets = manifest.get('packets')
    packets = packets if isinstance(packets, list) else []
    runtimes, profiles = {}, {}
    for packet in packets:
        result = packet.get('result', {}) if isinstance(packet, dict) else {}
        if not isinstance(result, dict):
            continue
        runtime, profile = result.get('detector_runtime'), result.get('detector_profile')
        if isinstance(runtime, dict):
            runtimes[canonical(runtime)] = runtime
        if isinstance(profile, dict):
            profiles[canonical(profile)] = profile
    producer = manifest.get('producer')
    kind = producer.get('kind') if isinstance(producer, dict) else None
    return {'kind': kind if isinstance(kind, str) else None,
            'runtimes': list(runtimes.values()), 'profiles': list(profiles.values())}


def _comparison_kind(left, right):
    kinds = {left['kind'], right['kind']}
    if kinds == {'RECORDED_SEMANTICS'}:
        return 'RECORDED_SEMANTICS_REPEAT'
    if kinds == {'ROAD_DETECTOR'}:
        old = {canonical(row.get('onnxruntime_version')) for row in left['runtimes']}
        new = {canonical(row.get('onnxruntime_version')) for row in right['runtimes']}
        return 'CONTROLLED_SAME_RUNTIME_EXPORTS' if old == new else 'CONTROLLED_CROSS_RUNTIME_EXPORTS'
    if kinds == {'RECORDED_SEMANTICS', 'ROAD_DETECTOR'}:
        return 'RECORDED_SEMANTICS_VS_CONTROLLED_REEXPORT_NOT_NATIVE_BEHAVIOR'
    return 'DECLARED_SEMANTIC_INTERVENTION'


def compare_artifacts(baseline, candidate, output):
    """Stream every difference; invalid input context is not semantic inequality."""
    comparator_sha = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    counts = {'validation': 0, 'input_context': 0, 'declared_semantics': 0, 'output': 0}
    inventories = {'baseline': [], 'candidate': []}
    receipts = {'baseline': [], 'candidate': []}
    with ArtifactWriter(output, schema=DIFF_SCHEMA, list_key='differences') as writer:
        def emit(category, value):
            counts[category] += 1
            writer.append({'category': category, **value})

        with ArtifactReader(baseline) as old, ArtifactReader(candidate) as new:
            missing = object()
            for index, (left, right) in enumerate(zip_longest(old.rows(), new.rows(), fillvalue=missing)):
                for side, row in (('baseline', left), ('candidate', right)):
                    if row is missing:
                        emit('validation', {'side': side, 'path': f'/rows/{index}', 'error': 'missing_row'})
                        continue
                    frame = row.get('frame') if isinstance(row, dict) else None
                    inventories[side].append(frame)
                    errors = report_errors({'expected_frames': [frame], 'rows': [row]}, complete=True)
                    if isinstance(row, dict):
                        for key in ('input_context', 'semantic_input'):
                            if key not in row or row.get(key + '_sha256') != digest(row[key]):
                                errors.append('invalid_' + key + '_sha256')
                        context, semantics = row.get('input_context'), row.get('semantic_input')
                        if not isinstance(context, dict) or not (semantics is None or isinstance(semantics, dict)):
                            errors.append('malformed_input_context_or_semantics')
                        else:
                            if canonical(immutable_semantic(semantics, ALLOWED_CHANGES)) != canonical(context.get('immutable_semantic')):
                                errors.append('undeclared_semantic_context_or_clock_change')
                            receipts[side].append((frame, context.get('semantic_frame'), row.get('semantic_input_sha256'),
                                                   context.get('original_semantic_sha256')))
                    for error in errors:
                        emit('validation', {'side': side, 'path': f'/rows/{index}', 'error': error})
                if left is missing or right is missing or not isinstance(left, dict) or not isinstance(right, dict):
                    emit('output', {'path': f'/rows/{index}', 'baseline': None if left is missing else left,
                                    'candidate': None if right is missing else right})
                    continue
                for category, key in (('input_context', 'frame'), ('input_context', 'input_context'),
                                      ('declared_semantics', 'semantic_input'), ('output', 'payload')):
                    for difference in value_differences(left.get(key), right.get(key), f'/rows/{index}/{key}'):
                        emit(category, difference)
            semantic_histories = {}
            for side, metadata in (('baseline', old.metadata), ('candidate', new.metadata)):
                for error in _metadata_errors(metadata, inventories[side], receipts[side]):
                    emit('validation', {'side': side, 'path': '/metadata', 'error': error})
                try:
                    semantic_histories[side] = _effective_semantic_history(metadata['semantic_intervention'])
                except (KeyError, TypeError, ValueError) as error:
                    emit('validation', {'side': side, 'path': '/metadata',
                                        'error': 'invalid_effective_semantic_history:' + str(error)})
            same_semantic_history = (len(semantic_histories) == 2
                                     and semantic_histories['baseline'] == semantic_histories['candidate'])
            if same_semantic_history:
                for difference in value_differences(old.metadata.get('history_sha256'), new.metadata.get('history_sha256'),
                                                   '/metadata/history_sha256'):
                    emit('input_context', difference)
            for key in ('recording', 'first', 'last', 'clock', 'source_sha256', 'script_sha256',
                        'contracts_sha256', 'source_unchanged', 'history_frames', 'expected_frames',
                        'semantic_alignment', 'original_history_sha256', 'input_context_history_sha256',
                        'evidence_class'):
                for difference in value_differences(old.metadata.get(key), new.metadata.get(key), '/metadata/' + key):
                    emit('input_context', difference)
            left_manifest, right_manifest = old.metadata.get('semantic_intervention', {}), new.metadata.get('semantic_intervention', {})
            left_manifest = left_manifest if isinstance(left_manifest, dict) else {}
            right_manifest = right_manifest if isinstance(right_manifest, dict) else {}
            for key in ('binding', 'warmup', 'allowed_changes'):
                for difference in value_differences(left_manifest.get(key), right_manifest.get(key), '/manifest/' + key):
                    emit('input_context', difference)
            for key in ('producer', 'packets'):
                if key == 'producer':
                    for difference in value_differences(left_manifest.get(key), right_manifest.get(key), '/manifest/producer'):
                        emit('declared_semantics', difference)
                    continue
                left_packets, right_packets = left_manifest.get(key), right_manifest.get(key)
                for index, pair in enumerate(zip_longest(left_packets if isinstance(left_packets, list) else [],
                                                        right_packets if isinstance(right_packets, list) else [])):
                    left, right = pair
                    if not isinstance(left, dict) or not isinstance(right, dict):
                        emit('validation', {'path': f'/manifest/packets/{index}', 'error': 'packet_inventory'})
                        continue
                    for field in ('evaluation_frame', 'original_result_sha256', 'source'):
                        for difference in value_differences(left.get(field), right.get(field), f'/manifest/packets/{index}/{field}'):
                            emit('input_context', difference)
                    for difference in value_differences(left.get('result'), right.get('result'), f'/manifest/packets/{index}/result'):
                        emit('declared_semantics', difference)
                    if isinstance(left.get('result'), dict) and isinstance(right.get('result'), dict):
                        for difference in value_differences(immutable_semantic(left['result'], ALLOWED_CHANGES),
                                immutable_semantic(right['result'], ALLOWED_CHANGES), f'/manifest/packets/{index}/immutable_semantic'):
                            emit('input_context', difference)
            valid = counts['validation'] == counts['input_context'] == 0
            left_provenance, right_provenance = _perception_provenance(left_manifest), _perception_provenance(right_manifest)
            summary = {'valid': valid, 'equivalent': valid and counts['output'] == 0,
                       'native_acceptance': False, 'root_goal_status': 'OPEN_NOT_ACCEPTED',
                       'comparator_source_sha256': comparator_sha,
                       'identical_effective_semantic_history': same_semantic_history,
                       'scope': 'EXACT_COMPLETE_OUTPUTS_AT_CONTROLLED_RECORDED_DELIVERY_NOT_NATIVE_ASYNC',
                       'comparison_kind': _comparison_kind(left_provenance, right_provenance),
                       'baseline_perception': left_provenance, 'candidate_perception': right_provenance,
                       'difference_counts': counts, 'baseline_rows': len(inventories['baseline']),
                       'candidate_rows': len(inventories['candidate']),
                       'baseline_producer': left_manifest.get('producer'),
                       'candidate_producer': right_manifest.get('producer'),
                       'differences_artifact': str(Path(output).absolute())}
            writer.finish(summary)
    return writer.metadata


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='operation', required=True)
    export = commands.add_parser('export', help='Explicit recorded or actual model packet export; never native')
    run = commands.add_parser('replay', help='Verified bundle through the actual complete deterministic driver')
    compare = commands.add_parser('compare', help='Stream complete exact differences and validate hashes')
    for command in (export, run):
        command.add_argument('recording', type=Path)
        command.add_argument('--first', type=int, required=True)
        command.add_argument('--last', type=int, required=True)
        command.add_argument('--wall-age-ms', type=float, default=100.)
        command.add_argument('--shield-age-ms', type=float, default=150.)
    export.add_argument('--activation-evaluation-frame', type=int, required=True)
    export.add_argument('--provider', choices=('recorded', 'CPU', 'DML'), default='recorded')
    export.add_argument('--model', type=Path)
    run.add_argument('--bundle', type=Path, required=True)
    compare.add_argument('baseline', type=Path)
    compare.add_argument('candidate', type=Path)
    for command in (export, run, compare):
        command.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(argv)
    try:
        if args.operation == 'export':
            result = export_bundle(args.recording, args.output, first=args.first, last=args.last,
                activation=args.activation_evaluation_frame, provider=args.provider, model=args.model,
                wall_age_ms=args.wall_age_ms, shield_age_ms=args.shield_age_ms)
            summary = {'packets': len(result['packets']), 'warmup': result['warmup'], 'producer': result['producer']}
        elif args.operation == 'replay':
            result = replay_to_artifact(args.recording, args.bundle, args.output, first=args.first, last=args.last,
                wall_age_ms=args.wall_age_ms, shield_age_ms=args.shield_age_ms)
            summary = {'frames': len(result['expected_frames']), 'source_unchanged': result['source_unchanged'],
                       'evidence_class': result['evidence_class']}
        else:
            summary = compare_artifacts(args.baseline, args.candidate, args.output)
        print(json.dumps({'output': str(args.output), **summary}))
        return 1 if summary.get('equivalent') is False or summary.get('source_unchanged') is False else 0
    except (OSError, ValueError, KeyError, TypeError, EOFError) as error:
        parser.exit(2, f'perception replay rejected: {error}\n')


if __name__ == '__main__':
    raise SystemExit(main())
