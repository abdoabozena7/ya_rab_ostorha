"""Sensor-contract and maneuver admission fixtures, not simulated driving proof."""
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock
import unittest
import numpy as np
from backend.core.congestion_recovery import CongestionRecovery
from backend.core.control import ControlMode
from backend.core.active_safety import ActiveSafetySupervisor
from backend.core.service import SimulationService
from backend.core.prediction import MotionTracker
from backend.core.motion_scene import advance_scene
from tests.test_safety_teacher import case
from tests.test_motion_reliability import motion, road, FREE
from tests.test_predictive_v2 import track
from tests.core_packets import packet
from backend.core.recovery_depth import depth_surfaces
from backend.core.contracts import SensorKind
from backend.core.maneuver import ObservedSpace
from backend.core.motion_geometry import VehicleGeometry
import io


class Space:
    def __init__(self,verified=True):self.verified=verified
    def certificate(self,path):return {**FREE,'verified':self.verified,'known_percent':100. if self.verified else 0.}


class RecoveryTests(unittest.TestCase):
    def step(self,p,frame,tracks,*,context=None,space=None,reverse=False,speed=0.,wall=100.):
        o,b=case(frame,speed=speed)
        o=replace(o,ego=replace(o.ego,reverse=reverse,gear=-1 if reverse else 1,steering=0.,angular_velocity_radps=(0,0,0)))
        b=replace(b,reverse=reverse,gear=-1 if reverse else 1,brake=1.,throttle=0.)
        return p.evaluate(o,b,motion(tracks,o.timestamp_s),space or Space(),context or road(),wall=wall)

    def blocked(self,p,tracks,**kw):
        result=None
        for frame in range(1,43):result=self.step(p,frame,tracks,**kw)
        return result

    def test_reverse_is_not_immediate_and_changes_gear_while_held(self):
        p=CongestionRecovery(reverse_accepted=True)
        command,status=self.step(p,1,[track([5.,0.])])
        self.assertIsNone(command)
        command,status=self.blocked(CongestionRecovery(reverse_accepted=True),[track([5.,0.])])
        self.assertEqual(status['action'],'BACK_UP')
        self.assertTrue(command.reverse);self.assertEqual(command.gear,-1)
        self.assertEqual((command.throttle,command.brake),(0.,1.))

    def test_reverse_releases_only_after_actual_gear_confirmation(self):
        p=CongestionRecovery(reverse_accepted=True);self.blocked(p,[track([5.,0.])])
        c,s=self.step(p,43,[track([5.,0.])],reverse=True)
        self.assertEqual(s['action'],'BACK_UP');self.assertGreater(c.throttle,0.);self.assertEqual(c.brake,0.)
        c,s=self.step(p,44,[track([5.,0.])],reverse=True,speed=1.1)
        self.assertEqual(s['reason'],'RECOVERY_SPEED_LIMIT');self.assertEqual(c.throttle,0.);self.assertEqual(c.brake,1.)

    def test_gaps_cancel_active_movement_without_switching_reverse_gear(self):
        p=CongestionRecovery(reverse_accepted=True);self.blocked(p,[track([5.,0.])])
        c,s=self.step(p,50,[track([5.,0.])],reverse=True,speed=.4)
        self.assertEqual(s['reason'],'RECOVERY_FRAME_GAP');self.assertEqual(s['phase'],'SETTLE')
        self.assertEqual((c.reverse,c.gear,c.throttle,c.brake),(True,-1,0.,1.))

    def test_fresh_repeated_blockage_can_be_observed_at_a_slower_rate(self):
        p=CongestionRecovery(reverse_accepted=True)
        for frame in range(1,44,4):c,s=self.step(p,frame,[track([5.,0.])])
        self.assertEqual(s['action'],'BACK_UP');self.assertEqual(c.brake,1.)

    def test_actual_protective_brake_detects_blockage_even_when_route_requests_throttle(self):
        p=CongestionRecovery(reverse_accepted=True)
        for frame in range(1,43):
            o,b=case(frame,speed=0.)
            o=replace(o,ego=replace(o.ego,brake=1.))
            b=replace(b,throttle=.4,brake=0.)
            command,status=p.evaluate(o,b,motion([track([5.,0.])],o.timestamp_s),Space(),road(),wall=100.)
        self.assertEqual(status['action'],'BACK_UP');self.assertEqual(command.throttle,0.)

    def test_occupied_or_unknown_rear_space_rejects_reverse(self):
        for tracks,space in [([track([5,0]),track([-4,0],ident='2')],Space()),([track([5,0])],Space(False))]:
            c,s=self.blocked(CongestionRecovery(reverse_accepted=True),tracks,space=space)
            self.assertIsNone(c);self.assertTrue(s['rejected'])

    def test_forward_escape_is_chosen_when_holding_creates_rear_intersection(self):
        c,s=self.step(CongestionRecovery(),1,[track([-6.4,0],[1.5,0])])
        self.assertEqual(s['action'],'CLEAR_FORWARD');self.assertGreater(c.throttle,0.)
        self.assertTrue(s['space']['verified']);self.assertEqual(s['rule_exception'],None)

    def test_rear_escape_never_releases_a_front_collision_or_crossing(self):
        for other in (track([3.2,0],ident='2'),track([2.5,3],[0,-2],ident='2')):
            c,s=self.step(CongestionRecovery(reverse_accepted=True),1,[track([-6.4,0],[1.5,0]),other])
            self.assertIsNone(c);self.assertTrue(any(r['reason']=='PREDICTED_INTERSECTION' for r in s['rejected']))

    def test_signal_exception_requires_acceptance_and_is_bounded(self):
        tracks=[track([-6.4,0],[1.5,0])];context=road(traffic_stop='RED_LIGHT')
        c,s=self.step(CongestionRecovery(),1,tracks,context=context);self.assertIsNone(c)
        p=CongestionRecovery(rule_exception_accepted=True);c,s=self.step(p,1,tracks,context=context)
        self.assertEqual(s['action'],'CLEAR_FORWARD');self.assertEqual(s['rule_exception']['maximum_distance_m'],2.)
        self.assertAlmostEqual(s['rule_exception']['expires_timestamp_s'],4.05)
        c,s=self.step(CongestionRecovery(rule_exception_accepted=True),1,tracks,context=road(traffic_stop='RED_LIGHT',junction_ahead=True))
        self.assertIsNone(c);self.assertEqual(s['rejected'][0]['reason'],'TRAFFIC_EXCEPTION_INTERSECTION_UNVERIFIED')

    def test_time_distance_and_settle_restore_forward_gear_without_launching(self):
        p=CongestionRecovery(reverse_accepted=True);self.blocked(p,[track([5,0])])
        p.distance=2.
        c,s=self.step(p,43,[track([5,0])],reverse=True)
        self.assertEqual(s['reason'],'RECOVERY_LIMIT_REACHED');self.assertEqual(c.brake,1.)
        c,s=self.step(p,44,[track([7,0])],reverse=True,speed=.2)
        self.assertEqual(s['phase'],'SETTLE');self.assertTrue(c.reverse)
        c,s=self.step(p,45,[track([7,0])],reverse=True)
        self.assertEqual(s['action'],'REPLAN');self.assertEqual((c.reverse,c.gear,c.throttle,c.brake),(False,1,0.,1.))

    def test_track_uncertainty_and_stale_scene_cancel_active_recovery(self):
        for update in ({'confirmed':False},{'occlusion_s':.2}):
            p=CongestionRecovery();p.intent='CLEAR_FORWARD';p.started=.05;p.phase='CLEARING'
            tr=track([-6.4,0],[1.5,0]);tr.update(update)
            c,s=self.step(p,2,[tr]);self.assertIn(s['reason'],('RECOVERY_TRACK_UNCERTAINTY','NO_VERIFIED_SAFE_ACTION'));self.assertEqual(c.brake,1.)
        p=CongestionRecovery();p.intent='CLEAR_FORWARD';p.started=.05
        c,s=self.step(p,2,[],wall=101.)
        self.assertEqual(s['reason'],'RECOVERY_OBSERVATION_UNAVAILABLE');self.assertEqual(c.throttle,0.)

    def test_disabled_capabilities_cannot_reverse_or_change_lanes(self):
        c,s=self.blocked(CongestionRecovery(),[track([5,0])])
        self.assertIsNone(c);self.assertEqual(s['action'],'FOLLOW')

    def test_lateral_escape_requires_lane_permission_and_checks_applied_steering(self):
        class LeftSpace:
            def certificate(self,path):return {**FREE,'verified':bool(np.asarray(path)[-1,2]<-.01)}
        p=CongestionRecovery(lateral_accepted=True)
        c,s=self.step(p,1,[track([-6.4,0],[1.5,0])],space=LeftSpace())
        self.assertEqual(s['action'],'CLEAR_LEFT');self.assertEqual(c.steering,-.15)
        expected,_=p._path(0.,c.steering,False)
        np.testing.assert_allclose(expected,np.asarray(s['selected_path']))
        c,s=self.step(CongestionRecovery(lateral_accepted=True),1,[track([-6.4,0],[1.5,0])],space=LeftSpace(),context=road(left_allowed=False,right_allowed=False))
        self.assertIsNone(c)

    def test_cancelled_reverse_preserves_gear_until_stopped(self):
        p=CongestionRecovery();p.intent='BACK_UP';p.started=.05;p.phase='REVERSING'
        c,s=self.step(p,2,[],reverse=True,speed=.4,wall=101.)
        self.assertEqual((c.reverse,c.gear,c.throttle,c.brake),(True,-1,0.,1.))

    def test_reverse_odometry_advances_scene_in_the_correct_direction(self):
        old,_=case(1,speed=1.);new,_=case(3,speed=1.)
        old=replace(old,ego=replace(old.ego,reverse=True,angular_velocity_radps=(0,0,0)))
        new=replace(new,ego=old.ego)
        cloud,current=advance_scene((old,np.array([[10.,4.,1.]]),motion([track([10,4])],old.timestamp_s)),new)
        self.assertAlmostEqual(cloud[0,0],10.1);self.assertAlmostEqual(current['tracks'][0]['position_m'][0],10.1)
        tracker=MotionTracker(enhanced=True);tracker.update(np.empty((0,3)),old);tracker.update(np.empty((0,3)),new)
        self.assertAlmostEqual(tracker.origin[0],-.1)


