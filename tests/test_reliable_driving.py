import copy
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch
import numpy as np
from backend.core.rear_separation import forward_separation
from backend.core.motion_geometry import VehicleGeometry,GRID
from backend.core.kinematic_prediction import kinematic_modes
from backend.core.control_semantics import SemanticAssociator
from backend.core.recording import queued_snapshot
from backend.learning.native_validation_budget import NativeValidationBudget


class ReliableDrivingTests(unittest.TestCase):
    def test_recorded_audit_keeps_missing_decisions_and_driver_holds(self):
        from scripts.audit_reliable_driving import recorded_samples
        from backend.core.driving_quality import evaluate_quality
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'telemetry').mkdir()
            frame={'timestamp_s':1.,'vehicle':{'speed_mps':0.,'angular_velocity_radps':[0,0,0],
                'longitudinal_acceleration_mps2':0.,'throttle':0.,'brake':1.,'steering':0.}}
            (root/'telemetry/frames.jsonl').write_text('\n'.join(json.dumps({**frame,'frame_id':i,'timestamp_s':i*.05}) for i in (1,2)))
            (root/'telemetry/safety-v2.jsonl').write_text(json.dumps({'evaluation_frame':1,'decision_source':'DRIVER',
                'braking':True,'application_timing':{'fresh_aligned':True}}))
            samples=recorded_samples(root);self.assertEqual(len(samples),2)
            report=evaluate_quality(samples,arrived=True,contacts=0)
            self.assertEqual(report['delay_frames'],[2])
            self.assertEqual([s['frame'] for s in report['unresolved_stop_frames']],[1,2])
            self.assertFalse(report['accepted'])

    def test_changed_fixture_freezes_survivors_without_guessing_missing_vehicle_is_walker(self):
        from backend.carla.benchmark_fixture import BenchmarkFixture
        from unittest.mock import Mock
        vehicle=Mock(type_id='vehicle.test');replacement=Mock(type_id='vehicle.test')
        actors={12:vehicle,13:replacement}
        pop=SimpleNamespace(vehicles={13:None},walkers={},traffic_manager=SimpleNamespace(port=8000))
        fixture=BenchmarkFixture(SimpleNamespace(population=pop,world=SimpleNamespace(world=SimpleNamespace(get_actor=actors.get))))
        fixture.actors=[{'id':12,'blueprint':'vehicle.test'},{'id':14,'blueprint':'walker.test'}]
        result=fixture.hold_current()
        self.assertFalse(result['passed'])
        self.assertTrue(any('Missing traffic actor 14' in f for f in result['failures']))
        for actor in (vehicle,replacement):
            actor.set_simulate_physics.assert_called_once_with(False)
            actor.set_autopilot.assert_called_once_with(False,8000)

    def test_changed_fixture_cleanup_can_finish_without_readmitting_missing_traffic(self):
        from backend.carla.benchmark_fixture import BenchmarkFixture
        from unittest.mock import Mock
        pop=SimpleNamespace(vehicles={},walkers={},benchmark_locked=True,benchmark_frozen=True)
        provider=SimpleNamespace(population=pop,connection=SimpleNamespace(api=Mock()),
            ego=SimpleNamespace(actor=Mock()),world=SimpleNamespace(world=SimpleNamespace(get_actor=lambda i:None)))
        fixture=BenchmarkFixture(provider);fixture.frozen=True
        fixture.actors=[{'id':12,'blueprint':'vehicle.test'}]
        with self.assertRaisesRegex(RuntimeError,'missing benchmark actor'):fixture.release()
        fixture.close()
        self.assertFalse(pop.benchmark_locked);self.assertFalse(pop.benchmark_frozen)

    def test_comfort_shaping_does_not_delay_hazard_brake_or_reverse(self):
        from backend.core.comfort_control import ComfortControl
        from tests.test_safety_teacher import case
        from dataclasses import replace
        observation,command=case()
        controller=ComfortControl()
        emergency=replace(command,throttle=0.,brake=1.)
        self.assertIs(controller.apply(emergency,observation.ego,10.,hazard=True),emergency)
        reverse=replace(command,reverse=True,gear=-1)
        self.assertIs(controller.apply(reverse,observation.ego,1.),reverse)

    def test_expired_navigation_command_ends_journey_with_original_hold(self):
        from backend.core.service import SimulationService
        from backend.core.control import ControlMode
        from tests.core_packets import packet
        service=SimulationService(SimpleNamespace(sensor_suite=False),now=lambda:10.)
        service.observation=packet(speed=0.);service._live=lambda:True
        service.arbiter.machine.mode=ControlMode.AUTOMATIC
        service.arbiter.safety.armed_at=0.
        service.journey.update(status='RUNNING',driving_mode='NORMAL')
        with patch.object(service,'_stop_navigation') as stop:
            command=service._choose()
        stop.assert_called_once_with('runtime_failure',status='ERROR')
        self.assertEqual(command.brake,1.)
        self.assertEqual(service.runtime_fault['exception_type'],'CommandLeaseTimeout')
        self.assertEqual(service.runtime_fault['applied_command']['brake'],1.)

    def test_normal_observer_runs_after_native_application_without_reselecting(self):
        from backend.core.service import SimulationService
        from backend.core.control import ControlMode
        from tests.core_packets import packet
        from unittest.mock import Mock
        provider=Mock(sensor_suite=False,allow_navigation=True);provider.name='test-fixture'
        service=SimulationService(provider);service._publish(packet(1,.05,speed=0.))
        service.arbiter.machine.mode=ControlMode.AUTOMATIC
        service.journey.update(status='RUNNING',driving_mode='NORMAL')
        provider.get_simulation_frame.return_value=packet(2,.1,speed=0.)
        provider.drain_sensor_frames.return_value=[];provider.drain_collision_events.return_value=[]
        calls=[]
        from tests.test_normal_navigation import command
        from dataclasses import replace
        selected=replace(command(),frame_id=1,timestamp_s=.05)
        provider.apply_control.side_effect=lambda c:calls.append(('apply',c))
        def observer(observer_base=None):calls.append(('observe',observer_base))
        with patch.object(service,'_navigation_step'),patch.object(service,'_choose',return_value=selected),\
                patch.object(service,'_active_safety_step',side_effect=observer),patch.object(service,'_record'):
            service._iteration()
        self.assertEqual(calls,[('apply',selected),('observe',selected)])

    def test_rear_certificate_requires_history_clearance_and_strict_forward_separation(self):
        case=json.loads(Path('docs/evidence/route-bypass-20261016/rear-corner-replay.json').read_text())
        track=case['track'];g=VehicleGeometry(**case['geometry'])
        track.update(history=[[0,0,0,0,0],[.5,0,0,0,0]],motion_observations=10)
        path=np.column_stack((GRID,GRID*.2,np.zeros((len(GRID),2))))
        proof=forward_separation(track,kinematic_modes([track]),path,g)
        self.assertGreater(proof['minimum_padded_clearance_m'],0)
        for change in ({'occlusion_s':.2},{'confirmed':False},{'velocity_mps':[1,0]},
                       {'history':[[0,0,0,1,0],[.5,0,0,0,0]]},{'class':'person'},
                       {'position_m':[-3,-1]},{'history':[]}):
            tr={**track,**change}
            self.assertIsNone(forward_separation(tr,kinematic_modes([tr]),path,g),change)
        for changed in (path*np.array([1,-1,1,1]),path*np.array([1,0,1,1]),path+np.array([0,0,.02,0])):
            self.assertIsNone(forward_separation(track,kinematic_modes([track]),changed,g))

    def test_semantic_association_is_one_to_one_cached_and_session_bounded(self):
        associator=SemanticAssociator()
        tracks=[{'id':str(i),'history':[[0,1,0,0,0],[1,1,0,0,0]],'class':'UNKNOWN'} for i in range(2)]
        prediction={'session_id':'s','tracks':tracks}
        obs=SimpleNamespace(timestamp_s=1.,frame_id=20,channels=[SimpleNamespace(sensor_id='frontCamera',calibration={})])
        result={'session_id':'s','status':'RUNNING','frame_id':10,'timestamp_s':.5,
            'detections':[{'class':'person','confidence':.9,'xyxy':[0,0,10,10]}]}
        with patch('backend.core.control_semantics.project',return_value=[5,5]) as project:
            poses=[[0,0,0,0,0],[1,0,0,0,20]]
            associator.apply(prediction,obs,poses,result)
            self.assertEqual(sum(t['class']=='person' for t in tracks),1)
            count=project.call_count
            associator.apply(prediction,obs,poses,result)
            self.assertEqual(project.call_count,count)
            foreign={**prediction,'session_id':'next-session','tracks':copy.deepcopy(tracks)}
            associator.apply(foreign,obs,[],result)
            self.assertTrue(all(t['class']=='UNKNOWN' for t in foreign['tracks']))
            invalid=copy.deepcopy(foreign)
            SemanticAssociator().apply(invalid,obs,poses,{**result,'session_id':'next-session','frame_id':5})
            self.assertTrue(all(t['class']=='UNKNOWN' for t in invalid['tracks']))
            obs.timestamp_s=2.
            associator.apply(prediction,obs,[],{**result,'session_id':'foreign'})
            self.assertTrue(all(t['class']=='UNKNOWN' for t in tracks))

    def test_queue_snapshot_owns_mutable_trace_and_charges_nested_payload(self):
        row={'prediction':{'tracks':[[1,2,3]]},'text':'☃'*1000}
        copied,size=queued_snapshot(row);row['prediction']['tracks'][0][0]=99
        self.assertEqual(copied['prediction']['tracks'][0][0],1)
        self.assertGreater(size,len(json.dumps(copied).encode()))

    def test_separate_repair_ticket_preserves_v1_cap_and_absolute_expiry(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):NativeValidationBudget.create(d,1201)
            budget=NativeValidationBudget.create_repair(d)
            self.assertEqual(budget.ticket['scope'],'NATIVE_RULE_REPAIR')
            expired=NativeValidationBudget(budget.path,now=lambda:budget.ticket['expires_at']+1)
            with self.assertRaises(ValueError):expired.activate_rule()
            self.assertEqual(expired.status()['remaining_s'],0)

    def test_missing_evidence_and_subsecond_stop_cannot_pass_quality(self):
        from backend.core.driving_quality import evaluate_quality
        samples=[{'frame_id':i,'timestamp_s':i*.05,'journey':{'status':'RUNNING'},'speed_kmh':0.,
            'longitudinal_acceleration_mps2':0.,'stop':{'reason':'unexplained','application_timing':{'fresh_aligned':True}}} for i in range(6)]
        result=evaluate_quality(samples,arrived=True,contacts=0)
        self.assertFalse(result['accepted']);self.assertEqual(len(result['unresolved_stop_frames']),6)
        self.assertFalse(result['gates']['cruise_50_verified']);self.assertFalse(result['gates']['display'])
        self.assertFalse(result['gates']['complete_measurements'])

    def test_application_deadline_veto_is_measured_before_native_submission(self):
        from backend.core.service import SimulationService
        from backend.core.control import ControlMode
        from tests.test_safety_teacher import case
        observation,command=case()
        service=SimulationService(SimpleNamespace(sensor_suite=True),now=lambda:100.3)
        service._context=lambda:(command.frame_id,command.timestamp_s)
        service.control_scene=SimpleNamespace(session_id=service.session_id,observation=observation,
            received_wall_s=100.,usable=lambda t,w:w<=100.25)
        service.arbiter.machine.mode=ControlMode.AUTOMATIC;service.journey['driving_mode']='ROBOSPHERE'
        held=service._application_guard(command)
        self.assertEqual(held.brake,1.);self.assertEqual(held.throttle,0.)
        self.assertFalse(service.application_timing['fresh_aligned'])
        self.assertAlmostEqual(service.application_timing['wall_age_s'],.3)

    def test_invalid_quality_measurements_fail_without_crashing_or_invalid_json(self):
        from backend.core.driving_quality import evaluate_quality
        sample={'frame_id':1,'timestamp_s':.1,'journey':{'status':'RUNNING'},'speed_kmh':50.,
            'longitudinal_acceleration_mps2':0.,'yaw_rate_radps':0.,'throttle':.2,'brake':0.,'steering':0.}
        for field in ('speed_kmh','longitudinal_acceleration_mps2','yaw_rate_radps','throttle','brake','steering'):
            for value in (None,float('nan'),float('inf'),'unavailable',True):
                with self.subTest(field=field,value=value):
                    result=evaluate_quality([{**sample,field:value}],arrived=True,contacts=0)
                    self.assertFalse(result['accepted'])
                    self.assertFalse(result['gates']['complete_measurements'])
                    self.assertIn(field,result['missing_measurements'][0]['fields'])
                    json.dumps(result,allow_nan=False)


if __name__=='__main__':unittest.main()
