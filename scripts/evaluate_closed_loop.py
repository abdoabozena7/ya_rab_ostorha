"""Aggregate closed-loop TEST episodes per controller configuration (evaluator side).

Every recorded outcome is included. Timeouts are not arrivals, missing logs
are failures, and superiority is reported only when safety and efficiency
evidence both support it on the same scenarios.
"""
import argparse
import json
import math
from pathlib import Path
import sys
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.core.closed_loop_metrics import episode_metrics  # noqa: E402
from backend.core.closed_loop_evaluation import CONFIGURATIONS  # noqa: E402
from backend.learning.counterfactual_check import verify_pair  # noqa: E402
from backend.learning.path_entry_dataset import load_episode  # noqa: E402

FRESHNESS_GATE = .99


def collect(roots, split):
    episodes = []
    for root in roots:
        for path in Path(root).rglob('outcome.json'):
            outcome = json.loads(path.read_text(encoding='utf8'))
            if outcome.get('split') != split or outcome.get('configuration') not in CONFIGURATIONS:continue
            directory = path.parent
            try:
                manifest, rows, outcome = load_episode(directory)
                metrics = episode_metrics(manifest, rows, outcome)
                walkers = outcome.get('realization') or {}
                metrics.update(condition_hash=manifest.get('condition_hash'), ego_initial=manifest.get('ego_initial'),
                               construction=json.dumps({'placements': manifest.get('placements'), 'route_m': manifest.get('native_route_length_m'),
                                                        'occluder': {k: v for k, v in (manifest.get('occluder') or {}).items() if k != 'id'}},
                                                       sort_keys=True),
                               initial_walkers=[(w['role'], w['position_m'][:2]) for w in manifest.get('initial_truth') or () if w.get('kind') == 'walker'],
                               initial_background_vehicles=[w['position_m'][:2] for w in manifest.get('initial_truth') or ()
                                                            if w.get('kind') == 'vehicle' and w.get('role') == 'background'],
                               perception_timing=(manifest.get('perception_timing') or {}).get('mode', 'ASYNC'),
                               traffic_lights=manifest.get('traffic_lights', 'NOT_RESET'),
                               walkers_realized=all(w.get('realized') for w in walkers.values()) if walkers else None,
                               unrealized_walkers=sorted(k for k, w in walkers.items() if not w.get('realized')))
            except (OSError, ValueError, KeyError) as error:
                metrics = {'scenario_id': outcome.get('scenario_id'), 'behavior': outcome.get('behavior'), 'outcome': outcome.get('outcome'),
                           'configuration': outcome.get('configuration'), 'arrived': False, 'log_error': str(error), 'collisions': None}
            metrics['directory'] = str(directory);episodes.append(metrics)
    return episodes


def _median(values):
    values = [v for v in values if v is not None and not (isinstance(v, float) and math.isnan(v))]
    return float(np.median(values)) if values else None


