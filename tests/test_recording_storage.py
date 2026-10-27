from dataclasses import replace
import gzip
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend.core.contracts import SensorKind
from backend.core.recording import RunRecorder, read_asset
from backend.core.recording_storage import compress_file, compress_recording, recording_size_estimate
from backend.core.replay import ReplayReader
from tests.core_packets import metadata, packet, sensor


class LosslessRecordingTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.workspace = Path(temporary.name)
        for target in ('backend.carla.runtime.native_processes', 'backend.learning.egypt_budget.ownership_status'):
            mocked = patch(target, return_value=[] if target.endswith('native_processes') else {'reserved': False})
            mocked.start()
            self.addCleanup(mocked.stop)

    def recording(self, name='original', *, partition='DEVELOPMENT'):
        config = {'scenario_id': 'EGYPT_URBAN_CHAOS_V1', 'seed_partition': partition, 'fixed_delta_seconds': .05}
        raw = b'preserved original sensor bytes\x00' * 3000
        with RunRecorder(self.workspace, replace(metadata(name), config=config)) as recorder:
            asset = recorder.store_asset('depth', 'depth.npy', raw, 'application/x-npy')
            observed = replace(sensor('depth'), kind=SensorKind.DEPTH, data={}, units={}, asset=asset)
            recorder.record(packet(sensors=(observed,)))
            recorder.record(packet(2, .1, sensors=(replace(observed, frame_id=2, timestamp_s=.1, sensor_timestamp_s=.1),)))
            recorder.record_safety({'version': 2, 'evaluation_frame': 1, 'reason': 'measured fixture ' * 100})
        (recorder.root / 'recording-status.json').write_text('{"finalized":true,"incomplete":false}')
        return recorder.root, asset, raw

    def test_compression_preserves_all_original_bytes_hashes_frames_events_and_seek(self):
        root, asset, raw = self.recording()
        original = ReplayReader(root, allow_test_data=True)
        frames, events, safety = list(original.frames()), list(original.events()), original.safety_at(1)
        metadata_bytes = (root / 'metadata.json').read_bytes()
        result = compress_recording(root, self.workspace)
        self.assertEqual(result['status'], 'COMPLETE')
        self.assertGreater(result['saved_bytes'], 0)
        self.assertFalse((root / asset.path).exists())
        self.assertEqual(read_asset(root, asset), raw)
        self.assertEqual((root / 'metadata.json').read_bytes(), metadata_bytes)
        replay = ReplayReader(root, allow_test_data=True)
        self.assertEqual(list(replay.frames()), frames)
        self.assertEqual(list(replay.events()), events)
        self.assertEqual(replay.safety_at(1), safety)
        self.assertEqual(replay.seek(.1), frames[1])
        self.assertEqual(replay.asset_bytes(frames[0].sensors[0]), raw)
        for line in (root / result['manifest']).read_text().splitlines():
            entry = json.loads(line)
            with gzip.open(root / entry['stored_path'], 'rb') as stream:
                self.assertEqual(hashlib.sha256(stream.read()).hexdigest(), entry['original_sha256'])
        self.assertEqual(compress_recording(root, self.workspace), result)

    def test_failed_roundtrip_never_removes_original_or_claims_completion(self):
        root, asset, raw = self.recording()
        path = root / asset.path
        path.with_name(path.name + '.gz').write_bytes(gzip.compress(b'different evidence', mtime=0))
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            compress_recording(root, self.workspace)
        self.assertEqual(path.read_bytes(), raw)
        self.assertEqual(json.loads((root / 'lossless-compression.json').read_text())['status'], 'ERROR')
        self.assertEqual(list(root.rglob('*.compressing')), [])

    def test_open_native_engine_or_active_recording_blocks_compression(self):
        root, _, _ = self.recording()
        with patch('backend.carla.runtime.native_processes', return_value=[{'ProcessId': 10}]):
            with self.assertRaisesRegex(RuntimeError, 'CARLA stopped'):
                compress_recording(root, self.workspace)
        (root / 'recording-status.json').write_text('{"finalized":false}')
        with self.assertRaisesRegex(ValueError, 'closed recordings'):
            compress_recording(root, self.workspace)
        self.assertFalse((root / 'lossless-compression.json').exists())

    def test_tampered_compressed_asset_is_not_served_as_sensor_bytes(self):
        root, asset, _ = self.recording()
        compress_recording(root, self.workspace)
        path = root / (asset.path + '.gz')
        path.write_bytes(gzip.compress(b'bad bytes', mtime=0))
        with self.assertRaisesRegex(ValueError, 'length mismatch'):
            read_asset(root, asset)

    def test_storage_estimate_counts_raw_size_after_compression_and_preserves_margin(self):
        root, _, _ = self.recording()
        before = recording_size_estimate([root])
        compress_recording(root, self.workspace)
        after = recording_size_estimate([root])
        self.assertEqual(before['recording_bytes'], after['recording_bytes'])
        self.assertLessEqual(after['matrix_estimate_bytes'], before['matrix_estimate_bytes'])
        self.assertEqual(after['required_free_bytes'], int(after['matrix_estimate_bytes'] * 1.5) + 4 * 1024**3)
        holdout, _, _ = self.recording('holdout', partition='HOLDOUT')
        with self.assertRaisesRegex(ValueError, 'development recordings'):
            recording_size_estimate([holdout])

    def test_workspace_root_cannot_be_compressed_as_a_file(self):
        with tempfile.TemporaryFile(mode='w+') as manifest, self.assertRaises(ValueError):
            compress_file(self.workspace, self.workspace, manifest)


if __name__ == '__main__':
    unittest.main()
