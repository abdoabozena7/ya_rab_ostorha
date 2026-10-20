"""Sensor bytes to frozen candidates and applied safety proposals, without free-space mocks."""
from dataclasses import replace
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock,patch
import numpy as np
import io
from backend.core.control_scene import ControlSceneBuilder
from backend.core.contracts import CommandSource,SensorKind
from backend.core.maneuver_candidates import CandidateGenerator,CANDIDATE_IDS,ExecutionShield,signed_path
from backend.core.maneuver import ObservedSpace
from backend.core.motion_geometry import VehicleGeometry
from backend.learning.pilot_budget import PilotBudget,active_ticket
from backend.learning.rl.maneuver_reward import ManeuverReward
from backend.core.reposition_lease import RepositionLease
from backend.learning.pilot_acceptance import validate
from tests.test_safety_teacher import case
from tests.test_active_safety import scene


class ControlSceneTests(unittest.TestCase):
    def test_volume_presentation_runs_after_control_scene_publication_using_immutable_sensor_support(self):
        from backend.core.display_prediction import measured_control_view
        with patch('backend.core.visual_geometry.measured_boxes',return_value=[]) as boxes:
            measured,_,_=self.measured()
            boxes.assert_not_called()
            self.assertNotIn('boxes_3d',measured.prediction)
            self.assertFalse(measured.space.visual_points.flags.writeable)
            view=measured_control_view(measured,{'position_m':[0.,0.,0.]},focused=True)
            boxes.assert_called_once()
            self.assertIs(boxes.call_args.args[0],measured.prediction)
            self.assertIs(boxes.call_args.args[1],measured.space.visual_points)
            self.assertIs(boxes.call_args.kwargs['lidar_points'],measured.points)
            self.assertEqual(view['evaluation_frame'],measured.observation.frame_id)
            self.assertEqual(view['visual_version'],1)

    def test_forward_assessment_reuses_same_frame_depth_decode(self):
        from backend.core.active_safety import assess_forward_space,RuntimeSafetyConfig
        measured,base,reader=self.measured()
        calls=[]
        def lidar_only(asset):
            calls.append(asset.path)
            if asset.path in measured.space.depth_images:raise AssertionError('Duplicate depth read')
            return reader(asset)
        assess_forward_space(measured.observation,lidar_only,RuntimeSafetyConfig.load(),
            geometry=measured.geometry,measured_space=measured.space)
        self.assertTrue(calls)
        self.assertTrue(all(not image.flags.writeable for image in measured.space.depth_images.values()))

    def test_same_frame_forward_brake_does_not_become_a_reverse_sensor_fault(self):
        from backend.core.service import SimulationService
        from backend.core.active_safety import ActiveSafetySupervisor
        from backend.core.control import ControlMode
        from types import SimpleNamespace
        o,b=case(distance=8.,velocity=-8.)
        o,reader=scene(o)
        clock=[100.]
        provider=Mock(sensor_suite=False);provider.allow_navigation=False;provider.get_sensor_asset=reader
        service=SimulationService(provider,now=lambda:clock[0]);service.active_safety=ActiveSafetySupervisor()
        service.policy_history.frames.append(o);service.safety_observed_at=100.;service.state_at=100.
        service.clock.timestamp_s=o.timestamp_s;service.observation=SimpleNamespace(frame_id=o.frame_id,timestamp_s=o.timestamp_s)
        service._live=lambda:True
        service.arbiter.machine.mode=ControlMode.MANUAL
        forward=replace(b,source=CommandSource.MANUAL)
        service.arbiter.submit(forward,frame_id=o.frame_id,timestamp_s=o.timestamp_s,connected=True)
        service._active_safety_step();self.assertIsNotNone(service.safety_command)
        clock[0]+=.025
        reverse=replace(forward,reverse=True,gear=-1)
        service.arbiter.submit(reverse,frame_id=o.frame_id,timestamp_s=o.timestamp_s,connected=True)
        service._active_safety_step()
        self.assertEqual(service.arbiter.machine.mode,ControlMode.MANUAL)
        self.assertIsNone(service.safety_command);self.assertIsNone(service.active_safety.last_fault)
        self.assertEqual(service.active_safety.status['status'],'FORWARD_ONLY')

    def measured(self,*,frame=1,obstacle=False):
        o,b=case(frame,distance=None,speed=0.)
        o,reader=scene(o,clear=True,obstacle=obstacle)
        depth=next(c for c in o.channels if c.kind==SensorKind.DEPTH)
        depth=replace(depth,calibration={**dict(depth.calibration),'width':80,'height':45,'fov_deg':90.})
        o=replace(o,channels=tuple(depth if c.kind==SensorKind.DEPTH else c for c in o.channels))
        encoded=io.BytesIO();np.save(encoded,np.full((45,80),1000.,np.float32),allow_pickle=False)
        lidar_reader=reader;reader=lambda asset:encoded.getvalue() if asset==depth.asset else lidar_reader(asset)
        builder=ControlSceneBuilder('test')
        measured=builder.build(o,reader,received_wall_s=100.)
        return measured,replace(b,throttle=.2,brake=0.,steering=0.),reader

    def test_frozen_scene_does_not_follow_mutable_display_forecasts(self):
        measured,base,_=self.measured()
        old=measured.legacy_scene();old[2]['tracks'].append({'display':True})
        self.assertNotEqual(len(old[2]['tracks']),len(measured.prediction['tracks']))
        with self.assertRaises(TypeError):measured.prediction['timestamp_s']=2.
        with self.assertRaises(ValueError):measured.points[0,0]=100.
        self.assertFalse(measured.usable(.2,100.))

    def test_rule_geometry_omits_forecasts_but_preserves_measured_coverage(self):
        full,base,reader=self.measured()
        builder=ControlSceneBuilder('test')
        builder.engine.evaluate=Mock(side_effect=AssertionError('RULE must not wait for hybrid forecasts'))
        geometry=builder.build(full.observation,reader,received_wall_s=100.,track_motion=False)
        path=signed_path(.5,0.,0.,full.geometry)
        self.assertEqual(geometry.space.certificate(path)['verified'],full.space.certificate(path)['verified'])
        self.assertFalse(geometry.prediction['motion_tracking_complete'])
        self.assertEqual(geometry.prediction['tracks'],())
        self.assertEqual(geometry.received_wall_s,full.received_wall_s)
        self.assertFalse(geometry.usable(full.observation.timestamp_s,100.251))

    def test_sensor_geometry_can_admit_forward_and_reject_unobserved_reverse(self):
        measured,base,_=self.measured()
        road={'session_id':'test','centerline':[[0.,0.],[50.,0.]],'junction_ahead':False,'lane_width_m':3.5}
        bundle=CandidateGenerator().build(measured,base,road,'MANUAL_PROTECTION',1.,wall_s=100.)
        self.assertEqual(tuple(c['id'] for c in bundle.candidates),CANDIDATE_IDS)
        self.assertTrue(bundle.candidates[1]['admitted'])
        # A held gear selection is admissible; unobserved reverse movement is not.
        self.assertTrue(bundle.candidates[10]['admitted'])
        self.assertEqual(bundle.candidates[10]['command']['brake'],1.)
        confirmed=replace(measured,observation=replace(measured.observation,
            ego=replace(measured.observation.ego,reverse=True,gear=-1)))
        after=CandidateGenerator().build(confirmed,replace(base,reverse=True,gear=-1),road,'MANUAL_PROTECTION',1.,wall_s=100.)
        self.assertFalse(after.candidates[10]['admitted'])
        self.assertEqual(after.candidates[10]['reason'],'SWEPT_SPACE_UNKNOWN_OR_OCCUPIED')
        masks=bundle.masks;masks[:]=False;self.assertTrue(bundle.masks.any())

    def test_disconnected_far_ground_is_not_a_continuous_corridor(self):
        g=VehicleGeometry()
        points=np.array([[35.,y,0.] for y in np.arange(-2.,2.1,.25)])
        observed=ObservedSpace(points,g)
        path=np.column_stack((np.arange(21),np.arange(21)*.5,np.zeros((21,2))))
        self.assertLess(observed.continuous_coverage(path),1.)

    def test_full_body_reverse_turn_and_signed_transforms(self):
        g=VehicleGeometry();path=signed_path(.5,.4,0.,g,True)
        self.assertLess(path[-1,1],0.);self.assertGreater(path[-1,2],0.);self.assertLess(path[-1,3],0.)
        points=np.array([[x,y,0.] for x in np.arange(-10,10,.25) for y in np.arange(-10,10,.25)])
        space=ObservedSpace(points,g)
        self.assertTrue(space.certificate(path)['verified'])
        obstacle=np.array([[path[-1,1]-2.5,path[-1,2]+.8,.8]])
        blocked=ObservedSpace(np.vstack((points,obstacle)),g)
        self.assertFalse(blocked.certificate(path)['verified'])

    def test_roll_back_is_measured_even_while_forward_gear_is_selected(self):
        from backend.core.prediction import MotionTracker
        from backend.core.ego_motion import signed_speed
        o,_=case(1,speed=1.,distance=None)
        o=replace(o,ego=replace(o.ego,reverse=False,gear=1,longitudinal_speed_mps=-1.,angular_velocity_radps=(0.,0.,0.)))
        tracker=MotionTracker(enhanced=True)
        tracker.update(np.empty((0,3)),o)
        current=replace(o,frame_id=2,timestamp_s=o.timestamp_s+.05,
            channels=tuple(replace(c,frame_id=2,timestamp_s=c.timestamp_s+.05,sensor_timestamp_s=c.sensor_timestamp_s+.05) for c in o.channels))
        tracker.update(np.empty((0,3)),current)
        self.assertEqual(signed_speed(o.ego),-1.);self.assertAlmostEqual(tracker.origin[0],-.05)

    def test_crashed_pilot_reservations_remain_charged_and_old_ledgers_not_needed(self):
        with tempfile.TemporaryDirectory() as root:
            budget=PilotBudget(root);ticket=budget.reserve('control',2700.)
            budget.publish_ticket(ticket)
            self.assertIsNotNone(active_ticket(root=root))
            with self.assertRaises(ValueError):budget.reserve('control',1.)
            self.assertEqual(budget.status()['charged_s'],2700.)
            budget.finish(ticket);self.assertIsNone(active_ticket(root=root))
            with self.assertRaises(ValueError):budget.finish(ticket)

    def test_authorized_phase_transfer_preserves_total_and_charged_reservations(self):
        with tempfile.TemporaryDirectory() as root:
            budget=PilotBudget(root)
            with self.assertRaises(ValueError):budget.reallocate('rl','control',1200.,'')
            status=budget.reallocate('rl','control',1200.,'User-approved test transfer')
            self.assertEqual(sum(status['phase_caps_s'].values()),14400.)
            self.assertEqual(status['phase_caps_s']['control'],3900.)
            self.assertEqual(status['phase_caps_s']['rl'],4200.)
            ticket=budget.reserve('control',3900.);budget.publish_ticket(ticket)
            with self.assertRaises(ValueError):budget.reallocate('control','rl',1.,'Test transfer')
            with self.assertRaises(ValueError):budget.reserve('control',1.)
            self.assertEqual(budget.status()['phase_charged_s']['control'],3900.)
            self.assertIsNotNone(active_ticket(root=root))
            budget.finish(ticket)
            used=budget.status()['phase_charged_s']['control']
            with self.assertRaises(ValueError):budget.reallocate('control','rl',3900.,'Cannot revoke charged time')
            self.assertEqual(budget.status()['phase_charged_s']['control'],used)
            self.assertIsNone(active_ticket(root=root))

    def test_progress_loops_and_completion_cannot_harvest_reward(self):
        reward=ManeuverReward(10.)
        positive=0.
        for _ in range(20):
            for progress in (10.,0.):
                value,parts=reward.evaluate(progress_m=progress,dt=.1,completed=progress==10.)
                positive+=sum(max(0.,x) for x in parts.values())
        self.assertLessEqual(positive,30.)
        value,parts=reward.evaluate(progress_m=10.,dt=.1,collision='VULNERABLE')
        self.assertEqual(parts['collision'],-200.);self.assertLess(value,-100.)

    def test_reposition_limits_survive_action_reselection_and_require_settling(self):
        from types import SimpleNamespace
        ego=SimpleNamespace(speed_mps=.5,reverse=True)
        lease=RepositionLease();self.assertTrue(lease.allow('REVERSE_LEFT',ego,0.)[0])
        lease.observe(2.)
        self.assertFalse(lease.allow('REVERSE_LEFT',ego,1.)[0]);self.assertEqual(lease.phase,'SETTLING')
        self.assertFalse(lease.allow('CONTINUE',ego,1.1)[0])
        ego.speed_mps=0.;ego.reverse=False
        self.assertFalse(lease.allow('CONTINUE',ego,1.2)[0])
        self.assertTrue(lease.allow('CONTINUE',ego,1.3)[0])
        self.assertFalse(lease.allow('REVERSE_LEFT',ego,1.4)[0])

    def test_missing_invalid_stationary_and_unfrozen_results_fail_behavioral_admission(self):
        manifest={'cases':[{'case_id':str(i),'group':'ordinary','mode':'AUTONOMOUS'} for i in range(10)]}
        result=validate(manifest,{'cases':[{'case_id':str(i),'outcome':'SUCCESS','scenario_valid':True,
            'complete_episode':True,'contacts':0,'native_distance_m':0.,'maximum_unexplained_stop_s':0.} for i in range(10)]})
        self.assertFalse(result['accepted']);self.assertFalse(result['gates']['ordinary'])
        self.assertFalse(result['gates']['frozen_test']);self.assertFalse(result['gates']['prediction'])


if __name__=='__main__':unittest.main()
