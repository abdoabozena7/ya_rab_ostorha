import unittest
from backend.learning.rl.route_progress import FrozenRouteProgress
from backend.learning.rl.maneuver_reward import ManeuverReward


class RouteProgressTests(unittest.TestCase):
    def test_continuous_progress_has_no_nearest_waypoint_jump_or_initial_credit(self):
        source=[[0.,0.,0.],[4.,0.,0.],[4.,0.,0.],[8.,0.,0.]]
        route=FrozenRouteProgress(source,[1.7,0.,0.]);reward=ManeuverReward(route.route_length)
        self.assertEqual(route.measure([1.7,0.,0.]),0.)
        _,parts=reward.evaluate(progress_m=route.measure([1.7,0.,0.]),dt=.1)
        self.assertEqual(parts['progress'],0.)
        self.assertAlmostEqual(route.measure([2.01,0.,0.])-route.measure([1.99,0.,0.]),.02)
        source[-1][0]=100.
        self.assertAlmostEqual(route.route_length,6.3)

    def test_reverse_is_signed_and_motion_on_a_curve_follows_route_arc(self):
        route=FrozenRouteProgress([[0.,0.],[4.,0.],[4.,4.]],[0.,0.])
        self.assertAlmostEqual(route.measure([-.5,0.]),-.5)
        self.assertAlmostEqual(route.measure([4.,2.]),6.)
        reward=ManeuverReward(8.);_,parts=reward.evaluate(progress_m=-.5,dt=.1)
        self.assertLess(parts['progress'],0.)


if __name__=='__main__':unittest.main()
