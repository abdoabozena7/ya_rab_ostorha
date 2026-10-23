import math
import unittest
import numpy as np
from backend.core.active_safety import ActiveSafetySupervisor, coverage_probe, extend_forward_path, RuntimeSafetyConfig
from backend.core.contracts import CommandSource, ControlCommand
from backend.core.maneuver import ObservedSpace
from backend.core.motion_geometry import VehicleGeometry
from backend.core.pedestrian_behaviors import project_polyline
from backend.core.route_tracking import RoutePolyline, dense_route, lookahead_m, track

GEOMETRY = VehicleGeometry(front_m=2.33, rear_m=2.33, half_width_m=1.01, wheelbase_m=2.85, max_steer_rad=1.222)


def right_turn(radius=8., straight=20., tail=30.):
    """Route along +x, then a right (y-increasing) quarter turn of ``radius`` and a straight tail."""
    points = [(x, 0.) for x in np.arange(-10., straight, 1.)]
    for a in np.linspace(0., math.pi/2, 25)[1:]:
        points.append((straight+radius*math.sin(a), radius*(1-math.cos(a))))
    points += [(straight+radius, radius+d) for d in np.arange(1., tail, 1.)]
    return points


def to_world(path, origin, yaw):
    c, s = math.cos(yaw), math.sin(yaw);p = np.asarray(path)
    return np.column_stack((origin[0]+c*p[:, 1]-s*p[:, 2], origin[1]+s*p[:, 1]+c*p[:, 2]))


def on_curve(radius, angle, straight=20.):
    """Body origin whose rear axle lies on the turn circle with the tangent heading."""
    rear = (straight+radius*math.sin(angle), radius*(1-math.cos(angle)))
    offset = -(GEOMETRY.center_offset-GEOMETRY.wheelbase_m/2.)
    return rear[0]+offset*math.cos(angle), rear[1]+offset*math.sin(angle)


class RouteTrackerTest(unittest.TestCase):
    def test_straight_lane_keeps_straight_and_offset_converges(self):
        route = [(x, 0.) for x in np.arange(-5., 80., 2.)]
        steering, path, info = track((0., 0.), 0., route, speed_mps=0., target_speed_mps=8., geometry=GEOMETRY)
        self.assertAlmostEqual(steering, 0., places=9)
        self.assertLess(np.max(np.abs(np.asarray(path)[:, 2])), 1e-9)
        self.assertGreater(path[-1][0], 45.)
        # Ego 0.5 m right of the lane (CARLA right-positive): steer left, rejoin the lane.
        steering, path, _ = track((0., .5), 0., route, speed_mps=3., target_speed_mps=8., geometry=GEOMETRY)
        self.assertLess(steering, 0.)
        self.assertAlmostEqual(np.asarray(path)[-1, 2], -.5, delta=.05)

    def test_tight_turn_is_followed_without_large_corner_cutting(self):
        route = right_turn()
        steering, path, _ = track((10., 0.), 0., route, speed_mps=4., target_speed_mps=4., geometry=GEOMETRY)
        world = to_world(path, (10., 0.), 0.)
        _, lateral = project_polyline(world, np.asarray(route))
        self.assertLess(np.max(np.abs(lateral)), .4)
        self.assertAlmostEqual(path[-1][3], math.pi/2, delta=.05)
        # Stopped on the curve itself (rear axle on the circle, tangent heading)
        # the command matches its curvature, atan(2.85/8)/1.222 = 0.28, unlike
        # the old 0.05-0.15 commands.
        steering, _, _ = track(on_curve(8., 3./8.), 3./8., route, speed_mps=0., target_speed_mps=4., geometry=GEOMETRY)
        self.assertAlmostEqual(steering, math.atan(2.85/8.)/1.222, delta=.03)

    def test_rate_limit_and_steering_limit_bind_the_first_command(self):
        route = right_turn(radius=6.5);a = .5;pose = on_curve(6.5, a)
        free, _, _ = track(pose, a, route, speed_mps=0., target_speed_mps=4., geometry=GEOMETRY)
        self.assertGreater(free, .25)
        first, _, _ = track(pose, a, route, speed_mps=0., target_speed_mps=4., geometry=GEOMETRY, previous_steering=0.)
        self.assertAlmostEqual(first, .1, places=9)
        limited, _, _ = track(pose, a, route, speed_mps=0., target_speed_mps=4., geometry=GEOMETRY, limit=.2)
        self.assertAlmostEqual(limited, .2, places=9)

    def test_vehicle_frame_path_is_invariant_to_world_pose(self):
        route = right_turn()
        _, reference, _ = track((12., .3), .05, route, speed_mps=5., target_speed_mps=6., geometry=GEOMETRY)
        yaw, shift = 1.1, np.array([140., -35.]);c, s = math.cos(yaw), math.sin(yaw)
        moved = [(shift[0]+c*x-s*y, shift[1]+s*x+c*y) for x, y in route]
        origin = shift+np.array([c*12.-s*.3, s*12.+c*.3])
        _, rotated, _ = track(tuple(origin), .05+yaw, moved, speed_mps=5., target_speed_mps=6., geometry=GEOMETRY)
        np.testing.assert_allclose(np.asarray(rotated), np.asarray(reference), atol=1e-7)

    def test_polyline_extends_behind_first_waypoint_and_lookahead_grows(self):
        line = RoutePolyline([(5., 0.), (7., 0.), (9., 0.)])
        s, _ = line.project(0., 0.)
        self.assertGreater(s, 0.)
        self.assertLess(lookahead_m(0.), lookahead_m(5.))
        self.assertLessEqual(lookahead_m(40.), 16.)


