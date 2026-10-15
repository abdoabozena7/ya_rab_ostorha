import unittest
from types import SimpleNamespace as NS
from backend.carla.benchmark_fixture import BenchmarkFixture,pose_data


class HybridBenchmarkTests(unittest.TestCase):
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
