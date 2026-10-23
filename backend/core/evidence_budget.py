"""Evidence-budgeted pedestrian decisions layered on the RULE supervisor (time-indexed, V2).

Physical protection is never relaxed. Measured hazards, LiDAR path conflicts,
moving-track conflicts, unconfirmed or in-lane people, insufficient coverage and
stale sensors keep RULE's braking. Only a verified-stationary person whose
every RULE conflict comes from a speculative alternative (possible start,
retreat or run) is handled here. Stationarity is never proof of future
stillness: every physically reachable alternative is checked in space and time.

For candidate speed plans (current/requested speed down to a crawl) the ego
footprint along its planned trajectory is compared with each reachable
alternative of each person, starting now:

* continue: no overlap within RULE's own forecast horizon -> the car passes
  before the person can reach the corridor (PASS_BEFORE_REACH);
* brake after detection: the same plan, then braking at the validated
  5 m/s^2 after the detection delay (observation age + measured processing
  latency + 0.35 s reaction + 0.3 s motion confirmation + one interval) never
  overlaps -> another observation is affordable (OBSERVATION_AFFORDABLE).

A plan is verified when, for every person, one response avoids all of that
person's alternatives. Re-verifying on every frame while the person stays
stationary covers any later start. The highest verified plan is selected;
otherwise RULE's validated crawl, otherwise protective braking. Calibrated
learned risk only lengthens the detection delay (lower verified speed).
"""
from dataclasses import dataclass
import math
import numpy as np

SPECULATIVE = ('PEDESTRIAN_POSSIBLE_START', 'PEDESTRIAN_POSSIBLE_RETREAT', 'PEDESTRIAN_POSSIBLE_RUN')
RESPONSES = ('CONTINUE', 'CAUTIOUS_APPROACH', 'PROTECTIVE_BRAKING')
LAYER_ID = 'EVIDENCE_BUDGETED_PEDESTRIAN_V2'
CANDIDATE_FRACTIONS = (.85, .7, .55, .4, .25)
CRAWL_SPEEDS_MPS = (6., 5., 4., 3., 2., 1.5, 1., .5)


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
    # Native Mercedes launches reached about 4.2 m/s^2; plans above the
    # current speed assume this faster bound.
    launch_acceleration_mps2: float = 4.5
    risk_floor_mps: float = 2.

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


def plan_profile(speed_mps, candidate_mps, grid, *, deceleration_mps2, acceleration_mps2, brake_after_s=None,
                 brake_deceleration_mps2=5.):
    """Speed and distance of a plan that approaches ``candidate_mps`` and then holds it.

    With ``brake_after_s`` the same plan brakes to a stop from that time.
    """
    grid = np.asarray(grid, float);v0 = max(0., float(speed_mps))
    if candidate_mps >= v0:v = np.minimum(candidate_mps, v0+acceleration_mps2*grid)
    else:v = np.maximum(candidate_mps, v0-deceleration_mps2*grid)
    if brake_after_s is not None:
        start = float(np.interp(brake_after_s, grid, v))
        v = np.where(grid <= brake_after_s, v, np.maximum(0., start-brake_deceleration_mps2*(grid-brake_after_s)))
    return v, np.r_[0., np.cumsum((v[1:]+v[:-1])*.5*np.diff(grid))]


def plan_poses(grid, distance, geometry, *, steering=0., path=None):
    """Body-centre poses (t, x, y, yaw) along the supervised path or the steering arc."""
    from .motion_geometry import footprint_centers
    distance = np.asarray(distance, float)
    if path is not None:
        p = np.asarray(path, float);arc = np.r_[0., np.cumsum(np.linalg.norm(np.diff(p[:, 1:3], axis=0), axis=1))]
        keep = np.r_[True, np.diff(arc) > 1e-9];arc = arc[keep];p = p[keep]
        x = np.interp(distance, arc, p[:, 1]);y = np.interp(distance, arc, p[:, 2]);yaw = np.interp(distance, arc, p[:, 3])
        beyond = distance > arc[-1]
        if beyond.any():
            extra = distance[beyond]-arc[-1]
            x[beyond] = p[-1, 1]+extra*math.cos(p[-1, 3]);y[beyond] = p[-1, 2]+extra*math.sin(p[-1, 3]);yaw[beyond] = p[-1, 3]
    else:
        kappa = math.tan(float(steering)*geometry.max_steer_rad)/geometry.wheelbase_m;yaw = distance*kappa
        if abs(kappa) > 1e-9:x, y = np.sin(yaw)/kappa, (1-np.cos(yaw))/kappa
        else:x, y = distance.copy(), np.zeros_like(distance)
    return footprint_centers(np.column_stack((np.asarray(grid, float), x, y, yaw)), geometry)


