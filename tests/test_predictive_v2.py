import copy
import tempfile
import unittest
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import patch
import numpy as np
from backend.core.prediction import MotionTracker, PredictionEngine, ego_paths, assess_conflicts, geometric_modes, intended_conflict
from backend.learning.async_worker import AsyncPredictionWorker
from backend.learning.supervised.motion import PredictiveModel
from backend.learning.experiment_budget import ExperimentBudget
from backend.core.predictive_safety import PredictiveSafetySupervisor
from backend.core.recording import RunRecorder, BufferedRunRecorder
from backend.core.service import SimulationService
from backend.core.contracts import CommandSource
from backend.core.replay import ReplayReader
from backend.carla.comparison_v2 import ComparisonV2, pose_audit
from tests.test_safety_teacher import case
from tests.test_active_safety import scene
from tests.core_packets import metadata, packet


def track(position, velocity=(0,0), ident='1'):
    return dict(id=ident,position_m=list(position),velocity_mps=list(velocity),half_size_m=[.4,.4],
        confirmed=True,uncertainty_m=.1,acceleration_mps2=[1.,-.5],quality=.9,**{'class':'car'})


class PredictionTests(unittest.TestCase):
    def test_ego_braking_distance_launch_and_turn_geometry(self):
        paths={p['intent']:p['points'] for p in ego_paths(8,0,1)}
        self.assertAlmostEqual(paths['CONTINUE'][-1,1],24.)
        self.assertAlmostEqual(paths['BRAKE'][-1,1],6.4)
        launch={p['intent']:p['points'] for p in ego_paths(0,0,1)}['LAUNCH']
        self.assertAlmostEqual(launch[-1,1],9.)
        self.assertGreater(ego_paths(8,.3,0)[0]['points'][-1,2],0.)

    def test_time_aligned_crossing_and_separated_arrival(self):
        tracks=[track([8,4],[0,-4])]
        conflicts=assess_conflicts(tracks,geometric_modes(tracks),ego_paths(8,0,1))
        self.assertTrue(conflicts);self.assertLessEqual(conflicts[0]['time_s'],1.)
        tracks=[track([24,5],[0,-10])]
        conflicts=assess_conflicts(tracks,geometric_modes(tracks),ego_paths(8,0,0))
        self.assertEqual(conflicts,[])

    def test_stopped_launch_keeps_risk_and_distinct_modes(self):
        tracks=[track([7,2],[0,-.5])]
        conflicts=assess_conflicts(tracks,geometric_modes(tracks),ego_paths(0,0,1))
        self.assertTrue(any(c['ego_intent']=='LAUNCH' for c in conflicts))
        self.assertFalse(assess_conflicts(tracks,geometric_modes(tracks),ego_paths(0,0,0)))
        model=PredictiveModel();modes=model.modes(tracks)
        self.assertEqual(len(modes),3); self.assertNotEqual(modes[0]['points'],modes[1]['points'])

    def test_stationary_rear_object_cannot_hold_safe_forward_launch(self):
        tracks=[track([-4,0])]
        conflicts=assess_conflicts(tracks,geometric_modes(tracks),ego_paths(0,0,1))
        self.assertIsNone(intended_conflict(conflicts,0,1))

    def test_initial_padded_rear_overlap_releases_only_when_motion_separates(self):
        rear=track([-3.86,-1.69],[.009,.086]);rear['half_size_m']=[1.19,.87]
        conflicts=assess_conflicts([rear],geometric_modes([rear]),ego_paths(0,0,1))
        self.assertTrue(any(c.get('separating_rear_overlap') for c in conflicts))
        self.assertIsNone(intended_conflict(conflicts,0,1))
        rear['velocity_mps']=[3.,0.]
        closing=assess_conflicts([rear],geometric_modes([rear]),ego_paths(0,0,1))
        self.assertIsNotNone(intended_conflict(closing,0,1))  # cannot clear within horizon
        front=track([3.8,0]);front['half_size_m']=[1.2,.8]
        self.assertIsNotNone(intended_conflict(assess_conflicts([front],geometric_modes([front]),ego_paths(0,0,1)),0,1))

    def test_rear_impact_must_not_command_a_strictly_worse_braking_action(self):
        rear=track([-5.22,.36],[2.13,-.02]);rear['half_size_m']=[1.52,.68];rear['uncertainty_m']=.25
        paths=ego_paths(0,0,1);conflicts=assess_conflicts([rear],geometric_modes([rear]),paths)
        launch=next(c for c in conflicts if c['ego_intent']=='LAUNCH')
        self.assertTrue(launch['braking_worsens_rear_conflict'])
        self.assertIsNone(intended_conflict(conflicts,0,1))
        front=track([7,0]);both=[rear,front]
        conflict=intended_conflict(assess_conflicts(both,geometric_modes(both),paths),0,1)
        self.assertIsNotNone(conflict);self.assertEqual(conflict['point_m'][0],7.)

    def test_scripted_hazards_continue_past_destination(self):
        from backend.carla.urban_chaos import extend_scripted_exits
        route=[[i*2,0,0] for i in range(91)];extension=[[i*2,0,0] for i in range(91,111)]
        plans={'sudden_brake':{'points':route[11:].copy()},'cut_in':{'points':[[130,0,0]]},
            'curb_return':{'return_points':[[138,0,0]]},'curb_up':{'points':[[68,7,0]]}}
        extend_scripted_exits(plans,route,extension)
        for key,field in [('sudden_brake','points'),('cut_in','points'),('curb_return','return_points')]:
            self.assertEqual(plans[key][field][-1],[220,0,0])
        self.assertEqual(plans['cut_in']['points'][0],[130,0,0])
        self.assertEqual(plans['curb_up']['points'],[[68,7,0]])

    def test_three_frames_stable_id_occlusion_and_session_reset(self):
        tracker=MotionTracker();rng=np.random.default_rng(2);cloud=rng.uniform(-.2,.2,(30,3))+[10,4,1]
        ids=[]
        for i in range(3):
            obs,_=case(i+1,speed=0)
            tracks=tracker.update(cloud,obs);ids.append(tracks[0]['id'])
            self.assertEqual(tracks[0]['confirmed'],i==2)
        self.assertEqual(len(set(ids)),1)
        obs,_=case(4,speed=0);occluded=tracker.update(np.empty((0,3)),obs)
        self.assertTrue(occluded[0]['confirmed']);self.assertGreater(occluded[0]['uncertainty_m'],tracks[0]['uncertainty_m'])
        for i in range(5,11): obs,_=case(i,speed=0);tracks=tracker.update(np.empty((0,3)),obs)
        self.assertEqual(tracks,[])
        self.assertIsNone(PredictionEngine('new').latest)

    def test_async_rejects_sim_wall_and_session_stale(self):
        worker=object.__new__(AsyncPredictionWorker)
        worker.latest={'session_id':'a','timestamp_s':10.,'request_wall_s':100.}
        self.assertIsNotNone(worker.current('a',10.75,101.))
        for session,sim,wall in [('b',10,100),('a',10.751,100),('a',10,101.001),('a',9,100)]:
            self.assertIsNone(worker.current(session,sim,wall))

    def test_association_survives_changed_detection_order_and_ego_motion(self):
        tracker=MotionTracker();rng=np.random.default_rng(12)
        shapes=[rng.uniform(-.2,.2,(25,3))+[10,y,1] for y in (-4,4)]
        identities=None
        for i in range(1,5):
            obs,_=case(i,speed=2)
            obs=replace(obs,ego=replace(obs.ego,angular_velocity_radps=(0.,0.,0.)))
            ordered=shapes if i%2 else shapes[::-1]
            cloud=np.vstack(ordered)-[2*(i-1)*.05,0,0]
            tracks=tracker.update(cloud,obs)
            current={np.sign(t['position_m'][1]):t['id'] for t in tracks}
            if identities is None:identities=current
            self.assertEqual(current,identities)
            self.assertTrue(all(np.linalg.norm(t['velocity_mps'])<.01 for t in tracks))

    def test_weights_influence_speed_and_prediction_ablation(self):
        model=PredictiveModel();x=np.zeros(13,np.float32)
        ctx=dict(speed=8.,distance=7.,conflict_time=.7,conflict=True,free_range=30.,cap=5.5)
        model.reset();learned=model.target_speed(x,ctx)
        model.reset();ablated=model.target_speed(x,ctx,ablate=True)
        self.assertNotEqual(learned,ablated)
        tracks=[track([10,3],[3,-1])]
        self.assertNotEqual(model.modes(tracks),model.modes(tracks,ablate=True))

    def test_model_does_not_execute_full_rule_and_sensor_fault_is_explicit(self):
        with patch('backend.learning.async_worker.AsyncPredictionWorker',side_effect=OSError('disabled test worker')):
            supervisor=PredictiveSafetySupervisor('MODEL','test')
        obs,base=case(distance=None,speed=0);obs,reader=scene(obs,clear=True)
        with patch('backend.core.active_safety.ActiveSafetySupervisor.evaluate',side_effect=AssertionError('RULE leakage')):
            result=supervisor.evaluate(obs,base,reader,as_of_timestamp_s=obs.timestamp_s)
        self.assertIsNotNone(result); self.assertEqual(supervisor.snapshot()['controller'],'MODEL')
        self.assertIn('pre_protection_command',supervisor.snapshot())
        with self.assertRaises(ValueError): supervisor.evaluate(obs,base,reader,as_of_timestamp_s=obs.timestamp_s+.2)

    def test_empty_and_curb_ground_do_not_request_measured_hazard(self):
        with patch('backend.learning.async_worker.AsyncPredictionWorker',side_effect=OSError('test')):
            s=PredictiveSafetySupervisor('RULE','s')
        for i in range(1,5):
            obs,base=case(i,distance=None,speed=2);obs,reader=scene(obs,clear=True)
            base=replace(base,steering=0.)
            command=s.evaluate(obs,base,reader,as_of_timestamp_s=obs.timestamp_s)
            self.assertEqual(command.brake,0);self.assertEqual(s.snapshot()['risk'],'CLEAR')

    def test_weak_obstacle_cannot_certify_a_stopping_corridor_and_near_hazards_are_immediate(self):
        with patch('backend.learning.async_worker.AsyncPredictionWorker',side_effect=OSError('test')):
            s=PredictiveSafetySupervisor('RULE','s')
        for i in range(1,4):
            obs,base=case(i,distance=None,speed=8);obs,reader=scene(obs,clear=True,obstacle=True)
            s.evaluate(obs,base,reader,as_of_timestamp_s=obs.timestamp_s)
            self.assertTrue(s.snapshot()['emergency_active'])
        obs,base=case(4,distance=None,speed=8);obs,reader=scene(obs,clear=True)
        cloud=np.vstack((np.frombuffer(reader(None),'<f4').reshape(-1,4),[[4.,0.,-1.4,.5]])).astype('<f4').tobytes()
        s.evaluate(obs,base,lambda _:cloud,as_of_timestamp_s=obs.timestamp_s)
        self.assertTrue(s.snapshot()['emergency_active']);self.assertAlmostEqual(s.snapshot()['raw_measured_range_m'],1.5,delta=.001)

    def test_model_failure_is_fatal_without_geometric_rule_fallback(self):
        with patch('backend.learning.async_worker.AsyncPredictionWorker',side_effect=OSError('test')):
            s=PredictiveSafetySupervisor('MODEL','s')
        obs,base=case(distance=None,speed=0);obs,reader=scene(obs,clear=True)
        with patch.object(s.model,'target_speed',side_effect=ValueError('corrupt output')):
            with self.assertRaisesRegex(ValueError,'MODEL_FAILURE'):s.evaluate(obs,base,reader,as_of_timestamp_s=obs.timestamp_s)

    def test_navigation_final_brake_retains_forward_gear_and_still_checks_sensors(self):
        for side in ('RULE','MODEL'):
            with patch('backend.learning.async_worker.AsyncPredictionWorker',side_effect=OSError('test')):
                s=PredictiveSafetySupervisor(side,'s')
            obs,base=case(distance=None,speed=4);obs,reader=scene(obs,clear=True)
            base=replace(base,gear=None,throttle=0.,brake=1.,source=CommandSource.NAVIGATION)
            command=s.evaluate(obs,base,reader,as_of_timestamp_s=obs.timestamp_s)
            self.assertEqual(command.brake,1.);self.assertEqual(command.throttle,0.)
            with self.assertRaisesRegex(ValueError,'freshness'):
                s.evaluate(obs,base,reader,as_of_timestamp_s=obs.timestamp_s+.2)
            obs,base=case(2,distance=None,speed=0);obs,reader=scene(obs,clear=True)
            with self.assertRaisesRegex(ValueError,'forward drive'):
                s.evaluate(obs,replace(base,gear=0),reader,as_of_timestamp_s=obs.timestamp_s)

    def test_clearance_hold_then_gradual_release(self):
        with patch('backend.learning.async_worker.AsyncPredictionWorker',side_effect=OSError('test')):
            s=PredictiveSafetySupervisor('RULE','s')
        for i in range(1,4):
            obs,base=case(i,distance=None,speed=8);obs,reader=scene(obs,clear=True,obstacle=True)
            s.evaluate(obs,base,reader,as_of_timestamp_s=obs.timestamp_s)
        brakes=[]
        for i in range(4,15):
            obs,base=case(i,distance=None,speed=0);obs,reader=scene(obs,clear=True)
            base=replace(base,steering=0.)
            brakes.append(s.evaluate(obs,base,reader,as_of_timestamp_s=obs.timestamp_s).brake)
        self.assertEqual(brakes[:2],[1.,1.]);self.assertEqual(brakes[-1],0)
        self.assertTrue(all(a>=b for a,b in zip(brakes,brakes[1:])))

    def test_audit_distinguishes_navigation_brake_and_model_failure(self):
        s=object.__new__(SimulationService);s.observation=packet();s.session_id='s';s.now=lambda:10.
        s.state_at=s.safety_observed_at=10.;s.recorder=None;s.journey={'reason':None}
        s.arbiter=SimpleNamespace(reason='SAFETY')
        _,base=case();command=replace(base,source=CommandSource.SAFETY,brake=.7)
        status={'base_driver_brake':.7,'base_command_source':'NAVIGATION','decision_source':'MODEL','reason':'shared navigation brake'}
        s.active_safety=SimpleNamespace(snapshot=lambda:status,last_fault=None);s.safety_command=command
        s._audit_command(command)
        self.assertEqual(s.stop_diagnostics['braking_sources'],['NAVIGATION'])
        s.active_safety.last_fault='MODEL_FAILURE: corrupt output';s.safety_command=None
        s._audit_command(replace(command,source=CommandSource.SYSTEM))
        self.assertEqual(s.stop_diagnostics['decision_source'],'MODEL')
        self.assertIn('corrupt output',s.stop_diagnostics['reason'])
        status['prediction']={'evaluation_frame':0}
        prior_pose={'position_m':[10,0,0],'rotation_rad':{'yaw':0}}
        s.render_pose_cache={0:prior_pose}
        s._audit_command(command)
        self.assertEqual(status['prediction']['render_reference'],prior_pose)

    def test_old_and_new_replay_sidecars_are_optional_and_frame_specific(self):
        with tempfile.TemporaryDirectory() as directory:
            writer=BufferedRunRecorder(RunRecorder(directory,metadata()))
            writer.submit(packet(),[]);writer.record_safety({'version':2,'evaluation_frame':1,'session_id':'s','safety':{'prediction':{'evaluation_frame':1}}});writer.close()
            reader=ReplayReader(writer.root,allow_test_data=True)
            self.assertEqual(reader.safety_at(1)['session_id'],'s');self.assertIsNone(reader.safety_at(2))
            (writer.root/'telemetry/safety-v2.jsonl').unlink()
            self.assertIsNone(ReplayReader(writer.root,allow_test_data=True).safety_at(1))

    def test_budget_hard_cap_is_persistent_and_crash_reservations_count(self):
        with tempfile.TemporaryDirectory() as directory:
            path=directory+'/budget.sqlite';a=ExperimentBudget(path);a.reserve('live',5000)
            b=ExperimentBudget(path)
            with self.assertRaises(ValueError):b.reserve('training',500)
            self.assertEqual(b.status()['charged_s'],5000)

    def test_pair_admission_prevents_overlap_and_pose_drift(self):
        with tempfile.TemporaryDirectory() as directory,patch('backend.carla.comparison_v2.DIRECTORY',__import__('pathlib').Path(directory)),patch('backend.learning.experiment_budget.ExperimentBudget',return_value=ExperimentBudget(directory+'/budget.sqlite')):
            s=SimpleNamespace(comparison=None,arbiter=SimpleNamespace(machine=SimpleNamespace(mode=SimpleNamespace(value='PAUSED'))),actions=[])
            manager=ComparisonV2(s);s.comparison=manager
            manager.request({'operation':'RUN','side':'RULE'})
            with self.assertRaises(ValueError):manager.request({'operation':'RUN','side':'MODEL'})
        state={'name':'a','blueprint':'car','velocity_mps':[0,0,0],'transform':{'position_m':[0,0,0],'rotation_rad':{'roll':0,'pitch':0,'yaw':0}}}
        other=copy.deepcopy(state);other['transform']['position_m'][0]=.06
        self.assertFalse(pose_audit([state],[other])['passed'])

    def test_last_run_uses_only_remaining_hard_cap_allowance(self):
        with tempfile.TemporaryDirectory() as directory:
            budget=ExperimentBudget(directory+'/budget.sqlite');budget.reserve('past_experiments',4900)
            with patch('backend.carla.comparison_v2.DIRECTORY',__import__('pathlib').Path(directory)),patch('backend.learning.experiment_budget.ExperimentBudget',return_value=budget):
                service=SimpleNamespace(comparison=None,arbiter=SimpleNamespace(machine=SimpleNamespace(mode=SimpleNamespace(value='PAUSED'))),actions=[])
                manager=ComparisonV2(service);manager.request({'operation':'RUN','side':'RULE'})
                self.assertEqual(manager.experiment_reservation[2],500.)
                self.assertEqual(budget.status()['charged_s'],5400.)

    def test_comparison_click_claims_control_only_after_admission(self):
        from backend.websocket_bridge import WebSocketBridge
        service=SimulationService(None);service._publish(packet(speed=0))
        bridge=WebSocketBridge(service,'127.0.0.1',0,8000);owner,observer=object(),object()
        try:
            bridge.process_message(owner,{'type':'start_driving'})
            request={'type':'comparison_v2','value':{'operation':'RUN','side':'MODEL'}}
            with patch.object(service,'queue_dashboard_action',side_effect=ValueError('not admitted')):
                with self.assertRaises(ValueError):bridge.process_message(observer,request)
            self.assertIs(bridge.owner,owner)
            with patch.object(service,'queue_dashboard_action') as queue:
                bridge.process_message(observer,request)
                queue.assert_called_once_with('comparison_v2',request['value'])
            self.assertIs(bridge.owner,observer)
            with self.assertRaises(ValueError):bridge.process_message(owner,{'type':'comparison_v2','value':{'operation':'STOP'}})
        finally:bridge.server.shutdown()

    def test_degenerate_native_bounding_box_cannot_crash_diagnostics(self):
        from backend.carla.geometry import rectangle_clearance
        self.assertGreater(rectangle_clearance(((0,0),(1,0),(1,1),(0,1)),((3,3),)*4),0)

if __name__=='__main__':unittest.main()
