"""Evaluation decision layers around RULE's pedestrian forecast.

``decision_layer=None`` leaves the original RULE untouched. ``LEARNED_RISK``
adds calibrated caution on top of every RULE decision. ``EVIDENCE_BUDGETED``
replaces RULE's response only for people whose every conflict is a
speculative alternative of a verified-stationary person: candidate speed
plans are checked in space and time against all of those people's physically
reachable alternatives (pass before reach, or brake after detection), with
calibrated risk only lengthening the detection delay. Physical decisions are
never relaxed.
"""
import math
import time
from .evidence_budget import SPECULATIVE, BudgetConfig, EvidenceBudget, TemporalVerifier, max_speed_for_distance, verified_stationary
from .path_entry_features import corridor_coordinates, eligible_track, steering_curvature
from .path_entry_risk import AsyncRiskEstimator, RiskEstimator


def classify_conflicts(prediction, conflicts, timestamp_s, *, geometry, curvature, layer):
    """Split pedestrian conflicts into speculative-only stationary people and physical risk."""
    tracks = {str(t['id']): t for t in (prediction or {}).get('tracks', ())}
    grouped = {}
    for item in conflicts or ():grouped.setdefault(str(item['track_id']), []).append(item)
    speculative = [];physical = []
    for track_id, items in grouped.items():
        track = tracks.get(track_id);sources = {c['source'] for c in items}
        reason = None
        if track is None:reason = 'TRACK_NOT_PUBLISHED'
        elif not sources <= set(SPECULATIVE):reason = 'MEASURED_MOTION_CONFLICT'
        elif not verified_stationary(track, timestamp_s, window_s=layer.config.stationary_window_s):reason = 'STATIONARITY_NOT_VERIFIED'
        if reason is None:
            zone = layer.person_zone(track, geometry=geometry, curvature=curvature, corridor_coordinates=corridor_coordinates)
            if zone['lateral_gap_m'] <= 0.:reason = 'PERSON_WITHIN_CORRIDOR_MARGIN'
            else:speculative.append(zone);continue
        physical.append({'track_id': track_id, 'reason': reason, 'sources': sorted(sources)})
    return speculative, physical


def ensure_layer(supervisor):
    layer = getattr(supervisor, 'evidence_budget', None)
    if layer is None:
        layer = supervisor.evidence_budget = EvidenceBudget(BudgetConfig.from_teacher(supervisor.config.teacher))
    return layer


def risk_for_frame(supervisor, prediction, observation, base, as_of_timestamp_s):
    estimator = getattr(supervisor, 'risk_estimator', None)
    if isinstance(estimator, AsyncRiskEstimator):
        # Submitted when this safety step began; bounded wait, same frame only.
        result = estimator.result_for(observation.frame_id)
    elif isinstance(estimator, RiskEstimator):
        result = estimator.estimate(prediction, frame_id=observation.frame_id, timestamp_s=observation.timestamp_s,
                                    ego_speed_mps=abs(observation.ego.speed_mps), steering=base.steering,
                                    observation_age_s=max(0., as_of_timestamp_s-observation.timestamp_s))
    else:return None, {'status': 'NO_ADMITTED_OR_EXPERIMENTAL_MODEL'}
    tracks = RiskEstimator.for_frame(result, observation.frame_id)
    return tracks, {k: result.get(k) for k in ('status', 'latency_ms', 'experimental', 'model_id', 'frame_id', 'inference',
                                               'since_submit_ms') if k in result}


def submit_risk(supervisor, observation, base, as_of_timestamp_s):
    """Start this frame's learned risk off the safety path (evaluation layers only)."""
    estimator = getattr(supervisor, 'risk_estimator', None)
    if isinstance(estimator, AsyncRiskEstimator):
        estimator.submit(getattr(supervisor, 'control_prediction', None), frame_id=observation.frame_id,
                         timestamp_s=observation.timestamp_s, ego_speed_mps=abs(observation.ego.speed_mps), steering=base.steering,
                         observation_age_s=max(0., as_of_timestamp_s-observation.timestamp_s))


def person_like(track):
    """Tracks the predictor was trained for: classified people or depth body-core people."""
    evidence = track.get('measurement_evidence') or {}
    return (str(track.get('class', '')).lower() in ('person', 'pedestrian') or evidence.get('source') == 'CURRENT_DEPTH_BODY_CORE')


def pedestrian_layer(supervisor, *, observation, base, geometry, prediction, conflicts, hazard, conflict,
                     rule_crawl_cap_mps, target_speed_mps, as_of_timestamp_s):
    """Return an override for RULE's pedestrian handling, or None to keep RULE."""
    mode = getattr(supervisor, 'decision_layer', None)
    if mode not in ('EVIDENCE_BUDGETED', 'LEARNED_RISK'):return None
    started = time.perf_counter()
    result = _pedestrian_layer(supervisor, mode, observation=observation, base=base, geometry=geometry, prediction=prediction,
                               conflicts=conflicts, hazard=hazard, conflict=conflict, rule_crawl_cap_mps=rule_crawl_cap_mps,
                               target_speed_mps=target_speed_mps, as_of_timestamp_s=as_of_timestamp_s)
    # Wall time of the layer itself (including any bounded wait for learned risk).
    result['decision']['layer_ms'] = (time.perf_counter()-started)*1000
    return result


