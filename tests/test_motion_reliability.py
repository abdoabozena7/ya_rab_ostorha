import tempfile
import unittest
from dataclasses import replace
from unittest.mock import patch
import numpy as np
from backend.core.motion_geometry import VehicleGeometry,integrate,path_coordinates,minimum_clearance,footprint_centers
from backend.core.kinematic_prediction import kinematic_modes,rank_learned_modes
from backend.core.motion_quality import MotionQuality
from backend.core.motion_scene import advance_scene
from backend.core.maneuver import ObservedSpace,ManeuverPlanner,route_path
from backend.learning.motion_budget import MotionBudget
from backend.core.prediction import PredictionEngine
from backend.learning.motion_selector import features,fit,apply
from tests.test_safety_teacher import case
from tests.test_predictive_v2 import track


FREE={'verified':True,'known_percent':100.,'occupied':False,'unknown_cells':0,'source':'EXPLICIT_UNIT_FIXTURE'}


def motion(tracks,stamp):
    return {'session_id':'s','timestamp_s':stamp,'published_wall_s':100.,'tracks':tracks,
        'trajectories':kinematic_modes(tracks),'measured_trajectories':kinematic_modes(tracks)}


def road(**kw):
    return dict({'session_id':'s','centerline':[[0.,0.],[50.,0.]],'lane_width_m':3.5,
        'junction_ahead':False,'left_allowed':True,'right_allowed':True,'traffic_stop':None},**kw)


class GeometryTests(unittest.TestCase):
    def test_coverage_stops_at_first_body_obstacle_or_unknown_slice_without_skipping_islands(self):
        geometry=VehicleGeometry(2.,2.,1.,2.8,.6)
        path=np.column_stack((np.arange(0.,11.,.5),np.arange(0.,11.,.5),np.zeros(22),np.zeros(22)))
        space=ObservedSpace(np.empty((0,3)),geometry)
        space.free[:]=True;space.measured_free[:]=True
        self.assertEqual(space.continuous_coverage(path),10.5)
        x,y=space.indices([[8.,0.]])[0];space.occupied[x,y]=True
        self.assertEqual(space.continuous_coverage(path),5.5)
        space.occupied[:]=False
        x,y=space.indices([[5.,0.]])[0];space.free[x,y]=False;space.measured_free[x,y]=False
        self.assertEqual(space.continuous_coverage(path),2.5)

    def test_real_dimensions_change_turn_radius_and_footprint(self):
        g=VehicleGeometry(2.,1.8,.9,3.4,.45,'ONBOARD_FIXTURE')
        self.assertAlmostEqual(g.half[0],1.9)
        self.assertLess(integrate(8,.3,geometry=g)[-1,2],integrate(8,.3)[-1,2])
        for values in ((0,2,1,2,.6),(2,2,1,2,float('nan'))):
            with self.assertRaises(ValueError):VehicleGeometry(*values)

    def test_curved_corridor_follows_ordered_path_not_straight_proximity(self):
        p=integrate(6,.3);x,y=p[20,1:3]
        along,lateral=path_coordinates([x,x],[y,y+5],p)
        self.assertLess(lateral[0],1e-6);self.assertGreater(lateral[1],2.)

    def test_clearance_uses_entire_asymmetric_body_at_equal_times(self):
        g=VehicleGeometry(3.,1.,1.,2.8,.6);p=footprint_centers(integrate(0.,0.,geometry=g),g)
        target=np.tile([5.,0.],(31,1))
        self.assertAlmostEqual(minimum_clearance(target,[.5,.5],p,g.half),1.3)
        target[:,0]=3.6
        self.assertEqual(minimum_clearance(target,[.5,.5],p,g.half),0.)
        target[:,0]=1.;target[:,1]=3.
        p=integrate(0.,0.,geometry=g);p[:,3]=np.pi/2;p=footprint_centers(p,g)
        self.assertEqual(minimum_clearance(target,[.5,.5],p,g.half),0.)

    def test_scene_rotation_keeps_conservative_box_and_local_heading(self):
        old,_=case(1,speed=0);new,_=case(3,speed=0)
        old=replace(old,ego=replace(old.ego,angular_velocity_radps=(0,0,1.)))
        new=replace(new,ego=old.ego);tr=track([10.,4.],[2.,0.]);tr['half_size_m']=[2.,.5]
        _,current=advance_scene((old,np.empty((0,3)),motion([tr],old.timestamp_s)),new)
        transformed=current['tracks'][0]
        self.assertAlmostEqual(transformed['heading_rad'],-.1)
        self.assertGreater(transformed['half_size_m'][1],.5)

    def test_scene_advancement_compensates_ego_translation(self):
        old,_=case(1,speed=2);new,_=case(3,speed=2)
        old=replace(old,ego=replace(old.ego,angular_velocity_radps=(0,0,0)))
        new=replace(new,ego=old.ego)
        tr=track([10.,4.]);p=motion([tr],old.timestamp_s)
        points,current=advance_scene((old,np.array([[10.,4.,1.]]),p),new)
        self.assertAlmostEqual(points[0,0],9.8);self.assertAlmostEqual(current['tracks'][0]['position_m'][0],9.8)
        stale,_=case(6,speed=2)
        with self.assertRaises(ValueError):advance_scene((old,points,p),stale)


