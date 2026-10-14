"""Direction and lateral-motion regressions for sensor-only RULE braking."""
from dataclasses import replace
import math
import json
import unittest

import numpy as np

from backend.core.path_conflicts import LidarPathConflicts
from backend.core.active_safety import ActiveSafetySupervisor
from tests.test_active_safety import scene
from tests.test_safety_teacher import case


def surface(x, y):
    return np.asarray([[x + dx, y + dy, z]
                       for dx in (-.4, 0., .4)
                       for dy in (-.3, 0., .3)
                       for z in (.6, 1., 1.4)])


def observe(tracker, frame, points, speed=0.):
    observation, _ = case(frame, speed=speed, distance=None)
    observation = replace(observation, ego=replace(observation.ego,
        angular_velocity_radps=(0., 0., 0.)))
    return tracker.assess(points, observation)


class DirectionalPathConflictTests(unittest.TestCase):
    def test_closing_car_behind_does_not_request_forward_braking(self):
        tracker = LidarPathConflicts()
        for frame in range(1, 18):
            result = observe(tracker, frame, surface(-7 + frame * .15, 0.))
            self.assertIsNone(result['conflict'])

    def test_adjacent_sampling_jitter_does_not_become_a_cut_in(self):
        tracker = LidarPathConflicts()
        for frame in range(1, 45):
            # A nearby parallel surface with 3 cm alternating sampling error.
            points = surface(2.5, 2. + .03 * math.sin(frame * .9))
            result = observe(tracker, frame, points)
            self.assertIsNone(result['conflict'])

    def test_adjacent_overtaking_without_lateral_ingress_does_not_brake(self):
        tracker = LidarPathConflicts()
        for frame in range(1, 25):
            result = observe(tracker, frame, surface(-6 + frame * .35, 2.5), speed=3.)
            self.assertIsNone(result['conflict'])

    def test_cut_in_behind_ego_does_not_request_counterproductive_braking(self):
        tracker = LidarPathConflicts()
        for frame in range(1, 15):
            result = observe(tracker, frame, surface(-4.5 - frame * .15, 3. - frame * .08), speed=3.)
            self.assertIsNone(result['conflict'])

    def test_confirmed_cut_in_ahead_still_requests_braking(self):
        for sign in (-1., 1.):
            with self.subTest(side=sign):
                tracker = LidarPathConflicts()
                results = [observe(tracker, frame,
                    surface(7. - frame * .15, sign * (4. - frame * .08)), speed=3.)
                    for frame in range(1, 13)]
                self.assertTrue(any(r['conflict'] for r in results))

    def test_slow_sustained_merge_ahead_is_still_detected(self):
        tracker = LidarPathConflicts()
        results = [observe(tracker, frame,
            surface(4. - frame * .05, 2.5 - frame * .02), speed=1.)
            for frame in range(1, 30)]
        self.assertTrue(any(r['conflict'] for r in results))

    def test_low_speed_lateral_registration_drift_is_not_a_merge(self):
        tracker=LidarPathConflicts()
        for frame in range(1,31):
            result=observe(tracker,frame,surface(5.,2.3-frame*.012))
            json.dumps(result,allow_nan=False)
            self.assertIsNone(result['conflict'])

    def test_changing_visible_face_with_fixed_inner_edge_does_not_brake(self):
        tracker=LidarPathConflicts()
        fixed=np.asarray([[x,2.,z] for x in (4.6,5.,5.4) for z in (.6,1.,1.4)])
        for frame in range(1,21):
            cloud=np.vstack((fixed,surface(5.,2.8-frame*.02)))
            result=observe(tracker,frame,cloud)
            self.assertIsNone(result['conflict'])

    def test_runtime_preserves_base_driver_for_rear_and_parallel_cars(self):
        for kind in ('rear', 'adjacent'):
            with self.subTest(kind=kind):
                supervisor = ActiveSafetySupervisor()
                for frame in range(1, 25):
                    observation, base = case(frame, speed=3., distance=None)
                    observation, road_reader = scene(observation, clear=True)
                    observation = replace(observation, ego=replace(observation.ego,
                        angular_velocity_radps=(0., 0., 0.)))
                    body = (surface(-8. + frame * .1, 0.) if kind == 'rear' else
                            surface(2.5, 2.5 + .03 * math.sin(frame * .9)))
                    # Convert body returns to the LiDAR's calibrated local frame.
                    body[:, 2] -= 1.9
                    road = np.frombuffer(road_reader(None), '<f4').reshape(-1, 4)
                    cloud = np.vstack((road, np.column_stack((body, np.full(len(body), .5)))))
                    encoded = cloud.astype('<f4').tobytes()
                    command = supervisor.evaluate(observation, base, lambda _: encoded,
                                                  as_of_timestamp_s=observation.timestamp_s)
                    self.assertIsNone(command)
                self.assertEqual(supervisor.interventions, 0)

    def test_front_obstacle_still_brakes_with_a_closing_car_behind(self):
        supervisor = ActiveSafetySupervisor()
        for frame in range(1, 15):
            observation, base = case(frame, speed=3., distance=8., velocity=-8.)
            observation, road_reader = scene(observation, clear=True)
            observation = replace(observation, ego=replace(observation.ego,
                angular_velocity_radps=(0., 0., 0.)))
            body = surface(-8. + frame * .1, 0.)
            body[:, 2] -= 1.9
            road = np.frombuffer(road_reader(None), '<f4').reshape(-1, 4)
            cloud = np.vstack((road, np.column_stack((body, np.full(len(body), .5)))))
            encoded = cloud.astype('<f4').tobytes()
            command = supervisor.evaluate(observation, base, lambda _: encoded,
                                          as_of_timestamp_s=observation.timestamp_s)
            self.assertEqual(command.brake, 1.)
            self.assertEqual(command.throttle, 0.)
            self.assertEqual(supervisor.status['risk'], 'FORWARD_COLLISION_RISK')


if __name__ == '__main__':
    unittest.main()