def candidate_speeds(speed_mps, target_mps):
    """Descending candidate plan speeds from the requested target down to a crawl."""
    target = max(0., float(target_mps));values = {round(target, 3)}
    if 0. < speed_mps < target:values.add(round(float(speed_mps), 3))
    values.update(round(target*f, 3) for f in CANDIDATE_FRACTIONS)
    values.update(c for c in CRAWL_SPEEDS_MPS if c < target)
    return sorted((v for v in values if v > 0.), reverse=True)


class TemporalVerifier:
    """Time-indexed physical check of candidate speed plans against every reachable alternative.

    ``tracks``/``modes`` are the published measured tracks and their physical
    alternatives (vehicle frame at the measurement); the ego footprint uses
    onboard geometry along the supervised path or steering arc.
    """
    def __init__(self, tracks, modes, *, geometry, speed_mps, steering, config, path=None, continue_horizon_s=None):
        self.tracks = [t for t in tracks if t.get('confirmed')];self.modes = list(modes);self.geometry = geometry
        self.speed = max(0., float(speed_mps));self.steering = float(steering);self.path = path;self.config = config
        self.continue_horizon_s = continue_horizon_s if continue_horizon_s is not None else max(3., .6+self.speed/5.)

    def evaluate(self, candidates, delays):
        """Return (per-candidate results, per-person 'braking now avoids every alternative')."""
        from .prediction import assess_conflicts
        c = self.config;delays = {str(k): float(v) for k, v in delays.items()}
        fastest = max([self.speed, *candidates]) if candidates else self.speed
        horizon = max(self.continue_horizon_s, max(delays.values(), default=0.)+fastest/c.safe_deceleration_mps2+.5)
        grid = np.round(np.arange(int(math.ceil(horizon/.1))+1)*.1, 6);distinct = sorted(set(delays.values()))
        paths = []
        def add(intent, distance):
            paths.append({'intent': intent, 'points': plan_poses(grid, distance, self.geometry, steering=self.steering, path=self.path),
                          'half': self.geometry.half})
        for i, candidate in enumerate(candidates):
            add(f'CONTINUE:{i}', plan_profile(self.speed, candidate, grid, deceleration_mps2=c.cautious_deceleration_mps2,
                                              acceleration_mps2=c.launch_acceleration_mps2)[1])
            for j, delay in enumerate(distinct):
                add(f'BRAKE:{i}:{j}', plan_profile(self.speed, candidate, grid, deceleration_mps2=c.cautious_deceleration_mps2,
                                                   acceleration_mps2=c.launch_acceleration_mps2, brake_after_s=delay,
                                                   brake_deceleration_mps2=c.safe_deceleration_mps2)[1])
        add('BRAKE_NOW', plan_profile(self.speed, 0., grid, deceleration_mps2=c.safe_deceleration_mps2, acceleration_mps2=0.)[1])
        hits = set()
        for conflict in assess_conflicts(self.tracks, self.modes, paths, grid=grid):
            if conflict.get('separating_rear_overlap'):continue
            if conflict['ego_intent'].startswith('CONTINUE') and conflict['time_s'] > self.continue_horizon_s+1e-9:continue
            hits.add((str(conflict['track_id']), conflict['ego_intent']))
        results = []
        for i, candidate in enumerate(candidates):
            people = {}
            for track_id, delay in delays.items():
                j = distinct.index(delay)
                if (track_id, f'CONTINUE:{i}') not in hits:people[track_id] = 'PASS_BEFORE_REACH'
                elif (track_id, f'BRAKE:{i}:{j}') not in hits:people[track_id] = 'OBSERVATION_AFFORDABLE'
                else:people[track_id] = 'UNVERIFIED'
            results.append({'speed_mps': candidate, 'people': people})
        return results, {track_id: (track_id, 'BRAKE_NOW') not in hits for track_id in delays}


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

    def decide(self, *, timestamp_s, speed_mps, target_speed_mps, physical_brake, people, verifier, rule_crawl_cap_mps,
               observation_age_s, processing_latency_s, risk=None, use_risk=False, pedestrian_physical=True):
        """Return the response for speculative-only pedestrian conflicts (time-indexed).

        ``people`` lists person zones; ``risk_only`` marks people without a RULE
        conflict whose calibrated risk may add caution. Every other entry is a
        verified-stationary person whose conflicts are all speculative.
        ``verifier`` is a :class:`TemporalVerifier` over their tracks and
        alternatives. Anything physical must be in ``physical_brake``;
        ``pedestrian_physical`` is false when that physical risk involves no
        person (a measured obstacle or unclassified moving object), which RULE
        handles with its own hysteresis.
        """
        c = self.config;v = max(0., speed_mps)
        delay = max(0., observation_age_s)+max(0., processing_latency_s)+c.reaction_time_s+c.motion_confirmation_s+c.observation_interval_s
        result = {'layer': LAYER_ID, 'timestamp_s': timestamp_s, 'delay_s': delay, 'speed_mps': v, 'people': [],
                  'risk_used': False, 'hysteresis': None, 'kind': None}
        if physical_brake:
            result['kind'] = 'PHYSICAL_PROTECTIVE'
            if not pedestrian_physical:
                # RULE brakes for this frame; the pedestrian layer's own state is untouched.
                result.update(response='PROTECTIVE_BRAKING', target_speed_mps=0., brake=None,
                              reason='Measured physical risk without a person: RULE decides')
                self.last = result;return result
            return self._protective(result, timestamp_s, 'Measured physical risk, stale or unverified scene')
        # RULE's own verified crawl for this frame bounds hysteresis holds from below.
        crawl_floor = None if rule_crawl_cap_mps is None else min(float(rule_crawl_cap_mps), float(target_speed_mps))
        delays = {};risk_only = set()
        for person in people:
            track_id = str(person['track_id'])
            probability = (risk or {}).get(track_id, {}).get('3s') if use_risk else None
            extra = c.risk_extra_budget_s if probability is not None and probability >= c.risk_high else 0.
            if person.get('risk_only'):
                # Without a RULE conflict a person matters here only through
                # calibrated risk, which can only lengthen the delay.
                if not extra:continue
                risk_only.add(track_id)
            delays[track_id] = delay+extra;result['risk_used'] |= bool(extra)
            result['people'].append({**person, 'track_id': track_id, 'risk_3s': probability, 'detection_delay_s': delay+extra})
        if not delays:
            result['kind'] = 'NO_SPECULATIVE_CONFLICT'
            # Nothing left for this layer to stabilize and RULE has no pedestrian
            # conflict either: holding here would only add stops RULE does not make.
            self.protective_since = self.clear_since = self.raise_since = None;self.applied_cap = None
            result.update(response='CONTINUE', target_speed_mps=None, brake=0., reason='No speculative pedestrian alternative conflicts')
            self.last = result;return result
        candidates = candidate_speeds(v, target_speed_mps)
        evaluations, stop_now = verifier.evaluate(candidates, delays)
        physical_ids = [k for k in delays if k not in risk_only]
        def best(ids):
            return next((e for e in evaluations if all(e['people'][k] != 'UNVERIFIED' for k in ids)), None)
        chosen = best(physical_ids) if physical_ids else None
        cap = chosen['speed_mps'] if chosen else None;source = 'TIME_INDEXED_VERIFICATION' if chosen else None
        if physical_ids and rule_crawl_cap_mps is not None and (cap is None or rule_crawl_cap_mps > cap):
            # RULE's validated crawl stays available beside a stationary person.
            cap, source = rule_crawl_cap_mps, 'RULE_VERIFIED_CRAWL'
        risk_cap = None
        if risk_only:
            verified = best(risk_only)
            risk_cap = verified['speed_mps'] if verified else min(c.risk_floor_mps, target_speed_mps)
        result.update(candidates_mps=candidates, verified_cap_mps=chosen['speed_mps'] if chosen else None,
                      responses=chosen['people'] if chosen else None, rule_crawl_cap_mps=rule_crawl_cap_mps,
                      risk_cap_mps=risk_cap, cap_source=source, braking_now_avoids=stop_now)
        if physical_ids and cap is None:
            if all(stop_now[k] for k in physical_ids):
                result['kind'] = 'STOP_BEFORE_POSSIBLE_CONFLICT'
                return self._protective(result, timestamp_s, 'No verified motion plan; stopping before a possible conflict')
            result['kind'] = 'AMBIGUOUS_PROTECTIVE'
            return self._protective(result, timestamp_s, 'Ambiguous: no response is verified against every reachable alternative')
        if risk_cap is not None:cap = risk_cap if cap is None else min(cap, risk_cap)
        if cap >= target_speed_mps-1e-6:
            passing = chosen is not None and all(r == 'PASS_BEFORE_REACH' for r in chosen['people'].values())
            result['kind'] = 'PASS_BEFORE_REACH' if passing else 'OBSERVATION_AFFORDABLE'
            return self._release(result, timestamp_s, None, 'Passing before any reachable alternative can enter the path'
                                 if passing else 'Another observation is affordable at the planned speed', floor_mps=crawl_floor)
        result['kind'] = 'RULE_VERIFIED_CRAWL' if source == 'RULE_VERIFIED_CRAWL' else 'SLOWING_FOR_OBSERVATION'
        return self._release(result, timestamp_s, cap, 'Slowing to the highest physically verified speed', floor_mps=crawl_floor)

    def _protective(self, result, timestamp_s, reason):
        if self.protective_since is None:self.protective_since = timestamp_s
        self.clear_since = None;self.applied_cap = 0.;self.raise_since = None
        result.update(response='PROTECTIVE_BRAKING', target_speed_mps=0., brake=None, reason=reason)
        self.last = result;return result

    def _release(self, result, timestamp_s, cap, reason, floor_mps=None):
        """Apply hysteresis to a non-protective decision.

        Holds delay *raising* the speed after protection, but never below RULE's
        own verified crawl for this frame (``floor_mps``): the layer must not be
        more restrictive than the validated RULE baseline it refines.
        """
        c = self.config
        requested = math.inf if cap is None else cap
        floor = None if floor_mps is None else min(float(floor_mps), requested)
        if self.protective_since is not None:
            if self.clear_since is None:self.clear_since = timestamp_s
            if timestamp_s-self.clear_since < c.release_hold_s-1e-9:
                if floor is None or floor <= 0.:
                    result.update(response='PROTECTIVE_BRAKING', target_speed_mps=0., brake=None,
                                  reason='Release hysteresis: verifying the clear decision', hysteresis='RELEASE_HOLD')
                    self.last = result;return result
                v = result['speed_mps']
                result.update(response='CAUTIOUS_APPROACH', target_speed_mps=floor, hysteresis='RELEASE_HOLD_AT_RULE_CRAWL',
                              brake=0. if v <= floor+.1 else min(c.cautious_max_brake, (v-floor)*.25),
                              reason='Release hysteresis: holding at the RULE-verified crawl')
                self.applied_cap = floor;self.last = result;return result
            self.protective_since = None;self.clear_since = None
        previous = math.inf if self.applied_cap is None else self.applied_cap
        if requested > previous+1e-6:
            # Raising the cap waits for stable evidence; lowering is immediate.
            if self.raise_since is None:self.raise_since = timestamp_s
            if timestamp_s-self.raise_since < c.raise_hold_s-1e-9:
                requested = previous if floor is None else max(previous, floor);result['hysteresis'] = 'RAISE_HOLD'
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
