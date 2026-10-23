from types import SimpleNamespace as NS
from unittest import TestCase
import numpy as np
from backend.core.evidence_budget import (BudgetConfig, EvidenceBudget, LAYER_ID, TemporalVerifier, candidate_speeds,
                                          max_speed_for_distance, plan_profile, stopping_distance, verified_stationary)
from backend.core.kinematic_prediction import kinematic_modes
from backend.core.motion_geometry import VehicleGeometry
from backend.core.path_entry_features import corridor_coordinates

TEACHER = NS(reaction_time_s=.35, assumed_deceleration_mps2=5., minimum_clearance_m=3.)
GEOMETRY = VehicleGeometry()


def person_track(along, lateral=4., track='p1'):
    return {'id': track, 'class': 'person', 'confirmed': True, 'position_m': [along, lateral], 'velocity_mps': [0., 0.],
            'half_size_m': [.35, .35], 'uncertainty_m': .25, 'occlusion_s': 0.}


class EvidenceBudgetTests(TestCase):
    def setUp(self):
        self.layer = EvidenceBudget(BudgetConfig.from_teacher(TEACHER))

    def decide(self, t, v, along, *, lateral=4., risk_only=False, tracks=None, **kw):
        tracks = tracks or [person_track(along, lateral)]
        verifier = TemporalVerifier(tracks, kinematic_modes(tracks), geometry=GEOMETRY, speed_mps=v, steering=0.,
                                    config=self.layer.config)
        people = [{'track_id': tr['id'], 'risk_only': risk_only} for tr in tracks]
        values = dict(timestamp_s=t, speed_mps=v, target_speed_mps=11., physical_brake=False, people=people, verifier=verifier,
                      rule_crawl_cap_mps=None, observation_age_s=.05, processing_latency_s=.1)
        values.update(kw)
        return self.layer.decide(**values)

    def test_stopping_distance_inverse_is_exact(self):
        for distance in (4., 12., 40.):
            v = max_speed_for_distance(distance, .9, 5., 3.)
            self.assertAlmostEqual(stopping_distance(v, .9, 5., 3.), distance, places=9)
        self.assertEqual(max_speed_for_distance(2., .9, 5., 3.), 0.)

    def test_plan_profile_brakes_after_the_detection_delay(self):
        grid = np.round(np.arange(31)*.1, 6)
        v, d = plan_profile(10., 10., grid, deceleration_mps2=2.5, acceleration_mps2=4.5, brake_after_s=1., brake_deceleration_mps2=5.)
        self.assertAlmostEqual(v[10], 10.);self.assertAlmostEqual(v[20], 5.);self.assertEqual(v[-1], 0.)
        self.assertAlmostEqual(d[-1], 10.+10.**2/10., places=6)
        v, _ = plan_profile(10., 4., grid, deceleration_mps2=2.5, acceleration_mps2=4.5)
        self.assertAlmostEqual(v[10], 7.5);self.assertEqual(v[-1], 4.)
        self.assertEqual(candidate_speeds(6., 11.)[0], 11.);self.assertIn(6., candidate_speeds(6., 11.))
        self.assertEqual(min(candidate_speeds(0., 11.)), .5)

    def test_physical_risk_is_always_protective_without_delay(self):
        result = self.decide(0., 10., 80., physical_brake=True)
        self.assertEqual((result['response'], result['kind'], result['layer']), ('PROTECTIVE_BRAKING', 'PHYSICAL_PROTECTIVE', LAYER_ID))
        result = self.decide(.05, 10., 80., physical_brake=True, risk={'p1': {'3s': .0}}, use_risk=True)
        self.assertEqual(result['response'], 'PROTECTIVE_BRAKING')

    def test_far_curbside_person_keeps_the_planned_speed_with_a_verified_stop_after_detection(self):
        result = self.decide(0., 10., 60.)
        self.assertEqual(result['response'], 'CONTINUE')
        self.assertIn(result['kind'], ('PASS_BEFORE_REACH', 'OBSERVATION_AFFORDABLE'))
        # Independent check: braking after the delay stops before the person can be reached.
        grid = np.round(np.arange(60)*.1, 6)
        _, d = plan_profile(10., 11., grid, deceleration_mps2=2.5, acceleration_mps2=4.5, brake_after_s=result['delay_s'])
        self.assertLess(d[-1]+GEOMETRY.front_m, 60.-.35-.25)

    def test_approach_slows_to_the_highest_verified_plan_and_then_needs_protection(self):
        responses = []
        for along in (60., 35., 28., 22.):
            self.layer.reset()
            responses.append(self.decide(0., 10., along))
        self.assertEqual(responses[0]['response'], 'CONTINUE')
        cautious = [r for r in responses if r['response'] == 'CAUTIOUS_APPROACH']
        self.assertTrue(cautious, [r['kind'] for r in responses])
        for r in cautious:
            self.assertEqual(r['kind'], 'SLOWING_FOR_OBSERVATION')
            self.assertLess(r['target_speed_mps'], 11.);self.assertLessEqual(r['brake'], .4)
            self.assertNotIn('UNVERIFIED', r['responses'].values())
        self.layer.reset()
        close = self.decide(0., 11., 12.)
        self.assertEqual(close['response'], 'PROTECTIVE_BRAKING')
        self.assertIn(close['kind'], ('STOP_BEFORE_POSSIBLE_CONFLICT', 'AMBIGUOUS_PROTECTIVE'))

    def test_beside_a_stationary_person_rule_verified_crawl_avoids_an_indefinite_stop(self):
        held = self.decide(0., 0., 3.5, lateral=2.6)
        self.assertEqual(held['response'], 'PROTECTIVE_BRAKING')
        self.layer.reset()
        crawl = self.decide(0., 0., 3.5, lateral=2.6, rule_crawl_cap_mps=2.)
        self.assertEqual((crawl['response'], crawl['kind'], crawl['target_speed_mps']), ('CAUTIOUS_APPROACH', 'RULE_VERIFIED_CRAWL', 2.))

    def test_high_calibrated_risk_only_lowers_the_speed(self):
        base = self.decide(0., 10., 30.)
        self.layer.reset()
        risky = self.decide(0., 10., 30., risk={'p1': {'3s': .9}}, use_risk=True)
        self.layer.reset()
        safe = self.decide(0., 10., 30., risk={'p1': {'3s': .01}}, use_risk=True)
        self.assertTrue(risky['risk_used']);self.assertFalse(safe['risk_used'])
        self.assertLess(risky['target_speed_mps'] or 11., base['target_speed_mps'] or 11.)
        self.assertEqual((safe['response'], safe['target_speed_mps']), (base['response'], base['target_speed_mps']))

    def test_risk_only_people_add_caution_but_never_protective_braking(self):
        risky = self.decide(0., 10., 30., risk_only=True, risk={'p1': {'3s': .9}}, use_risk=True)
        self.assertEqual(risky['response'], 'CAUTIOUS_APPROACH');self.assertTrue(risky['risk_used'])
        self.assertLessEqual(risky['brake'], .4)
        self.layer.reset()
        calm = self.decide(0., 10., 30., risk_only=True, risk={'p1': {'3s': .1}}, use_risk=True)
        self.assertEqual(calm['response'], 'CONTINUE')
        self.layer.reset()
        close = self.decide(0., 10., 15., risk_only=True, risk={'p1': {'3s': .99}}, use_risk=True)
        self.assertEqual(close['response'], 'CAUTIOUS_APPROACH')
        # A fast car that passes before any reachable alternative can enter is not slowed.
        self.layer.reset()
        passing = self.decide(0., 14., 6., risk_only=True, risk={'p1': {'3s': .99}}, use_risk=True)
        self.assertEqual(passing['response'], 'CONTINUE')

    def test_release_and_cap_increase_have_bounded_hysteresis(self):
        self.assertEqual(self.decide(0., 11., 12.)['response'], 'PROTECTIVE_BRAKING')
        held = self.decide(.05, 3., 80.)
        self.assertEqual((held['response'], held['hysteresis']), ('PROTECTIVE_BRAKING', 'RELEASE_HOLD'))
        for k in range(2, 20):
            released = self.decide(k*.05, 3., 80.)
            if released['response'] != 'PROTECTIVE_BRAKING':break
        self.assertLessEqual(k*.05, .5)
        low = self.decide(1.0, 10., 21.)['target_speed_mps']
        self.assertIsNotNone(low)
        raised = self.decide(1.05, 10., 80.)
        self.assertEqual(raised['target_speed_mps'], low);self.assertEqual(raised['hysteresis'], 'RAISE_HOLD')
        later = self.decide(1.6, 10., 80.)
        self.assertEqual(later['response'], 'CONTINUE')
        # Lowering is immediate.
        self.assertLess(self.decide(1.65, 10., 18.)['target_speed_mps'], 11.)

    def test_hysteresis_never_holds_below_the_rule_verified_crawl(self):
        # Flicker seen natively: a re-identified person is briefly unverified
        # (RULE decides that frame), then verified again with RULE's crawl at 4 m/s.
        self.assertEqual(self.decide(0., 0., 18., lateral=8., physical_brake=True)['response'], 'PROTECTIVE_BRAKING')
        held = self.decide(.05, 0., 18., lateral=8., rule_crawl_cap_mps=4.)
        self.assertEqual((held['response'], held['hysteresis'], held['target_speed_mps']),
                         ('CAUTIOUS_APPROACH', 'RELEASE_HOLD_AT_RULE_CRAWL', 4.))
        targets = [self.decide(.05*k, 0., 18., lateral=8., rule_crawl_cap_mps=4., physical_brake=k % 8 == 0)
                   for k in range(2, 40)]
        moving = [r for r in targets if r['response'] != 'PROTECTIVE_BRAKING']
        self.assertTrue(moving and all(r['target_speed_mps'] is None or r['target_speed_mps'] >= 4. for r in moving))
        # Without a RULE-verified crawl the release hold still brakes.
        self.layer.reset()
        self.decide(0., 0., 18., lateral=8., physical_brake=True)
        self.assertEqual(self.decide(.05, 0., 18., lateral=8.)['hysteresis'], 'RELEASE_HOLD')
        # The floor never exceeds the layer's own verified cap.
        self.layer.reset()
        self.decide(0., 10., 22., physical_brake=True)
        capped = self.decide(.05, 10., 22., rule_crawl_cap_mps=30.)
        self.assertLessEqual(capped['target_speed_mps'], 11.)

    def test_measured_obstacle_braking_does_not_arm_pedestrian_hysteresis(self):
        # Natively a measured-obstacle flicker became ~1 s full stops through this layer's holds.
        hazard = self.decide(0., 8., 80., physical_brake=True, pedestrian_physical=False)
        self.assertEqual((hazard['response'], hazard['kind']), ('PROTECTIVE_BRAKING', 'PHYSICAL_PROTECTIVE'))
        after = self.decide(.05, 8., 80.)
        self.assertEqual((after['response'], after['hysteresis']), ('CONTINUE', None))
        # A person-related physical frame still arms the bounded release hold.
        self.layer.reset()
        self.decide(0., 8., 80., physical_brake=True, pedestrian_physical=True)
        self.assertEqual(self.decide(.05, 8., 80.)['hysteresis'], 'RELEASE_HOLD')
        # Once no person conflict remains, nothing is held (RULE has none either).
        empty = self.layer.decide(timestamp_s=.1, speed_mps=0., target_speed_mps=11., physical_brake=False, people=[],
                                  verifier=None, rule_crawl_cap_mps=None, observation_age_s=.05, processing_latency_s=.1)
        self.assertEqual((empty['response'], empty['kind'], empty['hysteresis']), ('CONTINUE', 'NO_SPECULATIVE_CONFLICT', None))
        self.assertEqual(self.decide(.15, 0., 80.)['hysteresis'], None)

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
