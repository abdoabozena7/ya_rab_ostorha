import hashlib
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from backend.core import recording_relocation as relocation
from backend.core.recording_locations import recording_location, registered_location, receipt_path
from backend.core.recording_storage import compress_recording
from backend.core.storage_retention import contained, recording_roots
from backend.core.video_http import serve_video


class RecordingRelocationTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.base = Path(temporary.name)
        self.workspace = self.base / 'workspace'
        self.parent = self.workspace / 'runs' / 'normal_city'
        self.source = self.parent / ('run_' + 'a' * 32)
        (self.source / 'telemetry').mkdir(parents=True)
        (self.source / 'empty').mkdir()
        self.destination = self.base / 'external'
        self.payload = b'original native bytes' * 100
        (self.source / 'metadata.json').write_text(json.dumps({
            'provider': 'carla', 'data_origin': 'REAL_SIMULATION'}))
        (self.source / 'recording-status.json').write_text('{"finalized":true}')
        (self.source / 'telemetry' / 'frames.jsonl').write_bytes(b'original telemetry\n')
        (self.source / 'driving.mp4').write_bytes(self.payload)
        (self.source / 'video-status.json').write_text(json.dumps({
            'status': 'READY', 'source': 'RECORDED_NATIVE_DRIVING_CAMERA',
            'sha256': hashlib.sha256(self.payload).hexdigest()}))
        for target, value in (
                ('backend.carla.runtime.native_processes', []),
                ('backend.learning.egypt_budget.ownership_status', {'reserved': False}),
                ('backend.core.driving_video.wait_for_exports', True)):
            mocked = patch(target, return_value=value)
            mocked.start()
            self.addCleanup(mocked.stop)
        self.addCleanup(self.remove_alias)

    def remove_alias(self):
        if self.source.is_symlink() or self.source.is_junction():
            relocation._unlink(self.source)

    def relocate(self):
        return relocation.relocate_recording(self.source, self.destination, workspace=self.workspace)

    def test_copy_activation_preserves_every_byte_original_path_and_discovery(self):
        before = relocation.inventory(self.source)
        result = self.relocate()
        target = self.destination / self.source.name
        staged = Path(result['staged_source'])
        self.assertEqual(relocation.inventory(target), before)
        self.assertEqual(relocation.inventory(staged), before)
        self.assertEqual((self.source / 'driving.mp4').read_bytes(), self.payload)
        self.assertEqual(recording_location(self.source, self.parent, workspace=self.workspace), target)
        self.assertEqual(recording_location(target, self.parent, workspace=self.workspace), target)
        self.assertEqual(list(recording_roots(self.parent, self.workspace)), [target])
        with self.assertRaises(ValueError):
            contained(self.source, self.workspace)
        self.assertEqual(result['status'], 'ACTIVE')

    def test_release_requires_all_hashes_and_consumer_checks_before_removing_staged_copy(self):
        result = self.relocate()
        staged = Path(result['staged_source'])
        with patch.object(relocation, 'verify_closed_recording', side_effect=ValueError('decode failed')):
            with self.assertRaisesRegex(ValueError, 'decode failed'):
                relocation.release_staged_recording(self.source.name, workspace=self.workspace)
        self.assertTrue(staged.is_dir())
        with patch.object(relocation, 'verify_closed_recording', return_value={'replay': 'fixture'}) as check:
            released = relocation.release_staged_recording(self.source.name, workspace=self.workspace)
        check.assert_called_once_with(self.destination / self.source.name)
        self.assertEqual(released['status'], 'RELEASED')
        self.assertFalse(staged.exists())
        self.assertEqual((self.source / 'driving.mp4').read_bytes(), self.payload)

    def test_destination_tampering_blocks_release_and_keeps_staged_original(self):
        result = self.relocate()
        (self.destination / self.source.name / 'driving.mp4').write_bytes(b'changed')
        with self.assertRaisesRegex(ValueError, 'changed'):
            relocation.release_staged_recording(self.source.name, workspace=self.workspace)
        self.assertEqual((Path(result['staged_source']) / 'driving.mp4').read_bytes(), self.payload)

    def test_rollback_restores_physical_original_and_retains_external_evidence(self):
        self.relocate()
        with patch.object(relocation, 'verify_closed_recording', return_value={'replay': 'fixture'}):
            relocation.release_staged_recording(self.source.name, workspace=self.workspace)
        result = relocation.restore_recording(self.source.name, workspace=self.workspace)
        self.assertEqual(result['status'], 'RESTORED')
        self.assertFalse(self.source.is_junction() or self.source.is_symlink())
        self.assertEqual((self.source / 'driving.mp4').read_bytes(), self.payload)
        self.assertEqual((self.destination / self.source.name / 'driving.mp4').read_bytes(), self.payload)
        self.assertEqual(list(recording_roots(self.parent, self.workspace)), [self.source])

    def test_failed_copy_and_failed_activation_never_remove_original(self):
        with patch.object(relocation.shutil, 'copyfileobj', side_effect=lambda source, target, size: target.write(b'bad')):
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                self.relocate()
        self.assertFalse(self.source.is_junction() or self.source.is_symlink())
        self.assertEqual((self.source / 'driving.mp4').read_bytes(), self.payload)
        other = self.base / 'another-destination'
        with patch.object(relocation, '_link', side_effect=OSError('junction unavailable')):
            with self.assertRaisesRegex(OSError, 'junction unavailable'):
                relocation.relocate_recording(self.source, other, workspace=self.workspace)
        self.assertEqual((self.source / 'driving.mp4').read_bytes(), self.payload)
        self.assertEqual(json.loads(receipt_path(self.source.name, self.workspace).read_text())['status'], 'COPY_VERIFIED')
        self.assertFalse((receipt_path(self.source.name, self.workspace).parent / 'relocation.lock').exists())

    def test_unregistered_link_and_tampered_identity_are_not_trusted(self):
        result = self.relocate()
        receipt = receipt_path(self.source.name, self.workspace)
        data = receipt.read_bytes()
        receipt.unlink()
        with self.assertRaises(ValueError):
            recording_location(self.source, self.parent, workspace=self.workspace)
        receipt.write_bytes(data)
        (self.destination / self.source.name / 'metadata.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'identity changed'):
            registered_location(self.source.name, self.workspace)
        self.assertTrue(Path(result['staged_source']).is_dir())

    def test_registered_original_video_url_preserves_exact_range_and_rejects_unregistered_target(self):
        self.relocate()
        responses = []
        handler = SimpleNamespace(command='GET', headers={'Range': 'bytes=3-9'}, wfile=io.BytesIO(),
            send_response=lambda value: responses.append(value),
            send_header=lambda *args: None, end_headers=lambda: None,
            _json=lambda status, data: responses.append(status))
        with patch('backend.core.video_http.recording_location',
                   side_effect=lambda path, parent: recording_location(path, parent, workspace=self.workspace)):
            route = '/runs/normal_city/' + self.source.name + '/driving.mp4'
            self.assertTrue(serve_video(handler, route, self.parent))
            self.assertEqual(responses, [206])
            self.assertEqual(handler.wfile.getvalue(), self.payload[3:10])
            receipt_path(self.source.name, self.workspace).unlink()
            responses.clear()
            self.assertTrue(serve_video(handler, route, self.parent))
            self.assertEqual(responses, [404])

    def test_registered_compression_remains_scoped_to_the_verified_recording(self):
        self.relocate()
        result = compress_recording(self.source, self.workspace)
        self.assertEqual(result['status'], 'COMPLETE')
        self.assertEqual((self.source / 'driving.mp4').read_bytes(), self.payload)
        receipt_path(self.source.name, self.workspace).unlink()
        with self.assertRaises(ValueError):
            compress_recording(self.source, self.workspace)

    def test_inventory_manifest_tampering_invalidates_the_mapping(self):
        self.relocate()
        receipt_path(self.source.name, self.workspace).with_suffix('.manifest.json').write_text('{}')
        with self.assertRaisesRegex(ValueError, 'manifest changed'):
            registered_location(self.source.name, self.workspace)

    def test_failed_original_export_intermediates_are_preserved_not_certified(self):
        (self.source / 'storage-retention.json').write_text('{"raw_replay_available":false}')
        (self.source / 'old.encoding.mp4').write_bytes(b'original interrupted export')
        (self.source / 'shared-perception.mp4').write_bytes(b'original unavailable shared export')
        self.relocate()
        def served(handler, *args):
            handler.send_response(200)
            return True
        with patch.object(relocation.subprocess, 'run', return_value=SimpleNamespace(returncode=0)) as decode:
            with patch('backend.core.video_http.serve_video', side_effect=served):
                result = relocation.verify_closed_recording(self.destination / self.source.name)
        self.assertEqual(decode.call_count, 2)
        statuses = {row['name']: row.get('status') for row in result['videos']}
        self.assertEqual(statuses['old.encoding.mp4'], 'ORIGINAL_ENCODING_INTERMEDIATE_PRESERVED')
        self.assertEqual(statuses['shared-perception.mp4'], 'ORIGINAL_UNAVAILABLE_VIDEO_PRESERVED')
        self.assertEqual((self.source / 'old.encoding.mp4').read_bytes(), b'original interrupted export')

    def test_active_engine_unfinished_run_and_low_destination_capacity_refuse_copy(self):
        with patch('backend.carla.runtime.native_processes', return_value=[{'ProcessId': 10}]):
            with self.assertRaisesRegex(RuntimeError, 'CARLA stopped'):
                self.relocate()
        with patch.object(relocation.shutil, 'disk_usage', return_value=SimpleNamespace(free=0)):
            with self.assertRaisesRegex(ValueError, 'capacity'):
                self.relocate()
        (self.source / 'recording-status.json').write_text('{"finalized":false}')
        with self.assertRaisesRegex(ValueError, 'finalized'):
            self.relocate()
        self.assertFalse((self.destination / self.source.name).exists())


if __name__ == '__main__':
    unittest.main()
