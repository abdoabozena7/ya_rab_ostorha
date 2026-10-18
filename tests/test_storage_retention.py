import gzip
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from backend.core.storage_retention import archive_recording,contained,open_telemetry,retire_guided_history
from backend.core.replay import ReplayReader


class StorageRetentionTests(TestCase):
    def fixture(self,workspace,name='run'):
        root=workspace/'runs/normal_city'/name;(root/'telemetry').mkdir(parents=True)
        (root/'metadata.json').write_text(json.dumps({'config':{'storage_policy':'GUIDED_KEEP_TWO_RAW'},'created_at_utc':name}))
        (root/'recording-status.json').write_text(json.dumps({'finalized':True}))
        (root/'video-status.json').write_text(json.dumps({'status':'READY'}))
        (root/'driving.mp4').write_bytes(b'original video')
        (root/'telemetry/frames.jsonl').write_text('{"result":"contact retained"}\n')
        (root/'rgb').mkdir();(root/'rgb/frame.jpg').write_bytes(b'raw pixels')
        return root

    def test_dry_run_then_lossless_retirement_keeps_video_and_outcomes(self):
        with TemporaryDirectory() as directory:
            workspace=Path(directory);root=self.fixture(workspace)
            archive_recording(root,workspace);self.assertTrue((root/'rgb/frame.jpg').exists())
            archive_recording(root,workspace,apply=True)
            self.assertFalse((root/'rgb').exists());self.assertEqual((root/'driving.mp4').read_bytes(),b'original video')
            with open_telemetry(root/'telemetry/frames.jsonl') as stream:self.assertIn('contact retained',stream.read())
            with self.assertRaisesRegex(ValueError,'archived'):ReplayReader(root)

    def test_retention_does_not_delete_active_or_two_most_recent_recordings(self):
        with TemporaryDirectory() as directory:
            workspace=Path(directory);old=self.fixture(workspace,'1');active=self.fixture(workspace,'2')
            current=self.fixture(workspace,'3');new=self.fixture(workspace,'4')
            (active/'recording-status.json').write_text(json.dumps({'finalized':False}))
            retired=retire_guided_history(workspace)
            self.assertEqual(len(retired),1);self.assertFalse((old/'rgb').exists())
            for root in (active,current,new):self.assertTrue((root/'rgb').exists())

    def test_workspace_root_and_paths_outside_it_are_never_deletion_targets(self):
        with TemporaryDirectory() as directory:
            workspace=Path(directory)
            for path in (workspace,workspace.parent/'outside'):
                with self.assertRaises(ValueError):contained(path,workspace)

    def test_failed_export_preserves_raw_assets_for_recovery(self):
        with TemporaryDirectory() as directory:
            workspace=Path(directory);failed=self.fixture(workspace,'1')
            self.fixture(workspace,'2');self.fixture(workspace,'3')
            (failed/'video-status.json').write_text(json.dumps({'status':'ERROR'}))
            (failed/'driving.mp4').unlink()
            self.assertEqual(retire_guided_history(workspace),[])
            self.assertTrue((failed/'rgb/frame.jpg').exists())
