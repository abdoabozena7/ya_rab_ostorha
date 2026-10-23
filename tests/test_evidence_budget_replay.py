"""Closed-loop kinematic sweep of the evidence-budget layer (no simulator).

A curbside person may begin a 6 m/s², 3.5 m/s sprint toward the lane at any
moment. Measured motion appears only after a confirmation delay; until then
the track is a verified-stationary speculative person. Measured motion makes
the response protective (as in RULE). The ego must never collide, and when
the person never moves it must still pass without an indefinite stop.
"""
import math
import unittest
from types import SimpleNamespace as NS
from backend.core.evidence_budget import BudgetConfig, EvidenceBudget

TEACHER = NS(reaction_time_s=.35, assumed_deceleration_mps2=5., minimum_clearance_m=3.)
FRONT, REAR, HALF_WIDTH, PERSON = 2.5, 2.5, 1.15, .35
DT = .05


def sprint(elapsed):
    if elapsed <= 0.:return 0., 0.
    t1 = 3.5/6.
    return (3.*elapsed*elapsed, 6.*elapsed) if elapsed < t1 else (3.*t1*t1+3.5*(elapsed-t1), 3.5)


def crawl_cap(gap, speed):
    """RULE's verified crawl: the sprint cannot reach the path within reaction + stop + 0.1 s."""
    for cap in (4., 3., 2., 1., .5):
        horizon = .35+max(speed, cap)/5.+.1
        if sprint(horizon)[0] < gap:return cap
    return None


def simulate(start_s, *, lateral=4.0, person_x=60., target=11., confirmation=.3, uncertainty=.25):
    layer = EvidenceBudget(BudgetConfig.from_teacher(TEACHER));x = 0.;v = target;t = 0.;stopped = 0.;longest = 0.
    while t < 40.:
        moved, speed_person = sprint(t-start_s) if start_s is not None else (0., 0.)
        y = lateral-moved
        measured_moving = start_s is not None and t-start_s >= confirmation
        gap = abs(y)-HALF_WIDTH-PERSON-uncertainty
        along = person_x-x
        if along+PERSON < -REAR:return {'collision': False, 'passed': True, 'longest_stop_s': longest, 'time_s': t}
        if abs(y) <= HALF_WIDTH+PERSON and -REAR-PERSON <= along <= FRONT+PERSON:
            return {'collision': True, 'time_s': t, 'speed': v, 'start_s': start_s}
        if measured_moving or gap <= 0.:
            response = 'PROTECTIVE_BRAKING';decision = {'brake': None}
        else:
            zone = along-FRONT-PERSON-uncertainty-.5*max(0., gap)
            people = [{'track_id': 'p', 'zone_m': zone, 'lateral_gap_m': gap}] if along > -REAR else []
            decision = layer.decide(timestamp_s=t, speed_mps=v, target_speed_mps=target, physical_brake=False, speculative=people,
                                    rule_crawl_cap_mps=crawl_cap(gap, v) if people else None, observation_age_s=DT,
                                    processing_latency_s=.15)
            response = decision['response']
        if response == 'PROTECTIVE_BRAKING':a = -5.
        elif response == 'CAUTIOUS_APPROACH':
            cap = decision['target_speed_mps']
            a = -5.*decision['brake'] if v > cap+.1 else min(2., (cap-v)/DT)
        else:a = min(2., (target-v)/DT)
        v = max(0., v+a*DT);x += v*DT;t += DT
        stopped = stopped+DT if v < .15 else 0.;longest = max(longest, stopped)
    return {'collision': False, 'passed': False, 'longest_stop_s': longest, 'time_s': t}


class EvidenceBudgetReplayTests(unittest.TestCase):
    def test_sudden_sprint_at_any_moment_never_collides(self):
        for lateral in (2.65, 2.9, 3.2, 4.0, 5.5):
            for k in range(0, 120):
                result = simulate(k*.05, lateral=lateral)
                self.assertFalse(result['collision'], (lateral, k*.05, result))

    def test_stationary_person_is_passed_without_an_indefinite_stop(self):
        for lateral in (2.9, 3.2, 4.0, 5.5):
            result = simulate(None, lateral=lateral)
            self.assertTrue(result['passed'], (lateral, result));self.assertLess(result['longest_stop_s'], 1.)

    def test_unverifiable_curbside_gap_holds_instead_of_guessing(self):
        # 0.9 m from the swept path a sprint reaches the path within even the
        # 0.5 m/s reaction + stop horizon; the physical layer keeps holding.
        result = simulate(None, lateral=2.65)
        self.assertFalse(result['collision']);self.assertFalse(result['passed'])

    def test_far_people_do_not_force_early_hard_braking(self):
        layer = EvidenceBudget(BudgetConfig.from_teacher(TEACHER))
        decision = layer.decide(timestamp_s=0., speed_mps=11., target_speed_mps=11., physical_brake=False,
                                speculative=[{'track_id': 'p', 'zone_m': 55., 'lateral_gap_m': 2.}], rule_crawl_cap_mps=None,
                                observation_age_s=.05, processing_latency_s=.15)
        self.assertEqual(decision['response'], 'CONTINUE')
