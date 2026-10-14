import math
import unittest
from types import SimpleNamespace as NS
from unittest.mock import MagicMock
from backend.carla.route_crowding import route_slots
from backend.core.service import SimulationService
from backend.core.control import ControlMode
from tests.core_packets import packet


class Location:
    def __init__(self, x=0, y=0, z=0): self.x, self.y, self.z = x, y, z
    def distance(self, other): return math.dist((self.x,self.y,self.z),(other.x,other.y,other.z))


class Transform:
    def __init__(self, location, rotation=1): self.location, self.rotation = location, rotation
    def get_forward_vector(self): return NS(x=self.rotation,y=0,z=0)


class Waypoint:
    def __init__(self, x, y=0, facing=1, junction=False):
        self.transform=Transform(Location(x,y,0),facing)
        self.lane_type='Driving';self.lane_width=3.5;self.is_junction=junction
        self.left=self.right=None
    def get_left_lane(self): return self.left
    def get_right_lane(self): return self.right


API=NS(Location=Location, Transform=Transform, LaneType=NS(Driving='Driving'))


def route(length, parallel=False):
    points=[]
    for x in range(0,length+1,4):
        wp=Waypoint(x)
        if parallel: wp.right=Waypoint(x,3.5)
        points.append((wp,None))
    return points


class RouteCrowdingTests(unittest.TestCase):
    def test_count_scales_with_road_length_and_includes_nearby_and_distant_traffic(self):
        short,a=route_slots(route(120,True),Location(),API)
        long,b=route_slots(route(480,True),Location(),API)
        self.assertGreater(b['target_count'],a['target_count'])
        for slots, length in ((short,120),(long,480)):
            self.assertLess(min(s['distance_m'] for s in slots),40)
            self.assertGreater(max(s['distance_m'] for s in slots),length-25)
            self.assertTrue(all(s['transform'].location.distance(Location())>=16 for s in slots))
            self.assertTrue(all(s['path'][-1].x==length for s in slots))

    def test_cap_keeps_coverage_to_destination_and_preserves_parallel_lanes(self):
        slots,report=route_slots(route(2000,True),Location(),API)
        self.assertEqual(len(slots),75);self.assertTrue(report['capacity_capped'])
        self.assertGreater(max(s['distance_m'] for s in slots),1900)
        self.assertEqual({s['transform'].location.y for s in slots if s['distance_m']<40},{0,3.5})

    def test_junctions_and_opposing_lanes_are_excluded_without_mutating_waypoints(self):
        native=route(160)
        for wp,_ in native:
            wp.left=Waypoint(wp.transform.location.x,-3.5,-1)
            wp.is_junction=60<=wp.transform.location.x<=84
        slots,_=route_slots(native,Location(),API)
        self.assertTrue(all(s['transform'].location.y==0 for s in slots))
        self.assertFalse(any(60<=s['distance_m']<=84 for s in slots))
        self.assertTrue(all(wp.transform.location.z==0 for wp,_ in native))

    def test_short_route_rejects_without_any_native_mutation(self):
        with self.assertRaisesRegex(ValueError,'no safe traffic spaces'):
            route_slots(route(12),Location(),API)

    def test_external_traffic_occupancy_reduces_available_route_capacity(self):
        native=route(120)
        clear,report=route_slots(native,Location(),API)
        occupied=clear[0]['transform'].location
        slots,blocked=route_slots(native,Location(),API,occupied=[occupied])
        self.assertLess(blocked['target_count'],report['target_count'])
        self.assertTrue(all(s['transform'].location.distance(occupied)>=6 for s in slots))

    def test_wrong_destination_is_rejected_before_existing_traffic_is_touched(self):
        from backend.carla.population import WorldPopulationManager
        manager=object.__new__(WorldPopulationManager)
        manager.clear_traffic=MagicMock()
        with self.assertRaisesRegex(ValueError,'destination changed'):
            manager.crowd_route({'id':'new'},route(120),{'route_id':'old'})
        manager.clear_traffic.assert_not_called()

    def test_dashboard_crowding_requires_stopped_ego_and_no_recording(self):
        service=SimulationService(None);service._publish(packet(speed=0))
        service.arbiter.machine.transition(ControlMode.PAUSED,connected=True)
        service.queue_dashboard_action('crowd_route',{'route_id':'road'})
        self.assertEqual(service.actions[-1][0],'crowd_route')
        service.arbiter.machine.transition(ControlMode.MANUAL,connected=True)
        with self.assertRaisesRegex(ValueError,'Stop the vehicle'):
            service.queue_dashboard_action('crowd_route',{})
        service.arbiter.machine.transition(ControlMode.PAUSED,connected=True)
        service.recorder=MagicMock()
        with self.assertRaisesRegex(ValueError,'recording'):
            service.queue_dashboard_action('crowd_route',{})


if __name__=='__main__': unittest.main()
