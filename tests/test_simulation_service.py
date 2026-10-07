import math
import time
import unittest
from backend.simulation_service import SimulationService
from unittest.mock import MagicMock
from tests.core_packets import packet


class ServiceTests(unittest.TestCase):
    def test_controls_expire_and_missing_pedals_release(self):
        service = SimulationService(None)
        service._publish(packet())
        service.set_controls(throttle=.7, steering=-.2)
        at = service.command_at
        self.assertEqual(service.effective_controls(at+.1)["throttle"], .7)
        self.assertEqual(service.effective_controls(at+.4),
                         {"throttle": 0, "brake": 1, "steering": 0, "parkingbrake": 0})
        service.set_paused(False)
        service.set_controls(brake=.4)
        self.assertEqual(service.effective_controls()["throttle"], 0)
        service.release_controls()
        self.assertEqual(service.effective_controls()["brake"], 1)

    def test_invalid_controls_cannot_reach_sdk(self):
        service = SimulationService(None)
        for controls in ({"throttle": float('nan')}, {"steering": 2}, {"brake": -1},
                         {"throttle": True}, {"gear": 1.5}, {"unknown": 0}):
            with self.subTest(controls=controls), self.assertRaises(ValueError):
                service.set_controls(**controls)

    def test_stale_cached_state_is_disconnected(self):
        service = SimulationService(None)
        service._publish(packet())
        service.state_at = time.monotonic()-2
        self.assertFalse(service.snapshot()["connected"])
        service.state_at = time.monotonic()
        self.assertFalse(service.snapshot()["connected"])  # A stale session requires explicit reconnection.

    def test_camera_bytes_and_metadata_are_copied_as_one_frame(self):
        service = SimulationService(None)
        service._publish(packet())
        service.frame = b'jpeg'
        service.frame_metadata = {"sensorTimestamp": 12.5}
        frame, meta = service.get_camera_frame()
        service.frame_metadata["sensorTimestamp"] = 13
        self.assertEqual(frame, b'jpeg')
        self.assertEqual(meta["sensorTimestamp"], 12.5)

    def test_disabled_sensors_do_not_poll_or_create_placeholder_measurements(self):
        service = SimulationService(None)
        self.assertEqual(service.sensor_rates, {})
        self.assertEqual(service.snapshot()["sensors"], {})

    def test_stale_connection_suspends_commands_and_camera_reads(self):
        service = SimulationService(None)
        service._publish(packet())
        service.set_controls(throttle=.7)
        service.state_at = time.monotonic()-2
        with self.assertRaises(RuntimeError):
            service.require_connected()
        self.assertEqual(service.effective_controls()["throttle"], 0)
        service.frame = b'old jpeg'
        with self.assertRaises(RuntimeError):
            service.get_camera_frame()

    def test_worker_steps_before_reading_native_frame_and_rejects_mismatch(self):
        provider = MagicMock()
        provider.name = 'test-fixture'
        provider.get_simulation_frame.return_value = packet(3, .15)
        service = SimulationService(provider)
        service._iteration()
        calls = [call[0] for call in provider.mock_calls]
        self.assertLess(calls.index('step'), calls.index('get_simulation_frame'))
        self.assertTrue(service.snapshot()['connected'])
        provider.get_simulation_frame.return_value = {'frame': 4}
        with self.assertRaisesRegex(RuntimeError, 'one native frame'):
            service._iteration()

    def test_failure_closes_provider_and_clears_observations(self):
        provider = MagicMock(fixed_delta=.05, cleanup_errors=[])
        provider.name = 'test-fixture'
        provider.step.side_effect = RuntimeError('native server disconnected')
        service = SimulationService(provider)
        service._publish(packet())
        service.set_controls(throttle=.8)
        service.start()
        service.thread.join(timeout=2)
        self.assertFalse(service.thread.is_alive())
        self.assertFalse(service.snapshot()['connected'])
        self.assertIsNone(service.snapshot()['vehicle'])
        self.assertIn('server disconnected', service.snapshot()['error'])
        self.assertEqual(service.effective_controls()['throttle'], 0)
        provider.close.assert_called_once()

    def test_close_cleans_provider_even_without_started_worker(self):
        provider = MagicMock(cleanup_errors=[])
        service = SimulationService(provider)
        provider.name = 'test-fixture'
        service._publish(packet())
        service.close()
        provider.close.assert_called_once()
        self.assertFalse(service.snapshot()['connected'])
