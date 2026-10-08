"""Boundary/control/reward tests use declared fixtures, never mock CARLA physics."""
from dataclasses import replace
from types import SimpleNamespace
import unittest
import numpy as np
from gymnasium.utils.passive_env_checker import env_reset_passive_checker, env_step_passive_checker
from backend.rl.actions import normalize_action, physical_command
from backend.rl.observations import CONFIGS, ObservationAssembler, pack_observation, unpack_observation
from backend.rl.reward import RewardEvaluator, episode_outcome
from backend.rl.env import YaRabOstorhaEnv
from backend.core.contracts import CommandSource, CollisionEvent
from backend.core.control import ControlMode, ControlStateMachine, CommandArbiter, ControlSafetyLayer
from backend.core.safety_policy import sensor_observation
from backend.core.service import SimulationService
from tests.test_safety_policy import observation_frame


def policy_fixture(frame=1,timestamp=.05):
    f=observation_frame(frame,timestamp)
    imu=next(s for s in f.sensors if s.kind.value=='IMU')
    imu=replace(imu,data={**imu.data,'accelerometer_mps2':[0.,0.,9.81]})
    return replace(f,sensors=tuple(imu if s.kind.value=='IMU' else s for s in f.sensors))


class RLBoundaryTests(unittest.TestCase):
    def test_only_sensor_contract_enters_assembler_and_transport(self):
        assembler=ObservationAssembler(CONFIGS['lightweight'],lambda _:None)
        frame=policy_fixture()
        with self.assertRaises(ValueError):assembler.append(frame,[0,0,0])
        o=assembler.append(sensor_observation(frame),[0,0,0])
        self.assertEqual(o['history_valid'].tolist(),[0,0,0,1])
        self.assertEqual(set(o),{'ego','imu','radar','radar_valid','history_valid','frame_time','previous_action'})
        payload=pack_observation(o)
        self.assertTrue(assembler.space.contains(unpack_observation(payload,assembler.space)))
        payload['ground_truth']={'actors':[]}
        with self.assertRaises(ValueError):unpack_observation(payload,assembler.space)

    def test_privileged_replacement_cannot_change_policy_arrays(self):
        from tests.core_packets import TRANSFORM
        from backend.core.contracts import ActorState, SimulatorGroundTruth, GroundTruthObject
        f=policy_fixture()
        actor=ActorState(f.frame_id,f.timestamp_s,9999,'vehicle.privileged',TRANSFORM,(99.,99.,0.))
        altered=replace(f,actors=(actor,),ground_truth=SimulatorGroundTruth(f.frame_id,f.timestamp_s,(GroundTruthObject(actor,1.),)))
        a=ObservationAssembler(CONFIGS['lightweight'],lambda _:None).append(sensor_observation(f),[0,0,0])
        b=ObservationAssembler(CONFIGS['lightweight'],lambda _:None).append(sensor_observation(altered),[0,0,0])
        for k in a:np.testing.assert_array_equal(a[k],b[k])

    def test_history_bounded_and_stale_channels_rejected(self):
        a=ObservationAssembler(CONFIGS['lightweight'],lambda _:None)
        for i in range(1,12):a.append(sensor_observation(policy_fixture(i,i*.05)),[0,0,0])
        self.assertEqual(len(a.history),4)
        with self.assertRaises(ValueError):a.append(sensor_observation(policy_fixture(11,.55)),[0,0,0])
        stale=policy_fixture(12,.6)
        stale=replace(stale,sensors=tuple(replace(s,sensor_timestamp_s=.5) for s in stale.sensors))
        with self.assertRaises(ValueError):a.append(sensor_observation(stale),[0,0,0])

    def test_invalid_actions_conflicts_clipping_and_steering_rate(self):
        for a in ([np.nan,0,0],[0,np.inf,0],[0,0],['1',0,0],[True,0,0],{'steering':0,'throttle':0,'brake':0,'actor_id':7}):
            with self.assertRaises(ValueError):normalize_action(a)
        proposed,applied=normalize_action({'steering':2,'throttle':2,'brake':.5})
        self.assertEqual(applied.tolist(),[1.,0.,.5])
        _,applied,c=physical_command([1,1,0],policy_fixture(),[0,0,0],.05)
        self.assertAlmostEqual(c.steering,.075)
        self.assertEqual(c.source,CommandSource.TRAINING)

    def test_training_requires_exclusive_mode_and_rejects_manual(self):
        now=[1.]
        machine=ControlStateMachine(allow_training=True);machine.transition(ControlMode.MANUAL,connected=True)
        arb=CommandArbiter(ControlSafetyLayer(now=lambda:now[0]),machine)
        _,_,c=physical_command([0,.5,0],policy_fixture(),[0,0,0],.05)
        with self.assertRaises(ValueError):arb.submit(c,frame_id=1,timestamp_s=.05,connected=True)
        machine.transition(ControlMode.TRAINING,connected=True,explicit=True)
        arb.submit(c,frame_id=1,timestamp_s=.05,connected=True)
        self.assertEqual(arb.choose(frame_id=1,timestamp_s=.05,connected=True).source,CommandSource.TRAINING)
        with self.assertRaises(ValueError):arb.submit(replace(c,source=CommandSource.MANUAL),frame_id=1,timestamp_s=.05,connected=True)
        now[0]+=1.
        with self.assertRaises(ValueError):arb.submit(c,frame_id=4,timestamp_s=1.,connected=True)

    def test_service_blocks_mutating_normal_operations_during_rl(self):
        s=SimulationService(SimpleNamespace(name='test-fixture'))
        s.rl_runtime=SimpleNamespace(active=True)
        for call in (lambda:s.set_paused(False),s.reset_vehicle,lambda:s.queue_dashboard_action('scenario',{}),
                     lambda:s.start_journey(20),s.reconnect):
            with self.assertRaisesRegex(RuntimeError,'Exclusive RL'):call()

    def test_reward_discourages_stationary_and_gates_unsafe_progress(self):
        r=RewardEvaluator();context={'clearance_m':20.,'ttc_s':None,'lane_valid':True,
             'collisions':(),'progress_delta_m':0.,'speed_mps':0.}
        reward,components,_=r.evaluate(context,[0,0,0],[0,0,0],.05,False)
        self.assertLess(reward,0)
        reward,c,_=r.evaluate({**context,'clearance_m':.5,'progress_delta_m':1.,'speed_mps':10},[0,0,0],[0,1,0],.05,False)
        self.assertEqual(c['progress'],0);self.assertLess(reward,0)
        reward,c,_=r.evaluate({**context,'progress_delta_m':-1.},[0,0,0],[0,0,0],.05,False)
        self.assertLess(c['progress'],0)

    def test_outcome_flags_collision_timeout_stationary_and_success(self):
        spec=SimpleNamespace(timeout=10.,scenario_type=SimpleNamespace(value='FRONT_OBSTACLE'),
                            success_conditions={'min_progress_m':10.},metadata={})
        c={'collisions':(),'lane_valid':True,'progress_m':0.,'clearance_m':10.,'stop_duration_s':1.}
        metrics={'collision_count':0,'duration_s':10.}
        self.assertEqual(episode_outcome(c,metrics,spec,200,400)[:3],('TIMEOUT',False,True))
        self.assertEqual(episode_outcome({**c,'progress_m':12},metrics,spec,200,400)[:3],('SUCCESS',True,False))
        collision=CollisionEvent(1,.05,1,2,(100.,0.,0.),'carla-world')
        self.assertEqual(episode_outcome({**c,'collisions':(collision,)},metrics,spec,1,400)[:3],('COLLISION',True,False))
        self.assertEqual(episode_outcome(c,{**metrics,'duration_s':1},spec,5,5)[4],'maximum_steps')

    def test_spaces_in_all_profiles(self):
        from backend.rl.observations import observation_space
        for config in CONFIGS.values():
            space=observation_space(config)
            self.assertTrue(space.contains(space.sample()))

    def test_lost_backend_has_distinct_truncation_and_invalid_observation(self):
        assembler=ObservationAssembler(CONFIGS['lightweight'],lambda _:None)
        o=assembler.append(sensor_observation(policy_fixture()),[0,0,0])
        def unavailable(operation,**kwargs):raise ConnectionResetError('declared transport failure fixture')
        e=YaRabOstorhaEnv(transport=unavailable)
        e.done=False;e.token='fixture';e.last_observation=o
        e.current_info={'frame_id':1,'timestamp_s':.05,'recording_path':'missing-test-fixture',
                        'episode_id':'fixture','step':0}
        obs,reward,terminated,truncated,info=e.step([0,.4,0])
        self.assertEqual((terminated,truncated),(False,True))
        self.assertEqual(info['outcome'],'SIMULATOR_FAILURE')
        self.assertFalse(info['observation_valid']);self.assertFalse(obs['history_valid'].any())
        self.assertIsNone(info['applied_action'])
        e.close();self.assertFalse(e.last_close_info['cleanup_confirmed'])

    def test_dashboard_release_cannot_clear_rl_training_command(self):
        s=SimulationService(SimpleNamespace(name='test-fixture'));s.rl_runtime=SimpleNamespace(active=True)
        s.arbiter.safety.latest[CommandSource.TRAINING]='declared-command-fixture'
        s.release_controls()
        self.assertIn(CommandSource.TRAINING,s.arbiter.safety.latest)

    def test_failed_safety_rpc_preserves_failure_outcome(self):
        import json
        import tempfile
        from backend.rl.runtime import RLRuntime
        from backend.core.recording import RunRecorder
        from backend.core.contracts import ExperimentMetadata, DataOrigin
        from backend.core.scenarios import DatasetSplit
        def failed_rpc(command):raise RuntimeError('declared unavailable native RPC fixture')
        provider=SimpleNamespace(name='test-fixture',apply_control=failed_rpc,
                                 scenarios=SimpleNamespace(stop=lambda reason:None))
        service=SimulationService(provider)
        runtime=RLRuntime(service)
        runtime.measurements=SimpleNamespace(metrics={'duration_s':1.})
        runtime.spec=SimpleNamespace(scenario_id='fixture',random_seed=0)
        runtime.split=DatasetSplit.TRAIN;runtime.baseline_id='SCRIPTED_DIAGNOSTIC'
        runtime.total_reward=0.;runtime.steps=1;runtime.episode_id='fixture'
        with tempfile.TemporaryDirectory() as directory:
            runtime.recorder=RunRecorder(directory,ExperimentMetadata('fixture','Failure contract fixture','test-fixture',DataOrigin.TEST_FIXTURE))
            service.recorder=runtime.recorder
            runtime._finish('SIMULATOR_FAILURE',False,True,None,'native_rpc_unavailable')
            result=json.loads((runtime.recorder.root/'outcome.json').read_text(encoding='utf8'))
            self.assertEqual(result['outcome'],'SIMULATOR_FAILURE')
            self.assertIn('safety_stop_command_error',result)
            self.assertTrue(runtime.recorder.closed)
            self.assertIsNone(service.recorder)


if __name__=='__main__':unittest.main()
