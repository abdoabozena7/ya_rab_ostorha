"""Evaluator-side pedestrian behavior catalogue, walker scripts and offline labels.

Nothing in this module is a runtime driving input. Scripts command native
walkers during construction/evaluation and labels are computed offline from
recorded native positions. Runtime features live in ``path_entry_features``.
"""
import copy
import hashlib
import json
import math
import random
from pathlib import Path
import numpy as np
from .scenarios import DatasetSplit, SEED_RANGES

CONFIG = Path(__file__).resolve().parents[2]/'config/pedestrian-behavior-suite.json'
CATALOGUE_ID = 'PEDESTRIAN_BEHAVIOR_SUITE_V1'
LABEL_ID = 'PEDESTRIAN_ENTERING_EGO_PATH_WITHIN_H_SECONDS'
BEHAVIORS = ('WAIT_AT_CURB', 'WALK_PARALLEL', 'CROSS_NORMAL', 'SUDDEN_RUN', 'HESITATE_THEN_CROSS',
             'HESITATE_THEN_RETREAT', 'START_AND_RETURN', 'EMERGE_FROM_PARKED', 'MULTI_PEDESTRIAN',
             'MIXED_TRAFFIC')
SCRIPTS = ('WAIT', 'PARALLEL', 'CROSS', 'RUN', 'HESITATE_CROSS', 'HESITATE_RETREAT', 'START_RETURN')
SINGLE_SCRIPT = {'WAIT_AT_CURB': 'WAIT', 'WALK_PARALLEL': 'PARALLEL', 'CROSS_NORMAL': 'CROSS',
                 'SUDDEN_RUN': 'RUN', 'HESITATE_THEN_CROSS': 'HESITATE_CROSS',
                 'HESITATE_THEN_RETREAT': 'HESITATE_RETREAT', 'START_AND_RETURN': 'START_RETURN'}
CROSSING_SCRIPTS = ('CROSS', 'RUN', 'HESITATE_CROSS')
LABEL_STATUSES = ('LABELED', 'IN_PATH_AT_DECISION', 'MISSING_FUTURE', 'POST_CONTACT')


def load_suite(path=CONFIG):
    suite = json.loads(Path(path).read_text(encoding='utf8'))
    validate_suite(suite)
    return suite


