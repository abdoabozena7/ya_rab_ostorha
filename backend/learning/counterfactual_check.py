"""Offline verification of counterfactual pairs (evaluator side).

Both arms share construction and the waiting pose until the decision time.
This measures how identical the *observed* prefix actually was natively
(ego motion, applied commands, measured tracks) and how each arm diverged.
"""
import math
import numpy as np
from .path_entry_dataset import load_episode


def _prefix(rows, start_t, decision_s):
    return [r for r in rows if r['timestamp_s']-start_t < decision_s-1e-6]


def verify_pair(directory_a, directory_b, *, position_tolerance_m=.25, command_tolerance=.05):
    manifest_a, rows_a, outcome_a = load_episode(directory_a)
    manifest_b, rows_b, outcome_b = load_episode(directory_b)
    cf_a = manifest_a['spec']['counterfactual'];cf_b = manifest_b['spec']['counterfactual']
    if not cf_a or not cf_b or cf_a['pair_id'] != cf_b['pair_id']:raise ValueError('Episodes are not one counterfactual pair')
    if (manifest_a.get('admission') or {}).get('configuration') != (manifest_b.get('admission') or {}).get('configuration'):
        raise ValueError('Counterfactual arms must use the same controller configuration')
    timing_a = manifest_a.get('perception_timing') or {'mode': 'ASYNC'};timing_b = manifest_b.get('perception_timing') or {'mode': 'ASYNC'}
    if timing_a != timing_b:raise ValueError('Counterfactual arms must use the same perception timing')
    decision = cf_a['decision_s']
    start_a = rows_a[0]['timestamp_s']-rows_a[0]['elapsed_s'];start_b = rows_b[0]['timestamp_s']-rows_b[0]['elapsed_s']
    pa = _prefix(rows_a, start_a, decision);pb = _prefix(rows_b, start_b, decision)
    n = min(len(pa), len(pb))
    ego = max((math.dist(pa[i]['ego']['position_m'][:2], pb[i]['ego']['position_m'][:2]) for i in range(n)), default=None)
    def command(row):
        c = row.get('applied_command') or {}
        return np.array([c.get('throttle', 0.), c.get('brake', 0.), c.get('steering', 0.)])
    commands = max((float(np.max(np.abs(command(pa[i])-command(pb[i])))) for i in range(n)), default=None)
    def walker(row):
        return next((a['position_m'][:2] for a in row['evaluator_truth'] if a['role'] == 'ped_0'), None)
    walker_gap = max((math.dist(walker(pa[i]), walker(pb[i])) for i in range(n) if walker(pa[i]) and walker(pb[i])), default=None)
    def nearest_track(row):
        target = walker(row);scene = row.get('scene') or {}
        if not target or not scene.get('tracks'):return None
        ego = row['ego']['position_m'];yaw = row['ego']['yaw_rad'];d = np.subtract(target, ego[:2])
        local = np.array([d[0]*math.cos(yaw)+d[1]*math.sin(yaw), -d[0]*math.sin(yaw)+d[1]*math.cos(yaw)])
        return min((np.asarray(t['position_m'][:2]) for t in scene['tracks']), key=lambda p: np.linalg.norm(p-local))
    track_gaps = [float(np.linalg.norm(nearest_track(pa[i])-nearest_track(pb[i]))) for i in range(n)
                  if nearest_track(pa[i]) is not None and nearest_track(pb[i]) is not None]
    identical = (ego is not None and ego <= position_tolerance_m and commands is not None and commands <= command_tolerance
                 and walker_gap is not None and walker_gap <= .05)
    def prefix_complete(outcome, start):
        timing = outcome.get('perception_timing') or {}
        if timing.get('mode') != 'LOCKSTEP':return None
        if 'missed_at_s' not in timing:return timing.get('complete')
        return all(t-start >= decision-1e-6 for t in timing['missed_at_s'])
    return {'pair_id': cf_a['pair_id'], 'decision_s': decision, 'compared_frames': n, 'perception_timing': timing_a.get('mode'),
            'lockstep_complete': [(outcome.get('perception_timing') or {}).get('complete') for outcome in (outcome_a, outcome_b)],
            'lockstep_complete_before_decision': [prefix_complete(outcome_a, start_a), prefix_complete(outcome_b, start_b)],
            'prefix_frames': [len(pa), len(pb)], 'max_ego_position_gap_m': ego, 'max_applied_command_gap': commands,
            'max_walker_position_gap_m': walker_gap, 'max_measured_track_gap_m': max(track_gaps) if track_gaps else None,
            'observable_prefix_identical_within_tolerance': bool(identical),
            'tolerances': {'ego_position_m': position_tolerance_m, 'command': command_tolerance, 'walker_m': .05},
            'arms': {cf_a['arm']: {'outcome': outcome_a.get('outcome'), 'contacts': len(outcome_a.get('contacts') or ())},
                     cf_b['arm']: {'outcome': outcome_b.get('outcome'), 'contacts': len(outcome_b.get('contacts') or ())}}}
