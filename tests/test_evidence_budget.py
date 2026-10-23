from types import SimpleNamespace as NS
from unittest import TestCase
import numpy as np
from backend.core.evidence_budget import (BudgetConfig, EvidenceBudget, max_speed_for_distance, stopping_distance,
                                          verified_stationary)
from backend.core.path_entry_features import corridor_coordinates

TEACHER = NS(reaction_time_s=.35, assumed_deceleration_mps2=5., minimum_clearance_m=3.)


def person(zone, track='p1'):
    return {'track_id': track, 'zone_m': zone, 'lateral_gap_m': 1.5, 'along_m': zone+3., 'offset_m': 4.}


class EvidenceBudgetTests(TestCase):
    def setUp(self):
        self.layer = EvidenceBudget(BudgetConfig.from_teacher(TEACHER))

    def decide(self, t, v, zone, **kw):
        values = dict(timestamp_s=t, speed_mps=v, target_speed_mps=11., physical_brake=False,
                      speculative=[person(zone)], rule_crawl_cap_mps=None, observation_age_s=.05, processing_latency_s=.1)
        values.update(kw)
        return self.layer.decide(**values)

    def test_stopping_distance_inverse_is_exact(self):
        for distance in (4., 12., 40.):
            v = max_speed_for_distance(distance, .9, 5., 3.)
            self.assertAlmostEqual(stopping_distance(v, .9, 5., 3.), distance, places=9)
        self.assertEqual(max_speed_for_distance(2., .9, 5., 3.), 0.)

    def test_physical_risk_is_always_protective_without_delay(self):
        result = self.decide(0., 10., 80., physical_brake=True)
        self.assertEqual(result['response'], 'PROTECTIVE_BRAKING')
        # Low learned risk cannot change a physical decision.
        result = self.decide(.05, 10., 80., physical_brake=True, risk={'p1': {'3s': .0}}, use_risk=True)
        self.assertEqual(result['response'], 'PROTECTIVE_BRAKING')

    def test_continues_while_another_observation_and_a_stop_remain_affordable(self):
        result = self.decide(0., 10., 60.)
        self.assertEqual(result['response'], 'CONTINUE')
        delay = result['delay_s']
        self.assertGreaterEqual(60., stopping_distance(10., delay, 2.5, 3.))

    def test_cautious_cap_is_the_highest_verified_speed_and_never_exceeds_hard_limit(self):
        result = self.decide(0., 10., 25.)
        self.assertEqual(result['response'], 'CAUTIOUS_APPROACH')
        cap = result['target_speed_mps']
        self.assertAlmostEqual(cap, max_speed_for_distance(25., result['delay_s'], 2.5, 3.))
        self.assertLessEqual(cap, result['hard_cap_mps'])
        self.assertGreater(result['brake'], 0.);self.assertLessEqual(result['brake'], .4)

    def test_too_fast_for_the_hard_stop_limit_brakes_protectively(self):
        result = self.decide(0., 15., 12.)
        self.assertEqual(result['response'], 'PROTECTIVE_BRAKING')

    def test_stationary_person_does_not_cause_an_indefinite_stop_with_verified_crawl(self):
        # Beside the person the stop-before-zone budget is zero, but RULE's
        # verified crawl (reaction + full stop horizon) still admits motion.
        result = self.decide(0., 0., 1., rule_crawl_cap_mps=2.)
        self.assertEqual(result['response'], 'CAUTIOUS_APPROACH');self.assertEqual(result['target_speed_mps'], 2.)
        held = self.decide(.05, 0., 1., rule_crawl_cap_mps=None)
        self.assertEqual(held['response'], 'PROTECTIVE_BRAKING')

    def test_high_calibrated_risk_only_lowers_the_speed(self):
        base = self.decide(0., 6., 30.)
        self.layer.reset()
        risky = self.decide(0., 6., 30., risk={'p1': {'3s': .9}}, use_risk=True)
        self.layer.reset()
        safe = self.decide(0., 6., 30., risk={'p1': {'3s': .01}}, use_risk=True)
        self.assertTrue(risky['risk_used'])
        self.assertLess(risky['target_speed_mps'], base['target_speed_mps'] if base['target_speed_mps'] else 11.)
        self.assertEqual(safe['response'], base['response']);self.assertEqual(safe['target_speed_mps'], base['target_speed_mps'])

    def test_risk_only_people_add_caution_but_never_protective_braking(self):
        risky = self.decide(0., 10., 50., speculative=[], risk={'p1': {'3s': .9}}, use_risk=True, risk_people=[person(30.)])
        self.assertEqual(risky['response'], 'CAUTIOUS_APPROACH');self.assertTrue(risky['risk_used'])
        self.assertLessEqual(risky['brake'], .4)
        self.layer.reset()
        calm = self.decide(0., 10., 50., speculative=[], risk={'p1': {'3s': .1}}, use_risk=True, risk_people=[person(30.)])
        self.assertEqual(calm['response'], 'CONTINUE')
        self.layer.reset()
        close = self.decide(0., 14., 50., speculative=[], risk={'p1': {'3s': .99}}, use_risk=True, risk_people=[person(6.)])
        self.assertEqual(close['response'], 'CAUTIOUS_APPROACH')

    def test_release_and_cap_increase_have_bounded_hysteresis(self):
        self.assertEqual(self.decide(0., 15., 12.)['response'], 'PROTECTIVE_BRAKING')
        held = self.decide(.05, 3., 40.)
        self.assertEqual((held['response'], held['hysteresis']), ('PROTECTIVE_BRAKING', 'RELEASE_HOLD'))
        released = None
        for k in range(2, 20):
            released = self.decide(k*.05, 3., 40.)
            if released['response'] != 'PROTECTIVE_BRAKING':break
        self.assertLessEqual(k*.05, .5)
        low = self.decide(1.0, 3., 20.)['target_speed_mps']
        raised = self.decide(1.05, 3., 60.)
        self.assertEqual(raised['target_speed_mps'], low);self.assertEqual(raised['hysteresis'], 'RAISE_HOLD')
        later = self.decide(1.6, 3., 60.)
        self.assertEqual(later['response'], 'CONTINUE')
        # Lowering is immediate.
        self.assertLess(self.decide(1.65, 3., 15.)['target_speed_mps'], 11.)

    def test_verified_stationary_requires_history_and_position_stability(self):
        track = {'confirmed': True, 'occlusion_s': 0., 'velocity_mps': [0., 0.], 'uncertainty_m': .15,
                 'history': [[t, 10., 4.+.01*k, 0., 0.] for k, t in enumerate(np.arange(1.2, 2.01, .1))]}
        self.assertTrue(verified_stationary(track, 2.))
        self.assertFalse(verified_stationary({**track, 'history': track['history'][-3:]}, 2.))
        moving = {**track, 'history': [[t, 10., 4.-.5*(t-1.2), 0., -.5] for t in np.arange(1.2, 2.01, .1)]}
        self.assertFalse(verified_stationary(moving, 2.))
        self.assertFalse(verified_stationary({**track, 'velocity_mps': [0., -.6]}, 2.))

    def test_person_zone_accounts_for_size_uncertainty_and_heading_reach(self):
        geometry = NS(half_width_m=1., front_m=2.3)
        zone = self.layer.person_zone({'id': 'p', 'position_m': [30., 5.], 'half_size_m': [.35, .35], 'uncertainty_m': .25},
                                      geometry=geometry, curvature=0., corridor_coordinates=corridor_coordinates)
        gap = 5.-1.-.35-.25
        self.assertAlmostEqual(zone['lateral_gap_m'], gap)
        self.assertAlmostEqual(zone['zone_m'], 30.-2.3-.35-.25-.5*gap)