def _pedestrian_layer(supervisor, mode, *, observation, base, geometry, prediction, conflicts, hazard, conflict,
                      rule_crawl_cap_mps, target_speed_mps, as_of_timestamp_s):
    layer = ensure_layer(supervisor);config = layer.config
    curvature = steering_curvature(base.steering)
    speculative, physical = classify_conflicts(prediction, conflicts, observation.timestamp_s, geometry=geometry,
                                               curvature=curvature, layer=layer)
    risk, risk_status = risk_for_frame(supervisor, prediction, observation, base, as_of_timestamp_s)
    latency = max(0., float(getattr(supervisor, 'processing_latency_s', 0.) or 0.))
    age = max(0., as_of_timestamp_s-observation.timestamp_s)
    speed = abs(observation.ego.speed_mps)
    if mode == 'LEARNED_RISK':
        # RULE decides first; calibrated risk can only add a lower cap.
        cap = math.inf;people = []
        delay = age+latency+config.reaction_time_s+config.motion_confirmation_s+config.observation_interval_s
        for track in (prediction or {}).get('tracks', ()):
            probability = (risk or {}).get(str(track['id']), {}).get('3s')
            if (probability is None or probability < config.risk_high or not person_like(track)
                    or not eligible_track(track, front_m=geometry.front_m)):continue
            zone = layer.person_zone(track, geometry=geometry, curvature=curvature, corridor_coordinates=corridor_coordinates)
            if zone['lateral_gap_m'] <= 0.:continue
            limit = max_speed_for_distance(zone['zone_m'], delay+config.risk_extra_budget_s, config.cautious_deceleration_mps2, config.margin_m)
            people.append({**zone, 'risk_3s': probability, 'risk_cap_mps': limit});cap = min(cap, limit)
        decision = {'layer': 'LEARNED_RISK_CAUTION_V1', 'risk_status': risk_status, 'people': people, 'risk_used': bool(people),
                    'response': 'CAUTIOUS_APPROACH' if cap < target_speed_mps else 'CONTINUE',
                    'target_speed_mps': None if math.isinf(cap) else cap,
                    'brake': 0. if math.isinf(cap) or speed <= cap+.1 else min(config.cautious_max_brake, (speed-cap)*.25)}
        return {'mode': mode, 'keep_rule_braking': True, 'cap_mps': decision['target_speed_mps'], 'decision': decision}
    risk_people = []
    if risk:
        considered = {p['track_id'] for p in speculative}|{p['track_id'] for p in physical}
        for track in (prediction or {}).get('tracks', ()):
            if (str(track['id']) in considered or str(track['id']) not in risk or not person_like(track)
                    or not eligible_track(track, front_m=geometry.front_m)):continue
            zone = layer.person_zone(track, geometry=geometry, curvature=curvature, corridor_coordinates=corridor_coordinates)
            if zone['lateral_gap_m'] > 0.:risk_people.append(zone)
    people = [{**z, 'risk_only': False} for z in speculative]+[{**z, 'risk_only': True} for z in risk_people]
    ids = {str(p['track_id']) for p in people}
    tracks = [t for t in (prediction or {}).get('tracks', ()) if str(t['id']) in ids]
    cleared = {str(t['id']) for t in tracks if t.get('observed_crossing_cleared')}
    # The same physical alternatives RULE assessed; a person observed to have
    # cleared the crossing keeps only measured motion, as in RULE.
    modes = [m for m in (prediction or {}).get('trajectories', ()) if str(m['track_id']) in ids
             and not (str(m['track_id']) in cleared and m['source'] in SPECULATIVE)]
    verifier = TemporalVerifier(tracks, modes, geometry=geometry, speed_mps=speed, steering=base.steering, config=config,
                                path=getattr(supervisor, 'supervised_rows', None))
    decision = layer.decide(timestamp_s=observation.timestamp_s, speed_mps=speed, target_speed_mps=target_speed_mps,
                            physical_brake=bool(hazard or conflict is not None or physical), people=people, verifier=verifier,
                            # A pure measured-obstacle hazard is RULE's (with RULE's hysteresis); a
                            # physical person or an unclassified moving object may be a person.
                            pedestrian_physical=bool(physical or conflict is not None),
                            rule_crawl_cap_mps=rule_crawl_cap_mps, observation_age_s=age, processing_latency_s=latency,
                            risk=risk, use_risk=risk is not None)
    decision.update(risk_status=risk_status, physical_conflicts=physical, speculative_people=len(speculative),
                    supervised_path='ROUTE_TRACKER_PATH' if getattr(supervisor, 'supervised_rows', None) is not None else 'STEERING_ARC')
    return {'mode': mode, 'keep_rule_braking': bool(hazard or conflict is not None or physical), 'decision': decision,
            'cap_mps': decision.get('target_speed_mps') if decision['response'] == 'CAUTIOUS_APPROACH' else None}
