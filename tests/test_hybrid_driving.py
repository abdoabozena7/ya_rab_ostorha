from dataclasses import replace
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch, Mock
import numpy as np
from backend.core.hybrid_driver import HybridDriver
from backend.core.hybrid_acceptance import validate
from backend.carla.hybrid_navigation import RoadSpeedPolicy
from backend.learning.hybrid_budget import HybridBudget, active_ticket
from tests import test_control_scene as measured_fixtures


class HybridDrivingTests(unittest.TestCase):
    def test_map_context_reuse_expires_with_frame_session_or_route_and_cannot_be_mutated(self):
        from backend.core.service import SimulationService
        tools=SimpleNamespace(native_route=[])
        provider=SimpleNamespace(name='test-fixture',allow_navigation=True,dashboard_tools=tools,
            hybrid_road_context=Mock(return_value={'centerline':[[0.,0.],[50.,0.]],'left_allowed':True}))
        service=SimulationService(provider)
        service.clock.frame_id=10;service.clock.timestamp_s=.5
        road=service._hybrid_road_context();road['centerline'][0][1]=99.;road['left_allowed']=False
        fresh=service._hybrid_road_context()
        self.assertEqual(fresh['centerline'][0],[0.,0.]);self.assertTrue(fresh['left_allowed'])
        self.assertEqual(provider.hybrid_road_context.call_count,1)
        service.clock.frame_id=11;service._hybrid_road_context()
        service.session_id='new';service._hybrid_road_context()
        tools.native_route=[];service._hybrid_road_context()
        self.assertEqual(provider.hybrid_road_context.call_count,4)

    def measured(self):
        scene, base, _ = measured_fixtures.ControlSceneTests().measured()
        road={'session_id':'test','centerline':[[0.,0.],[50.,0.]],'lane_width_m':3.5,
              'left_allowed':False,'right_allowed':False,'junction_ahead':False,'traffic_stop':None}
        return scene,base,road

    def test_verified_forward_motion_is_selected_instead_of_a_cheap_hold(self):
        scene,base,road=self.measured()
        command,status=HybridDriver(scene.geometry).evaluate(scene,base,road,5.,wall=100.)
        self.assertGreater(command.throttle,0.,status)
        self.assertEqual(command.brake,0.)
        self.assertTrue(status['space']['complete_stopping_tail_verified'])
        self.assertEqual(status['driver_id'],'ROBOSPHERE_HYBRID_V1')

    def test_committed_lane_curve_is_fixed_in_measured_odometry(self):
        scene,base,road=self.measured()
        driver=HybridDriver(scene.geometry)
        curve=driver._make_curve(scene,road,-3.5,'EXIT')
        original=driver._local_curve(scene,curve)
        prediction=dict(scene.prediction);prediction['odometry_origin_m']=[5.,0.]
        advanced=replace(scene,prediction=prediction)
        shifted=driver._local_curve(advanced,curve)
        # The target at original x=8 stays at x=3 after measured ego travel.
        # Rebuilding a new lane-change curve here would postpone the turn.
        i=np.argmin(abs(shifted[:,1]-3.));j=np.argmin(abs(original[:,1]-8.))
        self.assertAlmostEqual(shifted[i,2],original[j,2])
        self.assertLess(shifted[i,2],-2.)

    def test_verified_passing_path_is_preferred_before_reaching_the_stopped_car(self):
        from backend.core.kinematic_prediction import kinematic_modes
        scene,base,road=self.measured();road['left_allowed']=True
        tr={'id':'lead','position_m':[15.,0.],'half_size_m':[2.,1.],'velocity_mps':[0.,0.],
            'confirmed':True,'class':'UNKNOWN','quality':1.,'uncertainty_m':.15,'occlusion_s':0.}
        prediction=dict(scene.prediction);prediction.update(tracks=[tr],control_trajectories=kinematic_modes([tr]))
        scene=replace(scene,prediction=prediction);driver=HybridDriver(scene.geometry)
        # This fixture exercises ranking after independent admission. Real
        # occupied/unknown corridor rejection is tested without this mock.
        with patch.object(driver.shield,'check',return_value=(True,'ADMITTED_RANKING_FIXTURE',{})):
            command,status=driver.evaluate(scene,base,road,5.,wall=100.)
        self.assertEqual(status['action'],'CHANGE_LEFT')
        self.assertEqual(driver.phase,'EXIT')
        self.assertLess(status['front_blocker']['gap_m'],12.)

    def test_losing_blocker_identity_while_stopped_does_not_finish_a_pass(self):
        scene,base,road=self.measured();road.update(return_allowed=True,centerline=[[0.,3.5],[50.,3.5]])
        driver=HybridDriver(scene.geometry);driver.phase='PASS';driver.offset=-3.5;driver.blocker='lost'
        driver.blocker_anchor=(np.array([8.,0.]),[2.,1.]);driver.lost_blocker_since=-100.
        # Hold all movement in this fixture; elapsed time cannot prove travel.
        driver.evaluate(scene,base,road,2.,wall=100.)
        self.assertEqual(driver.phase,'PASS')
        self.assertNotIn('PASS_RETURN',driver.completed_maneuvers)

    def test_execution_hold_does_not_turn_a_transient_automatic_shift_into_manual_neutral(self):
        from backend.core.service import SimulationService
        from backend.core.control import ControlMode
        from backend.core.contracts import CommandSource
        from tests.core_packets import packet
        scene,base,road=self.measured()
        provider=SimpleNamespace(name='test-fixture',allow_navigation=True,hybrid_road_context=lambda _:road)
        service=SimulationService(provider,now=lambda:100.)
        frame=packet(base.frame_id,base.timestamp_s,speed=7.)
        frame=replace(frame,vehicle=replace(frame.vehicle,gear=0))
        service._publish(frame)
        service.active_safety=SimpleNamespace(status={})
        service.control_scene=scene;service.maneuver_status={}
        service.journey.update(driving_mode='HYBRID',status='RUNNING')
        service.arbiter.machine.transition(ControlMode.AUTOMATIC,connected=True,explicit=True)
        proposal=replace(base,source=CommandSource.NAVIGATION,gear=1)
        service.arbiter.submit(proposal,frame_id=base.frame_id,timestamp_s=base.timestamp_s,connected=True)
        with patch('backend.core.maneuver_candidates.ExecutionShield.check',return_value=(False,'CONTROL_PROCESSING_DEADLINE',{})):
            service._hybrid_execution_step()
        self.assertEqual(service.safety_command.gear,1)
        self.assertEqual(service.safety_command.throttle,0.)
        self.assertEqual(service.safety_command.brake,1.)

    def test_terminal_stop_with_unspecified_gear_remains_a_valid_shield_command(self):
        from backend.core.control import safe_command
        from backend.core.maneuver_candidates import ExecutionShield,signed_path
        scene,base,road=self.measured()
        command=safe_command(base.frame_id,base.timestamp_s,source=base.source)
        self.assertIsNone(command.gear)
        path=signed_path(0.,0.,-5.,scene.geometry)
        for _ in range(2):
            accepted,reason,_=ExecutionShield().check(scene,path,command,road,timestamp_s=base.timestamp_s,wall_s=100.)
            self.assertTrue(accepted,reason)
        self.assertEqual(scene.space.proof_cache_hits,1)

    def test_stale_scene_cannot_be_relabelled_fresh_to_make_progress(self):
        scene,base,road=self.measured()
        command,status=HybridDriver(scene.geometry).evaluate(scene,base,road,5.,wall=100.251)
        self.assertEqual(command.brake,1.)
        self.assertEqual(status['reason'],'STALE_CONTROL_SCENE')

    def test_a_recent_but_unaligned_frame_is_not_used_as_the_current_vehicle_pose(self):
        scene,base,road=self.measured()
        base=replace(base,frame_id=base.frame_id+1,timestamp_s=base.timestamp_s+.05)
        self.assertTrue(scene.usable(base.timestamp_s,100.))
        command,status=HybridDriver(scene.geometry).evaluate(scene,base,road,5.,wall=100.)
        self.assertEqual(command.brake,1.);self.assertEqual(status['reason'],'AWAITING_CURRENT_SENSOR_FRAME')

    def test_red_light_is_required_waiting_and_cannot_start_recovery(self):
        scene,base,road=self.measured();road['traffic_stop']='red signal'
        driver=HybridDriver(scene.geometry);driver.blocked_since=0.
        command,status=driver.evaluate(scene,base,road,5.,wall=100.)
        self.assertEqual(command.brake,1.);self.assertEqual(status['reason'],'TRAFFIC_RULE_STOP')
        self.assertIsNone(driver.blocked_since)

    def test_active_reverse_never_switches_into_forward_gear_while_moving(self):
        scene,base,road=self.measured()
        scene=replace(scene,observation=replace(scene.observation,ego=replace(scene.observation.ego,speed_mps=.5,reverse=True,gear=-1)))
        driver=HybridDriver(scene.geometry);driver.phase='SETTLE'
        command,status=driver.evaluate(scene,base,road,5.,wall=100.)
        self.assertTrue(command.reverse);self.assertEqual(command.gear,-1);self.assertEqual(command.brake,1.)

    def test_validation_expiry_cannot_enable_an_ordinary_unaccepted_driver(self):
        scene,base,road=self.measured()
        command,status=HybridDriver(scene.geometry,deadline=99.).evaluate(scene,base,road,5.,wall=100.)
        self.assertEqual(status['reason'],'HYBRID_VALIDATION_EXPIRED');self.assertEqual(command.brake,1.)

    def test_map_speed_uses_declared_units_and_rejects_invalid_native_fallback(self):
        native=SimpleNamespace(to_opendrive=lambda:'<OpenDRIVE><road id="2"><type s="0"><speed max="40" unit="mph"/></type></road></OpenDRIVE>')
        policy=RoadSpeedPolicy(native)
        self.assertAlmostEqual(policy.limit(SimpleNamespace(road_id=2,s=1.),30.)[0],64.37376)
        self.assertEqual(policy.limit(SimpleNamespace(road_id=99,s=1.),1e-23)[0],20.)

    def test_stationary_zero_contact_records_do_not_pass_behavioral_acceptance(self):
        config=json.loads(Path('config/hybrid-driving.json').read_text())
        results={'cases':[{'group':'ordinary','outcome':'SUCCESS','contacts':0,'scenario_valid':True,
                          'complete_episode':True,'native_planar_distance_m':0.,'maximum_unexplained_stop_s':60.}]*10}
        report=validate(config,results)
        self.assertFalse(report['accepted']);self.assertFalse(report['gates']['ordinary'])
        self.assertEqual(len(report['missing_maneuvers']),4)

    def test_independent_budget_ticket_requires_a_live_ledger_reservation(self):
        with tempfile.TemporaryDirectory() as directory:
            budget=HybridBudget(directory)
            with budget.experiment('test',1.):
                self.assertIsNotNone(active_ticket(directory))
                self.assertEqual(budget.status()['cap_s'],14400.)
            self.assertIsNone(active_ticket(directory))
            self.assertGreater(budget.status()['remaining_s'],14398.)

    def test_changing_visible_surface_does_not_recenter_occupied_bounds_on_an_old_anchor(self):
        from backend.core.prediction import MotionTracker
        from tests.test_safety_teacher import case
        tracker=MotionTracker(enhanced=True)
        initial=np.array([[3.,4.],[3.,4.5],[3.,5.],[4.,4.],[4.,4.5],[4.,5.]])
        expanded=np.vstack((initial,[[5.5,4.],[5.5,4.5],[5.5,5.]]))
        for i,cloud in enumerate((initial,initial,initial,expanded)):
            low,high=cloud.min(0),cloud.max(0)
            surface={'center':(low+high)/2,'half':np.maximum((high-low)/2,.35),'cloud':cloud,'points':len(cloud)}
            o,_=case(i+1,speed=0.,distance=None)
            with patch('backend.core.prediction.surfaces',return_value=[surface]):
                tracks=tracker.update(np.zeros((0,3)),o)
        fresh=[t for t in tracks if t['occlusion_s']==0]
        self.assertEqual(len(fresh),1)
        track=fresh[0]
        self.assertAlmostEqual(track['position_m'][0]-track['half_size_m'][0],3.)
        self.assertAlmostEqual(track['position_m'][0]+track['half_size_m'][0],5.5)
        self.assertLess(np.linalg.norm(track['velocity_mps']),.01)

    def test_road_boundary_checks_whole_body_including_pavement_between_lane_strips(self):
        from backend.core.drivable_corridor import certificate
        from backend.core.motion_geometry import VehicleGeometry
        g=VehicleGeometry();path=np.array([[0.,0.,0.,0.],[.1,1.,0.,0.]])
        lane=[[-10.,0.,20.,0.,1.75]]
        self.assertTrue(certificate(path,g,lane)['verified'])
        offset=path.copy();offset[:,2]=1.2
        self.assertFalse(certificate(offset,g,lane)['verified'])
        self.assertFalse(certificate(path,g,[[-10.,-1.,20.,-1.,.25],[-10.,1.,20.,1.,.25]])['verified'])
        self.assertFalse(certificate(path,g,[[-10.,0.,20.,0.,1.75,-1.,0.]])['verified'])

    def test_partial_brake_certificate_keeps_actual_command_lease(self):
        from backend.core.maneuver_candidates import ExecutionShield,signed_path
        scene,base,road=self.measured()
        scene=replace(scene,observation=replace(scene.observation,ego=replace(scene.observation.ego,speed_mps=4.)))
        command=replace(base,brake=.1,throttle=0.)
        path=signed_path(4.,0.,-.5,scene.geometry)
        with patch('backend.core.maneuver_candidates.stopping_tail',wraps=__import__('backend.core.maneuver_candidates',fromlist=['stopping_tail']).stopping_tail) as tail:
            ExecutionShield().check(scene,path,command,road,timestamp_s=base.timestamp_s,wall_s=100.)
        leased=tail.call_args.args[0]
        self.assertAlmostEqual(leased[-1,1],.3975)
        self.assertEqual(tail.call_args.kwargs['initial_deceleration'],.5)

    def test_existing_braking_continues_during_emergency_response_time(self):
        from backend.core.maneuver_candidates import stopping_tail
        from backend.core.motion_geometry import VehicleGeometry
        start=np.array([[0.,0.,0.,0.],[.1,.4,0.,0.]])
        coasting=stopping_tail(start,4.,VehicleGeometry(),False)
        moderate=stopping_tail(start,4.,VehicleGeometry(),False,initial_deceleration=2.)
        braking=stopping_tail(start,4.,VehicleGeometry(),False,initial_deceleration=3.)
        self.assertLess(moderate[-1,1],coasting[-1,1])
        self.assertLess(braking[-1,1],moderate[-1,1])
        self.assertLessEqual(braking[-1,1],.4+4**2/6.+.01)

    def test_merged_parked_surfaces_remain_measured_and_tiles_do_not_slide_with_ego(self):
        from backend.core.path_conflicts import surfaces
        points=np.array([[x,3.,.8] for x in np.arange(-4.,8.,.1)])
        initial=surfaces(points,split_large_frame=(np.zeros(2),np.eye(2)))
        moved=points.copy();moved[:,0]-=.1
        current=surfaces(moved,split_large_frame=(np.array([.1,0.]),np.eye(2)))
        self.assertEqual(sum(c['points'] for c in initial),len(points))
        self.assertEqual(sum(c['points'] for c in current),len(points))
        np.testing.assert_allclose(sorted(c['center'][0] for c in initial),
                                   sorted(c['center'][0]+.1 for c in current),atol=1e-6)

    def test_exact_topology_endpoints_close_unsampled_driving_lane_tails(self):
        from backend.carla.hybrid_navigation import build_drivable_strips
        from backend.core.drivable_corridor import certificate
        from backend.core.motion_geometry import VehicleGeometry
        def point(x):
            loc=SimpleNamespace(x=x,y=0.)
            loc.distance=lambda other:abs(other.x-x)
            return SimpleNamespace(s=x,road_id=1,section_id=0,lane_id=-1,lane_type='Driving',lane_width=3.5,
                transform=SimpleNamespace(location=loc,get_forward_vector=lambda:SimpleNamespace(x=1.,y=0.)),next=lambda step:[])
        native=SimpleNamespace(generate_waypoints=lambda step:[point(x) for x in (0.,1.,2.,3.,4.)],
                               get_topology=lambda:[(point(0.),point(4.2))])
        rows=[row for _,_,row in build_drivable_strips(native)]
        g=VehicleGeometry(front_m=.5,rear_m=.5,half_width_m=.3)
        self.assertTrue(certificate(np.array([[0.,3.6,0.,0.]]),g,rows)['verified'])
        self.assertFalse(certificate(np.array([[0.,3.9,0.,0.]]),g,rows)['verified'])

    def test_static_drivable_map_preparation_reuses_geometry_and_invalidates_on_map_change(self):
        from backend.carla.hybrid_navigation import prepare_drivable_map
        provider = SimpleNamespace(dashboard_tools=SimpleNamespace(map=object(), map_name='Town10'))
        strips = [((1, 0, -1), (1, 0, -1), (0., 0., 1., 0., 1.75, 1., 0.))]
        with patch('backend.carla.hybrid_navigation.build_drivable_strips', return_value=strips) as build:
            prepare_drivable_map(provider)
            rows = provider.hybrid_road_strip_array
            prepare_drivable_map(provider)
            build.assert_called_once_with(provider.dashboard_tools.map)
            self.assertIs(rows, provider.hybrid_road_strip_array)
            provider.dashboard_tools.map_name = 'Town05'
            prepare_drivable_map(provider)
            self.assertEqual(build.call_count, 2)
            np.testing.assert_array_equal(rows, provider.hybrid_road_strip_array)

    def test_micrometre_duplicate_route_endpoints_do_not_limit_a_straight_road_to_walking_speed(self):
        scene,base,road=self.measured()
        road['centerline']=[[0.,0.],[7.227046962,.0001],[7.227046967,.0001019],
                            [11.227045675,.0002],[15.227044383,.0003],[50.,.0004]]
        command,status=HybridDriver(scene.geometry).evaluate(scene,base,road,30/3.6,wall=100.)
        self.assertAlmostEqual(status['target_speed_kmh'],30.)
        self.assertGreater(command.throttle,0.)

    def test_automatic_benchmark_names_cannot_alias_a_different_manual_controller(self):
        from backend.core.service import SimulationService
        service=SimulationService(None)
        for mode in ('HYBRID','BASELINE'):
            with self.assertRaisesRegex(ValueError,'automatic journey'):
                service.set_paused(False,driving_mode=mode)

    def test_verified_sleep_exclusion_is_append_only_and_cannot_be_applied_twice(self):
        import sqlite3,os,time
        from datetime import datetime,timezone
        with tempfile.TemporaryDirectory() as directory:
            budget=HybridBudget(directory);root=Path(directory);probe=root/'probe-TEST_FIXTURE';probe.mkdir()
            (probe/'initial-report.json').write_text('{}')
            now=time.time()+1.;stamp=lambda value:datetime.fromtimestamp(value,timezone.utc).isoformat()
            event=root/'TEST_FIXTURE-resume.xml'
            event.write_text('<Event xmlns="http://schemas.microsoft.com/win/2004/08/events/event"><System>'
                '<Provider Name="Microsoft-Windows-Power-Troubleshooter"/><EventID>1</EventID></System><EventData>'
                '<Data Name="SleepTime">'+stamp(now)+'</Data><Data Name="WakeTime">'+stamp(now+2.)+'</Data></EventData></Event>')
            report=probe/'report.json';report.write_text(json.dumps({'source':'LIVE_NATIVE_CARLA','reservation_wall_s':10.}))
            os.utime(report,(now+3.,now+3.))
            db=sqlite3.connect(budget.path)
            try:
                db.execute('INSERT INTO reservations VALUES (?,?,?,?,?)',('fixture','TEST_FIXTURE',10.,1,100.));db.commit()
            finally:db.close()
            result=budget.reconcile_sleep('fixture',event,report)
            self.assertAlmostEqual(result['used_s'],8.,places=5)
            self.assertEqual(result['reservations'][0]['charged_s'],10.)
            self.assertEqual(len(result['sleep_adjustments']),1)
            with self.assertRaises(sqlite3.IntegrityError):budget.reconcile_sleep('fixture',event,report)
            self.assertAlmostEqual(budget.status()['used_s'],8.,places=5)

    def test_invalid_native_attempts_cannot_disappear_from_the_ordinary_gate(self):
        config=json.loads(Path('config/hybrid-driving.json').read_text())
        base={'group':'ordinary','scenario_valid':True,'complete_episode':True,'source':'LIVE_NATIVE_CARLA',
              'driver_id':config['driver_id'],'outcome':'SUCCESS','contacts':0,'native_planar_distance_m':20.,
              'destination_reached':True,'maximum_unexplained_stop_s':0.}
        cases=[{**base,'case_id':str(i)} for i in range(10)]
        self.assertTrue(validate(config,{'cases':cases})['gates']['ordinary'])
        cases.append({**base,'case_id':'failed-fixture','scenario_valid':False})
        report=validate(config,{'cases':cases})
        self.assertFalse(report['gates']['ordinary']);self.assertIn('failed-fixture',report['invalid_case_ids'])
        self.assertIn('failed-fixture',report['failed_case_ids'])

    def test_sleep_does_not_consume_working_budget_but_control_ticket_keeps_wall_expiry(self):
        with tempfile.TemporaryDirectory() as directory:
            budget=HybridBudget(directory)
            with patch('backend.learning.hybrid_budget.working_time',side_effect=[10.,12.]),\
                 patch('backend.learning.hybrid_budget.time.monotonic',side_effect=[100.,36102.]):
                with budget.experiment('TEST_FIXTURE_SLEEP',3.) as ticket:
                    self.assertEqual(ticket['expires_monotonic_s'],103.)
            self.assertEqual(budget.status()['used_s'],2.)
            self.assertIsNone(active_ticket(directory))

    def test_active_overrun_remains_charged_and_cannot_be_hidden_by_the_sleep_clock(self):
        with tempfile.TemporaryDirectory() as directory:
            budget=HybridBudget(directory)
            with patch('backend.learning.hybrid_budget.working_time',side_effect=[10.,14.]):
                with self.assertRaises(TimeoutError):
                    with budget.experiment('TEST_FIXTURE_OVERRUN',3.):pass
            self.assertEqual(budget.status()['used_s'],4.)

    def test_geometry_proof_reuse_requires_the_same_frame_command_path_and_road(self):
        from backend.core.maneuver_candidates import ExecutionShield,signed_path
        scene,base,road=self.measured();shield=ExecutionShield()
        path=signed_path(0.,base.steering,base.throttle*2.5,scene.geometry)
        ok,_,first=shield.check(scene,path,base,road,timestamp_s=base.timestamp_s,wall_s=100.)
        self.assertTrue(ok);queries=scene.space.queries
        first['verified']=False
        ok,_,proof=shield.check(scene,path,base,road,timestamp_s=base.timestamp_s,wall_s=100.01)
        self.assertTrue(ok);self.assertTrue(proof['verified']);self.assertEqual(scene.space.queries,queries)
        self.assertEqual(scene.space.proof_cache_hits,1)
        from backend.core.control import ControlSafetyLayer
        normalized=ControlSafetyLayer.normalize(base.__dict__)
        shield.check(scene,path,normalized,road,timestamp_s=base.timestamp_s,wall_s=100.01)
        self.assertEqual(scene.space.proof_cache_hits,2)
        self.assertEqual(scene.space.queries,queries)
        ok,reason,_=shield.check(scene,path,base,{**road,'traffic_stop':True},timestamp_s=base.timestamp_s,wall_s=100.01)
        self.assertFalse(ok);self.assertEqual(reason,'TRAFFIC_RULE_STOP')
        ok,reason,_=shield.check(scene,path,base,road,timestamp_s=base.timestamp_s,wall_s=100.3)
        self.assertFalse(ok);self.assertEqual(reason,'STALE_CONTROL_SCENE')
        modified=replace(base,throttle=.3)
        shield.check(scene,signed_path(0.,0.,.75,scene.geometry),modified,road,timestamp_s=base.timestamp_s,wall_s=100.01)
        self.assertGreater(scene.space.queries,queries)

    def test_uncertain_acceleration_radius_does_not_invent_a_faster_diagonal_approach(self):
        from backend.core.corridor_uncertainty import uncertain_corridor_tracks
        from backend.core.motion_geometry import VehicleGeometry
        track={'id':'diagonal','confirmed':False,'position_m':[-1.,4.5],
               'velocity_mps':[0.,0.],'half_size_m':[.35,.35],'uncertainty_m':.15}
        path=np.array([[0.,0.,0.,0.],[1.7,6.2,0.,0.]])
        self.assertEqual(uncertain_corridor_tracks([track],[],path,VehicleGeometry()),[])
        nearer=path.copy();nearer[-1,1]=4.
        self.assertEqual(uncertain_corridor_tracks([track],[],nearer,VehicleGeometry()),['diagonal'])

    def test_native_cadence_actuation_does_not_reselect_or_advance_the_behavior_lease(self):
        scene,base,road=self.measured();driver=HybridDriver(scene.geometry)
        command,_=driver.evaluate(scene,base,road,5.,wall=100.)
        sequence=driver.sequence;behavior_stamp=driver.previous_stamp
        current=replace(scene,observation=replace(scene.observation,frame_id=base.frame_id+1,
            timestamp_s=base.timestamp_s+.05,ego=replace(scene.observation.ego,speed_mps=.2,throttle=.2),
            channels=tuple(replace(c,frame_id=base.frame_id+1,timestamp_s=base.timestamp_s+.05,
                                   sensor_timestamp_s=base.timestamp_s+.05) for c in scene.observation.channels)))
        base=replace(command,frame_id=base.frame_id+1,timestamp_s=base.timestamp_s+.05)
        updated=driver.update_actuation(current,base,.01,wall=100.01)
        self.assertIsNotNone(updated);self.assertEqual(driver.sequence,sequence)
        self.assertEqual(driver.previous_stamp,behavior_stamp)
        self.assertEqual(driver.motion_stamp,current.observation.timestamp_s)
        self.assertEqual(updated.frame_id,current.observation.frame_id)

    def test_hybrid_public_identity_cannot_inherit_the_historical_learned_controller(self):
        from backend.core.service import SimulationService
        service=SimulationService(None);service.journey={'driving_mode':'HYBRID'}
        service.provider=SimpleNamespace(active_safety_status={'type':'OLD_RESEARCH_CONTROLLER','model_identity':'HISTORICAL_MODEL'})
        status=service._safety_snapshot()
        self.assertEqual(status['driver_id'],'ROBOSPHERE_HYBRID_V1')
        self.assertFalse(status['learned_control_used']);self.assertNotIn('model_identity',status)

    def test_accepted_flag_alone_cannot_replace_all_native_gates(self):
        from backend.core import hybrid_config
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'report.json'
            path.write_text(json.dumps({'accepted':True,'source_fingerprint':'same','accepted_speed_kmh':50,'gates':{}}))
            with patch.object(hybrid_config,'REPORT',path),patch.object(hybrid_config,'source_fingerprint',return_value='same'):
                self.assertFalse(hybrid_config.accepted_report({'accepted_speed_kmh':50}))

    def test_discarded_candidate_evaluations_do_not_wind_up_the_actuation_integrator(self):
        scene,_,_=self.measured();driver=HybridDriver(scene.geometry);driver.ego=scene.observation.ego
        values=[driver._pedals(5.,0.,.1) for _ in range(10)]
        self.assertEqual(driver.acceleration_trim,0.);self.assertTrue(all(v==values[0] for v in values))
        driver._pedals(5.,0.,.1,commit=True);self.assertGreater(driver.acceleration_trim,0.)

    def test_an_admitted_launch_is_not_trapped_at_an_ineffective_fixed_pedal_ceiling(self):
        scene,_,_=self.measured();driver=HybridDriver(scene.geometry)
        driver.ego=replace(scene.observation.ego,throttle=.45,brake=0.)
        throttle,brake=driver._pedals(30/3.6,.05,.05)
        self.assertGreater(throttle,.45);self.assertLessEqual(throttle,.491);self.assertEqual(brake,0.)

    def test_waiting_for_native_clutch_cannot_wind_throttle_up_to_the_cruise_limit(self):
        scene,_,_=self.measured();driver=HybridDriver(scene.geometry)
        for _ in range(20):
            driver.ego=replace(scene.observation.ego,throttle=.2,brake=0.)
            throttle,brake=driver._pedals(20/3.6,0.,.1)
            self.assertLessEqual(throttle,.45);self.assertEqual(brake,0.)

    def test_emergency_brake_pressure_is_not_carried_into_comfort_braking(self):
        scene,_,_=self.measured();driver=HybridDriver(scene.geometry)
        driver.ego=replace(scene.observation.ego,throttle=0.,brake=1.)
        throttle,brake=driver._pedals(3.,5.,.1)
        self.assertGreaterEqual(throttle,0.);self.assertLess(brake,.2)

    def test_large_physical_forecasts_are_preserved_as_checksummed_trace_assets(self):
        from backend.core.recording import RunRecorder,read_trace_row,MAX_ROW_BYTES
        from tests.core_packets import metadata
        with tempfile.TemporaryDirectory() as directory:
            recorder=RunRecorder(directory,metadata('hybrid-trace'))
            prediction={'unmodified_physical_modes':['long-range-evidence']*90000}
            recorder.record_trace({'kind':'HYBRID_DECISION','decision_id':'test:1','prediction':prediction})
            recorder.close()
            path=recorder.root/'telemetry/comparison-controls.jsonl'
            self.assertLess(path.stat().st_size,MAX_ROW_BYTES)
            row=json.loads(path.read_text());self.assertNotIn('prediction',row)
            self.assertEqual(read_trace_row(recorder.root,row)['prediction'],prediction)
            (recorder.root/row['prediction_asset']['path']).write_bytes(b'corrupted')
            with self.assertRaises(ValueError):read_trace_row(recorder.root,row)

    def test_direct_recording_encoder_preserves_contract_and_frozen_forecast_wire_bytes(self):
        from backend.core.recording import encode_row
        from backend.core.contracts import freeze_json,to_dict
        from tests.core_packets import packet
        for value in (packet(),{'kind':'HYBRID_DECISION','prediction':freeze_json({
                'tracks':[{'id':'sensor-only','velocity_mps':[1.,-2.]}],
                'trajectories':[{'points':[[0.,1.,2.],[.1,1.1,2.]]}]})}):
            expected=(json.dumps(to_dict(value),allow_nan=False,separators=(',',':'))+'\n').encode('utf8')
            self.assertEqual(encode_row(value),expected)
        with self.assertRaises(ValueError):encode_row({'invalid':float('nan')})
        with self.assertRaises(TypeError):encode_row({'invalid':object()})

    def test_high_speed_route_steering_respects_the_lateral_acceleration_bound(self):
        scene,base,road=self.measured()
        driver=HybridDriver(scene.geometry)
        steering=driver._bounded_steering(.8,50/3.6)
        acceleration=(50/3.6)**2*np.tan(steering*scene.geometry.max_steer_rad)/scene.geometry.wheelbase_m
        self.assertLessEqual(acceleration,2.+1e-9)
        self.assertEqual(driver._bounded_steering(.3,1.),.3)

    def test_lane_admission_checks_its_full_intended_corridor(self):
        from backend.core.maneuver_candidates import ExecutionShield
        from backend.core.maneuver import route_path
        from backend.core.contracts import freeze_json,to_dict
        scene,base,road=self.measured()
        track={'id':'occupied-adjacent-lane','confirmed':True,'occlusion_s':0.,'position_m':[5.,-3.5],
               'velocity_mps':[0.,0.],'half_size_m':[1.,.7],'uncertainty_m':.15}
        from backend.core.kinematic_prediction import kinematic_modes
        scene=replace(scene,prediction=freeze_json({**to_dict(scene.prediction),'tracks':[track],
            'control_trajectories':kinematic_modes([track])}),
            observation=replace(scene.observation,ego=replace(scene.observation.ego,speed_mps=2.)))
        intended,_=route_path(2.,0.,-3.5,road,scene.geometry,2.)
        ok,reason,_=ExecutionShield().check(scene,intended,base,road,timestamp_s=base.timestamp_s,
                                           wall_s=100.,full_maneuver=True)
        self.assertFalse(ok);self.assertEqual(reason,'PREDICTED_INTERSECTION')

    def test_dynamic_crossing_after_three_seconds_is_checked_until_the_car_stops(self):
        from backend.core.kinematic_prediction import kinematic_modes
        from backend.core.maneuver_candidates import ExecutionShield,signed_path
        from backend.core.contracts import freeze_json,to_dict
        scene,base,road=self.measured()
        track={'id':'late-crossing','confirmed':True,'occlusion_s':0.,'position_m':[36.5,18.],
               'velocity_mps':[0.,-4.],'half_size_m':[.5,.5],'uncertainty_m':.15}
        grid=np.round(np.arange(61)*.1,6)
        prediction={**to_dict(scene.prediction),'tracks':[track],
                    'control_trajectories':kinematic_modes([track],grid=grid)}
        scene=replace(scene,prediction=freeze_json(prediction),
                      observation=replace(scene.observation,ego=replace(scene.observation.ego,speed_mps=14.)))
        path=signed_path(14.,0.,0.,scene.geometry)
        ok,reason,evidence=ExecutionShield().check(scene,path,replace(base,throttle=0.,brake=0.),road,
                                                 timestamp_s=base.timestamp_s,wall_s=100.)
        self.assertFalse(ok);self.assertEqual(reason,'PREDICTED_INTERSECTION')
        self.assertGreater(evidence['conflicts'][0]['time_s'],3.)
        prediction['control_trajectories']=kinematic_modes([track])
        scene=replace(scene,prediction=freeze_json(prediction))
        ok,reason,_=ExecutionShield().check(scene,path,base,road,timestamp_s=base.timestamp_s,wall_s=100.)
        self.assertFalse(ok);self.assertEqual(reason,'FORECAST_HORIZON_INCOMPLETE')

    def test_classification_is_applied_before_control_pedestrian_hypotheses_are_built(self):
        track={'id':'person','confirmed':True,'position_m':[6.,4.],
               'velocity_mps':[0.,0.],'half_size_m':[.3,.3],'uncertainty_m':.15,
               'class':'UNKNOWN'}
        def classify(prediction,*args):
            prediction['tracks'][0]['class']='PERSON'
            return {'classified':True}
        with patch('backend.core.prediction.MotionTracker.update',return_value=[track]),\
             patch('backend.core.control_semantics.SemanticAssociator.apply',side_effect=classify):
            scene,_,_=self.measured()
        sources={m['source'] for m in scene.prediction['control_trajectories']}
        self.assertEqual(sources,{'STATIONARY','PEDESTRIAN_POSSIBLE_START','PEDESTRIAN_POSSIBLE_RETREAT','PEDESTRIAN_POSSIBLE_RUN'})

    def test_short_occlusion_keeps_existing_forecasts_but_crossings_and_unresolved_motion_still_veto(self):
        from backend.core.corridor_uncertainty import uncertain_corridor_tracks
        from backend.core.maneuver_candidates import ExecutionShield,signed_path
        from backend.core.contracts import freeze_json,to_dict
        scene,base,road=self.measured()
        track={'id':'known','confirmed':True,'occlusion_s':.2,'position_m':[6.,4.],
               'velocity_mps':[0.,0.],'half_size_m':[.5,.5],'uncertainty_m':.55}
        mode={'track_id':'known','source':'MEASURED_TEST_CROSSING','mode':0,'probability':None,
              'points':[[0.,6.,4.],[.5,6.,0.],[3.,6.,0.]]}
        path=signed_path(4.,0.,0.,scene.geometry)
        self.assertEqual(uncertain_corridor_tracks([track],[mode],path,scene.geometry,retained_forecasts=True),[])
        self.assertEqual(uncertain_corridor_tracks([track],[mode],path,scene.geometry),['known'])
        self.assertEqual(uncertain_corridor_tracks([{**track,'confirmed':False}],[mode],path,scene.geometry),['known'])
        self.assertEqual(uncertain_corridor_tracks([track],[],path,scene.geometry),['known'])
        prediction={**to_dict(scene.prediction),'tracks':[track],'control_trajectories':[mode]}
        scene=replace(scene,prediction=freeze_json(prediction),
            observation=replace(scene.observation,ego=replace(scene.observation.ego,speed_mps=4.)))
        ok,reason,_=ExecutionShield().check(scene,path,replace(base,throttle=0.,brake=0.),road,
                                          timestamp_s=base.timestamp_s,wall_s=100.)
        self.assertFalse(ok);self.assertEqual(reason,'PREDICTED_INTERSECTION')


    def test_known_stationary_blockage_rejects_the_complete_escape_lane_beyond_a_short_lease(self):
        from backend.core.maneuver import spatial_route,stationary_route_blocker
        scene,base,road=self.measured()
        road['centerline']=[[0.,0.],[50.,0.]]
        path=spatial_route(-3.5,road,np.arange(0.,40.01,.5))
        target={'id':'occupied-left','confirmed':True,'occlusion_s':0.,'position_m':[18.,-3.5],
                'half_size_m':[2.,1.],'velocity_mps':[0.,0.]}
        self.assertEqual(stationary_route_blocker([target],path,scene.geometry,25.),'occupied-left')
        self.assertIsNone(stationary_route_blocker([{**target,'position_m':[18.,0.]}],path,scene.geometry,25.))
        self.assertIsNone(stationary_route_blocker([{**target,'velocity_mps':[4.,0.]}],path,scene.geometry,25.))


if __name__=='__main__':unittest.main()
