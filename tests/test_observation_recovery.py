import time
import unittest
from backend.core.service import SimulationService
from tests.core_packets import packet


class ObservationRecoveryTests(unittest.TestCase):
    def test_worker_watchdog_ends_journey_without_dashboard_polling(self):
        from backend.core.control import ControlMode
        now=[0.];service=SimulationService(None,now=lambda:now[0]);service._publish(packet())
        service.arbiter.machine.allow_navigation=True
        service.arbiter.machine.transition(ControlMode.AUTOMATIC,connected=True,explicit=True)
        service.journey.update(status='RUNNING',driving_mode='ROBOSPHERE')
        now[0]=1.1;held=service._choose()
        self.assertEqual(held.brake,1.)
        self.assertEqual(service.journey['status'],'ERROR')
        self.assertEqual(service.runtime_fault['exception_type'],'ObservationReceiptTimeout')

    def test_timeout_ends_automatic_journey_and_fresh_frame_keeps_original_failure(self):
        from backend.core.control import ControlMode
        from unittest.mock import Mock
        now=[0.]
        service=SimulationService(None,now=lambda:now[0]);service._publish(packet())
        service.arbiter.machine.allow_navigation=True
        service.arbiter.machine.transition(ControlMode.AUTOMATIC,connected=True,explicit=True)
        service.journey.update(status='RUNNING',driving_mode='ROBOSPHERE')
        service.journey_auto_recording=True
        now[0]=1.1
        snapshot=service.snapshot()
        self.assertEqual(snapshot['journey']['status'],'ERROR')
        self.assertEqual(snapshot['journey']['reason'],'observation_receipt_timeout')
        self.assertEqual(service.runtime_fault['exception_type'],'ObservationReceiptTimeout')
        self.assertEqual(service.last_drive_stop['detail'],'Observation receipt timeout')
        self.assertFalse(service.journey_recording_stop_pending['applied'])
        now[0]=1.2;service._publish(packet(2,.1))
        snapshot=service.snapshot()
        self.assertTrue(snapshot['connected']);self.assertEqual(snapshot['mode'],'PAUSED')
        self.assertEqual(snapshot['journey']['status'],'ERROR')
        self.assertEqual(service.effective_controls()['brake'],1.)
        service.recorder=Mock();service._audit_command(service._choose())
        self.assertEqual(service.stop_diagnostics['reason'],'observation_receipt_timeout')
        self.assertEqual(service.stop_diagnostics['decision_source'],'COMMUNICATION_FAILURE')
        self.assertTrue(service.journey_recording_stop_pending['applied'])

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
