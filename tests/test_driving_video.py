import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from backend.core.driving_video import export_video


class DrivingVideoTests(unittest.TestCase):
    def test_video_status_retries_a_transient_windows_reader_lock(self):
        from unittest.mock import patch
        from backend.core.driving_video import _status
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);original=Path.replace;attempts=[]
            def replace(path,target):
                attempts.append(path)
                if len(attempts)<3:raise PermissionError('Windows reader still has the status open')
                return original(path,target)
            with patch.object(Path,'replace',replace),patch('backend.core.driving_video.time.sleep'):
                _status(root,{'status':'READY','video':'original.mp4'})
            self.assertEqual(len(attempts),3)
            self.assertEqual(json.loads((root/'video-status.json').read_text())['status'],'READY')

    def test_automatic_pair_export_waits_for_driving_to_release_cpu(self):
        import threading
        from types import SimpleNamespace
        from unittest.mock import Mock,patch
        from backend.core.driving_video import export_after_close
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);release=threading.Event();encoded=threading.Event()
            recorder=SimpleNamespace(root=root,closed=True,status=lambda:{'incomplete':False})
            with patch('backend.core.driving_video.export_video',side_effect=lambda _:encoded.set()),patch('backend.core.storage_retention.retire_guided_history'):
                worker=export_after_close(recorder,ready=release.is_set)
                try:
                    self.assertFalse(encoded.wait(.15))
                    self.assertEqual(json.loads((root/'video-status.json').read_text())['status'],'WAITING_FOR_COMPARISON')
                finally:release.set();worker.join(3.)
                self.assertFalse(worker.is_alive());self.assertTrue(encoded.is_set())

    def test_presentation_video_starts_at_admitted_drive_instead_of_setup_frames(self):
        try:import imageio_ffmpeg
        except ImportError:self.skipTest('Optional MP4 encoder is not installed')
        for mode in ('ROBOSPHERE','NORMAL'):
            with self.subTest(mode=mode),tempfile.TemporaryDirectory() as directory:
                root=Path(directory);self.recording(root)
                (root/'events/events.jsonl').write_text(json.dumps({'timestamp_s':.1,
                    'payload':{'journey':{'status':'RUNNING','driving_mode':mode,'presentation_id':'test'}}})+'\n')
                status=export_video(root,allow_test_data=True)
                self.assertEqual(status['alignment_source'],'ADMITTED_JOURNEY_START')
                self.assertEqual(status['frames'],3)
                self.assertAlmostEqual(status['clock_zero_timestamp_s'],.1)

    def recording(self,root):
        from PIL import Image
        (root/'telemetry').mkdir();(root/'events').mkdir()
        (root/'metadata.json').write_text(json.dumps({'data_origin':'TEST_FIXTURE','provider':'test'}))
        rows=[]
        for i,stamp in enumerate((0.,.05,.1,.35,.4)):
            asset=root/f'{i}.jpg';Image.new('RGB',(160,90),(i*40,20,80)).save(asset)
            rows.append({'sensor_id':'drivingCamera','timestamp_s':stamp,
                'asset':{'path':asset.name,'sha256':hashlib.sha256(asset.read_bytes()).hexdigest()}})
        (root/'telemetry/video-frames.jsonl').write_text(''.join(json.dumps(row)+'\n' for row in rows))
        return rows

    def test_only_the_admitted_simulation_interval_is_encoded_and_fixture_stays_labelled(self):
        try:import imageio_ffmpeg
        except ImportError:self.skipTest('Optional MP4 encoder is not installed')
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);self.recording(root)
            (root/'events/events.jsonl').write_text(json.dumps({'timestamp_s':.1,
                'payload':{'journey':{'status':'RUNNING','driving_mode':'HYBRID'}}})+'\n')
            status=export_video(root,allow_test_data=True)
            self.assertEqual(status['source'],'TEST_FIXTURE');self.assertEqual(status['frames'],3)
            self.assertEqual(status['alignment_source'],'ADMITTED_JOURNEY_START')
            self.assertAlmostEqual(status['duration_s'],.3)
            self.assertAlmostEqual(status['maximum_frame_gap_s'],.25)
            self.assertTrue((root/'driving.mp4').stat().st_size>500)

    def test_corrupted_original_camera_bytes_are_rejected_before_encoding(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);self.recording(root);(root/'0.jpg').write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError,'checksum'):
                export_video(root,ffmpeg='not-called',allow_test_data=True)

    def test_test_recording_cannot_be_exported_as_native_evidence(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);self.recording(root)
            with self.assertRaisesRegex(ValueError,'provenance'):
                export_video(root,ffmpeg='not-called')
