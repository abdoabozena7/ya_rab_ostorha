"""Closed-loop kinematic sweep of the time-indexed evidence-budget layer (no simulator).

A curbside person may begin a 6 m/s^2, 3.5 m/s sprint toward the lane at any
moment. Until measured motion is confirmed (0.3 s) the layer sees a
verified-stationary person with RULE's real kinematic alternatives; the
protective response then takes effect only after the measured processing
latency and the reaction time. The ego must never collide, and a person who
never moves must still be passed without an indefinite stop when RULE's crawl
is verified.
"""
import unittest
from types import SimpleNamespace as NS
from backend.core.evidence_budget import BudgetConfig, EvidenceBudget, TemporalVerifier
from backend.core.kinematic_prediction import kinematic_modes
from backend.core.motion_geometry import VehicleGeometry

TEACHER = NS(reaction_time_s=.35, assumed_deceleration_mps2=5., minimum_clearance_m=3.)
GEOMETRY = VehicleGeometry()
FRONT, REAR, HALF_WIDTH, PERSON = GEOMETRY.front_m, GEOMETRY.rear_m, GEOMETRY.half_width_m, .35
DT, CONFIRM, LATENCY, REACTION = .05, .3, .15, .35


def sprint(elapsed):
    if elapsed <= 0.:return 0.
    t1 = 3.5/6.
    return 3.*elapsed*elapsed if elapsed < t1 else 3.*t1*t1+3.5*(elapsed-t1)


def crawl_cap(gap, speed):
    """RULE's verified crawl: the sprint cannot reach the path within reaction + stop + 0.1 s."""
    for cap in (4., 3., 2., 1., .5):
        if sprint(.35+max(speed, cap)/5.+.1) < gap:return cap
    return None


def simulate(start_s, *, lateral=4.0, person_x=45., target=11., limit_s=25.):
    layer = EvidenceBudget(BudgetConfig.from_teacher(TEACHER))
    x = 0.;v = target;t = 0.;stopped = 0.;longest = 0.;protect_at = None;command = ('CONTINUE', None)
    while t < limit_s:
        y = lateral-(sprint(t-start_s) if start_s is not None else 0.);along = person_x-x
        if along+PERSON < -REAR:return {'collision': False, 'passed': True, 'longest_stop_s': longest, 'time_s': t}
        if abs(y) <= HALF_WIDTH+PERSON and -REAR-PERSON <= along <= FRONT+PERSON:
            return {'collision': True, 'time_s': t, 'speed': v, 'start_s': start_s, 'lateral': lateral}
        if start_s is not None and t-start_s >= CONFIRM and protect_at is None:protect_at = t+LATENCY+REACTION
        if protect_at is not None:
            if t >= protect_at:command = ('PROTECTIVE_BRAKING', None)
        else:
            track = {'id': 'p', 'class': 'person', 'confirmed': True, 'position_m': [along, y], 'velocity_mps': [0., 0.],
                     'half_size_m': [PERSON, PERSON], 'uncertainty_m': .25, 'occlusion_s': 0.}
            verifier = TemporalVerifier([track], kinematic_modes([track]), geometry=GEOMETRY, speed_mps=v, steering=0., config=layer.config)
            gap = abs(y)-HALF_WIDTH-PERSON-.25
            decision = layer.decide(timestamp_s=t, speed_mps=v, target_speed_mps=target, physical_brake=gap <= 0.,
                                    people=[{'track_id': 'p', 'risk_only': False}] if along > -REAR else [], verifier=verifier,
                                    rule_crawl_cap_mps=crawl_cap(gap, v), observation_age_s=DT, processing_latency_s=LATENCY)
            command = (decision['response'], decision['target_speed_mps'])
        response, cap = command
        if response == 'PROTECTIVE_BRAKING':a = -5.
        elif response == 'CAUTIOUS_APPROACH':a = -2.5 if v > cap+.1 else min(2., (cap-v)/DT)
        else:a = min(2., (target-v)/DT)
        v = max(0., v+a*DT);x += v*DT;t += DT
        stopped = stopped+DT if v < .15 else 0.;longest = max(longest, stopped)
    return {'collision': False, 'passed': False, 'longest_stop_s': longest, 'time_s': t}


class EvidenceBudgetReplayTests(unittest.TestCase):
    def test_sudden_sprint_at_any_moment_never_collides(self):
        for lateral in (2.65, 3.2, 4.5):
            for k in range(0, 24):
                result = simulate(k*.2, lateral=lateral)
                self.assertFalse(result['collision'], result)

    def test_stationary_person_is_passed_without_an_indefinite_stop(self):
        for lateral in (2.9, 3.2, 4.0, 5.5):
            result = simulate(None, lateral=lateral)
            self.assertTrue(result['passed'], (lateral, result));self.assertLess(result['longest_stop_s'], 1.)

    def test_unverifiable_curbside_gap_holds_instead_of_guessing(self):
        # 0.9 m from the swept path a sprint reaches the path within even the
        # 0.5 m/s reaction + stop horizon; the physical layer keeps holding.
        result = simulate(None, lateral=2.65)
        self.assertFalse(result['collision']);self.assertFalse(result['passed'])

    def test_far_people_do_not_force_early_braking(self):
        layer = EvidenceBudget(BudgetConfig.from_teacher(TEACHER))
        track = {'id': 'p', 'class': 'person', 'confirmed': True, 'position_m': [58., 4.], 'velocity_mps': [0., 0.],
                 'half_size_m': [.35, .35], 'uncertainty_m': .25, 'occlusion_s': 0.}
        verifier = TemporalVerifier([track], kinematic_modes([track]), geometry=GEOMETRY, speed_mps=11., steering=0., config=layer.config)
        decision = layer.decide(timestamp_s=0., speed_mps=11., target_speed_mps=11., physical_brake=False,
                                people=[{'track_id': 'p', 'risk_only': False}], verifier=verifier, rule_crawl_cap_mps=None,
                                observation_age_s=.05, processing_latency_s=.15)
        self.assertEqual(decision['response'], 'CONTINUE')


if __name__ == '__main__':
    unittest.main()
