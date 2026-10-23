"""Closed-loop episode metrics from harness logs (evaluator side, after driving).

Safety, efficiency, comfort, prediction and performance are computed together
from the same recorded episode. Native walker poses classify independently
verified hazardous and nonhazardous situations; they never reached control.
"""
import math
import numpy as np
from .pedestrian_behaviors import project_polyline

PEDESTRIAN_REASONS = ('person who may cross', 'speculative', 'crossing limit', 'PEDESTRIAN', 'Bounded approach',
                      'conflict zone', 'stop-before-zone', 'Release hysteresis')


def _series(rows, key):
    return np.array([float(key(r)) if key(r) is not None else np.nan for r in rows])


def brake_reason(row):
    safety = row.get('safety') or {};decision = safety.get('evidence_decision') or {}
    reason = str(safety.get('reason') or '')
    if 'PROCESSING_DEADLINE' in reason or safety.get('status') == 'HOLD':return 'TIMING_DEADLINE'
    if decision.get('response') in ('PROTECTIVE_BRAKING', 'CAUTIOUS_APPROACH') and decision.get('people'):return 'PEDESTRIAN_FORECAST'
    if safety.get('pedestrian_prediction') or any(k in reason for k in PEDESTRIAN_REASONS):return 'PEDESTRIAN_FORECAST'
    if 'moving object' in reason or 'Measured obstacle' in reason or 'TTC' in reason:return 'MEASURED_OBSTACLE'
    if 'coverage' in reason.lower() or 'measured road' in reason:return 'COVERAGE'
    return 'OTHER'


def walker_tracks(rows, route):
    walkers = {}
    for row in rows:
        for actor in row.get('evaluator_truth') or ():
            if actor['kind'] != 'walker':continue
            entry = walkers.setdefault(actor['id'], {'t': [], 'xy': [], 'role': actor['role'], 'half': max(actor['half_size_m'])})
            entry['t'].append(row['timestamp_s']);entry['xy'].append(actor['position_m'][:2])
    for entry in walkers.values():
        entry['t'] = np.asarray(entry['t']);entry['xy'] = np.asarray(entry['xy'])
        entry['s'], entry['d'] = project_polyline(entry['xy'], route)
    return walkers


def restriction(row):
    """Why the selected speed is below the requested target on this frame."""
    safety = row.get('safety') or {};speed = row.get('speed') or {}
    requested = (speed.get('requested_kmh') or 0.)/3.6;navigation = speed.get('navigation_target_mps')
    limit = safety.get('coverage_speed_limit_mps');brake = (row.get('applied_command') or {}).get('brake', 0.)
    if (row.get('applied_command') or {}).get('source') == 'SAFETY' and brake >= .2:return brake_reason(row)
    if limit is not None and limit < requested-.5:
        return 'PEDESTRIAN_FORECAST' if brake_reason(row) == 'PEDESTRIAN_FORECAST' else 'MEASURED_COVERAGE_LIMIT'
    if navigation is not None and navigation < requested-.5:return 'ROUTE_TERMINAL_OR_SIGNAL'
    return 'NONE'


def speed_summary(rows, speed):
    requested = [((r.get('speed') or {}).get('requested_kmh')) for r in rows]
    posted = [((r.get('speed') or {}).get('posted_limit_kmh')) for r in rows]
    limits = [((r.get('safety') or {}).get('coverage_speed_limit_mps')) for r in rows]
    selected = []
    for r in rows:
        values = [v for v in ((r.get('speed') or {}).get('navigation_target_mps'), (r.get('safety') or {}).get('coverage_speed_limit_mps'),
                              (r.get('safety') or {}).get('cautious_roadside_speed_mps')) if v is not None]
        decision = (r.get('safety') or {}).get('evidence_decision') or {}
        if decision.get('target_speed_mps') is not None:values.append(decision['target_speed_mps'])
        selected.append(min(values) if values else None)
    reasons = {}
    for r in rows:
        key = restriction(r);reasons[key] = reasons.get(key, 0)+1
    finite = lambda xs: [x for x in xs if x is not None]
    return {'requested_target_kmh': max(finite(requested), default=None),
            'posted_limit_kmh': {'min': min(finite(posted), default=None), 'max': max(finite(posted), default=None)},
            'applicable_safe_limit_mps_median': float(np.median(finite(limits))) if finite(limits) else None,
            'controller_selected_mps_median': float(np.median(finite(selected))) if finite(selected) else None,
            'achieved_mps': {'max': float(np.nanmax(speed)), 'mean': float(np.nanmean(speed))},
            'restriction_frames': reasons}


