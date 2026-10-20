import copy
import unittest
from types import SimpleNamespace as NS
import numpy as np
from unittest.mock import Mock
from backend.carla.crossing_comparison import CrossingComparison,catalogue
from backend.core.crossing_result import evaluate_pair,PROTOCOL
from backend.core.visual_geometry import measured_boxes,corridor_forecasts
from backend.core.motion_geometry import VehicleGeometry
from backend.core.kinematic_prediction import kinematic_modes


class CrossingReplayTests(unittest.TestCase):
    def test_crossing_endpoints_are_native_sidewalk_points_and_missing_space_is_rejected(self):
        from backend.carla.crossing_comparison import sidewalk_pair
        points=[(NS(x=x,y=y,z=1.1),1,1)for x,y in ((100,9),(102,10),(100,-16),(98,-17),(100,0),(130,9))]
        a,b=sidewalk_pair(points,100.,True,lambda p:(p[0],p[1]),[])
        self.assertEqual(a,[100.,9.,1.1]);self.assertEqual(b,[100.,-16.,1.1])
        a,_=sidewalk_pair(points,100.,True,lambda p:(p[0],p[1]),[[100.,9.,1.1]])
        self.assertEqual(a,[102.,10.,1.1])
        with self.assertRaisesRegex(ValueError,'sidewalk start'):
            sidewalk_pair(points,200.,True,lambda p:(p[0],p[1]),[])
        with self.assertRaisesRegex(ValueError,'opposite'):
            sidewalk_pair(points[:2],100.,True,lambda p:(p[0],p[1]),[])
    def test_adjacent_riders_do_not_mask_the_critical_walker_during_construction(self):
        from backend.carla.crossing_comparison import approach_occupied
        self.assertTrue(approach_occupied(40.,3.5,'motorcycle'))
        self.assertTrue(approach_occupied(40.,-7.,'bicycle'))
        self.assertTrue(approach_occupied(40.,0.,'car'))
        self.assertTrue(approach_occupied(40.,3.5,'car'))
        self.assertFalse(approach_occupied(40.,-3.5,'car'))
        self.assertFalse(approach_occupied(125.,3.5,'car',90.))
        self.assertFalse(approach_occupied(-40.,3.5,'motorcycle'))
        self.assertFalse(approach_occupied(150.,3.5,'motorcycle'))

    def test_sidewalk_approach_crossing_and_departure_retain_the_clock_and_stop_at_the_final_target(self):
        location=NS(x=7.,y=3.,z=.95);control=Mock()
        actor=NS(get_location=lambda:location,get_velocity=lambda:NS(length=lambda:0.),apply_control=control)
        api=NS(Vector3D=lambda x=0.,y=0.,z=0.:NS(x=x,y=y,z=z),WalkerControl=lambda **v:NS(**v))
        provider=NS(connection=NS(api=api),world=NS(world=NS(get_actor=lambda _:actor)),
            population=NS(walkers={1:{'controller_id':None}}),last_vehicle={'timestamp':10.})
        stress=CrossingComparison(provider,1701);stress.origin=NS(x=0.,y=0.);stress.forward=NS(x=1.,y=0.);stress.right=NS(x=0.,y=1.)
        stress.plans={'crossing_01':{'kind':'CROSSING','critical':False,'origin':[10.,3.,.95],
            'approach_origin':[7.,3.,.95],'target':[10.,-3.,.95],'exit_target':[7.,-3.,.95],
            'start_s':2.,'speed_mps':2.8,'sidewalk_speed_mps':1.3,'direction':-1,'repeat':False}}
        stress.bind([{'role':'crossing_01','id':1}]);stress.start();stress.before_tick()
        self.assertEqual(control.call_args.args[0].speed,1.3)
        self.assertFalse(stress.observations['crossing_01']['realized'])
        location.x=10.;provider.last_vehicle['timestamp']=12.;stress.before_tick()
        self.assertEqual(control.call_args.args[0].speed,2.8)
        self.assertEqual(stress.observations['crossing_01']['first_crossing_command_s'],2.)
        location.y=-3.;provider.last_vehicle['timestamp']=13.;stress.before_tick()
        self.assertTrue(stress.observations['crossing_01']['completed']);self.assertEqual(control.call_args.args[0].speed,0.)
        provider.last_vehicle['timestamp']=13.1;stress.before_tick();self.assertEqual(control.call_args.args[0].speed,1.3)
        self.assertLess(control.call_args.args[0].direction.x,0.)
        location.x=7.;provider.last_vehicle['timestamp']=14.;stress.before_tick()
        self.assertTrue(stress.observations['crossing_01']['exit_completed']);self.assertEqual(control.call_args.args[0].speed,0.)

    def test_live_default_car_and_extra_rig_are_normalized_before_fixture_capture(self):
        from backend.carla.provider import CarlaProvider
        expected={'collision','frontCamera','drivingCamera','depth','radar','lidar','imu','gnss'}
        for canonical in (False,True):
            provider=NS(sensor_suite=True,camera_settings={},world=NS(world=Mock()),
                ego=NS(actor=NS(type_id='vehicle.mercedes.coupe_2020' if canonical else 'vehicle.lincoln.mkz_2020')),
                sensor_manager=NS(actors={name:None for name in expected| (set() if canonical else {'leftDepth'})},
                    configurations={'frontCamera':{'attributes':{'image_size_x':1280}},'depth':{'attributes':{'image_size_x':640}},
                        'drivingCamera':{'attributes':{'image_size_x':800,'image_size_y':450,'enable_postprocess_effects':'true','gamma':2.2},
                            'mountTransform':{'positionM':[-6.,0.,3.]}},
                        'lidar':{'attributes':{'channels':32,'points_per_second':128000,'lower_fov':-75}}}),
                reset_vehicle=Mock())
            self.assertEqual(CarlaProvider.prepare_guided_vehicle(provider),not canonical)
            self.assertTrue(provider.camera_settings['_comparison_rig'])
            self.assertEqual(provider.camera_settings['camera_view'],'chase')
            self.assertEqual(provider.blueprint,'vehicle.mercedes.coupe_2020')
            self.assertEqual(provider.reset_vehicle.call_count,0 if canonical else 1)
            if canonical:
                provider.sensor_manager.configurations['lidar']['attributes']['lower_fov']=-30
                self.assertTrue(CarlaProvider.prepare_guided_vehicle(provider))
                self.assertEqual(provider.reset_vehicle.call_count,1)

    def test_guided_crossing_keeps_population_and_uses_compliant_background_drivers(self):
        from backend.carla.presentation import finish_prepare
        from backend.carla.urban import sample_driver
        for guided in (False,True):
            world=Mock();world.get_actors.return_value.filter.return_value=[]
            provider=NS(guided_presentation=guided,dashboard_tools=NS(),
                population=NS(config={},apply=Mock()),connection=NS(api=NS()),world=NS(world=world))
            finish_prepare(provider,1701,{'scene':'DENSE_CHAOS','scenario_seed':1701})
            config=provider.population.apply.call_args.args[0]
            self.assertEqual((config['vehicle_count'],config['pedestrian_count']),(60,100))
            self.assertEqual(config['chaos_percent'],0 if guided else 100)
            self.assertEqual(config['driver_behavior'],'NORMAL' if guided else 'UNREGULATED')
            if guided:
                profile=sample_driver(1701,6,config['driver_behavior'],0.,config['light_compliance_percent'],config['chaos_percent'])
                self.assertEqual(profile['lane_change_percent'],0.)
                self.assertEqual(profile['light_violation_percent'],0.)
                self.assertEqual(profile['sign_violation_percent'],0.)

    def test_completed_walker_really_stops_with_libcarla_handle_local_control_cache(self):
        location=NS(x=10.,y=3.,z=.95);native={'speed':0.}
        class Walker:
            def __init__(self):self.cached_speed=0.
            def get_location(self):return location
            def get_velocity(self):return NS(length=lambda:native['speed'])
            def apply_control(self,control):
                if control.speed!=self.cached_speed:
                    native['speed']=control.speed;self.cached_speed=control.speed
        world=NS(get_actor=Mock(side_effect=lambda identity:Walker()))
        api=NS(Vector3D=lambda x=0.,y=0.,z=0.:NS(x=x,y=y,z=z),WalkerControl=lambda **values:NS(**values))
        provider=NS(connection=NS(api=api),world=NS(world=world),
            population=NS(walkers={1:{'controller_id':None}}),last_vehicle={'timestamp':10.})
        stress=CrossingComparison(provider,1701);stress.origin=NS(x=0.,y=0.)
        stress.forward=NS(x=1.,y=0.);stress.right=NS(x=0.,y=1.)
        stress.plans={'critical_pedestrian':{'kind':'CROSSING','critical':True,'origin':[10.,3.,.95],
            'target':[10.,-3.,.95],'start_s':2.,'speed_mps':2.8,'direction':-1,'repeat':False}}
        stress.bind([{'role':'critical_pedestrian','id':1}]);stress.start()
        provider.last_vehicle['timestamp']=12.;stress.before_tick();self.assertEqual(native['speed'],2.8)
        location.y=-3.;provider.last_vehicle['timestamp']=13.;stress.before_tick()
        self.assertTrue(stress.observations['critical_pedestrian']['completed'])
        self.assertEqual(native['speed'],0.)
        provider.last_vehicle['timestamp']=50.;stress.before_tick();self.assertEqual(native['speed'],0.)
        world.get_actor.assert_called_once_with(1)

    def test_three_distinct_candidates_keep_validation_explicit(self):
        library=catalogue();self.assertEqual(library['map'],'Town10HD_Opt')
        self.assertEqual(len(library['variants']),3);self.assertEqual(len({v['id'] for v in library['variants']}),3)
        for spec in library['variants']:
            self.assertGreater(spec['speed_mps'],0);self.assertGreater(spec['start_s'],0)
            self.assertIs(type(spec['validated']),bool)

    def test_clock_schedule_and_roles_replay_with_new_native_ids(self):
        actor=NS(get_location=lambda:NS(x=10.,y=3.,z=.95),get_velocity=lambda:NS(length=lambda:0.),apply_control=Mock())
        world=NS(get_actor=lambda identity:actor)
        api=NS(Vector3D=lambda x=0.,y=0.,z=0.:NS(x=x,y=y,z=z),WalkerControl=lambda **values:NS(**values))
        provider=NS(connection=NS(api=api),world=NS(world=world),population=NS(walkers={1:{'controller_id':None},2:{'controller_id':None}}),last_vehicle={'timestamp':10.})
        stress=CrossingComparison(provider,1701);stress.origin=NS(x=0.,y=0.);stress.forward=NS(x=1.,y=0.);stress.right=NS(x=0.,y=1.)
        stress.plans={'critical_pedestrian':{'kind':'CROSSING','critical':True,'origin':[10.,3.,.95],'target':[10.,-3.,.95],
            'start_s':2.,'speed_mps':2.8,'direction':-1,'repeat':False}}
        definition=stress.descriptor()['definition_sha256'];controls=[]
        for identity,epoch in ((1,10.),(2,100.)):
            stress.bind([{'role':'critical_pedestrian','id':identity}]);provider.last_vehicle['timestamp']=epoch;stress.start()
            for delta in (1.9,2.,2.1):
                provider.last_vehicle['timestamp']=epoch+delta;stress.before_tick();control=actor.apply_control.call_args.args[0]
                controls.append((control.speed,getattr(getattr(control,'direction',None),'y',None)))
            self.assertEqual(stress.run_evidence()['critical_actor_id'],identity)
            self.assertEqual(stress.descriptor()['definition_sha256'],definition)
        self.assertEqual(controls[:3],controls[3:]);self.assertEqual(controls[0][0],0.);self.assertEqual(controls[1],(2.8,-1.))