def aggregate(items):
    valid = [m for m in items if 'log_error' not in m]
    usable = sum(m['freshness']['usable_frames'] for m in valid);frames = sum(m['freshness']['frames'] for m in valid)
    leads = [e for m in valid for e in m['ingress_events']]
    ordinary = [m for m in items if m.get('behavior') == 'ORDINARY_CITY_JOURNEY']
    return {'episodes': len(items), 'failed_or_missing_logs': len(items)-len(valid),
            'walker_script_not_realized_episodes': sum(m.get('walkers_realized') is False for m in valid),
            'arrivals': sum(bool(m.get('arrived')) for m in items), 'arrival_rate': sum(bool(m.get('arrived')) for m in items)/len(items) if items else None,
            'false_arrivals': sum(bool(m.get('false_arrival')) for m in valid),
            'timeouts': sum(m.get('outcome') == 'TIMEOUT' for m in items),
            'collision_episodes': sum(bool(m.get('collisions')) for m in valid), 'walker_collisions': sum(m.get('walker_collisions', 0) for m in valid),
            'collision_rate': sum(bool(m.get('collisions')) for m in valid)/len(valid) if valid else None,
            'minimum_separation_m': {'min': min((m['minimum_separation_m'] for m in valid if m['minimum_separation_m'] is not None), default=None),
                                     'median': _median([m['minimum_separation_m'] for m in valid])},
            'missed_hazards': sum(m['missed_hazards'] for m in valid), 'ingress_events': len(leads),
            'prediction_lead_s_median': _median([e['prediction_lead_s'] for e in leads]),
            'braking_lead_s_median': _median([e['braking_lead_s'] for e in leads]),
            'unnecessary_braking_events': sum(m['unnecessary_braking_events'] for m in valid),
            'nonhazardous_braking_by_reason': {k: sum((m.get('nonhazardous_braking_by_reason') or {}).get(k, 0) for m in valid)
                                               for k in ('PEDESTRIAN_FORECAST', 'MEASURED_OBSTACLE', 'COVERAGE', 'TIMING_DEADLINE', 'OTHER')},
            'braking_by_reason': {k: sum((m.get('braking_by_reason') or {}).get(k, 0) for m in valid)
                                  for k in ('PEDESTRIAN_FORECAST', 'MEASURED_OBSTACLE', 'COVERAGE', 'TIMING_DEADLINE', 'OTHER')},
            'unnecessary_full_stops': sum(m['unnecessary_full_stops'] for m in valid),
            'unnecessary_stationary_s': sum(m['unnecessary_stationary_s'] for m in valid),
            'legitimate_wait_s': {k: sum((m.get('legitimate_wait_s') or {}).get(k, 0.) for m in valid) for k in ('signal', 'vehicle_queue')},
            'journey_time_s_median_arrived': _median([m['journey_time_s'] for m in valid]),
            'route_progress_mean': float(np.mean([m['route_progress'] for m in valid])) if valid else None,
            'maximum_deceleration_mps2': {'median': _median([m['maximum_deceleration_mps2'] for m in valid]),
                                          'max': max((m['maximum_deceleration_mps2'] for m in valid), default=None),
                                          'position_derived_median': _median([m.get('maximum_deceleration_position_derived_mps2') for m in valid])},
            'deceleration_p95_mps2_median': _median([m.get('deceleration_p95_mps2') for m in valid]),
            'hard_braking_s': sum(m.get('hard_braking_s', 0.) for m in valid),
            'maximum_abs_jerk_mps3_median': _median([m['maximum_abs_jerk_mps3'] for m in valid]),
            'maximum_lateral_acceleration_mps2_max': max((m['maximum_lateral_acceleration_mps2'] for m in valid), default=None),
            'brake_release_oscillations': sum(m['brake_release_oscillations'] for m in valid),
            'maximum_speed_mps_max': max((m['maximum_speed_mps'] for m in valid), default=None),
            'speed_handling': {'requested_target_kmh': sorted({m['speed_handling']['requested_target_kmh'] for m in valid
                                                               if m.get('speed_handling', {}).get('requested_target_kmh') is not None}),
                               'achieved_mps_max': max((m['speed_handling']['achieved_mps']['max'] for m in valid if m.get('speed_handling')), default=None),
                               'restriction_frames': {k: sum(m.get('speed_handling', {}).get('restriction_frames', {}).get(k, 0) for m in valid)
                                                      for k in sorted({k for m in valid for k in m.get('speed_handling', {}).get('restriction_frames', {})})}},
            'freshness': {'usable_frames': usable, 'frames': frames, 'fraction': usable/frames if frames else None,
                          'gate_99_percent': bool(frames and usable/frames >= FRESHNESS_GATE)},
            'ordinary_route_completion': {'journeys': len(ordinary), 'arrived': sum(bool(m.get('arrived')) for m in ordinary),
                                          'gate_all_arrive': bool(ordinary) and all(m.get('arrived') for m in ordinary)},
            'performance': {'median_step_ms': _median([m['performance']['median_step_ms'] for m in valid]),
                            'p95_step_ms_median': _median([m['performance']['p95_step_ms'] for m in valid]),
                            'real_time_factor_median': _median([m['performance']['real_time_factor'] for m in valid]),
                            'safety_ms_median': _median([m['performance'].get('safety_ms_median') for m in valid]),
                            'safety_ms_p95_median': _median([m['performance'].get('safety_ms_p95') for m in valid]),
                            'layer_ms_median': _median([m['performance'].get('layer_ms_median') for m in valid]),
                            'layer_ms_p95_median': _median([m['performance'].get('layer_ms_p95') for m in valid]),
                            'deadline_hold_frames': sum(m['performance'].get('deadline_hold_frames', 0) for m in valid),
                            'risk_status_frames': {k: sum((m['performance'].get('risk_status_frames') or {}).get(k, 0) for m in valid)
                                                   for k in sorted({k for m in valid for k in (m['performance'].get('risk_status_frames') or {})})}},
            'decision_responses': {k: sum(m['decision_responses'].get(k, 0) for m in valid) for k in ('CONTINUE', 'CAUTIOUS_APPROACH', 'PROTECTIVE_BRAKING')},
            'risk_used_frames': sum(m['risk_used_frames'] for m in valid)}


