import unittest
import importlib.util
import inspect
from unittest.mock import patch, MagicMock
from tempfile import TemporaryDirectory
from pathlib import Path

from backend.beamng_provider import BeamNGProvider, SensorManager, jsonable, normalize_radar, normalize_motion_sensor
from backend.installation import BeamNGBlocker


class FakeArray:
    def tolist(self):
        return [[1.0, 2.0, 3.0], [4.0, 5.0, 6.0]]


class FakeSensor:
    def poll(self):
        return {"time": 12.5, "pointCloud": FakeArray()}


class SensorContractTests(unittest.TestCase):
    def test_numpy_like_point_cloud_can_be_serialized(self):
        self.assertEqual(jsonable(FakeArray())[0], [1.0, 2.0, 3.0])

    def test_sensor_manager_preserves_sensor_timestamp(self):
        manager = SensorManager.__new__(SensorManager)
        manager.sensors = {"lidarRoof": FakeSensor()}
        data = manager.poll("lidarRoof", 12.55)
        self.assertEqual(data["sensorTimestamp"], 12.5)
        self.assertEqual(data["simulationTimeAtPoll"], 12.55)
        self.assertEqual(data["data"]["points"][1], {"x": 4.0, "y": 5.0, "z": 6.0})

    def test_seven_column_radar_keeps_doppler_angles_and_weight(self):
        data = normalize_radar([[18.4, -5, .2, .1, 3, 9, .6]])["returns"][0]
        self.assertEqual(data["relativeVelocityMps"], -5)
        self.assertEqual(data["azimuthRad"], .2)
        self.assertEqual(data["weight"], .6)
        self.assertIsNone(data["objectId"])

    def test_buffered_imu_samples_keep_their_individual_timestamps(self):
        samples = normalize_motion_sensor('imu', {"2": {"time": 1.02, "accRaw": [0, 0, 1]},
                                                   "1": {"time": 1.01, "accRaw": [-4, 0, 0]}})["samples"]
        self.assertEqual([sample["timestamp"] for sample in samples], [1.01, 1.02])
        self.assertEqual(samples[0]["linearAccelerationMps2"], [-4, 0, 0])

    def test_nonfinite_sensor_values_remain_serializable(self):
        self.assertEqual(jsonable([float('nan'), float('inf')]), [None, None])

    @unittest.skipUnless(importlib.util.find_spec('beamngpy'), 'Optional BeamNG environment not installed')
    def test_sensor_arguments_match_installed_sdk_signatures(self):
        import beamngpy.sensors as sdk
        names = ['Camera', 'Lidar', 'Radar', 'AdvancedIMU', 'GPS', 'Ultrasonic', 'PowertrainSensor']
        def constructor(cls):
            signature = inspect.signature(cls)
            def create(*args, **kwargs):
                signature.bind(*args, **kwargs)
                return FakeSensor()
            return create
        substitutes = {name: constructor(getattr(sdk, name)) for name in names}
        with patch.multiple(sdk, **substitutes):
            manager = SensorManager(None, None)
        self.assertEqual(len(manager.sensors), 7)

    @unittest.skipUnless(importlib.util.find_spec('numpy'), 'Optional sensor dependencies not installed')
    def test_full_precision_camera_depth_array_keeps_shape_and_precision(self):
        import numpy as np
        class Camera:
            def poll(self):
                return {'depth': np.array([[.001234, .8]], dtype=np.float32), 'colour': None}
        manager = SensorManager.__new__(SensorManager)
        manager.sensors = {'frontCamera': Camera()}
        manager.last_jpeg=b'old jpeg'
        envelope = manager.poll('frontCamera', 2)
        depth = envelope['data']['depth']
        self.assertEqual((depth['width'], depth['height']), (2, 1))
        self.assertAlmostEqual(depth['values'][0][0], .001234, places=6)
        self.assertFalse(depth['metricCalibrated'])
        self.assertFalse(envelope['frameAvailable'])
        self.assertIsNone(manager.last_jpeg)


@unittest.skipUnless(importlib.util.find_spec('beamngpy'), 'Optional BeamNG environment not installed')
class ProviderStartupTests(unittest.TestCase):
    def fixture(self, home):
        root = Path(home)
        (root / 'Bin64').mkdir()
        (root / 'Bin64/BeamNG.tech.x64.exe').touch()
        (root / 'tech.key').write_text('unit-test fixture; not a license')

    def test_default_preparation_starts_one_vehicle_without_traffic_or_extra_sensors(self):
        with TemporaryDirectory() as home:
            self.fixture(home)
            bng = MagicMock(); bng.tech_enabled = True
            with patch('beamngpy.BeamNGpy', return_value=bng) as sdk, \
                 patch('beamngpy.Scenario') as scenario, patch('beamngpy.Vehicle') as vehicle, \
                 patch('backend.beamng_provider.SensorManager') as sensor_manager:
                provider = BeamNGProvider(home)
                self.assertIn('BeamNG.tech.x64.exe', sdk.call_args.kwargs['binary'])
                self.assertEqual(vehicle.call_count, 1)
                self.assertEqual(scenario.return_value.add_vehicle.call_count, 1)
                bng.traffic.spawn.assert_not_called()
                sensor_manager.assert_not_called()
                self.assertIsNone(provider.sensor_manager)
                provider.close()

    def test_unlicensed_instance_is_rejected_before_scenario_creation(self):
        with TemporaryDirectory() as home:
            self.fixture(home)
            bng = MagicMock(); bng.tech_enabled = False
            with patch('beamngpy.BeamNGpy', return_value=bng), patch('beamngpy.Scenario') as scenario:
                with self.assertRaises(BeamNGBlocker):
                    BeamNGProvider(home)
                scenario.assert_not_called()
                bng.close.assert_called_once()


if __name__ == "__main__":
    unittest.main()
