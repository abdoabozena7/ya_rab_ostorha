import unittest
from types import SimpleNamespace as NS
from backend.carla.benchmark_fixture import BenchmarkFixture,pose_data


class HybridBenchmarkTests(unittest.TestCase):
    def test_both_matched_drivers_finish_only_after_stopping_inside_existing_arrival_radius(self):
        from backend.core.service import SimulationService
        from backend.core.control import ControlMode
        from unittest.mock import Mock
        from tests.core_packets import packet
        for mode in ('BASELINE','HYBRID'):
            for arrived,speed,expected in ((True,.1,'ARRIVED'),(True,1.,'RUNNING'),(False,0.,'RUNNING')):
                with self.subTest(mode=mode,arrived=arrived,speed=speed):
                    provider=NS(name='test-fixture',allow_navigation=True,route_state=lambda:{'arrived':arrived,'remaining_m':4.},
                        navigation_done=lambda:False,navigation_command=Mock(side_effect=RuntimeError('continue navigation')))
                    service=SimulationService(provider,now=lambda:100.);service._publish(packet(speed=speed))
                    service.journey.update(driving_mode=mode,status='RUNNING');service.navigation_heartbeat_at=100.
                    service.arbiter.machine.transition(ControlMode.AUTOMATIC,connected=True,explicit=True)
                    if expected=='ARRIVED':service._navigation_step()
                    else:
                        with self.assertRaisesRegex(RuntimeError,'continue navigation'):service._navigation_step()
                    self.assertEqual(service.journey['status'],expected)

    def test_native_driver_gets_goal_approach_without_disabling_obstacle_handling(self):
        from backend.carla.provider import CarlaProvider
        from backend.core.route_terminal import terminal_speed_mps
        from unittest.mock import Mock
        for mode in ('BASELINE','HYBRID'):
            native=NS(throttle=.2,brake=0.,steer=0.,reverse=False,hand_brake=False)
            navigation=NS(set_target_speed=Mock(),run_step=Mock(return_value=native))
            provider=NS(navigation=navigation,driving_mode=mode,
                ego=NS(actor=NS(get_speed_limit=lambda:60.,get_location=lambda:None)),
                dashboard_tools=NS(map=NS(get_waypoint=lambda _:None)),
                hybrid_speed_policy=NS(limit=lambda *_:(60.,'TEST')),
                route_state=lambda:{'remaining_m':10.})
            CarlaProvider.navigation_command(provider,1,.05,50.)
            navigation.set_target_speed.assert_called_once_with(terminal_speed_mps(10.)*3.6)
            navigation.run_step.assert_called_once()

    def test_route_end_failure_retains_baseline_fixture_until_restore_or_explicit_stop(self):
        from unittest.mock import Mock
        from backend.core.service import SimulationService
        from backend.core.journey_comparison import benchmark_terminal_supported
        from tests.core_packets import packet
        fixture=Mock()
        provider=NS(name='test-fixture',benchmark_fixture=fixture,benchmark_prepared=True)
        service=SimulationService(provider,now=lambda:100.);service._publish(packet(speed=0.))
        service.journey.update(driving_mode='BASELINE',benchmark=True,status='RUNNING')
        service._stop_navigation('route_ended_before_destination',status='ERROR')
        fixture.close.assert_not_called();self.assertIs(provider.benchmark_fixture,fixture)
        self.assertTrue(benchmark_terminal_supported(service.journey))
        service.stop_driving('operator_stop');fixture.close.assert_called_once()
        self.assertIsNone(provider.benchmark_fixture)
        for journey in ({'status':'ERROR','reason':'runtime_failure'},{'status':'PAUSED','reason':'operator_stop'},
                        {'status':'RUNNING','reason':'collision'}):self.assertFalse(benchmark_terminal_supported(journey))

    def fixture(self):
        pose=NS(location=NS(x=0.,y=0.,z=0.),rotation=NS(pitch=0.,yaw=0.,roll=0.))
        ego=NS(type_id='vehicle.test',get_transform=lambda:pose,
               get_velocity=lambda:NS(length=lambda:0.),get_angular_velocity=lambda:NS(length=lambda:0.))
        writes=[]
        light=NS(get_state=lambda:'Red',get_elapsed_time=lambda:0.,is_frozen=lambda:True,
                 get_green_time=lambda:10.,get_yellow_time=lambda:3.,get_red_time=lambda:10.,
                 set_state=lambda value:writes.append(('state',value)),freeze=lambda value:writes.append(('freeze',value)))
        provider=NS(ego=NS(actor=ego),world=NS(world=NS(get_actor=lambda key:light)),
                    connection=NS(api=NS(TrafficLightState=NS(Green='Green'))),
                    sensor_manager=NS(configurations={}),camera_settings={},fixed_delta=.05,population=NS(walkers={}))
        fixture=BenchmarkFixture(provider)
        fixture.lights=[{'id':9,'state':'Green','green_s':10.,'yellow_s':3.,'red_s':10.}]
        fixture.condition={'id':'fixture','sensors':{},'camera_settings':{},'fixed_delta_s':.05,
                           'ego':{'blueprint':ego.type_id,'pose':pose_data(pose)}}
        return fixture,pose,writes

    def test_audit_refuses_a_signal_mismatch_without_repairing_it_inside_verification(self):
        fixture,_,writes=self.fixture()
        result=fixture.verify()
        self.assertFalse(result['passed']);self.assertIn('light phase 9',result['failures'])
        self.assertEqual(writes,[])

    def test_frozen_start_is_reasserted_before_a_native_tick_and_never_after_release(self):
        fixture,_,writes=self.fixture();fixture.frozen=True
        fixture.prepare_tick();self.assertEqual(writes,[('state','Green'),('freeze',True)])
        fixture.frozen=False;fixture.prepare_tick();self.assertEqual(len(writes),2)

    def test_ego_initial_pose_is_part_of_matching_admission(self):
        fixture,pose,_=self.fixture();pose.location.x=.04
        self.assertIn('ego initial pose',fixture.verify()['failures'])


if __name__=='__main__':unittest.main()