class ForecastTests(unittest.TestCase):
    def test_stationary_noise_does_not_become_a_moving_forecast(self):
        tr=track([7.,4.],[.09,-.1]);m=kinematic_modes([tr])
        self.assertEqual(len(m),1);self.assertEqual(m[0]['source'],'STATIONARY')
        np.testing.assert_allclose(np.asarray(m[0]['points'])[:,1:3],np.tile([7.,4.],(31,1)))

    def test_acceleration_and_turn_modes_are_distinct_and_braking_never_reverses(self):
        tr=track([10,4],[4,0]);tr.update(consecutive_observations=8,turn_rate_radps=.3,acceleration_mps2=[-3,0])
        modes=kinematic_modes([tr]);self.assertEqual(len(modes),3)
        braking=np.asarray(modes[1]['points']);self.assertTrue(np.all(np.diff(braking[:,1])>=0))
        self.assertGreater(modes[2]['points'][-1][2],4)

    def test_remote_and_static_learned_modes_rejected_without_fake_probabilities(self):
        tr=track([10,3],[0,0]);bad={'track_id':'1','mode':1,'points':[[0,10,3],[1,12,3],[3,18,3]]}
        good={**bad,'mode':2,'points':[[0,10,3],[1,10,3],[3,10,3]]}
        accepted,rejected=rank_learned_modes([bad,good],[tr])
        self.assertEqual(accepted[0]['mode'],2);self.assertIsNone(accepted[0]['probability'])
        self.assertEqual(rejected[0]['reason'],'MEASURED_STATIONARY_OBJECT')

    def test_delayed_scores_require_future_measurements_and_report_missing(self):
        q=MotionQuality();tr=track([10,0],[1,0]);tr['history']=[[0,10,0,1,0]]
        self.assertEqual(q.update(0,[tr],kinematic_modes([tr]),np.zeros(2),0)['horizons']['1']['samples'],0)
        tr['history']=[[0,10,0,1,0],[1,11,0,1,0]];tr['position_m']=[11,0]
        score=q.update(1,[tr],kinematic_modes([tr]),np.zeros(2),0)
        self.assertEqual(score['horizons']['1']['fde_m'],0.)
        score=q.update(3,[],[],np.zeros(2),0);self.assertGreater(score['unobservable_samples'],0)

    def test_registered_stationary_cluster_survives_ego_rotation(self):
        from backend.core.prediction import MotionTracker,rotation
        rng=np.random.default_rng(42);fixed=rng.uniform(-.2,.2,(40,3))+[12,4,1]
        tracker=MotionTracker(enhanced=True);ids=[]
        for i in range(9):
            o,_=case(i+1,speed=0);o=replace(o,ego=replace(o.ego,angular_velocity_radps=(0,0,.2)))
            cloud=fixed.copy();cloud[:,:2]=cloud[:,:2]@rotation(-.2*.05*i).T
            tracks=tracker.update(cloud,o);ids.append(tracks[0]['id'])
        self.assertEqual(len(set(ids)),1);self.assertLess(np.linalg.norm(tracks[0]['velocity_mps']),.05)

    def test_fast_surface_displacement_does_not_freeze_anchor_or_rebirth_identity(self):
        from backend.core.prediction import MotionTracker
        rng=np.random.default_rng(42);cloud=rng.uniform(-.2,.2,(40,3))+[8,4,1]
        tracker=MotionTracker(enhanced=True);ids=[]
        for i in range(12):
            o,_=case(1+2*i,speed=0);o=replace(o,ego=replace(o.ego,angular_velocity_radps=(0,0,0)))
            points=cloud.copy();points[:,0]+=.8*i
            result=tracker.update(points,o);ids.append(result[0]['id'])
        self.assertEqual(len(set(ids)),1);self.assertTrue(result[0]['confirmed'])
        self.assertAlmostEqual(result[0]['velocity_mps'][0],8.,delta=.3)


