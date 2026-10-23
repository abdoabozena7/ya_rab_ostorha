import math
from types import SimpleNamespace as NS
from unittest import TestCase
from backend.core.launch_alignment import LAUNCH_STEERING_LIMIT, curvature_speed_limit, lane_alignment, launch_steering, pursuit_steering


def transform(x, y, yaw):
    return NS(location=NS(x=x, y=y), rotation=NS(yaw=yaw))


class LaunchAlignmentTests(TestCase):
    def test_small_lane_offset_launches_straight_at_standstill(self):
        steering, reason = launch_steering(.247, speed_mps=0., lateral_offset_m=-.38, heading_error_deg=0.)
        self.assertEqual(steering, LAUNCH_STEERING_LIMIT);self.assertEqual(reason, 'STRAIGHT_LAUNCH_ALIGNED_WITH_LANE')
        # Below the RULE steering-probe threshold, the straight corridor is checked.
        self.assertLess(abs(steering), .05)

    def test_real_turns_moving_cars_and_large_offsets_keep_route_steering(self):
        for kwargs in ({'speed_mps': 3., 'lateral_offset_m': .3, 'heading_error_deg': 0.},
                       {'speed_mps': 0., 'lateral_offset_m': .3, 'heading_error_deg': 25.},
                       {'speed_mps': 0., 'lateral_offset_m': 1.5, 'heading_error_deg': 0.}):
            self.assertEqual(launch_steering(.3, **kwargs), (.3, None))
        self.assertEqual(launch_steering(.02, speed_mps=0., lateral_offset_m=.3, heading_error_deg=1.), (.02, None))

    def test_low_speed_pursuit_follows_the_lane_curvature_instead_of_saturating(self):
        # A 12 m-radius right turn starting at the car: pursuit stays near the
        # lane curvature (atan(2.9/12) ~ 13.6 deg ~ 0.19) instead of 0.35.
        radius = 12.;route = [(radius*math.sin(a), radius*(1-math.cos(a))) for a in [k*.05 for k in range(1, 40)]]
        steering = pursuit_steering((0., 0.), 0., route)
        self.assertGreater(steering, .12);self.assertLess(steering, .26)
        left = pursuit_steering((0., 0.), 0., [(x, -y) for x, y in route]);self.assertAlmostEqual(left, -steering)
        straight = pursuit_steering((0., -.38), 0., [(float(x), 0.) for x in range(1, 30)])
        self.assertGreater(straight, 0.);self.assertLess(straight, .07)
        self.assertIsNone(pursuit_steering((0., 0.), 0., [(1., 0.), (2., 0.)]))
        self.assertIsNone(pursuit_steering((0., 0.), 0., [(-10., 0.), (-20., 0.)]))

    def test_curvature_limit_slows_before_tight_turns_only(self):
        straight = [(float(x), 0.) for x in range(2, 80, 2)]
        self.assertIsNone(curvature_speed_limit((0., 0.), straight))
        radius = 12.;corner = [(30., 0.)]+[(30.+radius*math.sin(a), radius*(1-math.cos(a))) for a in [k*.17 for k in range(1, 10)]]
        route = [(float(x), 0.) for x in range(2, 30, 2)]+corner
        at_corner = curvature_speed_limit((28., 0.), corner);far = curvature_speed_limit((0., 0.), route)
        # First evaluable corner sample is ~6.1 m ahead: sqrt(2.5*R + 2*2.5*6.1).
        self.assertAlmostEqual(at_corner, math.sqrt(2.5*radius+2.*2.5*6.08), delta=.4)
        self.assertGreater(far, at_corner)
        self.assertLess(far, math.sqrt(2.5*radius+2.*2.5*40.))

    def test_lane_alignment_signs(self):
        offset, error = lane_alignment(transform(10., 1., 5.), transform(10., 0., 0.))
        self.assertAlmostEqual(offset, 1.);self.assertAlmostEqual(error, 5.)
        offset, _ = lane_alignment(transform(0., 0., 90.), transform(1., 0., 90.))
        self.assertAlmostEqual(offset, 1.)
        self.assertAlmostEqual(lane_alignment(transform(0., 0., -179.), transform(0., 0., 179.))[1], 2.)
