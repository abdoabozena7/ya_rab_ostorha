"""Offline launch and lifecycle checks. Never starts CARLA or spends live budget."""
import io
import tempfile
import threading
import unittest
from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, MagicMock, patch
from backend.carla.comparison_v2 import ComparisonV2
from backend.core.service import SimulationService
from backend.learning.experiment_budget import ExperimentBudget
from scripts.final_runtime import verify_dashboard
from backend.learning.native_validation_budget import NativeValidationBudget
from tests.core_packets import packet


class DemoIntegrationTests(unittest.TestCase):
    def test_recording_audit_allows_only_verified_rule_arrival_hold_without_policy_proposal(self):
        from scripts.native.audit_rule_integration import command_audit
        applied={'frame_id':10,'throttle':0.,'brake':1.}
        trace={'frame_id':11,'applied_command':applied,'pre_protection_command':None,
            'safety':{'status':'STANDBY','active':False}}
        diagnostic={'evaluation_frame':10,'applied_command':applied,'reason':'paused','decision_source':'EMERGENCY_PROTECTION'}
        result={'side':'RULE','status':'ARRIVED','destination_arrived':True}
        self.assertEqual(command_audit([trace],[diagnostic],result),(True,1))
        for invalid in ({**result,'status':'FAILURE'},{**result,'side':'MODEL'},{**result,'destination_arrived':False}):
            self.assertFalse(command_audit([trace],[diagnostic],invalid)[0])
        self.assertFalse(command_audit([trace,trace],[diagnostic],result)[0])
        self.assertFalse(command_audit([trace],[{**diagnostic,'evaluation_frame':11}],result)[0])
        self.assertFalse(command_audit([trace],[{**diagnostic,'decision_source':'SENSOR_FAILURE'}],result)[0])

    def test_slow_dashboard_registry_does_not_hold_control_or_heartbeat_lock(self):
        entered=threading.Event(); release=threading.Event(); returned=[]
        provider=SimpleNamespace(name='test-fixture')
        def slow_registry():
            entered.set(); release.wait(2); return {'imu':{'latestFrame':1}}
        provider.sensor_registry=slow_registry
        service=SimulationService(provider); service._publish(packet(speed=0))
        reader=threading.Thread(target=lambda:returned.append(service.snapshot()))
        reader.start()
        try:
            self.assertTrue(entered.wait(1))
            acquired=service.lock.acquire(timeout=.1)
            self.assertTrue(acquired,'Display serialization blocked the control worker')
            if acquired: service.lock.release()
            # Admission must not invoke a second slow registry serialization.
            service.require_connected()
        finally:
            release.set();reader.join(2)
        self.assertEqual(returned[0]['sensorRegistry']['imu']['latestFrame'],1)
        self.assertEqual(returned[0]['vehicle']['frame'],1)

    def test_hybrid_navigation_brake_reports_its_original_behavior_cause(self):
        from backend.core.contracts import CommandSource
        from backend.core.control import ControlMode
        from tests.core_packets import command
        provider=SimpleNamespace(name='test-fixture',navigation_stop_reason=None,allow_navigation=True)
        service=SimulationService(provider,now=lambda:100.)
        service._publish(packet(speed=0))
        service.arbiter.machine.transition(ControlMode.AUTOMATIC,connected=True,explicit=True)
        service.journey.update(driving_mode='HYBRID',status='RUNNING')
        service.maneuver_status={'decision_id':'behavior-12','action':'HOLD','reason':'NO_VERIFIED_SAFE_ACTION'}
        applied=replace(command(),source=CommandSource.NAVIGATION,throttle=0.,brake=1.)
        service.arbiter.submit(applied,frame_id=applied.frame_id,timestamp_s=applied.timestamp_s,connected=True)
        service.arbiter.choose(frame_id=applied.frame_id,timestamp_s=applied.timestamp_s,connected=True)
        service._audit_command(applied)
        self.assertEqual(service.stop_diagnostics['decision_source'],'HYBRID')
        self.assertEqual(service.stop_diagnostics['reason'],'NO_VERIFIED_SAFE_ACTION')
        self.assertEqual(service.stop_diagnostics['behavior_decision']['decision_id'],'behavior-12')
        provider.navigation_stop_reason='Red traffic light on the planned route'
        service._audit_command(applied)
        self.assertEqual(service.stop_diagnostics['decision_source'],'NAVIGATION')
        self.assertEqual(service.stop_diagnostics['reason'],provider.navigation_stop_reason)

    def test_canonical_display_serialization_leaves_the_tick_and_control_lock(self):
        from backend.core.dashboard import dashboard_frame
        from backend.core.contracts import to_dict
        entered=threading.Event();release=threading.Event();returned=[]
        frame=packet(speed=0)
        provider=SimpleNamespace(name='test-fixture')
        service=SimulationService(provider)
        def display(observation,*,rich=True):
            if rich:entered.set();release.wait(2)
            return dashboard_frame(observation,rich=rich)
        with patch('backend.core.service.dashboard_frame',side_effect=display):
            service._publish(frame)
            self.assertFalse(entered.is_set(),'Control publication serialized the canonical display')
            reader=threading.Thread(target=lambda:returned.append(service.snapshot()));reader.start()
            try:
                self.assertTrue(entered.wait(1))
                acquired=service.lock.acquire(timeout=.1)
                self.assertTrue(acquired,'Canonical display blocked control admission')
                if acquired:service.lock.release()
                service.require_connected()
            finally:release.set();reader.join(2)
        self.assertEqual(returned[0]['canonical'],to_dict(frame))
        self.assertEqual(returned[0]['sensors'],dashboard_frame(frame)['sensors'])

    def test_sensor_registry_serialization_does_not_hold_callback_lock(self):
        from backend.carla.sensors import CarlaSensorManager
        from backend.core.contracts import to_dict
        manager=CarlaSensorManager(None,None)
        manager.configurations={'imu':{'actorId':3}}
        manager.frames={'imu':{'frame':12,'timestamp':.6,'data':{'value':1}}}
        entered=threading.Event();release=threading.Event();returned=[]
        def slow_conversion(data):
            entered.set();release.wait(2);return to_dict(data)
        with patch('backend.core.contracts.to_dict',side_effect=slow_conversion):
            reader=threading.Thread(target=lambda:returned.append(manager.registry()));reader.start()
            try:
                self.assertTrue(entered.wait(1))
                acquired=manager.lock.acquire(timeout=.1)
                self.assertTrue(acquired,'Display serialization blocked sensor callbacks')
                if acquired:
                    manager.frames['imu']={'frame':13,'timestamp':.65,'data':{'value':2}}
                    manager.lock.release()
            finally:release.set();reader.join(2)
        self.assertEqual(returned[0]['imu']['latestFrame'],12)
        self.assertEqual(returned[0]['imu']['latestValidData'],{'value':1})

    def test_urban_population_display_uses_cached_native_counts_without_actor_queries(self):
        from backend.carla.provider import CarlaProvider
        provider=CarlaProvider()
        provider.population=SimpleNamespace(get_population_state=lambda:{'actual':{},'requested':{}})
        provider.scenarios=SimpleNamespace(urban=SimpleNamespace(controllers={}),actors={'lead':10,'walker':11},
            spec=SimpleNamespace(metadata={'vehicle_plans':{'lead':{}}},random_seed=2811))
        provider.last_actor_ids={10,11};provider.local_population_counts={'vehicles_120m':1,'walkers_120m':0}
        provider.ego=Mock();provider.ego.actor.get_location.side_effect=AssertionError('Display queried native actor')
        state=provider.population_state()
        self.assertEqual(state['actual']['vehicles'],1)
        self.assertEqual(state['actual']['pedestrians'],1)
        self.assertEqual(state['local_counts'],{'vehicles_120m':1,'walkers_120m':0})
        provider.ego.actor.get_location.assert_not_called()

    def test_true_stale_sensor_receipt_still_stops_and_requires_explicit_resume(self):
        from backend.core.active_safety import ActiveSafetySupervisor
        from backend.core.control import ControlMode
        from tests.test_safety_teacher import case
        from tests.core_packets import command
        now=[0.];provider=SimpleNamespace(name='test-fixture',stop_navigation=lambda:None)
        service=SimulationService(provider,now=lambda:now[0]);service._publish(packet())
        service.active_safety=ActiveSafetySupervisor();observation,_=case()
        service.policy_history.frames.append(observation)
        service.arbiter.submit(command(),frame_id=1,timestamp_s=.05,connected=True)
        service.safety_observed_at=0.;now[0]=.251
        service._active_safety_step()
        self.assertEqual(service.arbiter.machine.mode,ControlMode.PAUSED)
        self.assertEqual(service.active_safety.last_fault,'Fresh complete safety observations unavailable')
        self.assertEqual(service._choose().brake,1.)
        now[0]=.252;service.safety_observed_at=now[0];service._active_safety_step()
        self.assertEqual(service.arbiter.machine.mode,ControlMode.PAUSED)
        self.assertEqual(service.active_safety.config.maximum_sensor_wall_age_s,.25)

    def test_sensor_and_model_faults_are_terminal_failures_even_when_stop_preempts_after_tick(self):
        for reason in ('ya_rab_ostorha_sensor_fault','ya_rab_ostorha_model_failure','dashboard_heartbeat_timeout'):
            with self.subTest(reason=reason),tempfile.TemporaryDirectory() as directory:
                service,manager=self.manager(directory)
                service.provider=Mock();service.provider.scenarios.run={}
                service.provider.scenarios.collect_outcome.return_value={'metrics':{'collision_count':0}}
                service.active_safety=SimpleNamespace(last_fault='Fresh complete safety observations unavailable',snapshot=lambda:{})
                manager.pair={'pair_id':'failure','seed':2811};manager.side='RULE';manager.phase='RUNNING'
                manager.attempt={'attempt_id':'fault','side':'RULE','phase':'RUNNING'}
                with patch('backend.carla.comparison_v2.DIRECTORY',Path(directory)),patch.object(service,'_live',return_value=False):manager.finish(reason)
                self.assertEqual(manager.latest['status'],'FAILURE')
                self.assertEqual(manager.latest['reason'],reason)
                self.assertTrue(manager.latest['completed'])
                self.assertIn('Fresh complete',manager.latest['failure_reason'])
                self.assertEqual(manager.results['RULE']['status'],'FAILURE')
                # Old v2 files retain their original bytes; their live summary
                # must still classify a known sensor fault as failure.
                manager.latest.update(status='INTERRUPTED',completed=False)
                self.assertEqual(manager.snapshot()['latest_attempt']['status'],'FAILURE')

    def test_validation_watchdog_rechecks_absolute_expiry_after_host_clock_jump(self):
        with tempfile.TemporaryDirectory() as directory:
            ticket=NativeValidationBudget.create(directory,600)
            clock=[ticket.ticket['started_at']]; waits=[]
            budget=NativeValidationBudget(ticket.path,now=lambda:clock[0])
            def host_suspended(seconds):
                waits.append(seconds);clock[0]+=18000
            budget.wait_for_expiry(wait=host_suspended)
            self.assertEqual(waits,[1.])
            self.assertEqual(budget.status()['remaining_s'],0)

    def test_separate_validation_expires_and_rejects_model_without_research_reservation(self):
        with tempfile.TemporaryDirectory() as directory:
            validation=NativeValidationBudget.create(Path(directory)/'validation',1200)
            service,manager=self.manager(directory)
            manager.validation_budget=validation; manager.experiment_budget=validation
            self.assertEqual(manager.snapshot()['budget']['scope'],'NATIVE_RULE_VALIDATION')
            self.assertFalse(manager.snapshot()['model_available'])
            with self.assertRaisesRegex(ValueError,'RULE only'):
                manager.request({'operation':'RUN','side':'MODEL'})
            manager.request({'operation':'RUN','side':'RULE'})
            manager.request_stop('operator_stop');manager.execute({'operation':'RUN','side':'RULE'})
            self.assertEqual(ExperimentBudget(Path(directory)/'budget.sqlite').status()['charged_s'],0)
            expired=NativeValidationBudget(validation.path,now=lambda:validation.ticket['expires_at']+1)
            self.assertEqual(expired.status()['remaining_s'],0)
            with self.assertRaises(ValueError):expired.reserve('comparison_v2_run',1)
            with self.assertRaises(ValueError):NativeValidationBudget.create(Path(directory),1201)

    def manager(self, directory):
        service=SimulationService(None); service._publish(packet(speed=0))
        with patch('backend.carla.comparison_v2.DIRECTORY',Path(directory)), patch(
                'backend.learning.experiment_budget.ExperimentBudget',return_value=ExperimentBudget(Path(directory)/'budget.sqlite')):
            manager=ComparisonV2(service)
        service.comparison_v2=manager
        return service,manager

    def test_stop_and_reset_cancel_queued_start_without_native_setup(self):
        for reset in (False,True):
            with self.subTest(reset=reset),tempfile.TemporaryDirectory() as directory:
                service,manager=self.manager(directory)
                manager.request({'operation':'RUN','side':'RULE'})
                if reset: service.reset_vehicle()
                else: service.stop_driving()
                with patch('backend.carla.comparison_v2.ComparisonDemo.execute') as native:
                    manager.execute({'operation':'RUN','side':'RULE'})
                    native.assert_not_called()
                self.assertFalse(manager.busy)
                self.assertIsNone(manager.experiment_reservation)
                self.assertEqual(manager.latest['status'],'INTERRUPTED')
                self.assertEqual(service.arbiter.machine.mode.value,'PAUSED')
                self.assertLess(manager.experiment_budget.status()['charged_s'],1.)
                if reset: self.assertIn(('reset',None),service.actions)

    def test_queued_run_blocks_manual_start_and_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            service,manager=self.manager(directory)
            manager.request({'operation':'RUN','side':'RULE'})
            for action in (lambda:service.set_paused(False),lambda:service.queue_dashboard_action('settings',{}),lambda:service.set_safety_enabled({'enabled':False})):
                with self.assertRaises(ValueError): action()
            manager.execute({'operation':'STOP'})

    def test_comparison_setup_brake_preserves_admitted_run_and_external_stop_cancels_it(self):
        with tempfile.TemporaryDirectory() as directory:
            service,manager=self.manager(directory)
            manager.request({'operation':'RUN','side':'RULE'})
            service.stop_driving('comparison_reset',cancel_comparison=False)
            self.assertIsNone(manager.stop_requested)
            self.assertTrue(manager.busy)
            service.stop_driving()
            self.assertEqual(manager.stop_requested,'operator_stop')
            manager.execute({'operation':'RUN','side':'RULE'})
            self.assertFalse(manager.busy)

    def test_emergency_latch_cancels_queued_run_and_cannot_be_cleared_by_later_setup(self):
        with tempfile.TemporaryDirectory() as directory:
            service,manager=self.manager(directory)
            manager.request({'operation':'RUN','side':'RULE'})
            service.emergency_stop()
            with patch('backend.carla.comparison_v2.ComparisonDemo.execute') as setup:
                manager.execute({'operation':'RUN','side':'RULE'})
            setup.assert_not_called()
            self.assertEqual(service.arbiter.machine.mode.value,'EMERGENCY_STOP')
            self.assertEqual(manager.latest['reason'],'emergency_stop')

    def test_rejected_manual_start_does_not_take_comparison_ownership(self):
        from backend.websocket_bridge import WebSocketBridge
        with tempfile.TemporaryDirectory() as directory:
            service,manager=self.manager(directory)
            manager.request({'operation':'RUN','side':'RULE'})
            bridge=WebSocketBridge(service,'127.0.0.1',0,8000);owner,observer=object(),object()
            bridge.owner=owner
            try:
                with self.assertRaises(ValueError):bridge.process_message(observer,{'type':'start_driving'})
                self.assertIs(bridge.owner,owner)
                self.assertIsNone(manager.stop_requested)
                manager.execute({'operation':'STOP'})
            finally:bridge.server.shutdown()

    def test_snapshot_accepts_partial_saved_results_and_persists_latest_interruption(self):
        with tempfile.TemporaryDirectory() as directory,patch('backend.carla.comparison_v2.DIRECTORY',Path(directory)):
            service,manager=self.manager(directory)
            manager.pair={'pair_id':'saved','seed':2811}
            manager.results={'RULE':{'status':'ARRIVED','completed':True,'destination_arrived':True,'outcome':{'metrics':{'collision_count':0,'progress_m':184.28}}}}
            manager.latest={'side':'RULE','status':'INTERRUPTED','reason':'operator_stop'}
            manager.save()
            restored=ComparisonV2(service)
            snapshot=restored.snapshot()
            self.assertEqual(snapshot['latest_attempt']['status'],'INTERRUPTED')
            self.assertEqual(snapshot['results']['RULE']['outcome_metrics']['progress_m'],184.28)
            self.assertGreaterEqual(snapshot['budget']['remaining_s'],0)

    def test_stop_during_preparation_finishes_on_worker_before_navigation(self):
        with tempfile.TemporaryDirectory() as directory:
            service,manager=self.manager(directory)
            manager.phase='RESETTING'; manager.request_stop('operator_stop')
            with patch.object(manager,'finish') as finish,patch('backend.carla.comparison_v2.ComparisonDemo.before_control') as advance:
                manager.before_control()
            finish.assert_called_once_with('operator_stop'); advance.assert_not_called()

    def test_worker_finalizes_active_recording_before_native_vehicle_reset(self):
        with tempfile.TemporaryDirectory() as directory:
            service,manager=self.manager(directory)
            provider=MagicMock();provider.name='test-fixture'
            provider.get_simulation_frame.return_value=packet(2,.1)
            service.provider=provider; service.comparison=manager; manager.phase='RUNNING'
            order=[]
            def finish(reason):
                order.append(('finalize',reason));manager.phase='FINISHED';manager.stop_requested=None
            provider.reset_vehicle.side_effect=lambda:order.append(('native_reset',None))
            with patch.object(manager,'finish',side_effect=finish):
                service.reset_vehicle();service._iteration()
            self.assertEqual(order,[('finalize','vehicle_reset'),('native_reset',None)])
            self.assertEqual(service.arbiter.machine.mode.value,'PAUSED')

    def test_restart_marks_latest_inflight_attempt_interrupted_instead_of_reusing_arrival(self):
        with tempfile.TemporaryDirectory() as directory,patch('backend.carla.comparison_v2.DIRECTORY',Path(directory)):
            service,manager=self.manager(directory)
            arrived={'side':'RULE','status':'ARRIVED','attempt_id':'old','destination_arrived':True}
            manager.pair={'pair_id':'restart','attempts':[{'attempt_id':'new','side':'RULE','phase':'RUNNING'}]}
            manager.results={'RULE':arrived};manager.latest=arrived;manager.save()
            restored=ComparisonV2(service)
            self.assertEqual(restored.latest['status'],'INTERRUPTED')
            self.assertEqual(restored.latest['reason'],'backend_restarted')
            self.assertEqual(restored.results['RULE']['status'],'ARRIVED')

    def test_launch_checks_assets_and_fresh_rule_default_without_starting_any_process(self):
        state={'connected':True,'vehicle':{'source':'carla'},'mode':'PAUSED',
               'safetySystem':{'controller':'RULE','enabled':True},'comparisonV2':{'budget':{'remaining_s':40.7}}}
        def asset(url,timeout):
            response=io.BytesIO(b'/frontend/dashboard.bundle.js comparison_v2'); response.status=200
            return response
        with patch('scripts.final_runtime.urllib.request.urlopen',side_effect=asset):
            self.assertTrue(verify_dashboard(state,require_default=True)['journey_interface_current'])
            with self.assertRaises(RuntimeError):verify_dashboard({**state,'safetySystem':{'controller':'MODEL','enabled':True}},require_default=True)
        with patch('scripts.final_runtime.urllib.request.urlopen',side_effect=asset):
            with self.assertRaises(RuntimeError):verify_dashboard({**state,'connected':False})
        missing=Mock(status=200);missing.__enter__=Mock(return_value=missing);missing.__exit__=Mock(return_value=False);missing.read.return_value=b'missing'
        with patch('scripts.final_runtime.urllib.request.urlopen',return_value=missing):
            with self.assertRaises(RuntimeError):verify_dashboard(state)


if __name__=='__main__':unittest.main()