class HealthRecoveryTests(unittest.TestCase):
    def service(self):
        wall=[1.];p=SimpleNamespace(name='test-fixture',stop_navigation=lambda:None)
        s=SimulationService(p,now=lambda:wall[0]);f=packet(speed=0.)
        s.clock.observe(f.world);s._publish(f);o,_=case(speed=0.)
        s.policy_history.frames.append(o);s.safety_observed_at=wall[0]
        s.active_safety=ActiveSafetySupervisor();s.active_safety.last_fault='Fresh complete safety observations unavailable'
        s.arbiter.machine.mode=ControlMode.PAUSED
        return s,wall

    def test_new_complete_fresh_data_clears_old_health_fault_but_keeps_held(self):
        s,_=self.service();s._active_safety_step()
        self.assertIsNone(s.active_safety.last_fault);self.assertEqual(s.active_safety.snapshot()['status'],'STANDBY')
        self.assertEqual(s.arbiter.machine.mode,ControlMode.PAUSED);self.assertEqual(s._choose().brake,1.)

    def test_stale_or_model_failure_is_not_declared_recovered(self):
        s,w=self.service();w[0]+=.251;s._active_safety_step();self.assertIsNotNone(s.active_safety.last_fault)
        s,_=self.service();s.active_safety.last_fault='MODEL_FAILURE: unavailable';s._active_safety_step()
        self.assertEqual(s.active_safety.last_fault,'MODEL_FAILURE: unavailable')

    def test_sensor_rebuild_uses_new_native_registry_and_preserves_test_provider_fallback(self):
        s,_=self.service();s.synchronizer.required=frozenset(('depth','rearDepth'))
        self.assertEqual(s._required_after_sensor_rebuild(),s.synchronizer.required)
        s.provider.required_sensors=('depth',)
        self.assertEqual(s._required_after_sensor_rebuild(),('depth',))


