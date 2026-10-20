"""Runtime geometry/command contracts. No vehicle physics are simulated."""
from dataclasses import replace
import unittest
from unittest.mock import patch
import numpy as np
from backend.core.active_safety import ActiveSafetySupervisor, RuntimeSafetyConfig, assess_forward_space, coverage_speed_limit
from backend.core.contracts import CommandSource, SensorKind
from backend.core.control import CommandArbiter, ControlMode, ControlSafetyLayer
from tests.test_safety_teacher import case


def scene(observation, *, clear=False, obstacle=False):
    # Explicit sensor-local point geometry, solely to check projection units.
    points = [[x, y, -1.9, .5] for x in np.arange(2.5,38.,.5) for y in np.arange(-1.5,1.51,.5)] if clear else []
    if obstacle: points += [[10., 0., -1.4, .5]]
    data = np.asarray(points, '<f4').reshape(-1, 4).tobytes()
    channels = []
    for s in observation.channels:
        if s.kind in (SensorKind.LIDAR, SensorKind.DEPTH):
            p = [0., 0., 1.9] if s.kind == SensorKind.LIDAR else [1.5, 0., 1.6]
            # A rear camera cannot certify forward free space. LiDAR stays fixed.
            calibration = {'mount_transform': {'position_m': p,
                'rotation_deg': {'roll': 0., 'pitch': 0., 'yaw': 0. if s.kind == SensorKind.LIDAR else 180.}}}
            s = replace(s, calibration=calibration)
        channels.append(s)
    return replace(observation, channels=tuple(channels)), lambda _: data