def paired(episodes, a, b):
    by = {}
    for m in episodes:by.setdefault(m.get('scenario_id'), {})[m.get('configuration')] = m
    rows = [(x[a], x[b]) for x in by.values() if a in x and b in x and 'log_error' not in x[a] and 'log_error' not in x[b]]
    if not rows:return {'pairs': 0}
    both = [(p, q) for p, q in rows if p['arrived'] and q['arrived']]
    return {'pairs': len(rows), 'both_arrived': len(both),
            'journey_time_delta_s_median': _median([p['journey_time_s']-q['journey_time_s'] for p, q in both]),
            'unnecessary_braking_delta': sum(p['unnecessary_braking_events']-q['unnecessary_braking_events'] for p, q in rows),
            'unnecessary_stationary_delta_s': sum(p['unnecessary_stationary_s']-q['unnecessary_stationary_s'] for p, q in rows),
            'collision_episode_delta': sum(bool(p['collisions'])-bool(q['collisions']) for p, q in rows),
            'arrival_delta': sum(bool(p['arrived'])-bool(q['arrived']) for p, q in rows),
            'oscillation_delta': sum(p['brake_release_oscillations']-q['brake_release_oscillations'] for p, q in rows)}


def counterfactuals(episodes):
    groups = {}
    for m in episodes:
        if not m.get('counterfactual') or 'log_error' in m:continue
        manifest = json.loads((Path(m['directory'])/'manifest.json').read_text(encoding='utf8'))
        key = (manifest['spec']['counterfactual']['pair_id'], m['configuration'])
        groups.setdefault(key, {})[m['counterfactual']] = m['directory']
    result = []
    for (pair, configuration), arms in sorted(groups.items()):
        if len(arms) != 2:result.append({'pair_id': pair, 'configuration': configuration, 'complete': False});continue
        a, b = sorted(arms.items())
        try:result.append({'configuration': configuration, 'complete': True, **verify_pair(a[1], b[1])})
        except (OSError, ValueError, KeyError) as error:result.append({'pair_id': pair, 'configuration': configuration, 'error': str(error)})
    return result


def initial_conditions(episodes):
    """Same scenario, same construction: compare condition hashes and initial poses across configurations."""
    groups = {}
    for m in episodes:
        if 'log_error' not in m:groups.setdefault(m['scenario_id'], []).append(m)
    report = []
    for scenario, items in sorted(groups.items()):
        ego = np.array([m['ego_initial']['position_m'][:2] for m in items if m.get('ego_initial')])
        walkers = {};background = {}
        for m in items:
            for role, position in m.get('initial_walkers') or ():
                if role == 'background':background.setdefault(m['configuration'], []).append(tuple(round(c, 1) for c in position))
                else:walkers.setdefault(role, []).append(position)
        walker_spread = max((float(np.max(np.linalg.norm(np.asarray(v)-np.asarray(v)[0], axis=1))) for v in walkers.values() if len(v) > 1), default=0.)
        # Background walkers are an unordered population; compare as sets.
        sets = {configuration: tuple(sorted(points)) for configuration, points in background.items()}
        majority = max(set(sets.values()), key=list(sets.values()).count) if sets else None
        vehicles = {m['configuration']: tuple(sorted(tuple(round(c, 1) for c in p) for p in m.get('initial_background_vehicles') or ()))
                    for m in items}
        vehicle_majority = max(set(vehicles.values()), key=list(vehicles.values()).count) if vehicles else ()
        report.append({'scenario_id': scenario, 'behavior': items[0].get('behavior'), 'configurations': sorted(m['configuration'] for m in items),
                       'identical_condition_hash': len({m.get('condition_hash') for m in items}) == 1,
                       # The hash includes native actor IDs; physical construction excludes them.
                       'identical_physical_construction': len({m.get('construction') for m in items}) == 1,
                       'ego_initial_spread_m': float(np.max(np.linalg.norm(ego-ego[0], axis=1))) if len(ego) else None,
                       'scripted_walker_initial_spread_m': walker_spread,
                       'background_walkers': len(majority) if majority else 0,
                       'background_population_differs': sorted(c for c, s in sets.items() if s != majority),
                       'background_vehicles': len(vehicle_majority),
                       'background_vehicles_differ': sorted(c for c, s in vehicles.items() if s != vehicle_majority),
                       'perception_timing': sorted({m.get('perception_timing', 'ASYNC') for m in items}),
                       'traffic_lights': sorted({m.get('traffic_lights', 'NOT_RESET') for m in items}),
                       'walkers_realized': {m['configuration']: m.get('walkers_realized') for m in items},
                       'unrealized_walkers': {m['configuration']: m['unrealized_walkers'] for m in items if m.get('unrealized_walkers')}})
    return report


