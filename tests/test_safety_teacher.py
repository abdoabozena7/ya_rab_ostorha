"""Teacher sensor-contract cases, without simulated vehicle physics."""
from dataclasses import replace
import unittest
from backend.core.contracts import ControlCommand,CommandSource,SensorKind
from backend.core.safety_policy import sensor_observation,admit_proposal
from backend.rl.teacher import YaRabOstorhaSafetyTeacher,TeacherConfig
from backend.rl.supervisor import TrainingRadarFeasibilityValidator,decide_intervention
from tests.test_rl import policy_fixture


def case(frame=1,speed=8.,distance=30.,velocity=-3.):
    o=sensor_observation(policy_fixture(frame=frame,timestamp=frame*.05))
    ego=replace(o.ego,speed_mps=speed,reverse=False,handbrake=False)
    radar=next(s for s in o.channels if s.kind==SensorKind.RADAR)
    radar=replace(radar,data={'detections':[] if distance is None else
        [{'depth_m':distance,'azimuth_rad':0.,'altitude_rad':0.,'velocity_mps':velocity}]})
    o=replace(o,ego=ego,channels=tuple(radar if s.kind==SensorKind.RADAR else s for s in o.channels))
    b=ControlCommand(frame,o.timestamp_s,.75,0.,.02,False,False,CommandSource.TRAINING,1)
    return o,b


class SafetyTeacherTests(unittest.TestCase):
    def test_physical_envelope_monitor_brake_release_and_stop(self):
        t=YaRabOstorhaSafetyTeacher()
        self.assertEqual(t.propose(*case()).decision,'NO_INTERVENTION')
        d=t.propose(*case(2,8.,8.,-8.))
        self.assertEqual(d.decision,'BRAKE_INTERVENTION');self.assertEqual(d.state,'PROTECTIVE_BRAKING')
        self.assertAlmostEqual(d.diagnostics['stopping_envelope_m'],12.2)
        self.assertEqual(t.propose(*case(3,0.,8.,0.)).decision,'RELEASE_TO_BASE_DRIVER')
        self.assertEqual(t.propose(*case(4,2.,3.,-2.)).decision,'BRAKE_INTERVENTION')
        self.assertEqual(t.propose(*case(5,0.,3.,0.)).state,'SAFE_STOP')
        self.assertEqual(t.propose(*case(6,0.,6.,1.)).decision,'RELEASE_TO_BASE_DRIVER')

    def test_missing_foreground_brakes_instead_of_certifying_clear_space(self):
        t=YaRabOstorhaSafetyTeacher();d=t.propose(*case(distance=None))
        self.assertEqual(d.action,(1.,1.,0.));self.assertFalse(d.diagnostics['foreground_valid'])
        self.assertEqual(t.propose(*case(2,0.,15.,0.)).decision,'RELEASE_TO_BASE_DRIVER')

    def test_accepted_braking_preserves_base_steering_and_protocol(self):
        o,b=case(distance=8.,velocity=-8.);d=YaRabOstorhaSafetyTeacher().propose(o,b)
        e=TrainingRadarFeasibilityValidator().validate((o,),b,d.proposal)
        self.assertTrue(admit_proposal(o,b,d.proposal,e).accepted)
        applied,result=decide_intervention(o,b,d.action,'YA_RAB_OSTORHA_TEACHER_V1')
        self.assertTrue(result['accepted']);self.assertEqual(applied,d.proposal.command)
        self.assertEqual(applied.steering,b.steering);self.assertEqual(applied.throttle,0.)

    def test_release_hysteresis_avoids_pedal_chatter_before_stop(self):
        t=YaRabOstorhaSafetyTeacher();t.propose(*case(distance=8.,velocity=-8.))
        self.assertEqual(t.propose(*case(2,2.,20.,1.)).decision,'BRAKE_INTERVENTION')
        self.assertEqual(t.propose(*case(3,.1,5.,0.)).state,'SAFE_STOP')
        self.assertEqual(t.propose(*case(4,.1,5.01,0.)).decision,'RELEASE_TO_BASE_DRIVER')

    def test_no_fixed_timestamp_or_goal_odometer(self):
        o,b=case(distance=8.,velocity=-8.)
        shifted=replace(o,timestamp_s=o.timestamp_s+100,
            channels=tuple(replace(s,timestamp_s=s.timestamp_s+100,sensor_timestamp_s=s.sensor_timestamp_s+100) for s in o.channels))
        a=YaRabOstorhaSafetyTeacher().propose(o,b)
        z=YaRabOstorhaSafetyTeacher().propose(shifted,replace(b,timestamp_s=b.timestamp_s+100))
        self.assertEqual(a.action,z.action);self.assertEqual(a.state,z.state)

    def test_stale_duplicate_future_base_and_age_are_rejected(self):
        o,b=case();t=YaRabOstorhaSafetyTeacher();t.propose(o,b)
        with self.assertRaises(ValueError):t.propose(o,b)
        with self.assertRaises(ValueError):YaRabOstorhaSafetyTeacher().propose(o,replace(b,frame_id=2))
        with self.assertRaises(ValueError):YaRabOstorhaSafetyTeacher().propose(o,b,as_of_timestamp_s=o.timestamp_s+.11)
        stale=replace(o,channels=tuple(replace(s,sensor_timestamp_s=s.sensor_timestamp_s-.01) if s.kind==SensorKind.RADAR else s for s in o.channels))
        with self.assertRaises(ValueError):YaRabOstorhaSafetyTeacher().propose(stale,b)

    def test_sensor_boundary_and_parameter_validation(self):
        f=policy_fixture();o,b=case()
        with self.assertRaises(ValueError):YaRabOstorhaSafetyTeacher().propose(f,b)
        with self.assertRaises(ValueError):TeacherConfig(reaction_time_s=float('nan'))
        with self.assertRaises(ValueError):TeacherConfig(additional_brake=2.)
        clean=sensor_observation(replace(f,ground_truth=None,actors=()))
        original=sensor_observation(f)
        base=replace(b,frame_id=f.frame_id,timestamp_s=f.timestamp_s)
        self.assertEqual(YaRabOstorhaSafetyTeacher().propose(original,base).action,
                         YaRabOstorhaSafetyTeacher().propose(clean,base).action)


if __name__=='__main__':unittest.main()
