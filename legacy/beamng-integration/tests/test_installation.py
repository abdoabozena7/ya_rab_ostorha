import tempfile
import unittest
from pathlib import Path
from backend.installation import require_installation, BeamNGBlocker


class InstallationTests(unittest.TestCase):
    def test_drive_binary_and_empty_placeholder_cannot_satisfy_tech_dependency(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'Bin64').mkdir()
            (root / 'Bin64/BeamNG.drive.x64.exe').touch()
            (root / 'tech.key').touch()
            with self.assertRaises(BeamNGBlocker) as error:
                require_installation(root)
            self.assertIn('BeamNG.tech.x64.exe', str(error.exception))
            self.assertIn('nonempty key', str(error.exception))

    def test_presence_check_does_not_claim_license_validity(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / 'Bin64').mkdir()
            (root / 'Bin64/BeamNG.tech.x64.exe').touch()
            (root / 'tech.key').write_text('unit-test fixture; not a license')
            found_root, binary = require_installation(root)
            self.assertEqual(found_root, root.resolve())
            self.assertEqual(binary.name, 'BeamNG.tech.x64.exe')