class CrossingOutcomeTests(unittest.TestCase):
    def pair(self):
        scenario={'protocol':PROTOCOL,'id':'native-crossing','definition_sha256':'same',
            'events':{'critical_pedestrian':{'origin':[10.,3.,1.],'start_s':2.}}}
        run={'setup':{'comparison_scenario':scenario,'initial_condition_id':'same-condition','speed_kmh':120.,'perception_profile':{'id':'FIXTURE','model_sha256':'same'}},
            'initial_condition_audit':{'passed':True},'scenario_evidence':{'events':{'critical_pedestrian':{'realized':True,
                'start_position':[10.,3.,1.],'first_crossing_command_s':2.}}}}
        return {'manifest':{'comparison_scenario':scenario},'runs':{
            'NORMAL':{**copy.deepcopy(run),'status':'COLLISION','collisions':1,'collision_events':[{'role':'critical_pedestrian','type':'walker.pedestrian.0001'}]},
            'ROBOSPHERE':{**copy.deepcopy(run),'status':'ARRIVED','collisions':0}}}

    def test_only_the_actual_expected_contact_and_arrival_qualify(self):
        self.assertTrue(evaluate_pair(self.pair())['passed'])
        for change in ({'status':'ARRIVED'},{'collision_events':[]},
                {'collision_events':[{'role':'different_person','type':'walker.pedestrian.0001'}]},
                {'collision_events':[{'role':'critical_pedestrian','type':'vehicle.tesla.model3'}]}):
            pair=self.pair();pair['runs']['NORMAL'].update(change)
            self.assertFalse(evaluate_pair(pair)['passed'])
        pair=self.pair();pair['runs']['ROBOSPHERE']['collisions']=1
        self.assertFalse(evaluate_pair(pair)['passed'])
        pair=self.pair();pair['runs']['NORMAL']['initial_condition_audit']['passed']=False
        self.assertFalse(evaluate_pair(pair)['passed'])
        pair=self.pair();pair['runs']['NORMAL']['setup']['speed_kmh']=50.
        self.assertFalse(evaluate_pair(pair)['passed'])

    def test_foreign_scenario_and_unrealized_walker_do_not_pass(self):
        pair=self.pair();pair['runs']['NORMAL']['setup']['comparison_scenario']['definition_sha256']='changed'
        self.assertFalse(evaluate_pair(pair)['passed'])
        pair=self.pair();pair['runs']['NORMAL']['scenario_evidence']['events']['critical_pedestrian']['realized']=False
        self.assertFalse(evaluate_pair(pair)['passed'])
        self.assertIsNone(evaluate_pair({'manifest':{},'runs':{}}))

    def test_arrival_does_not_accept_a_displaced_or_late_scheduled_crossing(self):
        for changes in ({'start_position':[12.,3.,1.]},{'first_crossing_command_s':2.5},
                {'first_crossing_command_s':None}):
            pair=self.pair();pair['runs']['ROBOSPHERE']['scenario_evidence']['events']['critical_pedestrian'].update(changes)
            self.assertFalse(evaluate_pair(pair)['gates']['scheduled_crossing_origins_verified'])


