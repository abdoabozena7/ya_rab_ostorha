"""Package/runtime selection tests; no native simulator or wheel code is run."""
import io
from pathlib import Path
import tempfile
import unittest
import zipfile
from scripts.inspect_carla_package import inspect


class PackageTests(unittest.TestCase):
    def package(self, path, filename='carla-0.9.16-cp312-cp312-win_amd64.whl'):
        wheel = io.BytesIO()
        with zipfile.ZipFile(wheel, 'w') as api:
            api.writestr('carla-0.9.16.dist-info/WHEEL', 'Wheel-Version: 1.0\nTag: cp312-cp312-win_amd64\n')
            api.writestr('carla-0.9.16.dist-info/METADATA', 'Name: carla\nVersion: 0.9.16\n')
        with zipfile.ZipFile(path, 'w') as package:
            package.writestr('CarlaUE4.exe', b'fixture, not executable')
            package.writestr('PythonAPI/carla/dist/' + filename, wheel.getvalue())

    def test_actual_zip_layout_wheel_metadata_and_checksum_are_inspected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'CARLA_0.9.16.zip'
            self.package(path)
            result = inspect(path, Path(directory) / 'api')
            self.assertEqual(result['version'], '0.9.16')
            self.assertEqual(result['launchers'], ['CarlaUE4.exe'])
            self.assertEqual(result['windowsWheels'][0]['tags'], ['cp312-cp312-win_amd64'])
            self.assertIn('Version: 0.9.16', result['windowsWheels'][0]['packageMetadata'])
            self.assertEqual(len(result['windowsWheels'][0]['sha256']), 64)
            self.assertTrue((Path(directory) / 'api/carla-0.9.16-cp312-cp312-win_amd64.whl').exists())

    def test_different_release_wheel_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'wrong.zip'
            self.package(path, 'carla-0.10.0-cp312-cp312-win_amd64.whl')
            with self.assertRaisesRegex(RuntimeError, 'No CARLA 0.9.16 Windows wheels'):
                inspect(path)
