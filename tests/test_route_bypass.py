from dataclasses import replace
import unittest
from backend.core.route_bypass import RuleRouteBypass
from tests.test_control_scene import ControlSceneTests
from tests.test_safety_teacher import case


class RouteBypassTests(unittest.TestCase):
    def test_unreachable_optional_detour_is_rejected_without_losing_turn_state(self):
        from backend.carla.routes import RouteService
        from types import SimpleNamespace
        from unittest.mock import Mock
        routes=RouteService(None,None)
        routes.planner=SimpleNamespace(_previous_decision='KEEP',_intersection_end_node=7)
        def unreachable(origin,target):
            routes.planner._previous_decision='TRANSIENT'
            raise ValueError('Native route does not reach the selected road waypoint')
        routes.plan=Mock(side_effect=unreachable)
        self.assertIsNone(routes.alternative('origin','destination','blocked'))
        self.assertEqual(routes.planner._previous_decision,'KEEP')
        self.assertEqual(routes.planner._intersection_end_node,7)

    def setUp(self):
        self.scene,_,_=ControlSceneTests().measured()

    def sample(self,frame,speed,closing,distance=18.,ready=True):
        observation,_=case(frame,speed=speed,distance=None)
        p=dict(self.scene.prediction);p.update(motion_tracking_complete=ready,
            tracks=[{'id':'side','confirmed':True,'position_m':[10.,8.],'half_size_m':[.5,.5],
                     'velocity_mps':[0.,0.],'occlusion_s':0.}])
        scene=replace(self.scene,observation=observation,prediction=p,received_wall_s=100.,published_wall_s=100.)
        return scene,{'timestamp_s':observation.timestamp_s,'measured_range_m':distance,'closing_speed_mps':closing}

    def test_moving_lead_vehicle_is_not_a_stationary_bypass_target(self):
        bypass=RuleRouteBypass(self.scene.geometry)
        for frame in range(1,25):
            scene,status=self.sample(frame,4.,1.)
            bypass.observe(scene,status,wall=100.)
        self.assertFalse(bypass.motion_required)

    def test_distance_history_can_warm_tracking_when_doppler_is_unavailable(self):
        bypass=RuleRouteBypass(self.scene.geometry)
        for frame in range(1,25):
            scene,status=self.sample(frame,4.,None,distance=18.-frame*.2)
            bypass.observe(scene,status,wall=100.)
        self.assertTrue(bypass.arming)
        self.assertFalse(bypass.engaged)

    def test_startup_measurement_is_bounded_and_does_not_keep_an_empty_road_slow(self):
        bypass=RuleRouteBypass(self.scene.geometry)
        self.assertTrue(bypass.motion_required)
        for frame in range(1,20):
            scene,status=self.sample(frame,0.,None,distance=None)
            bypass.observe(scene,status,wall=100.)
        self.assertFalse(bypass.preparing)
        self.assertFalse(bypass.motion_required)

    def test_stationary_target_warms_tracking_and_waits_for_low_speed(self):
        bypass=RuleRouteBypass(self.scene.geometry)
        for frame in range(1,12):
            scene,status=self.sample(frame,4.,4.)
            bypass.observe(scene,status,wall=100.)
        self.assertTrue(bypass.arming);self.assertFalse(bypass.engaged)
        scene,status=self.sample(12,1.5,1.5,ready=False)
        bypass.observe(scene,status,wall=100.)
        self.assertFalse(bypass.engaged)
        scene,status=self.sample(13,1.5,1.5)
        p={**scene.prediction,'odometry_origin_m':[0.,0.],'odometry_yaw_rad':0.,
            'tracks':[{'id':'front','confirmed':True,'position_m':[18.,0.],'half_size_m':[2.,1.],
                       'velocity_mps':[0.,0.],'occlusion_s':0.}]}
        scene=replace(scene,prediction=p)
        bypass.observe(scene,status,wall=100.)
        self.assertTrue(bypass.engaged)
        self.assertFalse(bypass.driver.allow_reverse)

    def test_side_track_and_front_range_alone_cannot_start_an_unanchored_pass(self):
        bypass=RuleRouteBypass(self.scene.geometry)
        for frame in range(1,30):
            scene,status=self.sample(frame,0.,None,distance=8.)
            bypass.observe(scene,status,wall=100.)
        self.assertTrue(bypass.arming);self.assertFalse(bypass.engaged)

    def test_red_signal_and_missing_target_do_not_start_a_pass(self):
        bypass=RuleRouteBypass(self.scene.geometry)
        for frame in range(1,25):
            scene,status=self.sample(frame,0.,None)
            bypass.observe(scene,status,wall=100.,traffic_stop=True)
        self.assertFalse(bypass.motion_required)
        for frame in range(25,50):
            scene,status=self.sample(frame,0.,None,distance=None)
            bypass.observe(scene,status,wall=100.)
        self.assertFalse(bypass.engaged)

    def test_crossing_person_is_a_protected_wait_not_a_passing_target(self):
        for classified in (True,False):
            bypass=RuleRouteBypass(self.scene.geometry)
            for frame in range(1,30):
                scene,status=self.sample(frame,0.,None,distance=8.)
                if classified:
                    person={**scene.prediction['tracks'][0],'class':'person','position_m':[8.,0.]}
                    scene=replace(scene,prediction={**scene.prediction,'tracks':[person]})
                else:status['pedestrian_prediction']={'source':'PEDESTRIAN_POSSIBLE_START'}
                bypass.observe(scene,status,wall=100.)
            self.assertFalse(bypass.arming);self.assertFalse(bypass.engaged)

    def test_short_classification_gap_does_not_turn_a_crossing_into_a_passing_target(self):
        bypass=RuleRouteBypass(self.scene.geometry)
        scene,status=self.sample(1,0.,None,distance=8.)
        person={**scene.prediction['tracks'][0],'class':'person','position_m':[10.,3.8]}
        scene=replace(scene,prediction={**scene.prediction,'tracks':[person]})
        bypass.observe(scene,status,wall=100.)
        for frame in range(2,60):
            scene,status=self.sample(frame,0.,None,distance=8.)
            bypass.observe(scene,status,wall=100.)
        self.assertFalse(bypass.arming);self.assertFalse(bypass.engaged)

    def test_completed_pass_releases_to_the_ordinary_route_without_reverse(self):
        bypass=RuleRouteBypass(self.scene.geometry);bypass.engaged=True
        bypass.driver.completed_maneuvers=['LANE_CHANGE','PASS_RETURN']
        scene,status=self.sample(20,1.,None)
        self.assertTrue(bypass.observe(scene,status,wall=100.))
        self.assertFalse(bypass.motion_required)
        self.assertGreater(bypass.cooldown_until,scene.observation.timestamp_s)

    def test_native_route_pass_requires_measured_travel_past_the_blocker(self):
        import numpy as np
        bypass=RuleRouteBypass(self.scene.geometry);bypass.engaged=True
        bypass.target_anchor=(np.array([10.,0.]),[2.,1.])
        scene,status=self.sample(20,1.,None)
        prediction={**scene.prediction,'odometry_origin_m':[0.,0.],'odometry_yaw_rad':0.}
        scene=replace(scene,prediction=prediction)
        self.assertFalse(bypass.observe(scene,status,wall=100.))
        prediction={**prediction,'odometry_origin_m':[18.,0.]}
        scene=replace(scene,prediction=prediction)
        self.assertTrue(bypass.observe(scene,status,wall=100.))
        self.assertIn('ROUTE_BYPASS',bypass.driver.completed_maneuvers)

    def test_target_confirmed_after_engagement_is_retained_for_completion(self):
        bypass=RuleRouteBypass(self.scene.geometry);bypass.engaged=True
        scene,status=self.sample(20,1.,None)
        prediction={**scene.prediction,'odometry_origin_m':[0.,0.],'odometry_yaw_rad':0.,
            'tracks':[{'id':'front','confirmed':True,'occlusion_s':0.,'position_m':[16.,0.],
                       'half_size_m':[2.,1.],'velocity_mps':[0.,0.]}]}
        scene=replace(scene,prediction=prediction)
        self.assertFalse(bypass.observe(scene,status,wall=100.))
        self.assertIsNotNone(bypass.target_anchor)
        scene=replace(scene,prediction={**prediction,'odometry_origin_m':[25.,0.],'tracks':[]})
        self.assertTrue(bypass.observe(scene,status,wall=100.))

    def test_detour_distance_does_not_release_before_the_measured_obstacle_is_cleared(self):
        import numpy as np
        bypass=RuleRouteBypass(self.scene.geometry);bypass.engaged=True
        bypass.detour_at=[0.,0.];bypass.target_anchor=(np.array([18.,0.]),[2.,1.])
        bypass.driver.last={'front_blocker':None}
        scene,status=self.sample(20,1.,None)
        scene=replace(scene,prediction={**scene.prediction,'odometry_origin_m':[9.,-2.],'odometry_yaw_rad':0.})
        self.assertFalse(bypass.observe(scene,status,wall=100.))
        self.assertTrue(bypass.engaged)

    def test_expired_validation_and_stale_target_cannot_engage_control(self):
        bypass=RuleRouteBypass(self.scene.geometry,deadline=99.)
        for frame in range(1,20):
            scene,status=self.sample(frame,0.,None)
            bypass.observe(scene,status,wall=100.)
        self.assertFalse(bypass.engaged)
        bypass=RuleRouteBypass(self.scene.geometry)
        for frame in range(1,20):
            scene,status=self.sample(frame,0.,None);status['timestamp_s']-=.3
            bypass.observe(scene,status,wall=100.)
        self.assertFalse(bypass.arming)

    def test_legacy_default_route_uses_the_same_bypass_preparation_lifecycle(self):
        from types import SimpleNamespace as NS
        from unittest.mock import Mock
        from backend.core.service import SimulationService
        from backend.core.control import ControlMode
        from backend.core.contracts import CommandSource
        service=SimulationService(None,now=lambda:100.)
        bypass=RuleRouteBypass(self.scene.geometry)
        scene,status=self.sample(1,0.,None,distance=None)
        _,base=case(1,speed=0.,distance=None)
        service.provider=NS(navigation_bypass=bypass,route_state=lambda:{'arrived':False},
            navigation_done=lambda:False,navigation_command=lambda *args:replace(base,source=CommandSource.NAVIGATION))
        service.control_scene=scene;service.observation=NS(vehicle=NS(speed_mps=0.))
        service._context=Mock(return_value=(1,scene.observation.timestamp_s))
        service._navigation_connection_alive=Mock(return_value=True)
        service.arbiter.machine.mode=ControlMode.AUTOMATIC
        service.journey={'status':'RUNNING','speed_kmh':30}
        service._navigation_step()
        self.assertIsNotNone(bypass.preparation_since)
        self.assertEqual(service.maneuver_status['action'],'PREPARE_DRIVE')