def superiority(summary, candidate, reference):
    c = summary.get(candidate);r = summary.get(reference)
    if not c or not r:return {'claim': False, 'reason': 'MISSING_CONFIGURATION'}
    safe = (c['walker_collisions'] <= r['walker_collisions'] and c['collision_episodes'] <= r['collision_episodes']
            and c['missed_hazards'] <= r['missed_hazards'])
    efficient = (c['arrivals'] >= r['arrivals'] and c['unnecessary_braking_events'] < r['unnecessary_braking_events']
                 and c['unnecessary_stationary_s'] <= r['unnecessary_stationary_s'])
    gates = c['freshness']['gate_99_percent'] and (c['ordinary_route_completion']['gate_all_arrive'] or not c['ordinary_route_completion']['journeys'])
    return {'claim': bool(safe and efficient and gates), 'safety_not_worse': safe, 'efficiency_better': efficient, 'acceptance_gates': gates}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--roots', required=True);parser.add_argument('--split', default='TEST');parser.add_argument('--out', required=True)
    args = parser.parse_args()
    episodes = collect(args.roots.split(','), args.split)
    summary = {c: aggregate([m for m in episodes if m.get('configuration') == c]) for c in CONFIGURATIONS
               if any(m.get('configuration') == c for m in episodes)}
    behaviors = sorted({m.get('behavior') for m in episodes})
    by_behavior = {c: {b: {'episodes': len(x), 'arrived': sum(bool(m.get('arrived')) for m in x),
                           'collisions': sum(bool(m.get('collisions')) for m in x),
                           'unnecessary_braking': sum(m.get('unnecessary_braking_events', 0) for m in x),
                           'unnecessary_stationary_s': round(sum(m.get('unnecessary_stationary_s', 0.) for m in x), 2)}
                       for b in behaviors for x in [[m for m in episodes if m.get('configuration') == c and m.get('behavior') == b]] if x}
                   for c in summary}
    comparisons = {f'{a}_vs_{b}': paired(episodes, a, b) for a, b in (('D_EVIDENCE_BUDGETED', 'B_PHYSICAL_PREDICTIVE'),
        ('E_PHYSICAL_ABLATION', 'B_PHYSICAL_PREDICTIVE'), ('D_EVIDENCE_BUDGETED', 'E_PHYSICAL_ABLATION'),
        ('C_LEARNED_RISK', 'B_PHYSICAL_PREDICTIVE'), ('B_PHYSICAL_PREDICTIVE', 'A_REACTIVE'))}
    result = {'split': args.split, 'source': 'LIVE_NATIVE_CARLA_HARNESS_LOGS', 'episodes': len(episodes), 'summary': summary,
              'by_behavior': by_behavior, 'paired': comparisons, 'counterfactual_pairs': counterfactuals(episodes),
              'initial_conditions': initial_conditions(episodes),
              'superiority': {'D_over_B': superiority(summary, 'D_EVIDENCE_BUDGETED', 'B_PHYSICAL_PREDICTIVE'),
                              'E_over_B': superiority(summary, 'E_PHYSICAL_ABLATION', 'B_PHYSICAL_PREDICTIVE'),
                              'D_over_E': superiority(summary, 'D_EVIDENCE_BUDGETED', 'E_PHYSICAL_ABLATION')},
              'episode_metrics': [{k: v for k, v in m.items() if k not in ('ingress_events', 'construction')} for m in episodes]}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(result, indent=1, default=float), encoding='utf8')
    print(json.dumps({'episodes': len(episodes), 'summary': {c: {k: s[k] for k in ('episodes', 'arrivals', 'collision_episodes', 'walker_collisions',
        'unnecessary_braking_events', 'unnecessary_stationary_s', 'journey_time_s_median_arrived', 'brake_release_oscillations', 'freshness')}
        for c, s in summary.items()}, 'superiority': result['superiority']}, indent=1, default=float))
    return 0


if __name__ == '__main__':sys.exit(main())