class ManeuverTests(unittest.TestCase):
    def evaluate(self,tracks,*,speed=4,context=None,lateral=True):
        o,b=case(speed=speed);o=replace(o,ego=replace(o.ego,angular_velocity_radps=(0,0,0)))
        planner=ManeuverPlanner(lateral_accepted=lateral)
        with patch.object(ObservedSpace,'certificate',return_value=FREE):
            command,status=planner.evaluate(o,b,motion(tracks,o.timestamp_s),np.empty((0,3)),context or road(),30/3.6,wall=100.)
        return command,status

    def test_parallel_pedestrian_and_adjacent_car_do_not_command_braking(self):
        for tr in (track([8,4],[1,0]),track([-4,3],[6,0])):
            cmd,status=self.evaluate([tr]);self.assertEqual(status['action'],'CONTINUE');self.assertEqual(cmd.brake,0.)

    def test_crossing_front_has_a_collision_protective_action(self):
        cmd,status=self.evaluate([track([7,3],[0,-3])],context=road(left_allowed=False,right_allowed=False))
        self.assertGreater(cmd.brake,0);self.assertNotEqual(status['action'],'ACCELERATE')

    def test_rear_approach_accelerates_only_with_verified_empty_forward_path(self):
        cmd,status=self.evaluate([track([-8,0],[8,0])],speed=3)
        self.assertEqual(status['action'],'ACCELERATE');self.assertGreater(cmd.throttle,0.)
        cmd,status=self.evaluate([track([-8,0],[8,0]),track([5,0])],speed=3,context=road(left_allowed=False,right_allowed=False))
        self.assertNotEqual(status['action'],'ACCELERATE');self.assertEqual(cmd.throttle,0)

    def test_traffic_light_vetoes_rear_escape(self):
        cmd,status=self.evaluate([track([-8,0],[8,0])],context=road(traffic_stop='RED_LIGHT'))
        self.assertEqual(status['action'],'RULE_STOP');self.assertEqual(cmd.brake,1.)

    def test_unknown_space_never_certifies_a_maneuver(self):
        g=VehicleGeometry();space=ObservedSpace(np.empty((0,3)),g)
        self.assertFalse(space.certificate(integrate(4,0))['verified'])
        o,b=case(speed=3);p=ManeuverPlanner(lateral_accepted=True)
        cmd,status=p.evaluate(o,b,motion([track([-8,0],[8,0])],o.timestamp_s),np.empty((0,3)),road(),8.,wall=100.)
        self.assertNotEqual(status['action'],'ACCELERATE')
        self.assertTrue(any(r['reason']=='SURROUNDING_SPACE_UNKNOWN_OR_OCCUPIED' for r in status['rejected']))

    def test_lateral_acceptance_is_explicit_and_old_scene_stops(self):
        _,status=self.evaluate([track([14,0])],lateral=False)
        self.assertTrue(any(r['reason']=='LATERAL_NATIVE_ACCEPTANCE_PENDING' for r in status['rejected']))
        o,b=case();p=ManeuverPlanner();prediction=motion([],o.timestamp_s-.5)
        cmd,status=p.evaluate(o,b,prediction,np.empty((0,3)),road(),8.,wall=100.)
        self.assertEqual(cmd.brake,1.);self.assertEqual(status['reason'],'FRESH_MOTION_REQUIRED')

    def test_planning_reuses_only_inside_tenth_second_with_new_command_identity(self):
        p=ManeuverPlanner();o,b=case(1,speed=4)
        with patch.object(ObservedSpace,'certificate',return_value=FREE):
            p.evaluate(o,b,motion([],o.timestamp_s),np.empty((0,3)),road(),8.,wall=100.)
            newer,base=case(2,speed=4)
            command,status=p.evaluate(newer,base,motion([],newer.timestamp_s),np.empty((0,3)),road(),8.,wall=100.)
        self.assertTrue(status['planning_reused']);self.assertEqual(command.frame_id,newer.frame_id)

    def test_expired_lateral_ticket_and_unknown_return_keep_current_steering(self):
        p=ManeuverPlanner(lateral_accepted=True);p.lateral_deadline=99.;p.phase='RETURN';p.offset=-3.5
        o,b=case(speed=4)
        command,status=p.evaluate(o,b,motion([],o.timestamp_s),np.empty((0,3)),road(centerline=[[0,3.5],[50,3.5]]),8.,wall=100.)
        self.assertFalse(p.lateral_accepted);self.assertEqual(status['action'],'BRAKE')
        self.assertEqual(command.steering,o.ego.steering)

    def test_lidar_self_returns_do_not_count_as_an_external_obstacle(self):
        g=VehicleGeometry();space=ObservedSpace(np.array([[1.,0.,.6],[-1.,0.,.7]]),g)
        self.assertFalse(space.occupied[space.indices([[1.,0.]])[0,0],space.indices([[1.,0.]])[0,1]])


class SupervisedTests(unittest.TestCase):
    def test_validation_selects_fit_and_outputs_are_not_probabilities(self):
        tr=track([10,4],[2,0]);x=np.tile(features(tr),(30,1));y=np.tile([1,0,0,.2,0],(30,1))
        w,metrics=fit(x,y,x,y);self.assertLess(metrics['validation_mse'],.1)
        mode=apply(w,tr,kinematic_modes([tr]))[0];self.assertIsNone(mode['probability']);self.assertFalse(mode['control_accepted'])
        with self.assertRaises(ValueError):fit(x[:2],y[:2],x,y)


class BudgetTests(unittest.TestCase):
    def test_new_limits_and_crashed_reservations_are_independent(self):
        with tempfile.TemporaryDirectory() as directory:
            b=MotionBudget(directory+'/new.sqlite');b.reserve('training',600)
            with self.assertRaises(ValueError):b.reserve('training',1)
            self.assertEqual(b.status()['charged_s'],600.)
            b.reserve('validation',1800)
            with self.assertRaises(ValueError):b.reserve('validation',1)


if __name__=='__main__':unittest.main()