class CoverageTests(unittest.TestCase):
    def test_depth_projection_uses_calibrated_degrees_and_origin(self):
        o,_=case(speed=0.)
        d=next(c for c in o.channels if c.kind==SensorKind.DEPTH)
        calibration={**d.calibration,'width':3,'height':3,'fov_deg':90.,
            'mount_transform':{'position_m':[-2.,0.,1.], 'rotation_deg':{'roll':0.,'pitch':-30.,'yaw':180.}}}
        d=replace(d,calibration=calibration)
        buf=io.BytesIO();np.save(buf,np.full((3,3),2.,np.float32))
        points,origin=depth_surfaces(replace(o,channels=tuple(d if c.kind==SensorKind.DEPTH else c for c in o.channels)),lambda a:buf.getvalue())[0]
        ray=np.array([1.,-1/1.5,1/1.5])*2.
        # Native mount x points backwards/down; camera z points back/up.
        expected=np.array([-2.,0.,1.])+np.array([[-np.sqrt(3)/2,0.,-.5],[0.,-1.,0.],[-.5,0.,np.sqrt(3)/2]])@ray
        np.testing.assert_allclose(points[0],expected,atol=1e-6)
        np.testing.assert_allclose(origin,[-2.,0.,1.])

    def test_new_ground_returns_never_erase_existing_occupied_cells(self):
        obstacle=np.array([[-5.,0.,1.]])
        ground=np.array([[-5.,0.,0.]])
        space=ObservedSpace(obstacle,VehicleGeometry(),measured_surfaces=[(ground,[-2.,0.,1.])])
        i=space.indices([[-5.,0.]])[0]
        self.assertTrue(space.occupied[tuple(i)]);self.assertFalse(space.free[tuple(i)])

    def test_own_returns_do_not_remove_measured_free_cells_outside_body(self):
        g=VehicleGeometry()
        ground=np.array([[x,y,0.] for x in np.arange(-4,4.1,.25) for y in np.arange(-2,2.1,.25)])
        own=np.array([[1.,.8,.8],[-1.,-.8,.7]])
        a=ObservedSpace(ground,g);b=ObservedSpace(np.vstack((ground,own)),g)
        np.testing.assert_array_equal(a.free,b.free);np.testing.assert_array_equal(a.occupied,b.occupied)

    def test_stopping_tail_is_included_even_after_an_even_length_path(self):
        g=VehicleGeometry();space=ObservedSpace(np.empty((0,3)),g)
        path=np.zeros((32,4));path[-1,1]=-5.
        self.assertFalse(space.certificate(path)['verified'])


if __name__=='__main__':unittest.main()