def street_scene(*, obstacle=None, measured_to_y=30.):
    """Measured LiDAR returns of an L-shaped street turning right and a building straight ahead.

    ``measured_to_y`` truncates the side street's returns, as a corner
    building does: nothing beyond it is observed, not even by passing rays.
    """
    points = []
    for x in np.arange(-6., 16., .25):
        for y in np.arange(-3., 3., .25):points.append((x, y, .02))
    for x in np.arange(13., 23., .25):
        for y in np.arange(3., measured_to_y, .25):points.append((x, y, .02))
    for x in np.arange(23.5, 24.5, .25):
        for y in np.arange(-6., 6., .25):
            for z in np.arange(.4, 2.2, .3):points.append((x, y, z))
    if obstacle:
        x0, y0 = obstacle
        for x in np.arange(x0-.5, x0+.5, .2):
            for y in np.arange(y0-.5, y0+.5, .2):
                for z in np.arange(.3, 1.5, .3):points.append((x, y, z))
    return ObservedSpace(np.asarray(points, float), GEOMETRY)


class RouteProbeCoverageTest(unittest.TestCase):
    config = RuntimeSafetyConfig.load()

    def probes(self):
        route = [(x, 0.) for x in np.arange(-10., 10., 1.)]
        for a in np.linspace(0., math.pi/2, 25)[1:]:route.append((10.+8.*math.sin(a), 8.*(1-math.cos(a))))
        route += [(18., 8.+d) for d in np.arange(1., 30., 1.)]
        steering, path, _ = track((0., 0.), 0., route, speed_mps=0., target_speed_mps=4., geometry=GEOMETRY)
        curved = coverage_probe(0., self.config, GEOMETRY.front_m, GEOMETRY,
                                forward_path=extend_forward_path(np.asarray(path), 0., GEOMETRY.front_m, self.config))
        straight = coverage_probe(0., self.config, GEOMETRY.front_m, GEOMETRY)
        return curved, straight

    def test_curved_probe_reaches_past_the_corner_building_that_blocks_the_straight_probe(self):
        curved, straight = self.probes();space = street_scene()
        along_straight = space.continuous_coverage(straight);along_curve = space.continuous_coverage(curved)
        self.assertLess(along_straight, 21.)
        self.assertGreater(along_curve, along_straight+5.)

    def test_obstacle_inside_the_curved_corridor_still_limits_coverage(self):
        curved, _ = self.probes()
        free = street_scene().continuous_coverage(curved)
        blocked = street_scene(obstacle=(18., 14.)).continuous_coverage(curved)
        self.assertLess(blocked, free-3.)

    def test_unmeasured_space_on_the_curve_is_never_assumed_clear(self):
        curved, _ = self.probes()
        free = street_scene().continuous_coverage(curved)
        hidden = street_scene(measured_to_y=12.).continuous_coverage(curved)
        self.assertLess(hidden, free-3.)
        # The probe stops before the body would enter the unobserved street.
        end = curved[np.searchsorted(curved[:, 0], hidden)]
        self.assertLess(end[2]+GEOMETRY.front_m*math.sin(end[3]), 12.5)


class PathCorridorIndexTest(unittest.TestCase):
    def test_index_equals_full_projection_for_every_point_within_the_corridor(self):
        from backend.core.motion_geometry import PathCorridorIndex, path_coordinates
        rng = np.random.default_rng(3)
        for route in (right_turn(radius=6.5), right_turn(radius=12.), [(x, 0.) for x in np.arange(-5., 70., 2.)]):
            _, path, _ = track((5., .4), .02, route, speed_mps=3., target_speed_mps=6., geometry=GEOMETRY)
            path = np.asarray(path);width = 1.21
            points = rng.uniform(path[:, 1:3].min(axis=0)-6., path[:, 1:3].max(axis=0)+6., (40000, 2))
            index = PathCorridorIndex(path, width)
            along, lateral = index.coordinates(points[:, 0], points[:, 1])
            full_along, full_lateral = path_coordinates(points[:, 0], points[:, 1], path)
            inside = full_lateral <= width
            self.assertTrue(np.all(np.isfinite(lateral[inside])), 'a corridor point was dropped')
            np.testing.assert_allclose(along[inside], full_along[inside], atol=1e-9)
            np.testing.assert_allclose(lateral[inside], full_lateral[inside], atol=1e-9)
            self.assertTrue(np.all(lateral[~inside] > width))


