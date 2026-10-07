import time
import unittest
from backend.core.service import SimulationService
from tests.core_packets import packet


class ObservationRecoveryTests(unittest.TestCase):
    def test_new_frame_restores_telemetry_but_does_not_resume_driving(self):
        service = SimulationService(None)
        service._publish(packet(1,.05)); service.set_controls(throttle=.5)
        service.state_at = time.monotonic()-2
        self.assertFalse(service.snapshot()['connected'])
        service._publish(packet(2,.1))
        self.assertTrue(service.snapshot()['connected'])
        self.assertEqual(service.snapshot()['mode'],'PAUSED')
        self.assertEqual(service.effective_controls()['throttle'],0)

    def test_duplicate_packet_cannot_reconnect_a_stale_session(self):
        service = SimulationService(None); service._publish(packet(1,.05))
        service.state_at = time.monotonic()-2; service.snapshot()
        service._publish(packet(1,.05))
        self.assertFalse(service.snapshot()['connected'])
