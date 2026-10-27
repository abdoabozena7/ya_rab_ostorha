from dataclasses import replace
import hashlib
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import zipfile

from backend.core.contracts import AssetReference, SensorKind
from scripts import behavior_experiment as experiment
from tests.core_packets import packet, sensor


class BehaviorExperimentTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.write('metadata.json', {'config': {'seed_partition': 'DEVELOPMENT'}})
        self.write('recording-status.json', {'finalized': True, 'incomplete': False})
        self.write('telemetry/comparison-controls.jsonl', {'kind': 'TEST_FIXTURE_ONLY'})
        raw = b'software-test-sensor-bytes'
        self.raw = raw
        asset = AssetReference('frame.bin', 'application/octet-stream', len(raw), hashlib.sha256(raw).hexdigest())
        channel = replace(sensor('camera'), kind=SensorKind.RGB, data={}, units={}, asset=asset)
        self.frame = packet(sensors=(channel,))
        self.reader = SimpleNamespace(frames=lambda: iter((self.frame,)),
                                      metadata=SimpleNamespace(config={'vehicle_geometry': {}}))

    def write(self, name, value):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value), encoding='utf8')
        return path

    def inputs(self, limit=10):
        with patch('backend.core.replay.ReplayReader', return_value=self.reader), \
             patch('backend.core.recording.read_asset', return_value=self.raw), \
             patch('backend.core.safety_policy.sensor_observation'):
            return experiment.replay_inputs(self.root, limit)

    def test_input_identity_verifies_assets_and_counts_excluded_incomplete_frames(self):
        self.reader.frames = lambda: iter((SimpleNamespace(frame_id=0, complete=False), self.frame))
        _, selected, identity = self.inputs()
        self.assertEqual(selected, [self.frame])
        self.assertEqual(identity['frame_ids'], [self.frame.frame_id])
        self.assertEqual(identity['excluded_frames'], [{'frame_id': 0, 'reason': 'INCOMPLETE_SENSOR_FRAME'}])
        self.assertEqual(identity['assets'], {'frame.bin': hashlib.sha256(self.raw).hexdigest()})
        self.assertEqual(self.inputs()[2], identity)
        self.write('telemetry/comparison-controls.jsonl', {'kind': 'CHANGED_TEST_FIXTURE'})
        self.assertNotEqual(self.inputs()[2]['input_sha256'], identity['input_sha256'])
        self.raw = b'corrupted-test-sensor'
        with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
            self.inputs()

    def test_reserved_unknown_unfinalized_and_empty_inputs_are_rejected(self):
        for partition in ('TEST', 'HOLDOUT', 'ACCEPTANCE', '', 'UNKNOWN'):
            self.write('metadata.json', {'config': {'seed_partition': partition}})
            with self.subTest(partition=partition), self.assertRaises(ValueError):
                self.inputs()
        self.write('metadata.json', {'config': {'seed_partition': 'DEVELOPMENT'}})
        for status in ({'finalized': False}, {'finalized': True, 'incomplete': True}):
            self.write('recording-status.json', status)
            with self.assertRaisesRegex(ValueError, 'finalized'):
                self.inputs()
        self.write('recording-status.json', {'finalized': True})
        self.reader.frames = lambda: iter(())
        with self.assertRaisesRegex(ValueError, 'No complete'):
            self.inputs()
        for limit in (0, -1, True):
            with self.assertRaisesRegex(ValueError, 'positive integer'):
                self.inputs(limit)

    def archive(self):
        path = self.root / 'source.zip'
        raw = b'original source bytes\n'
        manifest = {'source.py': hashlib.sha256(raw).hexdigest()}
        with zipfile.ZipFile(path, 'x') as archive:
            archive.writestr('source.py', raw)
        return path, manifest, hashlib.sha256(path.read_bytes()).hexdigest()

    def test_source_archive_verifies_exact_file_set_and_original_bytes(self):
        archive, manifest, checksum = self.archive()
        self.assertEqual(experiment.verify_archive(archive, manifest, checksum), checksum)
        with self.assertRaisesRegex(ValueError, 'checksum changed'):
            experiment.verify_archive(archive, manifest, '0' * 64)
        with self.assertRaisesRegex(ValueError, 'contents'):
            experiment.verify_archive(archive, {**manifest, 'missing.py': '0' * 64})
        with self.assertRaisesRegex(ValueError, 'contents'):
            experiment.verify_archive(archive, {'source.py': '0' * 64})
        with zipfile.ZipFile(archive, 'a') as bundle:
            bundle.writestr('unexpected.py', 'extra')
        with self.assertRaisesRegex(ValueError, 'contents'):
            experiment.verify_archive(archive, manifest)

    def test_freeze_preserves_effective_source_and_refuses_overwrite_or_source_race(self):
        source = self.root / 'source.py'
        source.write_bytes(b'pre-existing effective edits\n')
        manifest = {'source.py': hashlib.sha256(source.read_bytes()).hexdigest()}
        protocol = self.write('protocol.json', {'test_fixture': True})
        urban = {'output_sha256': 'urban', 'rows': [{'frame_id': 1}]}
        with patch.object(experiment, 'ROOT', self.root), patch.object(experiment, 'PROTOCOL', protocol), \
             patch.object(experiment, 'source_manifest', return_value=manifest), \
             patch.object(experiment, 'replay_inputs', return_value=(self.reader, [self.frame], {
                 'frame_limit': 1, 'recorded_controls': experiment.control_input_identity(self.root)})), \
             patch.object(experiment, 'urban_replay', return_value=urban), \
             patch('scripts.profile_control_pipeline.run', return_value=({}, 'rule', 1)), \
             patch.object(experiment.subprocess, 'check_output', return_value=b'test-working-tree\n'):
            result = experiment.freeze(self.root, 1, self.root / 'frozen.zip', self.root / 'baseline.json')
            saved = json.loads((self.root / 'baseline.json').read_text(encoding='utf8'))
            self.assertFalse(result['native_run'])
            self.assertEqual(saved['source_kind'], 'EFFECTIVE_WORKING_TREE_NOT_HEAD_ONLY')
            self.assertEqual(saved['source_manifest'], manifest)
            with zipfile.ZipFile(self.root / 'frozen.zip') as archive:
                self.assertEqual(archive.read('source.py'), source.read_bytes())
            with self.assertRaises(FileExistsError):
                experiment.freeze(self.root, 1, self.root / 'other.zip', self.root / 'baseline.json')
            with patch.object(experiment, 'source_manifest', side_effect=[manifest, {'source.py': 'changed'}]):
                with self.assertRaisesRegex(RuntimeError, 'Source or recorded controls changed'):
                    experiment.freeze(self.root, 1, self.root / 'race.zip', self.root / 'race.json')
            self.assertFalse((self.root / 'race.json').exists())

    def baseline(self):
        archive, manifest, checksum = self.archive()
        protocol = self.write('protocol.json', {'test_fixture': True})
        identity = {'frame_limit': 1, 'input_sha256': 'inputs',
                    'recorded_controls': experiment.control_input_identity(self.root)}
        value = {
            'source_manifest': manifest, 'source_sha256': experiment.digest(manifest),
            'source_archive': str(archive), 'source_archive_sha256': checksum,
            'protocol_sha256': hashlib.sha256(protocol.read_bytes()).hexdigest(),
            'recording': str(self.root), 'inputs': identity,
            'urban_replay': {'output_sha256': 'urban'},
            'rule_replay': {'frames': 1, 'output_sha256': 'rule'},
        }
        return self.write('baseline.json', value), protocol, identity

    def test_replay_requires_rule_and_urban_equality_and_retains_failed_gate(self):
        baseline, protocol, identity = self.baseline()
        with patch.object(experiment, 'PROTOCOL', protocol), \
             patch.object(experiment, 'replay_inputs', return_value=(self.reader, [self.frame], identity)), \
             patch.object(experiment, 'source_manifest', return_value={'current.py': 'sha'}), \
             patch.object(experiment, 'urban_replay', return_value={'output_sha256': 'urban', 'rows': [{}]}), \
             patch('scripts.profile_control_pipeline.run', return_value=({}, 'rule', 1)):
            result = experiment.verify_replay(baseline, self.root / 'passed.json')
            self.assertTrue(result['passed'])
            with patch('scripts.profile_control_pipeline.run', return_value=({}, 'different-rule', 1)):
                with self.assertRaisesRegex(ValueError, 'differ'):
                    experiment.verify_replay(baseline, self.root / 'failed.json')
            self.assertFalse(json.loads((self.root / 'failed.json').read_text())['passed'])
            with patch.object(experiment, 'urban_replay', return_value={'output_sha256': 'changed', 'rows': [{}]}):
                with self.assertRaisesRegex(ValueError, 'differ'):
                    experiment.verify_replay(baseline, self.root / 'urban-failed.json')
            with patch.object(experiment, 'source_manifest', side_effect=[{'first': 'a'}, {'second': 'b'}]):
                with self.assertRaisesRegex(RuntimeError, 'Source or recorded controls changed'):
                    experiment.verify_replay(baseline, self.root / 'race.json')
            self.assertFalse((self.root / 'race.json').exists())

    def test_replay_rejects_protocol_and_input_drift_before_comparing_results(self):
        baseline, protocol, identity = self.baseline()
        with patch.object(experiment, 'PROTOCOL', protocol):
            original = protocol.read_bytes()
            protocol.write_bytes(b'changed')
            with self.assertRaisesRegex(ValueError, 'protocol changed'):
                experiment.verify_replay(baseline, self.root / 'protocol-failed.json')
            protocol.write_bytes(original)
            with patch.object(experiment, 'replay_inputs', return_value=(self.reader, [self.frame], {**identity, 'changed': True})):
                with self.assertRaisesRegex(ValueError, 'input identity changed'):
                    experiment.verify_replay(baseline, self.root / 'input-failed.json')
        self.assertFalse((self.root / 'protocol-failed.json').exists())
        self.assertFalse((self.root / 'input-failed.json').exists())


if __name__ == '__main__':
    unittest.main()
