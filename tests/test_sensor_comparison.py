"""Sensor-reactive control, capability identity and historical comparison contracts."""
from dataclasses import replace
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from backend.core.active_safety import ActiveSafetySupervisor
from backend.core.driver_profiles import driver_profile,SENSOR_COMPARISON_PROTOCOL
from backend.core.journey_comparison import JourneyComparison,matching_setup
from tests.test_active_safety import scene
from tests.test_safety_teacher import case
from tests.test_braking_decisions import fixture
from tests.test_journey_comparison import manifest


class SensorComparisonTests(unittest.TestCase):
    def test_native_scoring_counts_sensor_approach_braking_without_requiring_an_extra_override(self):
        from scripts.native.validate_sensor_comparison import summarize
        sample={'timestamp_s':1.,'journey':{'status':'RUNNING'},'speed_kmh':0.,'brake':.25,
                'stop':{'decision_source':'NAVIGATION','applied_command':{'brake':.25},
                        'comfort_control':{'constraint':'MEASURED_APPROACH'}}}
        report={'mode':'NORMAL','scenario':'FRONT_OBSTACLE','seed':1701,'samples':[sample],
                'scenario_validity':{'valid':True},'native_planar_distance_m':8.4,
                'native_cleanup_confirmed':True,'contacts':[]}
        result=summarize(report,Path('software-scoring-fixture.json'))
        self.assertTrue(result['passed'])
        self.assertEqual(result['sensor_brake_samples'],1)
        sample['stop']['comfort_control']['constraint']='ROUTE_TARGET'
        self.assertFalse(summarize(report,Path('software-scoring-fixture.json'))['passed'])

    def test_predictive_label_does_not_turn_unknown_forward_coverage_into_clear_comparison_samples(self):
        from tests.core_packets import packet
        with tempfile.TemporaryDirectory() as directory:
            comparison=JourneyComparison(directory)
            comparison.begin('ROBOSPHERE',{**manifest(),'protocol':SENSOR_COMPARISON_PROTOCOL,
                'driver_profile':driver_profile('ROBOSPHERE')})
            comparison.sample(packet(),None,{'frame_id':1,'risk':'POSSIBLE_PEDESTRIAN_CROSSING',
                'reactive_risk':'UNKNOWN_SPACE','active':True})
            self.assertEqual(comparison.active['observed_samples'],0)
            self.assertEqual(comparison.active['risk_timeline'][0]['risk'],'UNKNOWN')

    def test_research_risk_metrics_keep_their_original_path_conflict_meaning(self):
        from tests.core_packets import packet
        with tempfile.TemporaryDirectory() as directory:
            comparison=JourneyComparison(directory);comparison.begin('BASELINE',manifest())
            for frame in (1,2):
                comparison.sample(packet(frame,frame*.05),None,{'frame_id':frame,'risk':'PATH_CONFLICT',
                    'reactive_risk':'FORWARD_CLEAR_SIDE_REAR_UNVERIFIED','active':False})
            self.assertGreater(comparison.active['high_risk_s'],0.)

    def test_each_arm_recreates_the_same_mercedes_and_appearance(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        from backend.carla.provider import CarlaProvider
        from tests.test_carla_provider import vec,transform
        provider=object.__new__(CarlaProvider)
        provider.presentation_vehicle_variants={mode:'vehicle.mercedes.coupe_2020' for mode in ('NORMAL','ROBOSPHERE')}
        provider.ego=SimpleNamespace(actor=Mock(type_id='vehicle.mercedes.coupe_2020'))
        provider.benchmark_fixture=SimpleNamespace(frozen=True,condition={'ego':{'pose':{
            'location':[1.,2.,3.],'rotation':[0.,0.,90.]}}})
        provider.connection=SimpleNamespace(api=SimpleNamespace(Location=vec,Transform=transform,
            Rotation=lambda **fields:SimpleNamespace(**fields)))
        actor=Mock(type_id='vehicle.mercedes.coupe_2020',id=42)
        blueprint=Mock();blueprint.has_attribute.return_value=True
        world=Mock();world.get_blueprint_library.return_value.find.return_value=blueprint
        world.try_spawn_actor.return_value=actor
        provider.world=SimpleNamespace(world=world);provider.population=SimpleNamespace(ego_id=1)
        provider.sensor_suite=False;provider.collision_sensor=False
        provider.destroy_ego_vehicle=Mock();provider.set_controls=Mock();provider.spawn_index=0
        with patch('backend.carla.provider.EgoVehicle',side_effect=lambda *args,**kwargs:SimpleNamespace(actor=None)),patch(
                'backend.carla.provider.CarlaSensorManager'),patch('backend.carla.provider.NearbyActorInspector'),patch(
                'backend.carla.onboard_geometry.geometry_for',return_value=SimpleNamespace()):
            for mode in ('NORMAL','ROBOSPHERE'):
                self.assertTrue(provider.select_presentation_vehicle(mode))
        self.assertEqual(provider.destroy_ego_vehicle.call_count,2)
        self.assertEqual(world.try_spawn_actor.call_count,2)
        self.assertEqual([entry.args[1] for entry in blueprint.set_attribute.call_args_list if entry.args[0]=='color'],
                         ['35,45,55','35,45,55'])

    def test_manual_recording_does_not_inherit_an_automatic_driver_profile(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        from backend.core.service import SimulationService
        provider=SimpleNamespace(name='carla',environment_state=lambda:{'mode':'LIVING_CITY'},
            recording_metadata=lambda:{},population_state=lambda:{})
        service=SimulationService(provider);service._event=Mock()
        service.journey.update(status='PAUSED',driver_profile=driver_profile('NORMAL'))
        with tempfile.TemporaryDirectory() as directory,patch('backend.core.recording.RunRecorder') as recorder,patch(
                'backend.core.recording.BufferedRunRecorder'):
            service.recording_directory=Path(directory)
            service._change_recording({'enabled':True})
            self.assertNotIn('driver_profile',recorder.call_args.args[1].config)
            service.recorder=None;service.last_recording=None
            service.journey['status']='STARTING'
            service._change_recording({'enabled':True})
            self.assertEqual(recorder.call_args.args[1].config['driver_profile']['controller'],'REACTIVE_SENSORS')

    def test_recorded_comparison_capabilities_cannot_change_mid_drive(self):
        service,_,_=fixture(driving_mode='NORMAL',automatic=True)
        service.journey['driver_profile']=driver_profile('NORMAL')
        with self.assertRaisesRegex(ValueError,'Stop the current'):
            service.set_safety_enabled({'enabled':False})

    def test_normal_brakes_at_eighty_kmh_for_an_obstacle_or_insufficient_stopping_coverage(self):
        for distance in (1.,45.,None):
            observation,base=case(distance=distance,speed=80/3.6)
            observation,reader=scene(observation,clear=True)
            supervisor=ActiveSafetySupervisor(anticipation_enabled=False)
            command=supervisor.evaluate(observation,base,reader,as_of_timestamp_s=observation.timestamp_s)
            self.assertEqual(command.throttle,0.)
            self.assertGreater(command.brake,0.)

    def test_normal_observation_delay_uses_the_same_full_stop_and_freshness_limit(self):
        service,now,_=fixture(driving_mode='NORMAL',automatic=True)
        now[0]=.343;service.navigation_heartbeat_at=now[0]
        service._navigation_step();service._active_safety_step()
        self.assertEqual(service._choose().brake,1.)
        self.assertEqual(service.active_safety.status['status'],'SENSOR_DELAY_HOLD')
        self.assertFalse(service.safety_fault['observer_only'])

    def test_same_vehicle_comparison_rejects_changed_physics_and_sensor_calibration(self):
        import copy
        setup={**manifest(),'protocol':SENSOR_COMPARISON_PROTOCOL,'vehicle_geometry':{'half_width_m':1.01},
               'vehicle_physics':{'mass':1800},'sensor_configuration':{'radar':{'fov':90}}}
        self.assertTrue(matching_setup(setup,copy.deepcopy(setup)))
        for field in ('vehicle_geometry','vehicle_physics','sensor_configuration'):
            changed=copy.deepcopy(setup);changed[field]={'different':True}
            self.assertFalse(matching_setup(setup,changed))

    def test_reactive_safety_never_calls_behavior_forecasting_even_with_supplied_predictions(self):
        supervisor=ActiveSafetySupervisor(anticipation_enabled=False)
        supervisor.control_prediction={'unexpected':'must not be consumed'}
        observation,base=case(distance=1.,speed=4.)
        observation,reader=scene(observation,clear=True)
        with patch.object(supervisor.path_conflicts,'assess',side_effect=AssertionError('Predictive crossing used')),patch(
                'backend.core.pedestrian_anticipation.crossing_forecast',side_effect=AssertionError('Person prediction used')):
            command=supervisor.evaluate(observation,base,reader,as_of_timestamp_s=observation.timestamp_s)
        self.assertEqual((command.throttle,command.brake),(0.,1.))
        self.assertIsNone(supervisor.status['path_conflict'])
        self.assertIsNone(supervisor.status['pedestrian_prediction'])

    def test_both_controllers_share_stopping_envelopes_and_reactive_hazards(self):
        for distance in (1.,12.,35.,None):
            observation,base=case(distance=distance,speed=4.)
            observation,reader=scene(observation,clear=True)
            states=[]
            for predictive in (False,True):
                supervisor=ActiveSafetySupervisor(anticipation_enabled=predictive)
                command=supervisor.evaluate(observation,base,reader,as_of_timestamp_s=observation.timestamp_s)
                states.append((supervisor.status['stopping_envelope_m'],supervisor.status['reactive_risk'],command))
            self.assertEqual(states[0],states[1])

    def test_normal_resumes_after_obstacle_clears_and_preserves_red_signal_braking(self):
        supervisor=ActiveSafetySupervisor(anticipation_enabled=False)
        for frame in range(1,15):
            observation,base=case(frame,distance=1. if frame==1 else None,speed=2.)
            observation,reader=scene(observation,clear=True)
            command=supervisor.evaluate(observation,base,reader,as_of_timestamp_s=observation.timestamp_s)
        self.assertIsNone(command)
        observation,base=case(15,distance=None,speed=2.)
        observation,reader=scene(observation,clear=True)
        base=replace(base,throttle=0.,brake=1.)
        command=supervisor.evaluate(observation,base,reader,as_of_timestamp_s=observation.timestamp_s)
        self.assertIsNone(command)
        self.assertEqual(base.brake,1.)

    def test_mode_switch_resets_predictive_state_and_cached_commands(self):
        service,_,_=fixture(driving_mode='ROBOSPHERE',automatic=True)
        service._navigation_step();service._active_safety_step()
        prior_tracker=service.active_safety.path_conflicts
        service.journey['driving_mode']='NORMAL'
        service._active_safety_step()
        self.assertIsNot(service.active_safety.path_conflicts,prior_tracker)
        self.assertFalse(service.active_safety.anticipation_enabled)
        service.journey['driving_mode']='ROBOSPHERE'
        service._active_safety_step()
        self.assertTrue(service.active_safety.anticipation_enabled)

    def test_new_profile_is_preserved_without_reclassifying_historical_normal(self):
        with tempfile.TemporaryDirectory() as directory:
            comparison=JourneyComparison(Path(directory))
            setup={**manifest(),'protocol':SENSOR_COMPARISON_PROTOCOL,'driver_profile':driver_profile('NORMAL')}
            run=comparison.begin('NORMAL',setup)
            self.assertEqual(comparison.data['version'],6)
            self.assertTrue(run['driver_profile']['sensor_obstacle_braking'])
            self.assertFalse(run['driver_profile']['reinforcement_learning_used'])
            comparison.finish('operator_stop')
            pair=comparison.data['pair_id']
            with self.assertRaisesRegex(ValueError,'different protocols'):
                comparison.begin('ROBOSPHERE',manifest(),pair_id=pair)
            legacy=JourneyComparison(Path(directory)/'legacy')
            self.assertIsNone(legacy.begin('NORMAL',manifest())['driver_profile'])
