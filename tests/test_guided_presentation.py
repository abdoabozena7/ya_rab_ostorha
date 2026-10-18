import copy
import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace as NS
from unittest.mock import Mock
from backend.core.service import SimulationService
from backend.core.journey_comparison import JourneyComparison
from tests.core_packets import packet


class GuidedPresentationTests(unittest.TestCase):
    def setUp(self):
        self.time=0.
        self.provider=NS(name='test-fixture',allow_navigation=True,stop_navigation=Mock(),
            prepare_presentation=Mock(return_value={'route_length_m':250}),route_state=lambda:{'arrived':False})
        self.s=SimulationService(self.provider,now=lambda:self.time);self.s._publish(packet(speed=0))
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.p=self.s.presentation;self.p.directory=Path(self.temp.name)/'presentations'
        self.s.journey_comparison=JourneyComparison(Path(self.temp.name)/'pairs')
        self.s.start_journey=Mock();self.s.queue_dashboard_action=Mock()

    def tick(self):
        self.s.observation=packet(self.s.observation.frame_id+10,self.s.observation.timestamp_s+.5,speed=0)
        self.s.navigation_transport_heartbeat(self.s.session_id);self.p.tick()

    def first(self,mode='NORMAL'):
        self.p.start(seed=123,guided=True,first_mode=mode);self.tick();self.tick();self.tick()
        self.assertEqual(self.s.start_journey.call_args.kwargs['driving_mode'],mode)
        self.s.journey_comparison.begin(mode,{'presentation_id':self.p.data['id'],'guided':True,'presentation_order':self.p.data['modes']})
        self.s.journey.update(status='RUNNING',driving_mode=mode);self.tick()

    def end(self,reason='destination_reached'):
        self.s.journey_comparison.finish(reason)
        self.s.journey.update(status='ARRIVED' if reason=='destination_reached' else 'PAUSED',reason=reason)
        self.tick();self.tick()

    def test_both_orders_wait_for_explicit_next_then_results_ignore_export_failure(self):
        for mode in ('NORMAL','ROBOSPHERE'):
            with self.subTest(mode=mode):
                self.first(mode);self.end()
                self.assertEqual(self.p.data['status'],'AWAITING_NEXT')
                self.s.queue_dashboard_action.assert_not_called()
                before=copy.deepcopy(self.s.journey_comparison.data)
                self.p.request_next(self.p.data['id'],0,'AWAITING_NEXT')
                self.p.request_next(self.p.data['id'],0,'AWAITING_NEXT')
                self.s.queue_dashboard_action.assert_called_once()
                self.s.dashboard_result={'action':'prepare_journey_mode','status':'APPLIED'}
                self.tick();self.tick()
                other='ROBOSPHERE' if mode=='NORMAL' else 'NORMAL'
                self.assertEqual(self.s.start_journey.call_args.kwargs['driving_mode'],other)
                self.assertEqual(before['runs'][mode],self.s.journey_comparison.data['runs'][mode])
                self.s.journey_comparison.begin(other,before['manifest'],pair_id=before['pair_id'])
                self.s.journey.update(status='RUNNING');self.tick();self.end('guided_shortened')
                self.p.video_states=Mock(side_effect=RuntimeError('encoder failed'))
                self.assertEqual(self.p.data['status'],'RESULTS');self.tick();self.p.video_states.assert_not_called()
                self.assertEqual(self.s.journey_comparison.data['runs'][other]['status'],'SHORTENED')
                self.p.finish(self.p.data['id']);self.assertEqual(self.p.data['status'],'COMPLETE')
                self.s.queue_dashboard_action.reset_mock()

    def test_contact_racing_next_keeps_collision_and_single_restore(self):
        self.first();self.s.journey_comparison.collision(NS(other_actor_id=4,timestamp_s=1.,impulse_magnitude_ns=20))
        self.s._stop_navigation('collision');self.p.request_next(self.p.data['id'],0,'DRIVING')
        self.tick();self.assertEqual(self.p.data['status'],'RESTORING')
        self.assertEqual(self.p.data['runs']['NORMAL']['status'],'COLLISION')
        self.assertEqual(self.p.data['runs']['NORMAL']['collisions'],1)
        self.p.request_next(self.p.data['id'],0,'DRIVING');self.s.queue_dashboard_action.assert_called_once()

    def test_early_next_waits_for_actual_stop_and_closed_recording(self):
        self.first();self.p.request_next(self.p.data['id'],0,'DRIVING')
        self.assertEqual(self.s.journey_comparison.data['runs']['NORMAL']['status'],'SHORTENED')
        self.s.last_recording=NS(closed=False)
        self.tick();self.s.queue_dashboard_action.assert_not_called()
        self.s.last_recording=NS(closed=True,status=lambda:{'incomplete':False});self.tick()
        self.assertEqual(self.p.data['status'],'RESTORING')

    def test_free_gpu_cancels_pending_transition_and_late_completion(self):
        self.first();self.p.request_next(self.p.data['id'],0,'DRIVING');self.p.cancel('simulator_shutdown')
        self.s.dashboard_result={'action':'prepare_journey_mode','status':'APPLIED'}
        for _ in range(3):self.tick()
        self.assertEqual(self.p.data['status'],'CANCELLED');self.assertEqual(self.s.start_journey.call_count,1)
        with self.assertRaises(ValueError):self.p.request_next(self.p.data['id'],0,'DRIVING')

    def test_technical_failure_keeps_first_outcome_and_no_automatic_other_arm(self):
        self.first();self.s.runtime_fault={'exception_type':'RuntimeError','message':'camera lost'}
        self.s._stop_navigation('runtime_failure',status='ERROR');self.tick();self.tick()
        self.assertEqual(self.p.data['status'],'AWAITING_NEXT')
        self.assertEqual(self.p.data['runs']['NORMAL']['status'],'ERROR');self.s.queue_dashboard_action.assert_not_called()

    def test_first_choice_is_not_an_input_to_scenario_preparation(self):
        for mode in ('ROBOSPHERE','NORMAL'):
            self.p.start(seed=123,guided=True,first_mode=mode,scene='DENSE_CHAOS');self.tick();self.tick()
            self.provider.prepare_presentation.assert_called_with(123,50.,scene='DENSE_CHAOS',guided=True)
            self.p.cancel('test')

    def test_stale_phase_or_identity_cannot_consume_another_arm(self):
        self.first()
        for identity,arm,phase in (('old',0,'DRIVING'),(self.p.data['id'],1,'DRIVING'),(self.p.data['id'],0,'READY'),(self.p.data['id'],0,'AWAITING_NEXT')):
            with self.assertRaises(ValueError):self.p.request_next(identity,arm,phase)
        self.s.queue_dashboard_action.assert_not_called()

    def test_waiting_for_user_has_no_phase_deadline(self):
        self.first();self.end();self.time=700.;self.tick()
        self.assertEqual(self.p.data['status'],'AWAITING_NEXT')

    def test_old_preparation_cannot_publish_into_new_session(self):
        self.p.start(seed=123,guided=True);self.tick()
        original=self.p.data['id']
        def prepare(*args,**kwargs):
            self.p.cancel('simulator_shutdown')
            self.p.start(seed=456,guided=True)
            return {'population_pending':True,'belongs_to':original}
        self.provider.prepare_presentation.side_effect=prepare
        self.tick()
        self.assertNotEqual(self.p.data['id'],original)
        self.assertEqual(self.p.data['seed'],456);self.assertEqual(self.p.data['status'],'STOPPING')
        self.assertNotIn('setup',self.p.data);self.s.start_journey.assert_not_called()

    def test_old_preparation_error_cannot_fail_new_session(self):
        self.p.start(seed=123,guided=True);self.tick()
        def prepare(*args,**kwargs):
            self.p.cancel('simulator_shutdown');self.p.start(seed=456,guided=True)
            raise RuntimeError('old preparation failed')
        self.provider.prepare_presentation.side_effect=prepare;self.tick()
        self.assertEqual(self.p.data['seed'],456);self.assertEqual(self.p.data['status'],'STOPPING')
        self.assertNotIn('failure',self.p.data)

    def test_preload_is_idempotent_holds_one_scene_and_waits_for_choice(self):
        self.provider.hold_prepared_presentation=Mock(return_value='world-start')
        self.provider.benchmark_fixture=NS(verify=lambda:{'passed':True})
        self.p.preload();identity=self.p.data['id'];seed=self.p.data['seed']
        self.assertEqual(self.p.data['speed_kmh'],80.)
        self.p.preload();self.assertEqual(self.p.data['id'],identity)
        self.tick();self.tick();self.tick()
        self.assertEqual(self.p.data['status'],'CHOOSING')
        self.s.start_journey.assert_not_called()
        self.time=999.;self.tick();self.assertEqual(self.p.data['status'],'CHOOSING')
        self.s._navigation_connection_alive=Mock(return_value=False)
        self.tick();self.assertEqual(self.p.data['status'],'CHOOSING')
        self.s._navigation_connection_alive.return_value=True
        for mode in ('ROBOSPHERE',):
            self.p.choose_preloaded(identity,mode)
            self.assertEqual(self.p.data['seed'],seed)
            self.assertEqual(self.p.data['setup']['route_length_m'],250)
            self.assertEqual(self.p.data['status'],'SELECTING')
            self.assertEqual(list(self.s.actions)[-1],('prepare_guided_vehicle',{'id':identity,'mode':mode}))
        self.s.dashboard_result={'action':'prepare_guided_vehicle','status':'APPLIED'}
        self.tick();self.tick()
        self.assertEqual(self.s.start_journey.call_args.kwargs['driving_mode'],'ROBOSPHERE')
        self.assertEqual(self.provider.prepare_presentation.call_count,1)

    def test_shutdown_cancels_preloaded_selection_and_stale_choice(self):
        self.p.preload();identity=self.p.data['id'];self.p.cancel('simulator_shutdown')
        with self.assertRaises(ValueError):self.p.choose_preloaded(identity,'NORMAL')
        self.s.dashboard_result={'action':'prepare_guided_vehicle','status':'APPLIED'}
        self.tick();self.s.start_journey.assert_not_called()

    def test_retry_before_recording_discards_failed_warm_identity_and_waits_for_choice(self):
        self.p.preload();identity=self.p.data['id']
        self.p.data.update(status='ERROR',failed_phase='SELECTING',prepared_condition_id='failed-fixture',awaiting_choice=False)
        self.p.retry_step(identity)
        self.assertNotIn('prepared_condition_id',self.p.data)
        self.assertTrue(self.p.data['awaiting_choice'])
        self.assertEqual(self.p.data['status'],'STOPPING')

    def test_new_page_replaces_attempt_and_waits_for_recording_close_without_restarting_engine(self):
        self.first();old_id=self.p.data['id'];self.p.data['page_id']='page-first'
        self.s.last_recording=NS(closed=False)
        self.assertTrue(self.p.preload('page-second'))
        self.assertNotEqual(self.p.data['id'],old_id)
        self.assertEqual(self.p.data['page_id'],'page-second')
        self.assertEqual(self.s.journey_comparison.data['runs']['NORMAL']['status'],'INTERRUPTED')
        self.assertEqual(self.s.journey_comparison.data['runs']['NORMAL']['reason'],'page_replaced')
        previous=json.loads((self.p.directory/(old_id+'.json')).read_text())
        self.assertEqual(previous['status'],'CANCELLED');self.assertEqual(previous['replaced_by_page'],'page-second')
        calls=self.provider.prepare_presentation.call_count
        self.tick();self.assertEqual(self.p.data['status'],'STOPPING')
        self.assertEqual(self.provider.prepare_presentation.call_count,calls)
        self.s.last_recording.closed=True;self.tick();self.tick()
        self.assertEqual(self.provider.prepare_presentation.call_count,calls+1)
        self.assertEqual(self.s.start_journey.call_count,1)

    def test_same_page_preload_is_idempotent_but_another_page_requires_a_fresh_identity(self):
        self.p.preload('page-first');identity=self.p.data['id']
        self.assertFalse(self.p.preload('page-first'))
        self.assertFalse(self.p.preload())
        self.assertEqual(self.p.data['id'],identity)
        self.p.data['status']='CHOOSING'
        with self.assertRaisesRegex(ValueError,'fresh start'):
            self.p.choose_preloaded(identity,'NORMAL','page-second')
        self.assertTrue(self.p.preload('page-second'))
        self.assertNotEqual(self.p.data['id'],identity)
        self.p.data['status']='CHOOSING'
        self.p.choose_preloaded(self.p.data['id'],'NORMAL','page-second')
        self.assertEqual(self.p.data['status'],'SELECTING')
