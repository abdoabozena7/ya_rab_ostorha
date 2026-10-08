from dataclasses import replace
import unittest
import numpy as np
from backend.core.contracts import CommandSource, SensorKind
from backend.core.safety_policy import sensor_observation
from backend.rl.supervisor import (decide_intervention, normalize_intervention,
                                  policy_features, FEATURE_DIM)
from backend.rl.observations import ObservationAssembler, CONFIGS
from tests.test_safety_policy import observation_frame
from tests.core_packets import command
from tests.test_rl import policy_fixture
from types import SimpleNamespace
from unittest.mock import MagicMock
from backend.carla.provider import CarlaProvider


class SupervisorTests(unittest.TestCase):
    def test_gate_preserves_exact_base_command_and_steering_is_unverified(self):
        observation=sensor_observation(observation_frame())
        base=replace(command(),source=CommandSource.TRAINING,steering=.02,throttle=.4,brake=0.,gear=1)
        result,info=decide_intervention(observation,base,[-1.,1.,1.],'TEST')
        self.assertIs(result,base);self.assertEqual(info['decision'],'NO_INTERVENTION')
        result,info=decide_intervention(observation,base,[1.,.8,1.],'TEST')
        self.assertTrue(info['accepted']);self.assertTrue(info['steering_adjustment_rejected'])
        self.assertEqual(result.steering,base.steering)
        self.assertEqual(result.throttle,0.);self.assertEqual(result.brake,.8)
        self.assertEqual(result.source,CommandSource.SAFETY)
        self.assertFalse(info['feasibility']['left_space_verified'])
        result,info=decide_intervention(observation,base,[1.,0.,1.],'TEST')
        self.assertIs(result,base);self.assertFalse(info['accepted'])

    def test_no_brake_reduction_or_acceleration_and_stale_sensor_rejects(self):
        observation=sensor_observation(observation_frame())
        base=replace(command(),source=CommandSource.TRAINING,throttle=0.,brake=.7,gear=1)
        result,info=decide_intervention(observation,base,[1.,.1,0.],'TEST')
        self.assertIs(result,base)
        stale=replace(observation,channels=tuple(replace(c,sensor_timestamp_s=0.) if c.kind==SensorKind.RADAR else c for c in observation.channels))
        result,info=decide_intervention(stale,base,[1.,1.,0.],'TEST')
        self.assertIs(result,base);self.assertFalse(info['accepted'])

    def test_projection_excludes_absolute_time_and_privileged_fields(self):
        frame=policy_fixture()
        assembler=ObservationAssembler(CONFIGS['lightweight'],lambda asset:b'')
        raw=assembler.append(sensor_observation(frame),[0.,0.,0.])
        features=policy_features(raw,[.01,.4,0.])
        self.assertEqual(features.shape,(FEATURE_DIM,));self.assertEqual(FEATURE_DIM,47)
        other={k:v.copy() for k,v in raw.items()};other['frame_time']+=100000.
        np.testing.assert_array_equal(features,policy_features(other,[.01,.4,0.]))
        with self.assertRaises(ValueError):policy_features({**raw,'ground_truth':{}},[0.,.4,0.])
        frame2=replace(frame,ground_truth=None)
        other=ObservationAssembler(CONFIGS['lightweight'],lambda asset:b'').append(sensor_observation(frame2),[0.,0.,0.])
        np.testing.assert_array_equal(features,policy_features(other,[.01,.4,0.]))

    def test_invalid_interventions_and_clipping(self):
        for value in ([np.nan,0,0],[1,np.inf,0],[True,0,0],[1,0],['1',0,0]):
            with self.assertRaises(ValueError):normalize_intervention(value)
        proposed,bounded=normalize_intervention([2.,-2.,3.])
        np.testing.assert_array_equal(bounded,[1.,0.,1.])

    def test_native_acknowledgement_uses_same_client_and_does_not_tick(self):
        # RPC serialization fixture only; it implements no vehicle physics.
        provider=CarlaProvider.__new__(CarlaProvider)
        provider.ego=SimpleNamespace(actor=SimpleNamespace(id=7))
        api=SimpleNamespace(VehicleControl=lambda **args:SimpleNamespace(**args),
                            command=SimpleNamespace(ApplyVehicleControl=MagicMock(return_value='CONTROL_RPC')))
        client=MagicMock();client.apply_batch_sync.return_value=[SimpleNamespace(error='')]
        provider.connection=SimpleNamespace(api=api,client=client)
        def admit(c):provider.controls=dict(throttle=c.throttle,brake=c.brake,steering=-c.steering,parkingbrake=0,gear=1)
        provider.apply_control=MagicMock(side_effect=admit)
        c=replace(command(),throttle=0.,brake=.7,steering=.03,gear=1)
        provider.apply_control_confirmed(c)
        provider.apply_control.assert_called_once_with(c)
        client.apply_batch_sync.assert_called_once_with(['CONTROL_RPC'],False)
        client.get_world.assert_not_called()
        self.assertEqual(api.command.ApplyVehicleControl.call_args.args[1].steer,c.steering)
        client.apply_batch_sync.return_value=[SimpleNamespace(error='refused')]
        with self.assertRaises(RuntimeError):provider.apply_control_confirmed(c)


if __name__=='__main__':unittest.main()
