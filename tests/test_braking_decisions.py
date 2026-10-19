"""Command, observer and terminal-recording regressions; no simulated physics."""
from dataclasses import replace
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
import numpy as np

from backend.core.active_safety import ActiveSafetySupervisor
from backend.core.contracts import CommandSource, to_dict
from backend.core.control import ControlMode
from backend.core.journey_comparison import JourneyComparison
from backend.core.recording import BufferedRunRecorder, RunRecorder
from backend.core.service import SimulationService
from tests.core_packets import packet, metadata
from tests.test_active_safety import scene
from tests.test_safety_teacher import case


def fixture(*, driving_mode='NORMAL', automatic=False, obstacle=False):
    now = [0.]
    observation, base = case(distance=1. if obstacle else None, speed=2.)
    observation, reader = scene(observation, clear=True)
    base = replace(base, source=CommandSource.NAVIGATION if automatic else CommandSource.MANUAL)
    provider = SimpleNamespace(name='test-fixture', allow_navigation=True,
        get_sensor_asset=reader, stop_navigation=Mock(),
        navigation_command=Mock(return_value=base), navigation_done=lambda: False,
        route_state=lambda: {'arrived':False}, apply_control=Mock(),
        apply_control_confirmed=Mock(), step=Mock(),
        get_simulation_frame=lambda: packet(2, .1, speed=2.))
    service = SimulationService(provider, now=lambda:now[0])
    service._publish(packet(speed=2.))
    service.clock.observe(service.observation.world)
    service.policy_history.frames.append(observation)
    service.active_safety = ActiveSafetySupervisor()
    service.manual_driving_mode = driving_mode
    if automatic:
        service.arbiter.machine.transition(ControlMode.AUTOMATIC, connected=True, explicit=True)
        service.journey.update(status='RUNNING', driving_mode=driving_mode)
        service.navigation_heartbeat_at = now[0]
    else:
        service.submit_control(base)
    return service, now, base


