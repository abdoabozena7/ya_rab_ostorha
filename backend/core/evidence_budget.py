"""Evidence-budgeted pedestrian decisions layered on the RULE supervisor.

Physical protection is never relaxed. Measured hazards, LiDAR path conflicts,
moving-track conflicts, unconfirmed or in-lane people, insufficient coverage and
stale sensors keep RULE's braking. Only a verified-stationary person's
speculative alternatives (possible start, retreat or run) may defer braking,
and only while the vehicle can obtain another observation and still stop
before that person's reachable conflict zone:

    D_stop = v * T_delay + v**2 / (2 * a) + margin

T_delay adds observation age, measured processing latency, the control
reaction delay, motion confirmation and one observation interval. Waiting is
never assumed to reveal intent. Calibrated learned risk may only lower the
selected speed among physically verified options; it never raises it.
"""
from dataclasses import dataclass
import math
import numpy as np

SPECULATIVE = ('PEDESTRIAN_POSSIBLE_START', 'PEDESTRIAN_POSSIBLE_RETREAT', 'PEDESTRIAN_POSSIBLE_RUN')
RESPONSES = ('CONTINUE', 'CAUTIOUS_APPROACH', 'PROTECTIVE_BRAKING')
LAYER_ID = 'EVIDENCE_BUDGETED_PEDESTRIAN_V1'


@dataclass(frozen=True)
class BudgetConfig:
    reaction_time_s: float
    safe_deceleration_mps2: float
    margin_m: float
    motion_confirmation_s: float = .3
    observation_interval_s: float = .05
    heading_reach: float = .5
    cautious_deceleration_mps2: float = 2.5
    cautious_max_brake: float = .4
    release_hold_s: float = .4
    raise_hold_s: float = .5
    risk_high: float = .5
    risk_extra_budget_s: float = 1.5
    stationary_window_s: float = .6

    def __post_init__(self):
        if not (0 < self.cautious_deceleration_mps2 < self.safe_deceleration_mps2 and self.reaction_time_s > 0
                and self.margin_m >= 0 and 0 < self.cautious_max_brake < 1 and 0 < self.risk_high < 1):
            raise ValueError('Invalid evidence-budget configuration')

    @classmethod
    def from_teacher(cls, teacher, **overrides):
        return cls(reaction_time_s=teacher.reaction_time_s, safe_deceleration_mps2=teacher.assumed_deceleration_mps2,
                   margin_m=teacher.minimum_clearance_m, **overrides)


def stopping_distance(speed_mps, delay_s, deceleration_mps2, margin_m):
    v = max(0., speed_mps)
    return v*delay_s+v*v/(2.*deceleration_mps2)+margin_m


def max_speed_for_distance(distance_m, delay_s, deceleration_mps2, margin_m):
    """Largest v with stopping_distance(v) <= distance_m (0 when none)."""
    usable = distance_m-margin_m
    if usable <= 0:return 0.
    a = deceleration_mps2
    return a*(-delay_s+math.sqrt(delay_s*delay_s+2.*usable/a))


def verified_stationary(track, timestamp_s, *, window_s=.6):
    """Measured stationary for the whole window, confirmed and unoccluded."""
    if not track.get('confirmed') or track.get('occlusion_s', 1.) > .1:return False
    if np.linalg.norm(track.get('velocity_mps') or (9., 9.)) >= .3:return False
    rows = np.asarray([r for r in track.get('history') or () if len(r) >= 3 and 0 <= timestamp_s-r[0] <= 1.], float)
    if len(rows) < 3 or rows[-1, 0]-rows[0, 0] < window_s-1e-6:return False
    spread = np.max(np.linalg.norm(rows[:, 1:3]-rows[-1, 1:3], axis=1))
    return bool(spread <= max(.15, float(track.get('uncertainty_m', .15) or .15)))


