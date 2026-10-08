import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend import perception, perception_worker


class PerceptionIsolationTests(unittest.TestCase):
    def test_windows_atomic_publish_retries_transient_reader_lock(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            real_replace = perception_worker.os.replace
            attempts = []
            def replace(source, destination):
                attempts.append(1)
                if len(attempts) < 3:
                    raise PermissionError('Windows reader lock')
                return real_replace(source, destination)
            with patch.object(perception_worker, 'OUTPUT', root), patch.object(
                    perception_worker.os, 'replace', side_effect=replace), patch.object(
                    perception_worker.time, 'sleep'):
                self.assertTrue(perception_worker.publish({'status':'RUNNING','frame_id':42}))
            self.assertEqual(json.loads((root/'latest.json').read_text())['frame_id'],42)
            self.assertEqual(len(attempts),3)

    def test_persistent_lock_retains_complete_previous_result(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'latest.json').write_text('{"frame_id":41}')
            with patch.object(perception_worker, 'OUTPUT', root), patch.object(
                    perception_worker.os, 'replace', side_effect=PermissionError), patch.object(
                    perception_worker.time, 'sleep'):
                self.assertFalse(perception_worker.publish({'frame_id':42}))
            self.assertEqual(json.loads((root/'latest.json').read_text())['frame_id'],41)

    def test_image_tokens_cannot_escape_bounded_output_directory(self):
        service = perception.PerceptionService.__new__(perception.PerceptionService)
        for token in ['../secret.jpg','frame_../secret.jpg','frame_a.jpg\\secret','C:/secret.jpg','']:
            with self.assertRaises(ValueError): service.image(token)

    def test_results_from_previous_native_session_are_never_published_as_current(self):
        service = perception.PerceptionService.__new__(perception.PerceptionService)
        service.error = None
        class Running:
            def poll(self): return None
        service.process = Running()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root/'latest.json').write_text(json.dumps({'status':'RUNNING',
                'session_id':'old','published_at':perception.time.time()}))
            with patch.object(perception, 'OUTPUT', root):
                self.assertEqual(service.latest('new')['status'],'WAITING')
