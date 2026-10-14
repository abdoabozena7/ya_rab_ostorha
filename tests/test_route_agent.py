import unittest
from backend.carla.route_agent import blocks_forward_route


def box(x,y,hx=2.,hy=.9):
    return [(x-hx,y-hy),(x+hx,y-hy),(x+hx,y+hy),(x-hx,y+hy)]


class ForwardRouteTests(unittest.TestCase):
    def hit(self,body,route=((2.5,0),(8,0),(15,0))):
        return blocks_forward_route(route,body,1.15,(0,0),(1,0),2.5)

    def test_rear_and_adjacent_cars_do_not_block_route(self):
        for x in (-8,-3,0,3,8):
            self.assertFalse(self.hit(box(x,3.5)))
        self.assertFalse(self.hit(box(-3,0)))

    def test_front_vehicle_and_crossing_footprint_still_block(self):
        self.assertTrue(self.hit(box(8,0)))
        self.assertTrue(self.hit(box(8,1.8)))

    def test_curved_route_uses_ordered_centerline(self):
        route=((2.5,0),(6,0),(9,2),(11,5),(11,9))
        self.assertTrue(self.hit(box(11,7,1.,.7),route))
        self.assertFalse(self.hit(box(12,-3,1.,.7),route))

    def test_rear_footprint_not_reintroduced_by_route_polygon(self):
        self.assertFalse(self.hit(box(-1,0),((2.5,0),(6,0),(6,6))))