def comfort_series(t, speed, yaw, window_s=.2):
    """Longitudinal acceleration/jerk and lateral acceleration over >= window_s differences."""
    if len(t) < 3:return np.zeros(1), np.zeros(1), np.zeros(1)
    order = np.argsort(t, kind='stable');t = t[order];speed = speed[order];yaw = np.unwrap(yaw[order])
    keep = np.r_[True, np.diff(t) > 1e-6];t = t[keep];speed = speed[keep];yaw = yaw[keep]
    grid = np.arange(t[0], t[-1]+1e-9, window_s/2.)
    if len(grid) < 3:return np.zeros(1), np.zeros(1), np.zeros(1)
    v = np.interp(grid, t, speed);h = np.interp(grid, t, yaw)
    accel = (v[2:]-v[:-2])/window_s;yaw_rate = (h[2:]-h[:-2])/window_s
    jerk = (accel[2:]-accel[:-2])/window_s if len(accel) > 2 else np.zeros(1)
    return accel, jerk, v[1:-1]*yaw_rate


def episode_metrics(manifest, rows, outcome, *, corridor_length_m=60.):
    if not rows:
        return {'scenario_id': manifest.get('scenario_id'), 'outcome': outcome.get('outcome'), 'valid_rows': 0}
    route = np.asarray(manifest['route'], float)[:, :2];geometry = manifest.get('ego_geometry') or {}
    front = float(manifest['ego_front_m']);half_width = float(geometry.get('half_width_m', manifest['corridor_half_width_m']-.25))
    rear = float(geometry.get('rear_m', 2.3));corridor = float(manifest['corridor_half_width_m'])
    t = _series(rows, lambda r: r['timestamp_s']);t0 = t[0]-rows[0]['elapsed_s']
    speed = _series(rows, lambda r: r['ego']['speed_mps']);yaw = _series(rows, lambda r: r['ego']['yaw_rad'])
    xy = np.array([r['ego']['position_m'][:2] for r in rows]);ego_s, _ = project_polyline(xy, route)
    brake = _series(rows, lambda r: (r.get('applied_command') or {}).get('brake', 0.))
    source = [(r.get('applied_command') or {}).get('source') for r in rows]
    walkers = walker_tracks(rows, route)
    # Independent hazard truth: a walker is in/entering the planned corridor ahead.
    in_path = np.zeros(len(rows), bool);entering_soon = np.zeros(len(rows), bool)
    min_separation = math.inf;entries = {}
    for wid, w in walkers.items():
        r = w['half']
        for i, row in enumerate(rows):
            k = int(np.argmin(np.abs(w['t']-row['timestamp_s'])))
            if abs(w['t'][k]-row['timestamp_s']) > 1e-6:continue
            ahead = ego_s[i]+front;inside = abs(w['d'][k]) <= corridor+r and ahead-front-rear <= w['s'][k] <= ahead+corridor_length_m
            in_path[i] |= inside and w['s'][k] >= ahead-.5
            future = (w['t'] > row['timestamp_s']) & (w['t'] <= row['timestamp_s']+3.)
            entering_soon[i] |= bool(np.any((np.abs(w['d'][future]) <= corridor+r) & (w['s'][future] >= ahead) & (w['s'][future] <= ahead+corridor_length_m)))
            if inside and wid not in entries and w['s'][k] >= ahead:entries[wid] = row['timestamp_s']
            # Ego footprint separation (oriented box vs. walker disc).
            dx, dy = w['xy'][k]-xy[i];c, s = math.cos(yaw[i]), math.sin(yaw[i])
            lx = dx*c+dy*s;ly = -dx*s+dy*c
            ox = max(0., lx-front, -rear-lx);oy = max(0., abs(ly)-half_width)
            min_separation = min(min_separation, math.hypot(ox, oy)-r)
    hazardous = in_path | entering_soon
    dt = np.r_[np.diff(t), 0.05]
    # Braking events (applied safety brake >= 0.2, separated by >= 1 s release).
    events = [];active = None
    for i in range(len(rows)):
        braking = brake[i] >= .2 and source[i] == 'SAFETY'
        if braking and active is None:active = {'start': i, 'reason': brake_reason(rows[i])}
        if not braking and active is not None and (i-active['start'] > 0):
            active['end'] = i;events.append(active);active = None
    if active is not None:active['end'] = len(rows)-1;events.append(active)
    for event in events:
        window = slice(event['start'], min(len(rows), event['end']+1))
        event['hazardous'] = bool(np.any(hazardous[window]))
        event['elapsed_s'] = float(t[event['start']]-t0);event['duration_s'] = float(t[event['end']]-t[event['start']])
    unnecessary = [e for e in events if not e['hazardous'] and e['reason'] in ('PEDESTRIAN_FORECAST', 'MEASURED_OBSTACLE', 'OTHER')]
    stopped = speed < .15
    remaining = _series(rows, lambda r: (r.get('route') or {}).get('remaining_m'))
    terminal = np.nan_to_num(remaining, nan=99.) < 8.
    unnecessary_stop = stopped & ~hazardous & ~terminal
    full_stops = 0;run = 0.
    for i in range(len(rows)):
        if unnecessary_stop[i]:
            run += dt[i]
            if abs(run-dt[i]) < 1e-9:pass
        else:
            if run >= .5:full_stops += 1
            run = 0.
    if run >= .5:full_stops += 1
    # Lead times relative to actual corridor ingress (first entry ahead).
    leads = []
    for wid, entry_t in entries.items():
        before = [i for i in range(len(rows)) if entry_t-6. <= t[i] < entry_t]
        prediction = next((t[i] for i in before if brake_reason(rows[i]) == 'PEDESTRIAN_FORECAST'
                           and (rows[i].get('safety') or {}).get('status') in ('BRAKING', 'CAUTIOUS_APPROACH', 'RELEASING')), None)
        braking = next((t[i] for i in before if brake[i] >= .2 and source[i] == 'SAFETY'), None)
        contact = next((c['timestamp_s'] for c in outcome.get('contacts') or () if c['other_actor_id'] == wid), None)
        leads.append({'walker_id': wid, 'role': walkers[wid]['role'], 'ingress_elapsed_s': float(entry_t-t0),
                      'prediction_lead_s': None if prediction is None else float(entry_t-prediction),
                      'braking_lead_s': None if braking is None else float(entry_t-braking), 'contact': contact is not None})
    active = np.array([(r.get('journey') or {}).get('status') in ('STARTING', 'RUNNING', None) for r in rows])
    accel, jerk, lateral = comfort_series(t[active], speed[active], yaw[active])
    smooth = accel
    oscillations = 0;last_brake_on = None;state = False
    for i in range(len(rows)):
        on = brake[i] >= .2
        if on and not state:
            if last_brake_on is not None and t[i]-last_brake_on <= 2.:oscillations += 1
            last_brake_on = t[i]
        state = on if (on or brake[i] <= .05) else state
    contacts = outcome.get('contacts') or []
    walker_ids = set(walkers)
    usable = [bool((r.get('scene') or {}).get('usable')) for r in rows if r.get('scene')]
    step_ms = _series(rows, lambda r: r.get('step_ms'))
    simulated = float(t[-1]-t0);wall = float(np.nansum(step_ms))/1000.
    route_length = float(manifest.get('native_route_length_m') or np.sum(np.linalg.norm(np.diff(route, axis=0), axis=1)))
    risk_frames = [((r.get('safety') or {}).get('evidence_decision') or {}).get('risk_used') for r in rows]
    responses = {}
    for r in rows:
        response = ((r.get('safety') or {}).get('evidence_decision') or {}).get('response')
        if response:responses[response] = responses.get(response, 0)+1
    speed_handling = speed_summary(rows, speed)
    return {'scenario_id': manifest['scenario_id'], 'behavior': manifest['behavior'], 'split': manifest['split'],
            'configuration': (manifest.get('admission') or {}).get('configuration'),
            'counterfactual': (manifest['spec'].get('counterfactual') or {}).get('arm'), 'outcome': outcome.get('outcome'),
            'arrived': outcome.get('outcome') == 'ARRIVED', 'timeout': outcome.get('outcome') == 'TIMEOUT',
            'collisions': len(contacts), 'walker_collisions': sum(c['other_actor_id'] in walker_ids for c in contacts),
            'minimum_separation_m': None if math.isinf(min_separation) else float(min_separation),
            'ingress_events': leads, 'missed_hazards': sum(1 for x in leads if x['contact'] or x['braking_lead_s'] is None and x['prediction_lead_s'] is None),
            'distance_m': outcome.get('distance_m'), 'route_length_m': route_length,
            'route_progress': float(min(1., max(0., (ego_s[-1]-ego_s[0])/max(route_length, 1.)))),
            'journey_time_s': simulated if outcome.get('outcome') == 'ARRIVED' else None, 'simulated_s': simulated,
            'braking_events': len(events), 'braking_by_reason': {k: sum(e['reason'] == k for e in events) for k in
                                                                 ('PEDESTRIAN_FORECAST', 'MEASURED_OBSTACLE', 'COVERAGE', 'TIMING_DEADLINE', 'OTHER')},
            'unnecessary_braking_events': len(unnecessary), 'unnecessary_full_stops': full_stops,
            'unnecessary_stationary_s': float(np.sum(dt[unnecessary_stop])),
            'stationary_s': float(np.sum(dt[stopped])), 'maximum_speed_mps': float(np.nanmax(speed)),
            'maximum_deceleration_mps2': float(max(0., -np.nanmin(smooth))), 'maximum_abs_jerk_mps3': float(np.nanmax(np.abs(jerk))),
            'rms_jerk_mps3': float(np.sqrt(np.nanmean(jerk**2))), 'maximum_lateral_acceleration_mps2': float(np.nanmax(np.abs(lateral))),
            'brake_release_oscillations': oscillations,
            'decision_responses': responses, 'risk_used_frames': sum(bool(x) for x in risk_frames),
            'speed_handling': speed_handling,
            'freshness': {'usable_frames': sum(usable), 'frames': len(usable), 'fraction': sum(usable)/len(usable) if usable else None},
            'performance': {'median_step_ms': float(np.nanmedian(step_ms)), 'p95_step_ms': float(np.nanpercentile(step_ms, 95)),
                            'real_time_factor': simulated/wall if wall > 0 else None, 'wall_s': wall}}