class EvidenceBudget:
    """Stateful decision layer; hysteresis only delays *release*, never protection."""
    def __init__(self, config):
        self.config = config;self.reset()

    def reset(self):
        self.protective_since = None;self.clear_since = None;self.applied_cap = None;self.raise_since = None
        self.last = None

    def person_zone(self, track, *, geometry, curvature, corridor_coordinates):
        along, offset = corridor_coordinates(np.asarray([track['position_m'][:2]], float), curvature)
        half = float(max(track.get('half_size_m') or (.35, .35)));uncertainty = float(track.get('uncertainty_m', .25) or .25)
        gap = abs(float(offset[0]))-geometry.half_width_m-half-uncertainty
        zone = float(along[0])-geometry.front_m-half-uncertainty-self.config.heading_reach*max(0., gap)
        return {'track_id': str(track['id']), 'along_m': float(along[0]), 'offset_m': float(offset[0]),
                'lateral_gap_m': gap, 'zone_m': zone, 'uncertainty_m': uncertainty}

    def decide(self, *, timestamp_s, speed_mps, target_speed_mps, physical_brake, speculative, rule_crawl_cap_mps,
               observation_age_s, processing_latency_s, risk=None, use_risk=False, risk_people=()):
        """Return the response for speculative-only pedestrian conflicts.

        ``speculative`` lists person zones whose every conflict is a speculative
        alternative of a verified-stationary person. Anything else must be in
        ``physical_brake`` and is answered with PROTECTIVE_BRAKING.
        ``risk_people`` are other person-like zones without a conflict; their
        calibrated risk can only add a lower cautious cap.
        """
        c = self.config;v = max(0., speed_mps)
        delay = max(0., observation_age_s)+max(0., processing_latency_s)+c.reaction_time_s+c.motion_confirmation_s+c.observation_interval_s
        result = {'layer': LAYER_ID, 'timestamp_s': timestamp_s, 'delay_s': delay, 'speed_mps': v, 'people': [],
                  'risk_used': False, 'hysteresis': None}
        if physical_brake:
            return self._protective(result, timestamp_s, 'Measured physical risk, stale or unverified scene')
        cautious_risk = []
        if use_risk:
            for person in risk_people:
                probability = (risk or {}).get(person['track_id'], {}).get('3s')
                if probability is None or probability < c.risk_high:continue
                cap = max_speed_for_distance(person['zone_m'], delay+c.risk_extra_budget_s, c.cautious_deceleration_mps2, c.margin_m)
                cautious_risk.append(cap);result['people'].append({**person, 'risk_3s': probability, 'risk_cap_mps': cap, 'risk_only': True})
        if not speculative and not cautious_risk:
            return self._release(result, timestamp_s, None, 'No speculative pedestrian alternative conflicts')
        caps = list(cautious_risk);hard = []
        result['risk_used'] = bool(cautious_risk)
        for person in speculative:
            zone = person['zone_m']
            budget_cap = max_speed_for_distance(zone, delay, c.cautious_deceleration_mps2, c.margin_m)
            hard_cap = max_speed_for_distance(zone, delay, c.safe_deceleration_mps2, c.margin_m)
            entry = {**person, 'cautious_cap_mps': budget_cap, 'hard_cap_mps': hard_cap,
                     'stopping_distance_m': stopping_distance(v, delay, c.safe_deceleration_mps2, c.margin_m),
                     'budget_s': (zone-stopping_distance(v, delay, c.safe_deceleration_mps2, c.margin_m))/max(v, .1)}
            probability = (risk or {}).get(person['track_id'], {}).get('3s') if use_risk else None
            entry['risk_3s'] = probability
            if probability is not None and probability >= c.risk_high:
                # Higher calibrated risk buys extra observation margin: an
                # earlier, gentler slowdown among physically verified speeds.
                budget_cap = min(budget_cap, max_speed_for_distance(zone, delay+c.risk_extra_budget_s,
                                                                    c.cautious_deceleration_mps2, c.margin_m))
                entry['risk_cap_mps'] = budget_cap;result['risk_used'] = True
            caps.append(budget_cap);hard.append(hard_cap);result['people'].append(entry)
        budget = min(caps);hard_cap = min(hard) if hard else math.inf
        # RULE's verified crawl (reaction + full stop horizon) covers passing
        # alongside a stationary person; both are physical verifications.
        cap = max(budget, rule_crawl_cap_mps or 0.) if hard else budget
        hard_limit = max(hard_cap, rule_crawl_cap_mps or 0.)
        result.update(budget_cap_mps=budget, hard_cap_mps=None if math.isinf(hard_cap) else hard_cap, rule_crawl_cap_mps=rule_crawl_cap_mps)
        if v > hard_limit+.25:
            return self._protective(result, timestamp_s, 'Speed exceeds the verified stop-before-zone limit')
        if hard and cap <= .05 and v <= .2:
            return self._protective(result, timestamp_s, 'No verified approach speed; holding before the conflict zone')
        if cap >= target_speed_mps-1e-6:
            return self._release(result, timestamp_s, None, 'Another observation is affordable at the planned speed')
        return self._release(result, timestamp_s, cap, 'Bounded approach at the highest verified speed')

    def _protective(self, result, timestamp_s, reason):
        if self.protective_since is None:self.protective_since = timestamp_s
        self.clear_since = None;self.applied_cap = 0.;self.raise_since = None
        result.update(response='PROTECTIVE_BRAKING', target_speed_mps=0., brake=None, reason=reason)
        self.last = result;return result

    def _release(self, result, timestamp_s, cap, reason):
        c = self.config
        if self.protective_since is not None:
            if self.clear_since is None:self.clear_since = timestamp_s
            if timestamp_s-self.clear_since < c.release_hold_s-1e-9:
                result.update(response='PROTECTIVE_BRAKING', target_speed_mps=0., brake=None,
                              reason='Release hysteresis: verifying the clear decision', hysteresis='RELEASE_HOLD')
                self.last = result;return result
            self.protective_since = None;self.clear_since = None
        requested = math.inf if cap is None else cap
        previous = math.inf if self.applied_cap is None else self.applied_cap
        if requested > previous+1e-6:
            # Raising the cap waits for stable evidence; lowering is immediate.
            if self.raise_since is None:self.raise_since = timestamp_s
            if timestamp_s-self.raise_since < c.raise_hold_s-1e-9:
                requested = previous;result['hysteresis'] = 'RAISE_HOLD'
            else:self.raise_since = None
        else:self.raise_since = None
        self.applied_cap = requested
        if math.isinf(requested):
            result.update(response='CONTINUE', target_speed_mps=None, brake=0., reason=reason)
        else:
            v = result['speed_mps']
            brake = 0. if v <= requested+.1 else min(c.cautious_max_brake, (v-requested)*.25)
            result.update(response='CAUTIOUS_APPROACH', target_speed_mps=requested, brake=brake, reason=reason)
        self.last = result;return result
