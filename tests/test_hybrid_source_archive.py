import hashlib
from pathlib import Path
import tempfile
import unittest
import zipfile
from scripts.validate_hybrid_native import archive_sources


class HybridSourceArchiveTests(unittest.TestCase):
    def test_archive_retains_exact_verified_source_bytes_for_reproduction(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'checkout';source=root/'backend/core/driver.py'
            source.parent.mkdir(parents=True);source.write_bytes(b'# diagnostic revision\n')
            evidence=Path(directory)/'evidence';evidence.mkdir()
            hashes={'backend/core/driver.py':hashlib.sha256(source.read_bytes()).hexdigest()}
            result=archive_sources(evidence,hashes,root)
            self.assertEqual(result['sha256'],hashlib.sha256((evidence/'source.zip').read_bytes()).hexdigest())
            source.write_bytes(b'# later revision\n')
            with zipfile.ZipFile(result['path']) as archive:
                self.assertEqual(archive.read('backend/core/driver.py'),b'# diagnostic revision\n')

    def test_source_change_or_outside_path_cannot_enter_a_frozen_archive(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)/'checkout';root.mkdir();source=root/'driver.py';source.write_bytes(b'changed')
            evidence=Path(directory)/'evidence';evidence.mkdir()
            with self.assertRaisesRegex(RuntimeError,'changed before archival'):
                archive_sources(evidence,{'driver.py':hashlib.sha256(b'previous').hexdigest()},root)
            self.assertFalse((evidence/'source.zip').exists())
            with self.assertRaisesRegex(ValueError,'escaped'):
                archive_sources(evidence,{'../outside.py':'not-read'},root)
