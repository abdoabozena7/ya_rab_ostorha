"""Lifecycle admission and reproducibility regressions for the native demo."""
import unittest
import tempfile
from unittest.mock import Mock
from types import SimpleNamespace
from backend.core.service import SimulationService
from backend.carla.comparison import ComparisonDemo, initial_signature
from backend.core.recording import RunRecorder, BufferedRunRecorder
from backend.core.replay import ReplayReader
from tests.core_packets import packet, metadata


class ComparisonTests(unittest.TestCase):
    def setUp(self):
        self.provider = SimpleNamespace(name='test-fixture', environment_state=lambda: {})
        self.service = SimulationService(self.provider)
        self.service._publish(packet(speed=0))
        self.service.comparison = ComparisonDemo(self.service)
        self.service.active_safety = Mock()
        self.provider.scenarios = Mock()

    def test_dashboard_button_reaches_worker_and_latest_click_wins(self):
        self.service.queue_dashboard_action('comparison', {'mode': 'WITHOUT'})
        self.service.queue_dashboard_action('comparison', {'mode': 'WITH'})
        self.assertEqual(list(self.service.actions), [('comparison', {'mode':'WITH','scenario':'URBAN_CHAOS','seed':2589})])
        self.assertEqual(self.service.dashboard_result['status'], 'PENDING')

    def test_invalid_click_does_not_cancel_queued_reset(self):
        self.service.queue_dashboard_action('comparison', {'mode': 'WITH'})
        with self.assertRaises(ValueError):
            self.service.queue_dashboard_action('comparison', {'mode': 'LEARNED'})
        self.assertEqual(list(self.service.actions), [('comparison', {'mode':'WITH','scenario':'URBAN_CHAOS','seed':2589})])

    def test_configuration_and_speed_cannot_change_during_demo(self):
        self.service.comparison.phase = 'RUNNING'
        with self.assertRaises(ValueError): self.service.queue_dashboard_action('destination', {})
        with self.assertRaises(ValueError): self.service.set_journey_speed(20)
        with self.assertRaises(ValueError): self.service.set_safety_enabled({'enabled': False})

    def test_signature_excludes_ids_and_frame_time_but_includes_actual_pose_and_route(self):
        run = {'initial_states': {'actors': [{'actor_id': 1, 'transform': [1, 2, 3]}],
                                 'weather': {'sun': 70}, 'frame_id': 4, 'timestamp_s': 2},
               'spec': {}, 'map': 'Town10HD_Opt', 'camera': {}, 'fixed_delta_seconds': .05}
        route = {'points': [[1, 2, 3]], 'destination': {'location': [4, 5, 6]}}
        first = initial_signature(run, route, {})[1]
        run['initial_states']['actors'][0]['actor_id'] = 99
        run['initial_states']['frame_id'] = 100
        self.assertEqual(first, initial_signature(run, route, {})[1])
        run['initial_states']['actors'][0]['transform'][0] = 2
        self.assertNotEqual(first, initial_signature(run, route, {})[1])

    def test_buffered_recording_flushes_every_frame_and_replays_in_order(self):
        with tempfile.TemporaryDirectory() as directory:
            recorder = BufferedRunRecorder(RunRecorder(directory, metadata()))
            for i in range(1, 7): recorder.submit(packet(i, i*.05), [])
            recorder.close()
            reader = ReplayReader(recorder.root, allow_test_data=True)
            self.assertEqual([f.frame_id for f in reader.frames()], list(range(1, 7)))

    def test_buffered_disk_failure_is_reported_on_close(self):
        writer = Mock()
        writer.record.side_effect = OSError('disk failure')
        recorder = BufferedRunRecorder(writer)
        recorder.submit(packet(), [])
        with self.assertRaisesRegex(RuntimeError, 'disk failure'): recorder.close()
        writer.close.assert_called_once()

if __name__ == '__main__': unittest.main()