class ActiveSafetyTests(unittest.TestCase):
    def test_forecast_uses_the_applied_coverage_speed_limit_for_a_distant_stationary_person(self):
        from tests.test_pedestrian_anticipation import PedestrianAnticipationTests
        from backend.core.pedestrian_anticipation import crossing_forecast
        from backend.core.kinematic_prediction import kinematic_modes
        from backend.core.motion_geometry import VehicleGeometry
        supervisor=ActiveSafetySupervisor();supervisor.geometry=VehicleGeometry()
        supervisor.prediction_speed_cap_mps=120/3.6
        o,b=case(distance=None,speed=0.);o,reader=scene(o,clear=True)
        b=replace(b,throttle=.9,steering=.01045)
        assessed=assess_forward_space(o,reader,supervisor.config)
        assessed.update(target_range_m=49.6,radar_range_m=None,observed_road_range_m=15.)
        p,_=PedestrianAnticipationTests().case();track=p['tracks'][0]
        p.update(evaluation_frame=o.frame_id,timestamp_s=o.timestamp_s)
        track.update(position_m=[36.54,3.666],velocity_mps=[0.,0.])
        track['measurement_evidence']['frame_id']=o.frame_id
        track['semantic_evidence']['timestamp_s']=o.timestamp_s
        p['trajectories']=kinematic_modes([track]);supervisor.control_prediction=p
        # The rejected native case predicted an unreachable 8 m/s² launch.
        self.assertIsNotNone(crossing_forecast(p,o,b,supervisor.geometry,cap_mps=120/3.6))
        with patch('backend.core.active_safety.assess_forward_space',return_value=assessed):
            selected=supervisor.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s)
        self.assertIsNone(selected)
        self.assertIsNone(supervisor.status['pedestrian_prediction'])
        self.assertAlmostEqual(supervisor.status['prediction_speed_cap_mps'],coverage_speed_limit(15.,supervisor.config.teacher))
        self.assertEqual(supervisor.status['requested_prediction_speed_cap_mps'],120/3.6)

    def test_current_unclassified_depth_motion_limits_launch_without_extending_the_person_label(self):
        from tests.test_pedestrian_anticipation import PedestrianAnticipationTests
        from backend.core.kinematic_prediction import kinematic_modes
        from backend.core.motion_geometry import VehicleGeometry
        for predictive in (True,False):
            supervisor=ActiveSafetySupervisor(anticipation_enabled=predictive);supervisor.geometry=VehicleGeometry()
            o,b=case(distance=None,speed=0.);o,reader=scene(o,clear=True)
            assessed=assess_forward_space(o,reader,supervisor.config)
            assessed.update(target_range_m=None,radar_range_m=None,observed_road_range_m=40.)
            p,_=PedestrianAnticipationTests().case();track=p['tracks'][0]
            p.update(evaluation_frame=o.frame_id,timestamp_s=o.timestamp_s)
            track.update(**{'class':'UNKNOWN','position_m':[17.,-6.9],'velocity_mps':[0.,2.],'motion_observations':5,
                'measurement_evidence':{'session_id':'s','frame_id':o.frame_id,'timestamp_s':o.timestamp_s,
                    'source':'CURRENT_DEPTH_BODY_CORE','support_points':20,'mad_m':.02,'motion_span_s':.25}})
            track.pop('semantic_evidence');p['trajectories']=kinematic_modes([track]);supervisor.control_prediction=p
            with patch('backend.core.active_safety.assess_forward_space',return_value=assessed):
                selected=supervisor.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s)
            if predictive:
                self.assertEqual(selected.brake,0.);self.assertLess(selected.throttle,b.throttle)
                self.assertLessEqual(selected.throttle,.5);self.assertIsNone(supervisor.status['pedestrian_prediction'])
                self.assertEqual(supervisor.status['path_conflict']['source'],'CURRENT_DEPTH_SURFACE_TRACK')
                from backend.core.pedestrian_anticipation import crossing_forecast
                cap=supervisor.status['cautious_roadside_speed_mps'];self.assertIsNotNone(cap)
                self.assertIsNone(crossing_forecast(p,o,b,supervisor.geometry,allow_measured_unknown=True,cap_mps=cap))
                assessed.update(target_range_m=2.)
                blocking=ActiveSafetySupervisor();blocking.geometry=supervisor.geometry;blocking.control_prediction=p
                with patch('backend.core.active_safety.assess_forward_space',return_value=assessed):
                    unsafe=blocking.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s)
                self.assertEqual(unsafe.brake,1.);self.assertIsNone(blocking.status['cautious_roadside_speed_mps'])
            else:self.assertIsNone(selected)

    def test_stationary_and_moving_crossings_verify_a_bounded_approach(self):
        from tests.test_pedestrian_anticipation import PedestrianAnticipationTests
        from backend.core.kinematic_prediction import kinematic_modes
        for moving in (False,True):
            supervisor=ActiveSafetySupervisor();o,b=case(distance=None,speed=0.);o,reader=scene(o,clear=True)
            assessed=assess_forward_space(o,reader,supervisor.config)
            assessed.update(target_range_m=None,radar_range_m=None,observed_road_range_m=12.)
            p,_=PedestrianAnticipationTests().case();track=p['tracks'][0];now=o.timestamp_s
            track.update(position_m=[7.3,3.25],velocity_mps=[0.,-.5] if moving else [0.,0.],
                history=[[now-.8,7.3,3.25,0.,0.],[now-.4,7.3,3.25,0.,0.],[now,7.3,3.25,0.,0.]])
            p.update(evaluation_frame=o.frame_id,timestamp_s=now)
            track['measurement_evidence']['frame_id']=o.frame_id
            track['semantic_evidence']['timestamp_s']=now
            p['trajectories']=kinematic_modes([track])
            supervisor.control_prediction=p
            with patch('backend.core.active_safety.assess_forward_space',return_value=assessed):
                result=supervisor.evaluate(o,b,reader,as_of_timestamp_s=now)
            self.assertEqual(result.brake,0.);self.assertLessEqual(result.throttle,.5)
            self.assertEqual(supervisor.status['cautious_roadside_speed_mps'],1. if moving else 4.)
            self.assertEqual(supervisor.status['status'],'CAUTIOUS_APPROACH')
            self.assertTrue(supervisor.status['cautious_roadside_approach'])

    def test_legacy_teacher_receives_front_radar_while_surround_stays_in_scene(self):
        o,b=case(distance=8.,speed=3.,velocity=-8.);o,reader=scene(o,clear=True)
        radar=next(c for c in o.channels if c.kind==SensorKind.RADAR)
        front=replace(radar,sensor_id='radar')
        rear=replace(radar,sensor_id='rearRightRadar',calibration={**dict(radar.calibration),
            'mount_transform':{'position_m':[-2.5,1.,.65],'rotation_deg':{'pitch':0.,'yaw':135.,'roll':0.}}})
        o=replace(o,channels=tuple(front if c is radar else c for c in o.channels)+(rear,))
        assessed=assess_forward_space(o,reader,RuntimeSafetyConfig.load())
        self.assertEqual([c.sensor_id for c in assessed['teacher_observation'].channels if c.kind==SensorKind.RADAR],['radar'])
        self.assertIs(o.channels[-1],rear)
        command=ActiveSafetySupervisor().evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s)
        self.assertEqual(command.brake,1.)

    def test_out_of_range_radar_return_does_not_invent_hazard_on_measured_clear_road(self):
        from unittest.mock import Mock
        supervisor=ActiveSafetySupervisor()
        o,b=case(distance=None,speed=8.);o,reader=scene(o,clear=True)
        assessed=assess_forward_space(o,reader,supervisor.config)
        assessed.update(radar_range_m=95.,target_range_m=None,observed_road_range_m=25.)
        supervisor.teacher.propose=Mock(side_effect=AssertionError('No usable foreground target'))
        with patch('backend.core.active_safety.assess_forward_space',return_value=assessed):
            command=supervisor.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s)
        self.assertEqual(command.brake if command else 0.,0.)
        self.assertNotEqual(supervisor.status['risk'],'FORWARD_COLLISION_RISK')

    def test_cleared_target_does_not_transfer_a_teacher_stop_latch_to_a_distant_object(self):
        from backend.learning.rl.teacher import TeacherState
        supervisor=ActiveSafetySupervisor()
        o,b=case(distance=45.,speed=4.);o,reader=scene(o,clear=True)
        assessed=assess_forward_space(o,reader,supervisor.config)
        assessed.update(radar_range_m=45.,target_range_m=42.,observed_road_range_m=50.)
        supervisor.teacher.state=TeacherState.PROTECTIVE_BRAKING
        with patch('backend.core.active_safety.assess_forward_space',return_value=assessed):
            self.assertIsNone(supervisor.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s))
        self.assertEqual(supervisor.teacher.state,TeacherState.MONITORING)
        # Missing stopping coverage cannot release that same held vehicle.
        supervisor=ActiveSafetySupervisor();supervisor.teacher.state=TeacherState.PROTECTIVE_BRAKING
        with patch('backend.core.active_safety.assess_forward_space',return_value={**assessed,'observed_road_range_m':0.}):
            self.assertEqual(supervisor.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s).brake,1.)

    def test_retained_near_ground_is_not_admitted_as_a_different_current_radar_foreground(self):
        from backend.learning.rl.teacher import TeacherDecision
        supervisor=ActiveSafetySupervisor();o,b=case(distance=45.,speed=4.);o,reader=scene(o,clear=True)
        assessed=assess_forward_space(o,reader,supervisor.config)
        assessed.update(radar_range_m=45.,target_range_m=42.,observed_road_range_m=50.)
        wrong=TeacherDecision('BRAKE_INTERVENTION','FINAL_APPROACH',(1.,1.,0.),None,
            {'foreground_valid':True,'forward_range_m':1.,'reason':'Wrong retained ground layer'})
        with patch('backend.core.active_safety.assess_forward_space',return_value=assessed),patch.object(supervisor.teacher,'propose',return_value=wrong):
            self.assertIsNone(supervisor.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s))
        # The independent actual depth/LiDAR hazard still commands full braking.
        supervisor=ActiveSafetySupervisor()
        with patch('backend.core.active_safety.assess_forward_space',return_value={**assessed,'target_range_m':2.}),patch.object(supervisor.teacher,'propose',return_value=wrong):
            self.assertEqual(supervisor.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s).brake,1.)

    def test_legacy_missing_foreground_is_not_a_measured_obstacle(self):
        from backend.learning.rl.teacher import TeacherDecision
        supervisor=ActiveSafetySupervisor()
        o,b=case(distance=None,speed=4.);o,reader=scene(o,clear=True)
        assessed=assess_forward_space(o,reader,supervisor.config)
        assessed.update(radar_range_m=30.,target_range_m=27.5,target_source='RADAR',observed_road_range_m=35.)
        missing=TeacherDecision('BRAKE_INTERVENTION','PROTECTIVE_BRAKING',(1.,1.,0.),None,
            {'foreground_valid':False,'reason':'No valid foreground return; absence is not free space'})
        with patch('backend.core.active_safety.assess_forward_space',return_value=assessed),patch.object(supervisor.teacher,'propose',return_value=missing):
            command=supervisor.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s)
        self.assertIsNone(command)
        self.assertNotEqual(supervisor.status['risk'],'FORWARD_COLLISION_RISK')
        self.assertEqual(supervisor.teacher.state.value,'MONITORING')

    def test_forward_radar_filter_preserves_unique_surround_channels(self):
        observation,_=case(distance=15.,speed=0.)
        observation,reader=scene(observation,clear=True)
        front=next(c for c in observation.channels if c.kind==SensorKind.RADAR)
        observation=replace(observation,channels=tuple(replace(c,sensor_id='radar') if c is front else c for c in observation.channels))
        front=next(c for c in observation.channels if c.sensor_id=='radar')
        surround=replace(front,sensor_id='rearRightRadar')
        observation=replace(observation,channels=observation.channels+(surround,))
        from backend.core.active_safety import retained_radar_observation
        with patch('backend.core.active_safety.retained_radar_observation',wraps=retained_radar_observation) as retained:
            assessed=assess_forward_space(observation,reader,RuntimeSafetyConfig.load())
        filtered=retained.call_args.args[0]
        self.assertEqual(len(filtered.channels),len(observation.channels)-1)
        self.assertEqual(sum(c.sensor_id==front.sensor_id for c in filtered.channels),1)
        self.assertFalse(any(c.sensor_id==surround.sensor_id for c in filtered.channels))
        self.assertIs(observation.channels[-1],surround)
        self.assertIsNotNone(assessed)

    def test_far_side_of_a_turn_uses_arc_distance_and_does_not_become_a_near_obstacle(self):
        from backend.core.motion_geometry import VehicleGeometry
        geometry=VehicleGeometry(2.44,2.45,.92,2.86,1.22,'ONBOARD_TEST')
        for sign in (-1.,1.):
            with self.subTest(sign=sign):
                steering=sign*.265
                curvature=np.tan(steering*geometry.max_steer_rad)/geometry.wheelbase_m
                angle=sign*2.8
                x,y=np.sin(angle)/curvature,(1-np.cos(angle))/curvature
                o,b=case(distance=None,speed=0.)
                o,reader=scene(o,clear=True)
                cloud=np.frombuffer(reader(None),'<f4').reshape(-1,4)
                cloud=np.vstack((cloud,[[x,y,-.9,.5]])).astype('<f4')
                assessed=assess_forward_space(o,lambda _:cloud.tobytes(),RuntimeSafetyConfig.load(),steering=steering,geometry=geometry)
                self.assertEqual(assessed['target_source'],'LIDAR')
                self.assertAlmostEqual(assessed['target_range_m'],angle/curvature-geometry.front_m,places=4)
                self.assertGreater(assessed['target_range_m'],20.)
                # Keep explicit measured-space evidence separate from the
                # turn-range regression, so missing curve coverage cannot hold.
                assessed['observed_road_range_m']=10.
                supervisor=ActiveSafetySupervisor();supervisor.geometry=geometry
                with patch('backend.core.active_safety.assess_forward_space',return_value=assessed):
                    applied=supervisor.evaluate(o,replace(b,steering=steering),lambda _:cloud.tobytes(),as_of_timestamp_s=o.timestamp_s)
                self.assertIsNone(applied)

    def test_near_obstacle_on_turn_arc_still_requires_protective_braking(self):
        from backend.core.motion_geometry import VehicleGeometry
        geometry=VehicleGeometry(2.44,2.45,.92,2.86,1.22,'ONBOARD_TEST')
        steering=-.265;curvature=np.tan(steering*geometry.max_steer_rad)/geometry.wheelbase_m
        arc=geometry.front_m+2.;angle=arc*curvature
        o,b=case(distance=None,speed=0.);o,reader=scene(o,clear=True)
        cloud=np.frombuffer(reader(None),'<f4').reshape(-1,4)
        cloud=np.vstack((cloud,[[np.sin(angle)/curvature,(1-np.cos(angle))/curvature,-.9,.5]])).astype('<f4')
        supervisor=ActiveSafetySupervisor();supervisor.geometry=geometry
        applied=supervisor.evaluate(o,replace(b,steering=steering),lambda _:cloud.tobytes(),as_of_timestamp_s=o.timestamp_s)
        self.assertEqual(applied.brake,1.)
        self.assertAlmostEqual(supervisor.status['measured_range_m'],2.,places=4)
        self.assertEqual(supervisor.status['risk'],'FORWARD_COLLISION_RISK')

    def test_release_padding_does_not_start_braking_on_saved_coverage_boundary(self):
        o, b = case(distance=None, speed=.00021824)
        o, reader = scene(o, clear=True)
        assessed = assess_forward_space(o, reader, RuntimeSafetyConfig.load())
        assessed['observed_road_range_m'] = 4.986027110061446
        with patch('backend.core.active_safety.assess_forward_space', return_value=assessed):
            supervisor = ActiveSafetySupervisor()
            applied = supervisor.evaluate(o, b, reader, as_of_timestamp_s=o.timestamp_s)
        self.assertIsNone(applied)
        self.assertFalse(supervisor.active)
        self.assertFalse(supervisor.status['forward_release_clear'])
        self.assertEqual(supervisor.status['risk'], 'FORWARD_CLEAR_SIDE_REAR_UNVERIFIED')
        self.assertGreater(supervisor.status['coverage_speed_limit_mps'], 0.)

    def test_short_coverage_sets_a_stopping_speed_and_progressive_braking(self):
        supervisor = ActiveSafetySupervisor()
        o, b = case(distance=None, speed=4.)
        o, reader = scene(o, clear=True)
        assessed = assess_forward_space(o, reader, supervisor.config)
        assessed['observed_road_range_m'] = 4.986027110061446
        with patch('backend.core.active_safety.assess_forward_space', return_value=assessed):
            applied = supervisor.evaluate(o, b, reader, as_of_timestamp_s=o.timestamp_s)
        limit = supervisor.status['coverage_speed_limit_mps']
        t = supervisor.config.teacher
        self.assertAlmostEqual(t.minimum_clearance_m + limit*t.reaction_time_s + limit**2/(2*t.assumed_deceleration_mps2), assessed['observed_road_range_m'])
        self.assertGreater(applied.brake, 0.)
        self.assertLess(applied.brake, 1.)
        self.assertEqual(applied.throttle, 0.)
        self.assertIn('coverage speed limit', supervisor.status['reason'])

    def test_distant_surface_does_not_cancel_a_short_measured_coverage_speed_limit(self):
        supervisor=ActiveSafetySupervisor()
        o,b=case(distance=None,speed=4.);o,reader=scene(o,clear=True)
        assessed=assess_forward_space(o,reader,supervisor.config)
        assessed.update(target_range_m=30.,target_source='LIDAR',observed_road_range_m=4.986027110061446)
        with patch('backend.core.active_safety.assess_forward_space',return_value=assessed):
            applied=supervisor.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s)
        self.assertGreater(applied.brake,0.)
        self.assertLess(applied.brake,1.)
        self.assertEqual(applied.throttle,0.)
        self.assertEqual(supervisor.status['risk'],'UNKNOWN_SPACE')
        self.assertAlmostEqual(supervisor.status['coverage_speed_limit_mps'],3.0377730836595065)

    def test_coverage_limit_recovers_without_an_emergency_hold_or_release_padding(self):
        supervisor = ActiveSafetySupervisor()
        for frame, speed in ((1, 4.), (2, 0.)):
            o, b = case(frame, distance=None, speed=speed)
            o, reader = scene(o, clear=True)
            assessed = assess_forward_space(o, reader, supervisor.config)
            assessed['observed_road_range_m'] = 4.986027110061446
            with patch('backend.core.active_safety.assess_forward_space', return_value=assessed):
                applied = supervisor.evaluate(o, b, reader, as_of_timestamp_s=o.timestamp_s)
        # Any residual brake releases smoothly; limited coverage never latches
        # the full hazard brake while stationary.
        self.assertLess(applied.brake if applied else 0., .2)
        self.assertIsNone(supervisor.started_s)
        self.assertEqual(coverage_speed_limit(0., supervisor.config.teacher), 0.)

    def test_sensor_geometry_distinguishes_measured_road_from_unknown(self):
        o, _ = case(distance=None)
        empty, reader = scene(o)
        self.assertEqual(assess_forward_space(empty, reader, RuntimeSafetyConfig.load())['observed_road_range_m'], 0.)
        road, reader = scene(o, clear=True)
        s = assess_forward_space(road, reader, RuntimeSafetyConfig.load())
        self.assertGreater(s['observed_road_range_m'], 30.)
        self.assertIsNone(s['target_range_m']); self.assertFalse(s['depth_observed'])
        target, reader = scene(o, clear=True, obstacle=True)
        s = assess_forward_space(target, reader, RuntimeSafetyConfig.load())
        self.assertEqual(s['target_range_m'], 7.5); self.assertEqual(s['target_source'], 'LIDAR')
        self.assertIsNone(s['closing_speed_mps'])

    def test_empty_road_preserves_manual_and_basicagent_controls(self):
        for source in (CommandSource.MANUAL, CommandSource.NAVIGATION):
            o, b = case(distance=None); o, reader = scene(o, clear=True)
            s = ActiveSafetySupervisor()
            self.assertIsNone(s.evaluate(o, replace(b, source=source), reader, as_of_timestamp_s=o.timestamp_s))
            self.assertEqual(s.snapshot()['risk'], 'FORWARD_CLEAR_SIDE_REAR_UNVERIFIED'); self.assertEqual(s.interventions, 0)

    def test_missing_returns_remain_unknown_and_brake_through_admission(self):
        o, b = case(distance=None); o, reader = scene(o)
        s = ActiveSafetySupervisor(); c = s.evaluate(o, b, reader, as_of_timestamp_s=o.timestamp_s)
        self.assertEqual(c.source, CommandSource.SAFETY); self.assertEqual(c.brake, 1.)
        self.assertEqual(c.throttle, 0.); self.assertEqual(c.steering, b.steering)
        self.assertEqual(s.snapshot()['risk'], 'UNKNOWN_SPACE')

    def test_radar_hazard_and_smooth_release_without_steering(self):
        s = ActiveSafetySupervisor(); o, b = case(distance=8., velocity=-8.); o, reader = scene(o)
        c = s.evaluate(o, b, reader, as_of_timestamp_s=o.timestamp_s)
        self.assertEqual(c.brake, 1.); self.assertEqual(c.steering, b.steering)
        self.assertAlmostEqual(s.snapshot()['stopping_envelope_m'], 12.2)
        brakes = []
        for frame in range(2, 13):
            o, b = case(frame, distance=None); o, reader = scene(o, clear=True)
            c = s.evaluate(o, b, reader, as_of_timestamp_s=o.timestamp_s)
            brakes.append(c.brake if c else 0.)
        self.assertEqual(brakes, sorted(brakes, reverse=True)); self.assertEqual(brakes[-1], 0.)
        self.assertEqual(s.interventions, 1)

    def test_stale_future_duplicate_and_unaligned_commands_rejected(self):
        o, b = case(distance=None); o, reader = scene(o, clear=True)
        for now in (o.timestamp_s-.001, o.timestamp_s+.11, float('nan')):
            with self.assertRaises(ValueError): ActiveSafetySupervisor().evaluate(o, b, reader, as_of_timestamp_s=now)
        with self.assertRaises(ValueError): ActiveSafetySupervisor().evaluate(o, replace(b, frame_id=2), reader, as_of_timestamp_s=o.timestamp_s)
        s=ActiveSafetySupervisor(); s.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s)
        with self.assertRaises(ValueError): s.evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s)

    def test_reverse_is_explicitly_unsupported_and_invalid_configuration_rejected(self):
        o, b = case(); s = ActiveSafetySupervisor()
        self.assertIsNone(s.evaluate(o, replace(b, reverse=True, gear=-1), None, as_of_timestamp_s=o.timestamp_s))
        self.assertEqual(s.snapshot()['status'], 'FORWARD_ONLY')
        with self.assertRaises(ValueError): replace(RuntimeSafetyConfig.load(), maximum_safety_steering_delta=.1)
        with self.assertRaises(ValueError): replace(RuntimeSafetyConfig.load(), ttc_trigger_s=float('nan'))

    def test_supervisor_has_no_world_or_actor_interface(self):
        import inspect
        from backend.core import active_safety
        source = inspect.getsource(active_safety)
        for forbidden in ('get_actors(', 'get_transform(', '.ground_truth', '.world.', 'future_trajectory'):
            self.assertNotIn(forbidden, source)

    def test_axial_depth_plane_does_not_become_false_nearby_obstacle(self):
        import io
        o,b=case(distance=None);o,lidar_reader=scene(o)
        depth=next(s for s in o.channels if s.kind==SensorKind.DEPTH)
        cal={'width':80,'height':45,'fov_deg':90.,'mount_transform':{'position_m':[1.5,0.,1.6],
            'rotation_deg':{'roll':0.,'pitch':0.,'yaw':0.}}}
        depth=replace(depth,calibration=cal)
        o=replace(o,channels=tuple(depth if s.kind==SensorKind.DEPTH else s for s in o.channels))
        a=np.full((45,80),1000.,np.float32)
        for v in range(23,45): a[v,:]=1.6*40/(v-22.)
        encoded=io.BytesIO();np.save(encoded,a,allow_pickle=False)
        reader=lambda asset:encoded.getvalue() if asset==depth.asset else lidar_reader(asset)
        assessed=assess_forward_space(o,reader,RuntimeSafetyConfig.load())
        self.assertIsNone(assessed['target_range_m']);self.assertGreater(assessed['observed_road_range_m'],10.)

    def test_disconnected_narrow_depth_returns_do_not_certify_forward_space(self):
        import io
        o,_=case(distance=None);o,lidar_reader=scene(o)
        depth=next(s for s in o.channels if s.kind==SensorKind.DEPTH)
        cal={'width':80,'height':45,'fov_deg':90.,'mount_transform':{'position_m':[1.5,0.,1.6],
            'rotation_deg':{'roll':0.,'pitch':0.,'yaw':0.}}}
        depth=replace(depth,calibration=cal)
        o=replace(o,channels=tuple(depth if s.kind==SensorKind.DEPTH else s for s in o.channels))
        values=np.full((45,80),1000.,np.float32)
        values[27,36]=values[27,40]=1.6*40/(27-22.)
        encoded=io.BytesIO();np.save(encoded,values,allow_pickle=False)
        reader=lambda asset:encoded.getvalue() if asset==depth.asset else lidar_reader(asset)
        assessed=assess_forward_space(o,reader,RuntimeSafetyConfig.load())
        self.assertIsNone(assessed['target_range_m'])
        self.assertEqual(assessed['observed_road_range_m'],0.)

    def test_fresh_safety_commands_cannot_resurrect_expired_driver_commands(self):
        now=[0.];a=CommandArbiter(ControlSafetyLayer(now=lambda:now[0]))
        a.machine.transition(ControlMode.MANUAL,connected=True,explicit=True)
        _,b=case();b=replace(b,source=CommandSource.MANUAL)
        a.submit(b,frame_id=b.frame_id,timestamp_s=b.timestamp_s,connected=True)
        now[0]=.36
        safe=replace(b,source=CommandSource.SAFETY,brake=1.,throttle=0.)
        a.submit(safe,frame_id=b.frame_id,timestamp_s=b.timestamp_s,connected=True)
        chosen=a.choose(frame_id=b.frame_id,timestamp_s=b.timestamp_s,connected=True,exclude_sources=(CommandSource.SAFETY,))
        self.assertEqual(a.machine.mode,ControlMode.PAUSED);self.assertEqual(chosen.brake,1.)
        self.assertEqual(a.reason,'command_timeout')

    def test_rl_tick_owner_suspends_active_runtime_supervisor(self):
        from backend.core.service import SimulationService
        from unittest.mock import Mock
        p=Mock(sensor_suite=False);s=SimulationService(p);s.active_safety=ActiveSafetySupervisor()
        s.arbiter.machine.mode=ControlMode.TRAINING;s._active_safety_step()
        self.assertEqual(s.active_safety.snapshot()['status'],'SUSPENDED_RL')
        self.assertIsNone(s.safety_command);p.apply_control.assert_not_called()

    def test_invalid_imu_cannot_be_admitted_as_valid_hazard_evidence(self):
        o,b=case(distance=8.,velocity=-8.);o,reader=scene(o)
        imu=next(s for s in o.channels if s.kind==SensorKind.IMU)
        with self.assertRaises(ValueError):
            replace(imu,data={**imu.data,'gyroscope_radps':[float('nan'),0.,0.]})
        imu=replace(imu,data={**imu.data,'gyroscope_radps':[0.,0.]})
        o=replace(o,channels=tuple(imu if s.kind==SensorKind.IMU else s for s in o.channels))
        with self.assertRaisesRegex(ValueError,'feasibility rejected'):
            ActiveSafetySupervisor().evaluate(o,b,reader,as_of_timestamp_s=o.timestamp_s)

    def test_runtime_refresh_keeps_the_existing_command_rate_guard(self):
        from backend.core.service import SimulationService
        from tests.test_rl import policy_fixture
        from unittest.mock import Mock
        now=[0.];o,b=case(distance=8.,velocity=-8.);o,reader=scene(o)
        p=Mock(sensor_suite=False);p.get_sensor_asset=reader
        s=SimulationService(p,now=lambda:now[0]);s.active_safety=ActiveSafetySupervisor()
        s.observation=policy_fixture();s.clock.observe(s.observation.world);s.policy_history.frames.append(o)
        s.arbiter.machine.mode=ControlMode.MANUAL
        s.arbiter.submit(replace(b,source=CommandSource.MANUAL),frame_id=o.frame_id,timestamp_s=o.timestamp_s,connected=True)
        with patch.object(s,'_live',return_value=True):
            s._active_safety_step();self.assertIsNotNone(s.safety_command)
            now[0]=.01;s._active_safety_step()
        self.assertEqual(s.arbiter.machine.mode,ControlMode.PAUSED)
        self.assertIn('rate limit',s.active_safety.last_fault)


if __name__ == '__main__': unittest.main()
