import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from backend import perception, perception_worker


class PerceptionIsolationTests(unittest.TestCase):
    def test_text_model_is_requested_only_by_its_current_parent_with_a_recent_panel_request(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(perception_worker,'OUTPUT',Path(directory)),patch.object(perception_worker.time,'time',return_value=10.):
                self.assertFalse(perception_worker.ocr_requested(7))
                path=Path(directory)/'ocr-request.json'
                for value,expected in [({'parent':7,'requested_at':9.},True),({'parent':8,'requested_at':9.},False),({'parent':7,'requested_at':5.},False),({'parent':7,'requested_at':11.},False)]:
                    path.write_text(json.dumps(value));self.assertEqual(perception_worker.ocr_requested(7),expected)

    def test_lockstep_fast_polling_is_requested_only_by_its_parent(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(perception_worker,'OUTPUT',Path(directory)):
                self.assertFalse(perception_worker.lockstep_requested(7))
                path=Path(directory)/'lockstep-request.json'
                for value,expected in [({'parent':7},True),({'parent':8},False),([7],False)]:
                    path.write_text(json.dumps(value));self.assertEqual(perception_worker.lockstep_requested(7),expected)
                path.write_text('{broken');self.assertFalse(perception_worker.lockstep_requested(7))

    def test_semantic_publication_uses_the_same_windows_lock_retries(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);real_replace=perception_worker.os.replace;calls=[]
            def replace(source,destination):
                calls.append(destination)
                if len(calls)<3:raise PermissionError('Windows reader lock')
                return real_replace(source,destination)
            with patch.object(perception_worker,'OUTPUT',root),patch.object(perception_worker.os,'replace',side_effect=replace),patch.object(perception_worker.time,'sleep'):
                self.assertTrue(perception_worker.publish({'frame_id':1084},'latest-detections.json'))
            self.assertEqual(json.loads((root/'latest-detections.json').read_text())['frame_id'],1084)
            self.assertFalse((root/'latest.json').exists())
            self.assertEqual(len(calls),3)

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
