import unittest
from backend.learning.rl.maneuver_reward import REWARD_VERSION, ManeuverReward


class ManeuverRewardV3Tests(unittest.TestCase):
    def test_comfortable_launch_beats_holding_with_a_verified_forward_candidate(self):
        launch = ManeuverReward(40.);hold = ManeuverReward(40.)
        speed = 0.;position = 0.;launched = held = 0.
        for _ in range(20):  # two seconds at 1.5 m/s^2
            speed += .15;position += speed*.1
            value, parts = launch.evaluate(progress_m=position, dt=.1, acceleration_mps2=1.5)
            self.assertEqual(parts['discomfort'], 0.);launched += value
            value, parts = hold.evaluate(progress_m=0., dt=.1, acceleration_mps2=0., stationary_with_verified_forward=True)
            self.assertLess(parts['unnecessary_stationary'], 0.);held += value
        self.assertGreater(launched, 0.);self.assertLess(held, 0.);self.assertEqual(REWARD_VERSION, 3)

    def test_harsh_acceleration_is_still_penalized(self):
        _, parts = ManeuverReward(40.).evaluate(progress_m=0., dt=.1, acceleration_mps2=-8.)
        self.assertLess(parts['discomfort'], 0.)

    def test_reversing_then_returning_cannot_harvest_progress(self):
        reward = ManeuverReward(10.);total = 0.
        for progress in (5., 2., 5., 2., 5.):
            total += reward.evaluate(progress_m=progress, dt=.1)[1]['progress']
        self.assertAlmostEqual(total, 10.*(5.-3.-3.)/10.)

    def test_stationary_without_a_verified_forward_option_is_not_penalized(self):
        _, parts = ManeuverReward(40.).evaluate(progress_m=0., dt=.1, stationary_with_verified_forward=False)
        self.assertEqual(parts['unnecessary_stationary'], 0.)
        value, parts = ManeuverReward(40.).evaluate(progress_m=0., dt=.1, collision='VULNERABLE')
        self.assertEqual(parts['collision'], -200.)
