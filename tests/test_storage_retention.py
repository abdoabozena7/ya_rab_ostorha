import gzip
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import TestCase
from unittest.mock import patch
from types import SimpleNamespace
from backend.core.storage_retention import archive_recording,contained,open_telemetry,retire_guided_history
from backend.core.replay import ReplayReader


class StorageRetentionTests(TestCase):
    def test_new_recording_is_refused_before_creating_files_below_disk_reserve(self):
        from backend.core.recording import RunRecorder,DISK_RESERVE_BYTES
        from tests.core_packets import metadata
        with TemporaryDirectory() as directory:
            root=Path(directory)
            with patch('backend.core.recording.shutil.disk_usage',return_value=SimpleNamespace(free=DISK_RESERVE_BYTES-1)):
                with self.assertRaisesRegex(OSError,'4 GiB disk reserve'):
                    RunRecorder(root,metadata())
            self.assertEqual(list(root.iterdir()),[])

    def test_active_writer_stops_with_a_saved_prefix_before_using_the_disk_reserve(self):
        from backend.core.recording import RunRecorder,BufferedRunRecorder,DISK_RESERVE_BYTES
        from tests.core_packets import metadata,packet
        with TemporaryDirectory() as directory:
            writer=RunRecorder(directory,metadata())
            with patch('backend.core.recording.shutil.disk_usage',return_value=SimpleNamespace(free=DISK_RESERVE_BYTES-1)):
                recorder=BufferedRunRecorder(writer)
                for i in range(1,21):recorder.submit(packet(i,i*.05),[])
                with self.assertRaisesRegex(RuntimeError,'disk reserve'):recorder.close()
            self.assertEqual(recorder.written_frames,16)
            self.assertTrue(recorder.status()['incomplete'])
            self.assertEqual(len((writer.root/'telemetry/frames.jsonl').read_text().splitlines()),16)

    def test_bulk_cleanup_preserves_requested_roots_and_never_overwrites_old_manifest(self):
        from scripts import prune_recordings
        import sys
        with TemporaryDirectory() as directory:
            root=Path(directory);keep=self.fixture(root,'keep');old=self.fixture(root,'old')
            preserve=root/'preserve.json';preserve.write_text(json.dumps([str(keep)]))
            args=['prune_recordings','--apply','--preserve-file',str(preserve),'--report','evidence/maintenance.json']
            with patch.object(prune_recordings,'ROOT',root),patch.object(sys,'argv',args), \
                 patch('urllib.request.urlopen',side_effect=OSError), \
                 patch('backend.carla.runtime.native_processes',return_value=[]), \
                 patch('backend.learning.egypt_budget.ownership_status',return_value={'reserved':False}):
                prune_recordings.main()
                self.assertTrue((keep/'rgb/frame.jpg').exists())
                self.assertFalse((old/'rgb').exists())
                report=root/'evidence/maintenance.json';before=report.read_bytes()
                with self.assertRaises(FileExistsError):prune_recordings.main()
                self.assertEqual(report.read_bytes(),before)

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

    def test_required_annotation_must_be_ready_and_checksum_verified_before_retirement(self):
        with TemporaryDirectory() as directory:
            workspace=Path(directory);old=self.fixture(workspace,'1')
            self.fixture(workspace,'2');self.fixture(workspace,'3')
            status={'status':'READY','annotation_required':True}
            (old/'video-status.json').write_text(json.dumps(status))
            self.assertEqual(retire_guided_history(workspace),[])
            path=old/'driving-annotated.mp4';path.write_bytes(b'overlay')
            status['variants']={'annotated':{'status':'READY','sha256':'incorrect'}}
            (old/'video-status.json').write_text(json.dumps(status))
            self.assertEqual(retire_guided_history(workspace),[])
            status['variants']['annotated']['sha256']=hashlib.sha256(path.read_bytes()).hexdigest()
            (old/'video-status.json').write_text(json.dumps(status))
            self.assertEqual(len(retire_guided_history(workspace)),1)
            self.assertTrue(path.exists())
