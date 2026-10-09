"""Learned contracts, independent export equation, fallback and admission tests."""
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import numpy as np
from backend.core.contracts import SensorKind, CommandSource
from backend.core.research_safety import ResearchSafetySupervisor
from backend.learned.features import features, DIM
from backend.learned.inference import LearnedSafetyPolicy, DEFAULT_MODEL
from tests.test_safety_teacher import case
from tests.test_active_safety import scene


class LearnedTests(unittest.TestCase):
    def test_only_sensor_contract_and_aligned_proposal_enter_features(self):
        o,b=case()
        x=features(o,b,[0,0,0]);self.assertEqual(x.shape,(DIM,));self.assertTrue(np.isfinite(x).all())
        with self.assertRaises(ValueError):features({'actor_id':1},b,[0,0,0])
        with self.assertRaises(ValueError):features(o,replace(b,frame_id=2),[0,0,0])
        radar=next(s for s in o.channels if s.kind==SensorKind.RADAR)
        with self.assertRaises(ValueError):replace(radar,data={'detections':[{'actor_id':1}]})

    def test_acceleration_scale_is_correct_and_original_sac_contract_unchanged(self):
        o,b=case();imu=next(s for s in o.channels if s.kind==SensorKind.IMU)
        imu=replace(imu,data={**imu.data,'accelerometer_mps2':[12.,0.,9.81]})
        o=replace(o,channels=tuple(imu if s.kind==SensorKind.IMU else s for s in o.channels))
        self.assertAlmostEqual(float(features(o,b,[0,0,0])[1]),.6,places=6)
        from backend.rl.supervisor import FEATURE_DIM
        self.assertEqual(FEATURE_DIM,47)

    def test_model_integrity_finite_outputs_and_recurrent_reset(self):
        p=LearnedSafetyPolicy();x=np.zeros(DIM,np.float32)
        d,a=p.predict(x);self.assertAlmostEqual(float(a.sum()),1.,places=6)
        p.predict(np.ones(DIM,np.float32));p.reset();_,b=p.predict(x)
        np.testing.assert_array_equal(a,b)
        with self.assertRaises(ValueError):p.predict(np.full(DIM,np.nan))
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);(root/'metadata.json').write_bytes((DEFAULT_MODEL/'metadata.json').read_bytes())
            (root/'weights.npz').write_bytes(b'corrupt')
            with self.assertRaisesRegex(ValueError,'integrity'):LearnedSafetyPolicy(root)

    def test_validation_gate_and_default_rule(self):
        s=ResearchSafetySupervisor();self.assertEqual(s.controller,'RULE')
        s.learned_config['native_validated_modes']['LEARNED']=False
        with self.assertRaisesRegex(ValueError,'native validation'):s.set_controller('LEARNED')
        s.set_controller('LEARNED',controlled_validation=True);self.assertEqual(s.controller,'LEARNED')
        with self.assertRaises(ValueError):s.set_controller('INVALID')

    def test_service_research_switch_is_stationary_and_cannot_escape_rl_owner(self):
        from backend.core.service import SimulationService
        from backend.core.control import ControlMode
        from tests.test_rl import policy_fixture
        from unittest.mock import Mock
        service=SimulationService(Mock(sensor_suite=False));service.active_safety=ResearchSafetySupervisor()
        frame=policy_fixture();service.observation=replace(frame,vehicle=replace(frame.vehicle,speed_mps=1.))
        with patch.object(service,'require_connected'):
            with self.assertRaisesRegex(ValueError,'Stop the vehicle'):service.set_safety_enabled({'enabled':True,'controller':'HYBRID'})
        service.arbiter.machine.mode=ControlMode.TRAINING
        with self.assertRaises((ValueError,RuntimeError)):service.set_safety_enabled({'enabled':True,'controller':'RULE'})

    def test_learned_proposal_uses_same_feasibility_and_preserves_steering(self):
        s=ResearchSafetySupervisor();s.set_controller('LEARNED',controlled_validation=True)
        o,b=case(distance=8.,velocity=-8.);o,reader=scene(o)
        with patch.object(s.model,'predict',return_value=('BRAKE_INTERVENTION',np.array([0.,1.,0.]))):
            applied=s.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s)
        self.assertEqual(applied.source,CommandSource.SAFETY);self.assertEqual(applied.steering,b.steering)
        self.assertEqual(applied.brake,1.);self.assertEqual(applied.throttle,0.)
        self.assertEqual(s.snapshot()['actual_generator'],'LEARNED_BC')

    def test_model_failure_is_visible_rule_fallback_and_missing_is_not_clear(self):
        s=ResearchSafetySupervisor();s.set_controller('LEARNED',controlled_validation=True)
        o,b=case(distance=8.,velocity=-8.);o,reader=scene(o)
        with patch.object(s.model,'predict',side_effect=ValueError('broken inference')):
            applied=s.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s)
        self.assertEqual(applied.brake,1.);self.assertEqual(s.snapshot()['actual_generator'],'RULE_FALLBACK')
        self.assertEqual(s.snapshot()['model_health'],'DEGRADED')
        o,b=case(2,distance=None);o,reader=scene(o)
        self.assertEqual(s.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s).brake,1.)
        self.assertIn('No measured',s.snapshot()['fallback_reason'])

    def test_hybrid_guard_overrides_model_missed_braking_honestly(self):
        s=ResearchSafetySupervisor();s.set_controller('HYBRID',controlled_validation=True)
        o,b=case(distance=8.,velocity=-8.);o,reader=scene(o)
        with patch.object(s.model,'predict',return_value=('NO_INTERVENTION',np.array([1.,0.,0.]))):
            applied=s.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s)
        self.assertEqual(applied.brake,1.);self.assertEqual(s.snapshot()['actual_generator'],'RULE_GUARD')

    def test_reverse_and_stale_do_not_reach_learned_inference(self):
        s=ResearchSafetySupervisor();s.set_controller('LEARNED',controlled_validation=True)
        o,b=case();o,reader=scene(o)
        with patch.object(s.model,'predict') as predict:
            self.assertIsNone(s.evaluate(o,replace(b,reverse=True,gear=-1),reader,as_of_timestamp_s=o.timestamp_s))
            predict.assert_not_called()
        with self.assertRaises(ValueError):s.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s+.2)

    def test_hybrid_preserves_rule_release_when_model_continues_braking(self):
        s=ResearchSafetySupervisor();s.set_controller('HYBRID',controlled_validation=True)
        o,b=case(distance=8.,velocity=-8.);o,reader=scene(o)
        with patch.object(s.model,'predict',return_value=('BRAKE_INTERVENTION',np.array([0.,1.,0.]))):
            self.assertEqual(s.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s).brake,1.)
            for frame in range(2,13):
                o,b=case(frame,speed=0.,distance=25.,velocity=2.);o,reader=scene(o,clear=True)
                command=s.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s)
                if command:self.assertEqual(command.brake,s.guard.brake)
            self.assertIsNone(command);self.assertTrue(s.status['hybrid_release_veto'])
            self.assertEqual(s.status['learned_decision'],'BRAKE_INTERVENTION')


if __name__=='__main__':unittest.main()
