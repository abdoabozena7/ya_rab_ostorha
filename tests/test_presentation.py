import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

from backend.core.presentation import Presentation
from backend.core.service import SimulationService
from backend.core.control import ControlMode
from tests.core_packets import packet


class PresentationTests(unittest.TestCase):
    def setUp(self):
        self.time = 0.
        self.provider = SimpleNamespace(name='test-fixture', allow_navigation=True,
            stop_navigation=Mock(), prepare_presentation=Mock(return_value={'route_length_m':250}),
            route_state=lambda: {'arrived':False})
        self.service = SimulationService(self.provider, now=lambda:self.time)
        self.service._publish(packet(speed=0))
        self.p = self.service.presentation
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.p.directory = Path(self.temp.name)
        self.service.queue_dashboard_action = Mock()
        self.service.start_journey = Mock()

    def tick(self):
        self.service.observation=packet(self.service.observation.frame_id+10,
            self.service.observation.timestamp_s+.5,speed=0)
        self.service.navigation_transport_heartbeat(self.service.session_id)
        self.p.tick()

    def test_one_restart_sequences_both_recorded_arms_and_waits_for_real_playback(self):
        s = self.service
        self.p.start(50)
        self.tick(); self.tick(); self.tick()
        self.assertEqual(self.p.data['status'], 'STARTING')
        self.assertEqual(s.start_journey.call_args.kwargs['driving_mode'], 'ROBOSPHERE')
        s.journey_comparison.data.update(pair_id='same-pair', runs={})
        s.journey.update(status='RUNNING')
        self.tick()
        s.journey.update(status='ARRIVED', reason='destination_reached')
        self.tick(); self.tick()
        self.assertEqual(self.p.data['status'], 'RESTORING')
        s.queue_dashboard_action.assert_called_once_with('prepare_journey_mode', {'mode':'NORMAL', 'pair_id':'same-pair'})
        s.dashboard_result = {'action':'prepare_journey_mode', 'status':'APPLIED'}
        self.tick(); self.tick()
        self.assertEqual(s.start_journey.call_count, 2)
        self.assertEqual(s.start_journey.call_args.kwargs['pair_id'], 'same-pair')
        self.assertEqual(s.start_journey.call_args.kwargs['driving_mode'], 'NORMAL')
        s.journey.update(status='RUNNING'); self.tick()
        s.journey.update(status='ARRIVED', reason='destination_reached'); self.tick(); self.tick()
        self.assertEqual(self.p.data['status'], 'EXPORTING')
        self.p.video_states = lambda: {m:{'status':'READY'} for m in self.p.MODES}
        self.tick()
        self.assertEqual(self.p.data['status'], 'PLAYBACK')
        self.tick()
        self.assertEqual(self.p.data['status'], 'PLAYBACK')
        with self.assertRaises(ValueError): self.p.playback_finished('old-id')
        self.p.playback_finished(self.p.data['id'])
        self.assertEqual(self.p.data['status'], 'COMPLETE')

    def test_stop_and_emergency_cancel_without_queued_restart(self):
        self.p.start()
        self.service.stop_driving('operator_stop')
        self.tick()
        self.assertEqual(self.p.data['status'], 'CANCELLED')
        self.service.start_journey.assert_not_called()
        self.p.start()
        self.service.emergency_stop()
        self.tick()
        self.assertEqual(self.p.data['reason'], 'emergency_stop')
        with self.assertRaisesRegex(ValueError, 'Release emergency'): self.p.start()
        self.service.acknowledge_stop()
        self.assertEqual(self.service.journey['reason'],'emergency_stop_released')
        self.assertEqual(self.service.arbiter.machine.mode,ControlMode.PAUSED)
        self.service._audit_command(self.service._choose())
        self.assertEqual(self.service.stop_diagnostics['reason'],'emergency_stop_released')
        self.assertEqual(self.service.stop_diagnostics['decision_source'],'VEHICLE_HOLD')

    def test_timeout_preserved_then_requires_twenty_distinct_fresh_frames_before_normal(self):
        s=self.service;self.p.start(seed=320418473)
        self.tick();self.tick();self.tick()
        s.journey_comparison.data.update(pair_id='pair',runs={})
        s.journey.update(status='RUNNING');self.tick()
        s.runtime_fault={'exception_type':'ControlSceneTimeout','message':'original timeout'}
        s.journey.update(status='ERROR',reason='runtime_failure');self.tick();self.tick()
        self.assertEqual(self.p.data['status'],'RESTORING')
        s.dashboard_result={'action':'prepare_journey_mode','status':'APPLIED'};self.tick()
        self.assertEqual(self.p.data['status'],'RECOVERING')
        s.provider.benchmark_fixture=SimpleNamespace(verify=lambda:{'passed':True})
        for i in range(20):
            s.observation=packet(100+i,5+i*.05,speed=0)
            s.clock.frame_id=s.observation.frame_id;s.clock.timestamp_s=s.observation.timestamp_s
            s.control_scene=SimpleNamespace(session_id=s.session_id,observation=s.observation,usable=lambda t,w:True)
            s.navigation_transport_heartbeat(s.session_id);self.p.tick()
            if i<19:self.assertEqual(self.p.data['status'],'RECOVERING')
        self.assertEqual(self.p.data['status'],'READY');self.tick()
        self.assertEqual(s.start_journey.call_args.kwargs['driving_mode'],'NORMAL')
        self.assertEqual(self.p.data['failures'][0]['fault']['message'],'original timeout')
        self.assertEqual(self.p.data['outcome'],'FAILED_ARMS')

    def test_failed_recovery_cannot_start_normal_or_erase_original_fault(self):
        self.p.data={'status':'RECOVERING','id':'p','arm':1,'recovery':{'fresh_frames':0},
            'failures':[{'fault':{'message':'original timeout'}}]}
        self.time=11.;self.service.navigation_transport_heartbeat(self.service.session_id)
        self.p.tick()
        self.assertEqual(self.p.data['status'],'ERROR')
        self.assertEqual(self.p.data['failures'][0]['fault']['message'],'original timeout')
        self.service.start_journey.assert_not_called()

    def test_comparison_storage_failure_stops_automatic_continuation(self):
        self.p.start()
        self.service.journey_comparison.data['storage_error']='disk full'
        self.tick()
        self.assertEqual(self.p.data['status'],'ERROR')
        self.assertEqual(self.p.data['outcome'],'INCOMPLETE')
        self.service.start_journey.assert_not_called()

    def test_initial_arm_waits_for_confirmed_traffic_and_walker_controllers(self):
        population={'route_crowding':{'status':'PARTIAL'},'walker_controllers_ready':False}
        self.provider.population_state=lambda:population
        self.p.start();self.tick();self.tick();self.tick()
        self.assertEqual(self.p.data['status'],'READY')
        self.service.start_journey.assert_not_called()
        population['route_crowding']['status']='READY';self.tick()
        self.service.start_journey.assert_not_called()
        population['walker_controllers_ready']=True;self.tick()
        self.service.start_journey.assert_called_once()

    def test_stop_during_native_preparation_cannot_be_overwritten_by_ready(self):
        self.p.start();self.tick()
        def prepare(*args):
            self.service.stop_driving('operator_stop')
            return {'route_length_m':250}
        self.provider.prepare_presentation.side_effect=prepare
        self.tick();self.tick()
        self.assertEqual(self.p.data['status'],'CANCELLED')
        self.assertEqual(self.p.data['reason'],'operator_stop')
        self.service.start_journey.assert_not_called()

    def test_population_placement_waits_for_new_native_pose_and_rejects_small_setup(self):
        self.provider.prepare_presentation.return_value={'population_pending':True}
        self.provider.finish_presentation_setup=Mock(return_value={'population_pending':False})
        self.provider.presentation_population_audit=Mock(return_value={'passed':False,'counts':{'vehicles':18}})
        self.p.start();self.tick();self.tick()
        self.assertEqual(self.p.data['status'],'PREPARING')
        self.p.tick();self.provider.finish_presentation_setup.assert_not_called()
        self.tick();self.provider.finish_presentation_setup.assert_called_once()
        self.tick()
        self.assertEqual(self.p.data['status'],'ERROR')
        self.assertIn('below required population',self.p.data['reason'])
        self.service.start_journey.assert_not_called()

    def test_route_timeout_keeps_first_fixture_for_the_second_measured_attempt(self):
        fixture=Mock();self.provider.benchmark_fixture=fixture
        self.service.journey.update(status='RUNNING',benchmark=True,driving_mode='ROBOSPHERE',presentation_id='p')
        self.service._stop_navigation('presentation_route_timeout')
        fixture.close.assert_not_called()

    def test_terminal_fixture_failure_does_not_rearm_the_consumed_traffic_hold(self):
        self.provider.benchmark_fixture=Mock()
        self.service.journey.update(status='RUNNING',benchmark=True,driving_mode='ROBOSPHERE',presentation_id='old')
        self.service._stop_navigation('destination_reached',status='ARRIVED')
        self.assertTrue(self.service.presentation_traffic_hold_pending)
        self.service.presentation_traffic_hold_pending=False
        self.p.data={'id':'old','status':'FINALIZING'}
        self.p.fail('The comparison traffic changed')
        self.assertFalse(self.service.presentation_traffic_hold_pending)
        self.assertEqual(self.p.data['status'],'ERROR')
        self.assertEqual(self.service.journey['status'],'ERROR')

    def test_restart_after_a_failed_fixture_can_reach_fresh_setup(self):
        self.provider.benchmark_fixture=Mock()
        self.service.journey.update(status='ERROR',benchmark=True,driving_mode='ROBOSPHERE',presentation_id='old')
        self.p.data={'id':'old','status':'ERROR','reason':'The comparison traffic changed'}
        self.p.start(seed=2086914493)
        self.assertFalse(getattr(self.service,'presentation_traffic_hold_pending',False))
        self.tick();self.tick()
        self.provider.prepare_presentation.assert_called_once_with(2086914493,50.)
        self.assertEqual(self.p.data['status'],'READY')

    def test_lost_connection_and_failed_setup_do_not_retry(self):
        self.p.start(); self.time=3.
        self.p.tick()
        self.assertEqual(self.p.data['status'], 'ERROR')
        self.assertEqual(self.p.data['reason'], 'dashboard_disconnected')
        self.service._publish(packet(2,.1,speed=0))
        self.p.start(); self.tick()
        self.provider.prepare_presentation.side_effect = RuntimeError('original route failure')
        self.tick(); self.tick()
        self.assertEqual(self.p.data['status'], 'ERROR')
        self.assertEqual(self.p.data['reason'], 'original route failure')
        self.provider.prepare_presentation.assert_called_once()

    def test_same_owner_pong_extends_intent_only_not_actuator_commands(self):
        s=self.service
        s.journey.update(status='RUNNING')
        s.navigation_heartbeat_at=0.
        self.time=.4
        self.assertFalse(s._navigation_connection_alive())
        s.navigation_transport_heartbeat('previous-session')
        self.assertFalse(s._navigation_connection_alive())
        s.navigation_transport_heartbeat(s.session_id)
        self.assertTrue(s._navigation_connection_alive())
        self.assertEqual(s.CONTROL_TTL, .35)
        self.assertEqual(s.command_at, 0.)
        self.time=1.401
        self.assertFalse(s._navigation_connection_alive())

    def test_50_is_scoped_to_the_explicit_presentation_not_old_normal(self):
        self.service.start_journey = SimulationService.start_journey.__get__(self.service)
        with self.assertRaisesRegex(ValueError, '5–30'): self.service.start_journey(50, driving_mode='NORMAL')
        with self.assertRaisesRegex(ValueError, 'inactive session'):
            self.service.start_journey(50, driving_mode='NORMAL', presentation_id='forged')

    def test_stream_summary_retains_metrics_and_audit_without_copying_actor_manifest(self):
        from backend.core.journey_comparison import JourneyComparison
        comparison=JourneyComparison(Path(self.temp.name)/'journeys')
        comparison.begin('ROBOSPHERE',{'presentation_id':'p','initial_condition_id':'condition',
            'initial_conditions':{'actors':[{'raw':'retained'}]}})
        full=comparison.snapshot();compact=comparison.snapshot(compact=True)
        self.assertEqual(full['version'],3)
        self.assertNotIn('initial_conditions',compact['manifest'])
        self.assertEqual(compact['runs']['ROBOSPHERE']['setup']['initial_condition_id'],'condition')
        self.assertEqual(compact['runs']['ROBOSPHERE']['collisions'],full['runs']['ROBOSPHERE']['collisions'])
        self.assertIn('initial_conditions',comparison.data['manifest'])
        comparison.data['runs']['ROBOSPHERE']['stop_diagnostics']={'runtime_fault':{
            'exception_type':'ControlSceneTimeout','message':'original timeout','injected_validation_fault':True,
            'sensor_frames':['large raw data']},'reason':'runtime_failure'}
        fault=comparison.snapshot(compact=True)['runs']['ROBOSPHERE']['stop_diagnostics']['runtime_fault']
        self.assertEqual(fault['message'],'original timeout')
        self.assertTrue(fault['injected_validation_fault'])
        self.assertNotIn('sensor_frames',fault)


if __name__ == '__main__': unittest.main()