class DenseRouteTest(unittest.TestCase):
    class Lane:
        """Analytic lane: straight to x=20, quarter circle of radius 8, then straight (+y)."""
        def __init__(self, s, offset=0.):self.s = s;self.offset = offset

        def point(self):
            s = self.s
            if s <= 20.:x, y, yaw = s, 0., 0.
            elif s <= 20.+8.*math.pi/2:
                a = (s-20.)/8.;x, y, yaw = 20.+8.*math.sin(a), 8.*(1-math.cos(a)), a
            else:x, y, yaw = 28., 8.+s-20.-8.*math.pi/2, math.pi/2
            return x-self.offset*math.sin(yaw), y+self.offset*math.cos(yaw)

        @property
        def transform(self):
            x, y = self.point()
            class Location:
                pass
            location = Location();location.x, location.y = x, y
            class Transform:
                pass
            t = Transform();t.location = location
            return t

        def next(self, d):return [DenseRouteTest.Lane(self.s+d, self.offset)]

    def test_dense_route_follows_lane_geometry_between_sparse_waypoints(self):
        sparse = [self.Lane(s) for s in np.arange(0., 50., 4.)]
        dense = np.asarray(dense_route(sparse))
        reference = np.asarray([self.Lane(s).point() for s in np.arange(0., 48.1, .05)])
        error = np.min(np.linalg.norm(dense[:, None, :]-reference[None, :, :], axis=2), axis=1)
        self.assertLess(error.max(), .03)
        self.assertLess(np.max(np.linalg.norm(np.diff(dense, axis=0), axis=1)), .6)

    def test_unreachable_next_waypoint_falls_back_to_the_chord(self):
        sparse = [self.Lane(0.), self.Lane(8., offset=3.5)]
        dense = np.asarray(dense_route(sparse))
        np.testing.assert_allclose(dense[0], [0., 0.]);np.testing.assert_allclose(dense[-1], [8., 3.5])
        direction = np.array([8., 3.5])/np.hypot(8., 3.5);offset = dense-dense[0]
        self.assertLess(np.max(np.abs(offset[:, 0]*direction[1]-offset[:, 1]*direction[0])), 1e-9)


class SupervisedPathSelectionTest(unittest.TestCase):
    def setUp(self):
        self.supervisor = ActiveSafetySupervisor()
        self.path = np.array([[0., 0., 0., 0.], [1., 1., .05, .1], [2., 2., .2, .2]])

    def observation(self, frame=10, stamp=1.):
        class Observation:pass
        o = Observation();o.frame_id = frame;o.timestamp_s = stamp
        return o

    def base(self, steering):
        return ControlCommand(10, 1., .3, 0., steering, False, False, CommandSource.NAVIGATION, 1)

    def test_route_probe_requires_same_frame_timestamp_and_steering(self):
        s = self.supervisor
        self.assertEqual(s.supervised_path(self.observation(), self.base(.2))[1], 'STEERING_ARC')
        s.route_probe = {'frame_id': 10, 'timestamp_s': 1., 'steering': .2, 'path_array': self.path}
        path, source = s.supervised_path(self.observation(), self.base(.2))
        self.assertEqual(source, 'ROUTE_TRACKER_PATH');np.testing.assert_array_equal(path, self.path)
        self.assertEqual(s.supervised_path(self.observation(frame=11), self.base(.2)), (None, 'STEERING_ARC_ROUTE_PROBE_STALE'))
        self.assertEqual(s.supervised_path(self.observation(stamp=1.05), self.base(.2))[1], 'STEERING_ARC_ROUTE_PROBE_STALE')
        self.assertEqual(s.supervised_path(self.observation(), self.base(.21))[1], 'STEERING_ARC_ROUTE_PROBE_STEERING_MISMATCH')
        self.assertEqual(s.supervised_path(self.observation(), self.base(.02))[1], 'STRAIGHT_ROUTE_PROBE_STEERING_MISMATCH')

    def test_invalid_probe_and_maneuver_path_priority(self):
        s = self.supervisor
        s.route_probe = {'frame_id': 10, 'timestamp_s': 1., 'steering': .2, 'path_array': self.path+np.array([0., .5, 0., 0.])}
        self.assertEqual(s.supervised_path(self.observation(), self.base(.2))[1], 'STEERING_ARC_ROUTE_PROBE_INVALID')
        s.forward_path = self.path
        self.assertEqual(s.supervised_path(self.observation(), self.base(.2))[1], 'SELECTED_MANEUVER_PATH')


if __name__ == '__main__':
    unittest.main()