def identity(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def validate_suite(suite):
    if suite.get('id') != CATALOGUE_ID or suite.get('label', {}).get('id') != LABEL_ID:
        raise ValueError('Unexpected pedestrian behavior suite identity')
    if tuple(suite['behaviors']) != BEHAVIORS:
        raise ValueError('Pedestrian suite must list the ten supported behaviors in catalogue order')
    seen = {}
    for split in DatasetSplit:
        rows = suite['locations'].get(split.value)
        if not rows:raise ValueError('Every split requires at least one location: '+split.value)
        for row in rows:
            key = location_id(row)
            if key in seen and seen[key] != split.value:
                raise ValueError('Location appears in more than one split: '+key)
            seen[key] = split.value
    if sorted(suite['label']['horizons_s']) != [1, 2, 3]:raise ValueError('Path-entry labels use 1, 2 and 3 s horizons')
    return True


def location_id(row):
    return f"{row['town']}:{int(row['spawn_index'])}"


def _uniform(rng, bounds):
    lo, hi = bounds
    if not math.isfinite(lo) or not math.isfinite(hi) or hi < lo:raise ValueError('Invalid sampling range')
    return round(rng.uniform(lo, hi), 3)


def _pedestrian(rng, ranges, script, *, role, along_m, side=None):
    side = side or rng.choice(('RIGHT', 'LEFT'))
    plan = {'role': role, 'script': script, 'side': side, 'along_m': round(along_m, 3),
            'curb_offset_m': _uniform(rng, ranges['curb_offset_m']),
            'walk_speed_mps': _uniform(rng, ranges['walk_speed_mps']),
            'trigger': {'kind': 'EGO_DISTANCE', 'distance_m': _uniform(rng, ranges['trigger_distance_m'])},
            'blueprint_index': rng.randrange(1 << 16)}
    if script == 'RUN':plan['run_speed_mps'] = _uniform(rng, ranges['run_speed_mps'])
    if script in ('HESITATE_CROSS', 'HESITATE_RETREAT'):
        plan['hesitation_s'] = _uniform(rng, ranges['hesitation_s'])
        plan['approach_offset_m'] = _uniform(rng, ranges['approach_offset_m'])
    if script == 'HESITATE_RETREAT':plan['retreat_m'] = _uniform(rng, ranges['retreat_m'])
    if script == 'START_RETURN':
        plan['incursion_m'] = _uniform(rng, ranges['incursion_m'])
        plan['pause_s'] = _uniform(rng, ranges['return_pause_s'])
    if script == 'PARALLEL':
        plan['direction'] = rng.choice((-1, 1))
        plan['trigger'] = {'kind': 'EPISODE_START'}
    if script in CROSSING_SCRIPTS:plan['far_offset_m'] = _uniform(rng, ranges['far_offset_m'])
    return plan


def sample_episode(suite, split, index, *, behavior=None):
    """Deterministic episode definition for one split-local index."""
    split = DatasetSplit(split)
    lo, hi = SEED_RANGES[split]
    if type(index) is not int or not 0 <= index <= hi-lo:raise ValueError('Episode index outside split seed range')
    return _episode(suite, split.value, lo+index, index, suite['locations'][split.value], behavior=behavior)


def _episode(suite, split_label, seed, index, locations, *, behavior=None):
    rng = random.Random(f'{CATALOGUE_ID}:{split_label}:{seed}')
    behavior = behavior or BEHAVIORS[index % len(BEHAVIORS)]
    if behavior not in BEHAVIORS:raise ValueError('Unsupported pedestrian behavior: '+str(behavior))
    ranges = suite['ranges']
    location = copy.deepcopy(locations[rng.randrange(len(locations))])
    along = _uniform(rng, ranges['pedestrian_along_m'])
    pedestrians = []
    occluder = None
    traffic = {'vehicles': 0, 'pedestrians': 0}
    if behavior in SINGLE_SCRIPT:
        pedestrians.append(_pedestrian(rng, ranges, SINGLE_SCRIPT[behavior], role='ped_0', along_m=along))
    elif behavior == 'EMERGE_FROM_PARKED':
        # A parked occluder must fit outside the planned corridor; narrow
        # two-lane roads fail construction explicitly, so sample wide roads.
        wide = [row for row in locations if row.get('road_width_m', 0.) >= ranges['occluder_min_road_width_m']]
        if not wide:raise ValueError('Split has no road wide enough for a parked occluder')
        if location.get('road_width_m', 0.) < ranges['occluder_min_road_width_m']:
            location = copy.deepcopy(wide[rng.randrange(len(wide))])
        script = rng.choice(('CROSS', 'RUN'))
        ped = _pedestrian(rng, ranges, script, role='ped_0', along_m=along, side='RIGHT')
        ped['curb_offset_m'] = _uniform(rng, ranges['occluded_curb_offset_m'])
        pedestrians.append(ped)
        occluder = {'blueprint': rng.choice(suite['occluder_blueprints']), 'side': 'RIGHT',
                    'along_m': round(along-_uniform(rng, ranges['occluder_gap_m']), 3),
                    'curb_inset_m': _uniform(rng, ranges['occluder_curb_inset_m'])}
    elif behavior == 'MULTI_PEDESTRIAN':
        count = rng.randint(*ranges['multi_count'])
        scripts = rng.sample(list(SCRIPTS), count)
        along = _uniform(rng, ranges['multi_along_m'])
        for i, script in enumerate(scripts):
            pedestrians.append(_pedestrian(rng, ranges, script, role=f'ped_{i}',
                along_m=along+i*_uniform(rng, ranges['multi_spacing_m'])))
    elif behavior == 'MIXED_TRAFFIC':
        script = rng.choice(SCRIPTS)
        pedestrians.append(_pedestrian(rng, ranges, script, role='ped_0', along_m=along))
        traffic = {'vehicles': rng.randint(*ranges['traffic_vehicles']),
                   'pedestrians': rng.randint(*ranges['traffic_pedestrians'])}
    spec = {'version': 1, 'catalogue': CATALOGUE_ID, 'split': split_label, 'seed': seed, 'index': index,
            'behavior': behavior, 'location': location,
            'route_length_m': _uniform(rng, ranges['route_length_m']),
            'ego': {'target_speed_kmh': rng.choice(ranges['ego_target_speed_kmh'])},
            'pedestrians': pedestrians, 'occluder': occluder, 'traffic': traffic,
            'time_limit_s': float(suite['time_limit_s']), 'counterfactual': None}
    validate_spec(spec)
    spec['scenario_id'] = identity({k: v for k, v in spec.items() if k != 'scenario_id'})
    return spec


ORDINARY = 'ORDINARY_CITY_JOURNEY'


def ordinary_journey(suite, split, index):
    """Route-completion journey with native background traffic and no scripted walker."""
    split = DatasetSplit(split);lo, hi = SEED_RANGES[split]
    if type(index) is not int or not 0 <= index <= hi-lo:raise ValueError('Episode index outside split seed range')
    return _ordinary(suite, split.value, lo+index, index, suite['locations'][split.value])


def _ordinary(suite, split_label, seed, index, locations):
    rng = random.Random(f'{CATALOGUE_ID}:{ORDINARY}:{split_label}:{seed}')
    ranges = suite['ranges']
    spec = {'version': 1, 'catalogue': CATALOGUE_ID, 'split': split_label, 'seed': seed, 'index': index, 'behavior': ORDINARY,
            'location': copy.deepcopy(locations[rng.randrange(len(locations))]),
            'route_length_m': _uniform(rng, ranges['route_length_m']),
            'ego': {'target_speed_kmh': rng.choice(ranges['ego_target_speed_kmh'])}, 'pedestrians': [], 'occluder': None,
            'traffic': {'vehicles': rng.randint(*ranges['traffic_vehicles']), 'pedestrians': rng.randint(*ranges['traffic_pedestrians'])},
            'time_limit_s': float(suite['time_limit_s']), 'counterfactual': None}
    validate_spec(spec, allow_ordinary=True)
    spec['scenario_id'] = identity(spec)
    return spec


def counterfactual_pair(suite, split, index):
    """Identical construction and waiting history; only the post-decision action differs.

    The decision point is a simulation-clock trigger. Neither arm's alternative
    future is a runtime input; the shared prefix is verified offline.
    """
    base = sample_episode(suite, split, index, behavior='WAIT_AT_CURB')
    return _counterfactual_arms(suite, base)


def _counterfactual_arms(suite, base):
    rng = random.Random(f'{CATALOGUE_ID}:COUNTERFACTUAL:{base["split"]}:{base["seed"]}')
    decision = _uniform(rng, suite['ranges']['counterfactual_decision_s'])
    run_speed = _uniform(rng, suite['ranges']['run_speed_mps'])
    pair = identity({'base': base['scenario_id'], 'decision_s': decision, 'run_speed_mps': run_speed})
    arms = []
    for arm, script in (('A_REMAINS_STATIONARY', 'WAIT'), ('B_SUDDEN_CROSSING', 'RUN')):
        spec = copy.deepcopy(base)
        ped = spec['pedestrians'][0]
        ped['script'] = script
        ped['trigger'] = {'kind': 'SIMULATION_TIME', 'at_s': decision}
        ped.setdefault('far_offset_m', 1.2)
        ped['run_speed_mps'] = run_speed
        spec['behavior'] = 'COUNTERFACTUAL_PAIR'
        spec['counterfactual'] = {'pair_id': pair, 'arm': arm, 'decision_s': decision,
                                  'shared_prefix': 'IDENTICAL_CONSTRUCTION_AND_WAITING_POSE'}
        spec.pop('scenario_id', None)
        validate_spec(spec, allow_counterfactual=True)
        spec['scenario_id'] = identity(spec)
        arms.append(spec)
    return arms


def validate_spec(spec, *, allow_counterfactual=False, allow_ordinary=False):
    if spec.get('catalogue') != CATALOGUE_ID or spec.get('version') != 1:raise ValueError('Unknown episode catalogue')
    behaviors = BEHAVIORS+(('COUNTERFACTUAL_PAIR',) if allow_counterfactual else ())+((ORDINARY,) if allow_ordinary else ())
    if spec['behavior'] not in behaviors:raise ValueError('Unsupported pedestrian behavior: '+str(spec['behavior']))
    if not spec['pedestrians'] and spec['behavior'] != ORDINARY:raise ValueError('Pedestrian behavior episode requires a scripted pedestrian')
    roles = [p['role'] for p in spec['pedestrians']]
    if len(set(roles)) != len(roles):raise ValueError('Duplicate pedestrian role')
    for ped in spec['pedestrians']:
        if ped['script'] not in SCRIPTS:raise ValueError('Unsupported walker script: '+str(ped['script']))
        if ped['side'] not in ('RIGHT', 'LEFT'):raise ValueError('Pedestrian side must be RIGHT or LEFT')
        if not 0 < ped['walk_speed_mps'] <= 2.2:raise ValueError('Walking speed outside physical range')
        if ped['script'] == 'RUN' and not 2. <= ped.get('run_speed_mps', 0) <= 4.:raise ValueError('Running speed outside physical range')
        if ped['trigger']['kind'] not in ('EGO_DISTANCE', 'EPISODE_START', 'SIMULATION_TIME'):raise ValueError('Unsupported trigger')
        if not 10. <= ped['along_m'] <= spec['route_length_m']-15.:raise ValueError('Pedestrian must stand on the planned route segment')
    if spec.get('occluder') and spec['occluder']['side'] != 'RIGHT':raise ValueError('Only right-side parked occluders are supported')
    if spec['behavior'] == 'EMERGE_FROM_PARKED' and not spec.get('occluder'):raise ValueError('Emerging pedestrian requires a parked occluder')
    if spec['behavior'] == 'MIXED_TRAFFIC' and spec['traffic']['vehicles'] <= 0:raise ValueError('Mixed traffic requires vehicles')
    if not 5 <= spec['ego']['target_speed_kmh'] <= 60:raise ValueError('Evaluation target speed must be 5-60 km/h')
    return True


def split_episodes(suite, split, count, *, start=0):
    return [sample_episode(suite, split, start+i) for i in range(count)]


HOLDOUT = 'HOLDOUT'
HOLDOUT_SEED_RANGE = (3000, 3999)


def _holdout_seed(index):
    lo, hi = HOLDOUT_SEED_RANGE
    if type(index) is not int or not 0 <= index <= hi-lo:raise ValueError('Episode index outside the HOLDOUT seed range')
    return lo+index


def _time_limit(spec, limit_s):
    """Routes can end behind a red light or signal queue; allow one full signal cycle."""
    if limit_s is None:return spec
    if not spec['time_limit_s'] <= limit_s <= 600.:raise ValueError('Time limit must extend the suite limit')
    spec = copy.deepcopy(spec);spec.pop('scenario_id');spec['time_limit_s'] = float(limit_s)
    validate_spec(spec, allow_counterfactual=True, allow_ordinary=True)
    spec['scenario_id'] = identity(spec)
    return spec


def holdout_episode(suite, locations, index, *, behavior=None, time_limit_s=None):
    """Post-hoc independent partition: caller-validated new locations, new seed namespace."""
    if not locations:raise ValueError('HOLDOUT requires its own locations')
    spec = _episode(suite, HOLDOUT, _holdout_seed(index), index, locations, behavior=behavior)
    return _time_limit(spec, time_limit_s)


def holdout_ordinary(suite, locations, index, *, time_limit_s=None):
    if not locations:raise ValueError('HOLDOUT requires its own locations')
    return _time_limit(_ordinary(suite, HOLDOUT, _holdout_seed(index), index, locations), time_limit_s)


def holdout_counterfactual(suite, locations, index, *, time_limit_s=None):
    return [_time_limit(arm, time_limit_s) for arm in
            _counterfactual_arms(suite, holdout_episode(suite, locations, index, behavior='WAIT_AT_CURB'))]


class WalkerScript:
    """Position-targeted script in route coordinates.

    ``u`` is the distance from the road centerline toward this pedestrian's
    own side (positive on the starting sidewalk). The near curb is ``near_u``
    and the far curb is ``-far_u``. Output velocities are along the route and
    toward the road (positive decreases ``u``).
    """
    def __init__(self, plan, *, near_u, far_u):
        self.plan = plan;self.near_u = float(near_u);self.far_u = float(far_u)
        self.start_u = self.near_u+plan['curb_offset_m']
        self.phase = 'WAITING';self.phase_started = None;self.triggered_at = None;self.history = []

    def trigger(self, elapsed, *, ego_distance_m=None):
        if self.triggered_at is not None:return True
        trigger = self.plan['trigger']
        fired = (trigger['kind'] == 'EPISODE_START' or trigger['kind'] == 'SIMULATION_TIME' and elapsed >= trigger['at_s']
                 or trigger['kind'] == 'EGO_DISTANCE' and ego_distance_m is not None and ego_distance_m <= trigger['distance_m'])
        if fired:self.triggered_at = elapsed
        return fired

    def _enter(self, phase, elapsed):
        if self.phase != phase:
            self.phase = phase;self.phase_started = elapsed;self.history.append((round(elapsed, 3), phase))

    def _toward(self, target_u, u, speed):
        # Positive output moves toward the road (decreasing u). The tolerance
        # is about one native tick of walking, so approaches do not stop short.
        error = u-target_u
        return 0. if abs(error) <= .1 else math.copysign(speed, error)

    def command(self, elapsed, u, *, ego_distance_m=None):
        """Return (along_mps, toward_mps, phase); deterministic in its inputs."""
        p = self.plan;script = p['script']
        if not self.trigger(elapsed, ego_distance_m=ego_distance_m):
            return 0., 0., 'WAITING'
        walk = p['walk_speed_mps']
        if script == 'WAIT':
            self._enter('WAITING', elapsed);return 0., 0., self.phase
        if script == 'PARALLEL':
            self._enter('WALKING_PARALLEL', elapsed);return p['direction']*walk, 0., self.phase
        cross_target = -self.far_u-p['far_offset_m'] if script in CROSSING_SCRIPTS else None
        approach_u = self.near_u+p.get('approach_offset_m', .3)
        if script in ('CROSS', 'RUN'):
            speed = p['run_speed_mps'] if script == 'RUN' else walk
            toward = self._toward(cross_target, u, speed)
            self._enter('CROSSING' if toward else 'CROSSED', elapsed)
            return 0., toward, self.phase
        if script in ('HESITATE_CROSS', 'HESITATE_RETREAT'):
            if self.phase in ('WAITING', 'APPROACHING'):
                toward = self._toward(approach_u, u, walk)
                if toward:self._enter('APPROACHING', elapsed);return 0., toward, self.phase
                self._enter('HESITATING', elapsed)
            if self.phase == 'HESITATING':
                if elapsed-self.phase_started < p['hesitation_s']:return 0., 0., self.phase
                self._enter('CROSSING' if script == 'HESITATE_CROSS' else 'RETREATING', elapsed)
            target = cross_target if script == 'HESITATE_CROSS' else approach_u+p['retreat_m']
            toward = self._toward(target, u, walk)
            if not toward:self._enter('CROSSED' if script == 'HESITATE_CROSS' else 'RETREATED', elapsed)
            return 0., toward, self.phase
        if script == 'START_RETURN':
            if self.phase in ('WAITING', 'STEPPING_IN'):
                toward = self._toward(self.near_u-p['incursion_m'], u, walk)
                if toward:self._enter('STEPPING_IN', elapsed);return 0., toward, self.phase
                self._enter('PAUSED_IN_ROAD', elapsed)
            if self.phase == 'PAUSED_IN_ROAD':
                if elapsed-self.phase_started < p['pause_s']:return 0., 0., self.phase
                self._enter('RETURNING', elapsed)
            toward = self._toward(self.near_u+1., u, walk)
            if not toward:self._enter('RETURNED', elapsed)
            return 0., toward, self.phase
        raise ValueError('Unsupported walker script: '+script)


def project_polyline(points, polyline):
    """Arc length and right-positive signed offset of points on a polyline."""
    pts = np.atleast_2d(np.asarray(points, float))[:, :2];line = np.asarray(polyline, float)[:, :2]
    if len(line) < 2:raise ValueError('Corridor polyline requires two points')
    seg = np.diff(line, axis=0);length = np.linalg.norm(seg, axis=1)
    keep = length > 1e-6;seg = seg[keep];start = line[:-1][keep];length = length[keep]
    if not len(seg):raise ValueError('Degenerate corridor polyline')
    cumulative = np.r_[0., np.cumsum(length)]
    rel = pts[:, None, :]-start[None]
    t = np.clip(np.einsum('nmk,mk->nm', rel, seg)/(length**2)[None], 0., 1.)
    closest = start[None]+t[..., None]*seg[None]
    dist = np.linalg.norm(pts[:, None, :]-closest, axis=2)
    best = np.argmin(dist, axis=1);rows = np.arange(len(pts))
    tangent = seg[best]/length[best, None]
    offset = pts-closest[rows, best]
    # Right normal (-ty, tx): CARLA and ego frames are x-forward/y-right.
    signed = offset[:, 0]*-tangent[:, 1]+offset[:, 1]*tangent[:, 0]
    # Before the first or after the last vertex, extend the end tangents.
    s = cumulative[best]+t[rows, best]*length[best]
    first = (best == 0) & (t[rows, best] <= 0.);last = (best == len(seg)-1) & (t[rows, best] >= 1.)
    s = np.where(first, np.einsum('nk,k->n', pts-start[0], seg[0]/length[0]), s)
    s = np.where(last, cumulative[-1]+np.einsum('nk,k->n', pts-line[-1], seg[-1]/length[-1]), s)
    return s, signed


def path_entry_labels(decision_t, ego_front_s, times, ped_s, ped_d, *, radius_m, corridor_half_width_m,
                      corridor_length_m, horizons=(1, 2, 3), contact_t=None, max_gap_s=.15):
    """Offline label for one pedestrian at one decision time.

    The corridor is fixed at decision time: route arc [front, front+length]
    and |offset| <= half width + measured actor radius. Gaps or truncated
    futures are MISSING_FUTURE; contact-affected futures are POST_CONTACT.
    """
    times = np.asarray(times, float);ped_s = np.asarray(ped_s, float);ped_d = np.asarray(ped_d, float)
    inside = ((ped_s >= ego_front_s) & (ped_s <= ego_front_s+corridor_length_m)
              & (np.abs(ped_d) <= corridor_half_width_m+radius_m))
    now = np.searchsorted(times, decision_t-1e-6)
    if now >= len(times) or abs(times[now]-decision_t) > max_gap_s:
        return {f'{h}s': {'status': 'MISSING_FUTURE', 'label': None} for h in horizons}
    result = {}
    for h in horizons:
        key = f'{h}s'
        if inside[now]:result[key] = {'status': 'IN_PATH_AT_DECISION', 'label': None};continue
        window = (times > decision_t+1e-9) & (times <= decision_t+h+1e-9)
        # Contact changes the walker's physics. An entry before contact is a
        # valid positive; an otherwise contact-affected future is excluded.
        before_contact = window & (times < contact_t) if contact_t is not None else window
        span = times[window]
        complete = (len(span) and span[-1] >= decision_t+h-max_gap_s and
                    np.all(np.diff(np.r_[times[now], span]) <= max_gap_s+1e-9))
        entered = bool(np.any(inside[before_contact]))
        if entered:
            first = float(times[before_contact][np.argmax(inside[before_contact])])
            result[key] = {'status': 'LABELED', 'label': 1, 'entry_time_s': round(first-decision_t, 3)}
        elif contact_t is not None and contact_t <= decision_t+h:
            result[key] = {'status': 'POST_CONTACT', 'label': None}
        elif not complete:
            result[key] = {'status': 'MISSING_FUTURE', 'label': None}
        else:
            result[key] = {'status': 'LABELED', 'label': 0}
    return result


def lateral_profile(samples):
    """Classify a measured map lateral scan into curbs and road edges.

    ``samples`` contains (right-positive offset, lane type name) pairs from a
    construction-time map query. A location without sidewalks on both sides of
    the driving surface is rejected; no geometry is substituted.
    """
    rows = sorted((float(y), str(kind)) for y, kind in samples)
    if not rows or not any(abs(y) < .3 and kind == 'Driving' for y, kind in rows):
        raise ValueError('Ego lane centre is not a driving lane')
    def edge(sign):
        ordered = [(y, k) for y, k in rows if y*sign >= 0]
        ordered.sort(key=lambda r: abs(r[0]))
        road_edge = None;curb = None;width = 0.;parking = False
        for y, kind in ordered:
            if kind in ('Driving', 'Bidirectional'):road_edge = y;continue
            if kind in ('Parking', 'Shoulder', 'Border', 'Biking', 'Median', 'Curb', 'Restricted'):
                parking |= kind in ('Parking', 'Shoulder');continue
            if kind == 'Sidewalk':
                if curb is None:curb = y
                width = abs(y-curb)
                continue
            if curb is not None:break
            if kind == 'NONE':continue
        if curb is None:raise ValueError('No measured sidewalk on the '+('right' if sign > 0 else 'left')+' side')
        return {'road_edge_m': road_edge, 'curb_m': curb, 'sidewalk_width_m': round(width, 3), 'parking_or_shoulder': parking}
    right = edge(1.);left = edge(-1.)
    if right['road_edge_m'] is None or left['road_edge_m'] is None:raise ValueError('Driving lane boundaries are not measurable')
    return {'right': right, 'left': left, 'road_width_m': round(right['curb_m']-left['curb_m'], 3)}


def verify_realization(plan, samples, *, near_u, far_u, corridor_half_width_m, radius_m=.3):
    """Physically verify a scripted behavior from native positions.

    ``samples`` rows are (time_s, along_m, u_m, speed_mps) for the walker.
    Unrealized behavior is reported, never silently relabeled.
    """
    if len(samples) < 5:return {'realized': False, 'reason': 'INSUFFICIENT_NATIVE_SAMPLES'}
    rows = np.asarray(samples, float);t, s, u, speed = rows.T
    corridor = np.abs(u) <= corridor_half_width_m+radius_m
    in_road = u < near_u-.3
    script = plan['script'];moved = float(np.max(np.hypot(s-s[0], u-u[0])))
    checks = {'max_displacement_m': round(moved, 3), 'entered_corridor': bool(corridor.any()),
              'entered_road': bool(in_road.any()), 'peak_speed_mps': round(float(speed.max()), 3)}
    if script == 'WAIT':realized = moved <= .5 and not in_road.any()
    elif script == 'PARALLEL':
        realized = abs(s[-1]-s[0]) >= 3. and float(np.ptp(u)) <= .8 and not corridor.any()
    elif script in ('CROSS', 'RUN', 'HESITATE_CROSS'):
        crossed = bool(corridor.any()) and float(u.min()) <= -corridor_half_width_m-radius_m
        realized = crossed and (script != 'RUN' or speed.max() >= 2.)
        if script == 'HESITATE_CROSS':
            pause = _stationary_interval(t, speed, u <= near_u+1.2)
            checks['hesitation_s'] = round(pause, 3);realized = realized and pause >= .6
    elif script == 'HESITATE_RETREAT':
        pause = _stationary_interval(t, speed, u <= near_u+1.2)
        retreat = float(u[-1]-u.min())
        checks.update(hesitation_s=round(pause, 3), retreat_m=round(retreat, 3))
        realized = pause >= .6 and retreat >= .6 and not corridor.any()
    elif script == 'START_RETURN':
        incursion = float(near_u-u.min())
        checks['incursion_m'] = round(incursion, 3)
        realized = incursion >= .4 and u[-1] >= near_u-.2
    else:raise ValueError('Unsupported walker script: '+script)
    return {'realized': bool(realized), 'checks': checks}


def _stationary_interval(t, speed, region):
    best = current = 0.;start = None
    for i in range(len(t)):
        if speed[i] < .3 and region[i]:
            start = t[i] if start is None else start;current = t[i]-start;best = max(best, current)
        else:start = None
    return best