class SensorVolumeTests(unittest.TestCase):
    def case(self):
        track={'id':'p','class':'person','confirmed':True,'occlusion_s':0.,'position_m':[10.,2.],
            'half_size_m':[.35,.35],'velocity_mps':[0.,0.],'uncertainty_m':.1,
            'semantic_evidence':{'session_id':'sensor-session','timestamp_s':2.,'confidence':.9,'source_sensor':'frontCamera','source_frame':40,
                'depth_evidence':{'source_sensor':'depth','frame_id':40,'timestamp_s':2.,'axial_m':8.5,'samples':12}}}
        prediction={'session_id':'sensor-session','tracks':[track]}
        points=np.array([[x,y,z] for x in np.linspace(9.8,10.2,5) for y in np.linspace(1.8,2.2,5) for z in np.linspace(.2,1.8,8)])
        return prediction,points,NS(frame_id=42,timestamp_s=2.1,ego=NS(speed_mps=10.,throttle=.7,steering=0.))

    def test_volume_comes_from_current_measured_height_and_tracked_surface(self):
        prediction,points,observation=self.case();boxes=measured_boxes(prediction,points,observation)
        self.assertEqual(len(boxes),1);box=boxes[0]
        self.assertEqual(box['source'],'CURRENT_SENSOR_GEOMETRY');self.assertEqual(box['measurement_frame'],42)
        self.assertAlmostEqual(box['center_m'][2],1.);self.assertAlmostEqual(box['half_size_m'][2],.8)
        self.assertEqual(box['support_points'],len(points))
        self.assertAlmostEqual(box['half_size_m'][0],.2);self.assertAlmostEqual(box['half_size_m'][1],.2)
        self.assertEqual(measured_boxes(prediction,points,observation,lidar_points=np.empty((0,3))),[])
        self.assertGreater(measured_boxes(prediction,points,observation,lidar_points=points)[0]['lidar_support_points'],0)
        for changes in ({'occlusion_s':.2},{'class':'UNKNOWN'},{'confirmed':False},
                {'semantic_evidence':{'session_id':'foreign','timestamp_s':2.,'confidence':.9}}):
            modified=copy.deepcopy(prediction);modified['tracks'][0].update(changes)
            self.assertEqual(measured_boxes(modified,points,observation),[])
        self.assertEqual(measured_boxes(prediction,points[points[:,2]<.4],observation),[])

    def test_2d_only_labels_and_merged_tall_support_cannot_become_metric_object_boxes(self):
        prediction,points,observation=self.case();semantic=prediction['tracks'][0]['semantic_evidence']
        for change in ({'depth_evidence':None},{'source_frame':41},{'source_sensor':'otherCamera'}):
            wrong=copy.deepcopy(prediction);wrong['tracks'][0]['semantic_evidence'].update(change)
            self.assertEqual(measured_boxes(wrong,points,observation,lidar_points=points),[])
        tall=points.copy();tall[:,2]*=2.
        self.assertEqual(measured_boxes(prediction,tall,observation,lidar_points=tall),[])
        prediction['tracks'][0].update(position_m=[20.,3.]);semantic.pop('depth_evidence')
        prediction['trajectories']=kinematic_modes(prediction['tracks'])
        self.assertEqual(corridor_forecasts(prediction,observation,VehicleGeometry(),{}),[])

    def test_one_relevant_hypothesis_per_actor_and_no_irrelevant_arrows(self):
        prediction,_,observation=self.case();track=prediction['tracks'][0]
        track.update(position_m=[20.,3.])
        prediction['tracks']=[track,{**copy.deepcopy(track),'id':'q','position_m':[23.,-3.]},
            {**copy.deepcopy(track),'id':'off-road','position_m':[20.,20.]}]
        prediction['trajectories']=kinematic_modes(prediction['tracks'])
        result=corridor_forecasts(prediction,observation,VehicleGeometry(),{})
        self.assertEqual({m['track_id'] for m in result},{'p','q'});self.assertEqual(len(result),2)
        prediction['tracks'][0]['observed_crossing_cleared']=True
        self.assertNotIn('p',{m['track_id'] for m in corridor_forecasts(prediction,observation,VehicleGeometry(),{})})
        observation.timestamp_s=2.8
        self.assertEqual(corridor_forecasts(prediction,observation,VehicleGeometry(),{}),[])

    def test_unclassified_hypotheses_stay_in_details_except_the_actual_applied_surface_forecast(self):
        prediction,_,observation=self.case();prediction['tracks'][0].update(**{'class':'UNKNOWN'})
        prediction['trajectories']=kinematic_modes(prediction['tracks'])
        self.assertEqual(corridor_forecasts(prediction,observation,VehicleGeometry(),{}),[])
        surface={'frame_id':observation.frame_id,'path_conflict':{'center_m':[10.,2.],'forecast_motion_mps':[0.,-1.]}}
        paths=corridor_forecasts(prediction,observation,VehicleGeometry(),surface)
        self.assertEqual(len(paths),1);self.assertTrue(paths[0]['used_for_actuation']);self.assertEqual(paths[0]['track_id'],'p')