class BrakingDecisionTests(unittest.TestCase):
    def test_late_complete_automatic_frame_only_admits_full_hold_then_a_new_frame(self):
        service,now,base=fixture(driving_mode='ROBOSPHERE',automatic=True)
        now[0]=.343
        service.navigation_heartbeat_at=now[0];service._navigation_step()
        service._active_safety_step()
        self.assertEqual(service._choose().brake,1.)
        self.assertEqual(service.journey['status'],'RUNNING')
        self.assertEqual(service.active_safety.status['status'],'SENSOR_DELAY_HOLD')
        self.assertEqual(service.safety_fault['stage'],'observation_freshness')
        self.assertEqual(service.safety_fault['sensor_frame']['frame_id'],1)
        service.stop_driving('operator_stop')
        now[0]+=.05
        service._publish(packet(2,.1,speed=2.))
        service._active_safety_step()
        self.assertEqual(service.arbiter.machine.mode,ControlMode.PAUSED)
        self.assertEqual(service._choose().brake,1.)
        self.assertEqual(service.last_drive_stop['reason'],'operator_stop')

    def test_missing_or_simulation_stale_observation_does_not_enter_automatic_recovery(self):
        for invalid in ('missing','simulation_age'):
            with self.subTest(invalid=invalid):
                service,now,base=fixture(driving_mode='ROBOSPHERE',automatic=True)
                now[0]=.343;service.navigation_heartbeat_at=now[0]
                service._navigation_step()
                if invalid=='missing':service.policy_history.clear()
                else:service.clock.timestamp_s=.3
                service._active_safety_step()
                self.assertEqual(service.arbiter.machine.mode,ControlMode.PAUSED)
                self.assertEqual(service.journey['status'],'ERROR')
                self.assertIsNone(service.safety_command)

    def test_navigation_final_stop_is_audited_as_the_current_driver_command(self):
        service,_,base=fixture(driving_mode='NORMAL',automatic=True)
        service.provider.navigation_done=lambda:True
        service._navigation_step()
        applied=service._choose();service._audit_command(applied)
        self.assertEqual(service.stop_diagnostics['base_command'],to_dict(applied))
        self.assertEqual(applied.brake,1.)
        self.assertEqual(applied.source,CommandSource.NAVIGATION)

    def test_transient_processing_delay_requires_fresh_frames_and_releases_smoothly(self):
        service, now, base = fixture(driving_mode='ROBOSPHERE', automatic=True)
        service._navigation_step()
        def delayed(*args, **kwargs):
            now[0] += .26
            return None
        with patch.object(service.active_safety, 'evaluate', side_effect=delayed):
            service._active_safety_step()
        self.assertEqual(service._choose().brake, 1.)
        self.assertEqual(service.journey['status'], 'RUNNING')
        self.assertEqual(service.safety_command.throttle, 0.)
        self.assertEqual(service.active_safety.brake,0.)
        self.assertIsNone(service.active_safety.started_s)
        brakes=[]
        for frame in range(2,15):
            now[0] += .05
            service._publish(packet(frame,frame*.05,speed=2.))
            service.clock.observe(service.observation.world)
            observation, _ = case(frame,distance=None,speed=2.)
            observation, reader = scene(observation,clear=True)
            service.policy_history.frames.append(observation)
            service.provider.get_sensor_asset=reader
            service.provider.navigation_command.return_value=replace(base,frame_id=frame,timestamp_s=frame*.05)
            service.navigation_heartbeat_at=now[0]
            service._navigation_step();service._active_safety_step()
            selected=service._choose();brakes.append(selected.brake)
            self.assertEqual(service.journey['status'],'RUNNING')
        self.assertEqual(brakes,sorted(brakes,reverse=True))
        self.assertEqual(brakes[-1],0.)
        self.assertIsNone(service.safety_processing_wait_at)
        self.assertIsNone(service.last_drive_stop)
        self.assertIsNone(service.safety_fault)
        self.assertNotEqual(service.active_safety.snapshot().get('decision_source'),'SENSOR_FRESHNESS')

    def test_repeated_processing_delays_are_terminal_and_focus_loss_keeps_original_cause(self):
        service,now,base=fixture(driving_mode='ROBOSPHERE',automatic=True)
        for frame in range(1,7):
            now[0] += .03
            service._publish(packet(frame,frame*.05,speed=2.))
            if frame>1:service.clock.observe(service.observation.world)
            observation,_=case(frame,distance=None,speed=2.)
            service.policy_history.frames.append(observation)
            service.provider.navigation_command.return_value=replace(base,frame_id=frame,timestamp_s=frame*.05)
            service.navigation_heartbeat_at=now[0]
            service._navigation_step()
            def delayed(*args,**kwargs):now[0]+=.26;return None
            with patch.object(service.active_safety,'evaluate',side_effect=delayed):service._active_safety_step()
            if service.arbiter.machine.mode==ControlMode.PAUSED:break
        self.assertEqual(service.arbiter.machine.mode,ControlMode.PAUSED)
        self.assertEqual(service.journey['status'],'ERROR')
        original=dict(service.last_drive_stop)
        service.stop_driving('focus_lost')
        self.assertEqual(service.last_drive_stop,original)
        self.assertIn('processing exceeded',original['detail'])
        self.assertEqual(service._choose().brake,1.)

    def test_fresh_obstacle_still_brakes_after_an_expired_proposal(self):
        service,now,base=fixture(driving_mode='ROBOSPHERE',automatic=True)
        service._navigation_step()
        def delayed(*args,**kwargs):now[0]+=.26;return None
        with patch.object(service.active_safety,'evaluate',side_effect=delayed):service._active_safety_step()
        self.assertEqual(service._choose().brake,1.)
        now[0]+=.05
        service._publish(packet(2,.1,speed=2.));service.clock.observe(service.observation.world)
        observation,_=case(2,distance=1.,speed=2.)
        observation,reader=scene(observation,clear=True)
        service.policy_history.frames.append(observation);service.provider.get_sensor_asset=reader
        service.provider.navigation_command.return_value=replace(base,frame_id=2,timestamp_s=.1)
        service.navigation_heartbeat_at=now[0]
        service._navigation_step();service._active_safety_step()
        self.assertEqual(service._choose().brake,1.)
        self.assertEqual(service._choose().throttle,0.)
        self.assertEqual(service.journey['status'],'RUNNING')

    def test_empty_straight_curve_and_parallel_surface_preserve_both_mode_commands(self):
        for mode in ('NORMAL', 'ROBOSPHERE'):
            for situation in ('straight', 'curve', 'parallel'):
                with self.subTest(mode=mode, situation=situation):
                    service, _, base = fixture(driving_mode=mode, automatic=True)
                    if situation == 'curve':
                        base = replace(base, steering=.35)
                        service.provider.navigation_command.return_value = base
                        # A turn sweeps the rear corners outside the current
                        # body too; the recorded point fixture covers that road.
                        distance = np.arange(-5., 40., .25)
                        curvature = np.tan(.35*.6)/2.8
                        yaw = distance*curvature
                        x, y = np.sin(yaw)/curvature, (1-np.cos(yaw))/curvature
                        cloud = np.asarray([[xx-offset*np.sin(angle), yy+offset*np.cos(angle), -1.9, .5]
                            for xx, yy, angle in zip(x, y, yaw) for offset in np.arange(-2., 2.01, .25)], '<f4')
                        service.provider.get_sensor_asset = lambda _:cloud.tobytes()
                    elif situation == 'parallel':
                        road = np.frombuffer(service.provider.get_sensor_asset(None), '<f4').reshape(-1, 4)
                        body = np.asarray([[8.+dx, 3.+dy, -.9, .5]
                            for dx in (-.4, 0., .4) for dy in (-.3, 0., .3)], '<f4')
                        encoded = np.vstack((road, body)).astype('<f4').tobytes()
                        service.provider.get_sensor_asset = lambda _:encoded
                    service._iteration()
                    self.assertEqual(service.provider.apply_control.call_args.args[0], base)
                    self.assertEqual(service.stop_diagnostics['base_command'], to_dict(base))
                    self.assertEqual(service.stop_diagnostics['applied_command'], to_dict(base))
                    self.assertIsNone(service.journey_observer['measured_range_m'])
                    self.assertIsNone(service.journey_observer['path_conflict'])

    def test_normal_automatic_brakes_for_hazards_while_manual_retains_driver_control(self):
        for automatic in (False, True):
            with self.subTest(automatic=automatic):
                service, _, base = fixture(automatic=automatic, obstacle=True)
                service._iteration()
                applied = (service.provider.apply_control_confirmed if automatic else service.provider.apply_control).call_args.args[0]
                if automatic:
                    self.assertEqual((applied.throttle,applied.brake),(0.,1.))
                    self.assertIsNotNone(service.safety_command)
                    self.assertFalse(service.active_safety.anticipation_enabled)
                    self.assertEqual(service.stop_diagnostics['decision_source'],'REACTIVE_SENSORS')
                else:
                    self.assertEqual(applied,base)
                    self.assertIsNone(service.safety_command)
                self.assertTrue(service.journey_observer['active'])
                self.assertEqual(service.stop_diagnostics['base_command'], to_dict(base))
                self.assertEqual(service.stop_diagnostics['applied_command'], to_dict(applied))

    def test_normal_skips_maneuver_and_rear_acceleration_overlays(self):
        service, _, base = fixture(automatic=True)
        service.provider.navigation_planner = Mock(lateral_deadline=-1.)
        service.active_safety.status.update(frame_id=1, timestamp_s=.05,
            risk='FORWARD_CLEAR_SIDE_REAR_UNVERIFIED', measured_range_m=None,
            observed_road_range_m=40., side_rear_observations=[{
                'relation':'REAR_APPROACH', 'matched_frames':8, 'time_to_conflict_s':1.}])
        service._navigation_step()
        self.assertEqual(service._choose(), base)
        service.provider.navigation_planner.evaluate.assert_not_called()
        self.assertFalse(service.rear_assist)

    def test_normal_automatic_sensor_fault_stops_and_manual_observer_fault_retains_control(self):
        for automatic in (False, True):
            with self.subTest(automatic=automatic):
                service, _, base = fixture(automatic=automatic)
                with patch.object(service.active_safety, 'evaluate', side_effect=ValueError('corrupt depth asset')):
                    service._iteration()
                applied=service.provider.apply_control.call_args.args[0]
                self.assertEqual(applied.brake,1.) if automatic else self.assertEqual(applied,base)
                self.assertEqual(service.arbiter.machine.mode, ControlMode.PAUSED if automatic else ControlMode.MANUAL)
                self.assertEqual(service.safety_fault['stage'], 'supervisor_evaluation')
                self.assertEqual(service.safety_fault['message'], 'corrupt depth asset')
                self.assertEqual(service.safety_fault['observer_only'],not automatic)
                self.assertEqual(service.active_safety.status['status'], 'SENSOR_FAULT_STOP' if automatic else 'OBSERVER_FAULT')
                if not automatic:self.assertIsNone(service.active_safety.last_fault)

    def test_operator_stop_emergency_lock_and_communication_timeout_still_apply_in_normal(self):
        for automatic in (False, True):
            with self.subTest(automatic=automatic):
                service, _, _ = fixture(automatic=automatic)
                service.stop_driving()
                self.assertEqual(service._choose().brake, 1.)
                self.assertEqual(service.arbiter.machine.mode, ControlMode.PAUSED)
                service.arbiter.machine.transition(ControlMode.MANUAL, connected=True, explicit=True)
                service.emergency_stop()
                self.assertEqual(service._choose().brake, 1.)
                with self.assertRaises(RuntimeError):
                    service.submit_control(replace(case()[1], source=CommandSource.MANUAL))
                service.acknowledge_stop()
                self.assertEqual(service.arbiter.machine.mode, ControlMode.PAUSED)
                self.assertEqual(service._choose().brake, 1.)
                service, now, _ = fixture(automatic=automatic)
                now[0] = .351
                if automatic:
                    service._navigation_step()
                self.assertEqual(service._choose().brake, 1.)
                self.assertEqual(service.arbiter.machine.mode, ControlMode.PAUSED)
                with patch.object(service, '_live', return_value=False):
                    self.assertEqual(service._choose().brake, 1.)

    def test_protected_fault_saves_exception_frame_base_and_actual_stop_before_writer_is_sealed(self):
        with tempfile.TemporaryDirectory() as directory:
            service, _, base = fixture(driving_mode='ROBOSPHERE', automatic=True)
            service.journey_comparison = JourneyComparison(Path(directory)/'comparison')
            recorder = BufferedRunRecorder(RunRecorder(directory, metadata()))
            recorder.submit(service.observation, [])
            service.recorder = service.last_recording = recorder
            service.journey_auto_recording = True
            service.journey_comparison.begin('ROBOSPHERE', {'route_length_m':100.}, recording=str(recorder.root))
            applications = []
            service.provider.apply_control.side_effect = lambda command: applications.append(command)
            try:
                with patch.object(service.active_safety, 'evaluate', side_effect=ValueError('corrupt depth asset')):
                    service._iteration()
                self.assertEqual(applications[-1].brake, 1.)
                self.assertEqual(service.arbiter.machine.mode, ControlMode.PAUSED)
                self.assertIsNone(service.recorder)
                recorder.close()
                decisions = [json.loads(row) for row in (recorder.root/'telemetry/safety-v2.jsonl').read_text().splitlines()]
                terminal = decisions[-1]
                self.assertEqual(terminal['applied_command'], to_dict(applications[-1]))
                self.assertEqual(terminal['base_command'], to_dict(base))
                fault = terminal['safety_fault']
                self.assertEqual(fault['exception_type'], 'ValueError')
                self.assertEqual(fault['stage'], 'supervisor_evaluation')
                self.assertEqual(fault['sensor_frame']['frame_id'], 1)
                self.assertIn('corrupt depth asset', fault['traceback'])
                self.assertEqual(terminal['decision_source'], 'SENSOR_FAILURE')
                self.assertEqual(terminal['reason'], 'corrupt depth asset')
                frames = [json.loads(row) for row in (recorder.root/'telemetry/frames.jsonl').read_text().splitlines()]
                self.assertEqual(frames[-1]['control']['brake'], 1.)
                result = json.loads((Path(directory)/'comparison/latest.json').read_text())
                self.assertEqual(result['runs']['ROBOSPHERE']['stop_diagnostics'], terminal)
                self.assertEqual(result['runs']['ROBOSPHERE']['status'], 'ERROR')
                events = [json.loads(row) for row in (recorder.root/'events/events.jsonl').read_text().splitlines()]
                self.assertTrue(any(e['payload'].get('safety_fault', {}).get('message') == 'corrupt depth asset' for e in events))
                self.assertFalse(recorder.status()['incomplete'])
            finally:
                if not recorder.closed:
                    recorder.close()

    def test_worker_failure_keeps_original_trace_and_terminal_command_through_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            service, _, base = fixture(driving_mode='ROBOSPHERE', automatic=True)
            service.base_driver_command = base
            service.provider.is_connected = lambda:True
            service.provider.close = Mock()
            service._iteration = Mock(side_effect=ValueError('invalid synchronized frame'))
            service.journey_comparison = JourneyComparison(Path(directory)/'comparison')
            recorder = BufferedRunRecorder(RunRecorder(directory, metadata()))
            recorder.submit(service.observation, [])
            service.recorder = service.last_recording = recorder
            service.journey_auto_recording = True
            service.journey_comparison.begin('ROBOSPHERE', {'route_length_m':100.}, recording=str(recorder.root))
            service._run()
            recorder.close()
            terminal = json.loads((recorder.root/'telemetry/safety-v2.jsonl').read_text().splitlines()[-1])
            self.assertEqual(terminal['decision_source'], 'RUNTIME_FAILURE')
            self.assertEqual(terminal['reason'], 'invalid synchronized frame')
            self.assertEqual(terminal['runtime_fault']['exception_type'], 'ValueError')
            self.assertIn('invalid synchronized frame', terminal['runtime_fault']['traceback'])
            self.assertEqual(terminal['applied_command']['brake'], 1.)
            self.assertEqual(terminal['applied_command'], to_dict(service.provider.apply_control.call_args.args[0]))
            self.assertFalse(recorder.status()['incomplete'])
            result = json.loads((Path(directory)/'comparison/latest.json').read_text())
            self.assertEqual(result['runs']['ROBOSPHERE']['status'], 'ERROR')
            self.assertEqual(result['runs']['ROBOSPHERE']['stop_diagnostics'], terminal)


if __name__ == '__main__':
    unittest.main()
