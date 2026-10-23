"""Compile the failed-gates recovery evidence (23 October 2026) from native harness outputs.

Reads ignored raw outputs under ``output/`` and writes compact JSON evidence to
``docs/evidence/failed-gates-recovery-20261023``. Missing inputs are recorded
as missing; nothing is substituted.
"""
import argparse
import gzip
import json
import math
from pathlib import Path
import sys

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
OUT = ROOT/'output'
SUITE = OUT/'pedestrian-suite'
REPRO = OUT/'route-repro'
EVIDENCE = ROOT/'docs/evidence/failed-gates-recovery-20261023'
SUMMARY_KEYS = ('episodes', 'failed_or_missing_logs', 'arrivals', 'timeouts', 'false_arrivals', 'collision_episodes',
                'walker_collisions', 'missed_hazards', 'minimum_separation_m', 'unnecessary_braking_events',
                'unnecessary_full_stops', 'unnecessary_stationary_s', 'brake_release_oscillations',
                'journey_time_s_median_arrived', 'route_progress_mean', 'nonhazardous_braking_by_reason',
                'freshness', 'ordinary_route_completion', 'performance', 'decision_responses', 'maximum_deceleration_mps2',
                'deceleration_p95_mps2_median', 'hard_braking_s', 'maximum_abs_jerk_mps3_median',
                'maximum_lateral_acceleration_mps2_max', 'maximum_speed_mps_max', 'prediction_lead_s_median',
                'braking_lead_s_median', 'ingress_events')


def load(path):
    path = Path(path)
    return json.loads(path.read_text(encoding='utf8')) if path.exists() else None


def rounded(value, digits=3):
    if isinstance(value, float):return round(value, digits) if math.isfinite(value) else None
    if isinstance(value, dict):return {k: rounded(v, digits) for k, v in value.items()}
    if isinstance(value, (list, tuple)):return [rounded(v, digits) for v in value]
    return value


def compact_summary(evaluation):
    if not evaluation:return {'status': 'MISSING'}
    return {configuration: rounded({k: summary.get(k) for k in SUMMARY_KEYS})
            for configuration, summary in evaluation['summary'].items()}


def episode_rows(evaluation):
    rows = []
    for m in (evaluation or {}).get('episode_metrics', ()):
        if 'log_error' in m:
            rows.append({'configuration': m.get('configuration'), 'behavior': m.get('behavior'), 'outcome': m.get('outcome'),
                         'log_error': m['log_error'][:160]});continue
        rows.append(rounded({'configuration': m['configuration'], 'behavior': m['behavior'], 'scenario_id': m['scenario_id'][:16],
                             'counterfactual_arm': m.get('counterfactual'), 'outcome': m['outcome'],
                             'journey_time_s': m.get('journey_time_s'), 'final_destination_distance_m': m.get('final_destination_distance_m'),
                             'collisions': m['collisions'], 'minimum_separation_m': m['minimum_separation_m'],
                             'unnecessary_braking_events': m['unnecessary_braking_events'],
                             'unnecessary_full_stops': m['unnecessary_full_stops'], 'unnecessary_stationary_s': m['unnecessary_stationary_s'],
                             'brake_release_oscillations': m['brake_release_oscillations'],
                             'nonhazardous_braking_by_reason': m['nonhazardous_braking_by_reason'],
                             'maximum_speed_mps': m['maximum_speed_mps'], 'deadline_hold_frames': m['performance'].get('deadline_hold_frames')}))
    return sorted(rows, key=lambda r: (str(r.get('behavior')), str(r.get('scenario_id')), str(r.get('configuration'))))


def stop_geometry(directory, start_s):
    """Applied steering and the planned route's heading change ahead of the ego when a stall began."""
    directory = Path(directory)
    try:
        manifest = json.loads((directory/'manifest.json').read_text(encoding='utf8'))
        rows = [json.loads(l) for l in gzip.open(directory/'episode.jsonl.gz', 'rt', encoding='utf8')]
    except (OSError, ValueError):return None
    row = min(rows, key=lambda r: abs(r['elapsed_s']-start_s))
    route = np.asarray(manifest['route'], float)[:, :2]
    cumulative = np.r_[0., np.cumsum(np.linalg.norm(np.diff(route, axis=0), axis=1))]
    index = int(np.argmin(np.linalg.norm(route-np.asarray(row['ego']['position_m'][:2]), axis=1)))
    def heading(s):
        k = int(np.clip(np.searchsorted(cumulative, s), 1, len(route)-1))
        d = route[k]-route[k-1]
        return math.atan2(d[1], d[0])
    turn = [abs(math.degrees((heading(cumulative[index]+ahead)-heading(cumulative[index])+math.pi) % (2*math.pi)-math.pi))
            for ahead in (5., 10., 15.)]
    return rounded({'applied_steering': (row.get('applied_command') or {}).get('steering'),
                    'route_heading_change_deg_at_5_10_15_m': turn})


def task1():
    def episodes(name, geometry=False):
        data = load(REPRO/name)
        if not data:return {'status': 'MISSING', 'file': name}
        def contacts(e):
            outcome = load(Path(e['directory'])/'outcome.json') if e.get('directory') else None
            return None if outcome is None else len(outcome.get('contacts') or ())
        return {'source': data.get('source'), 'stops_by_cause': data['stops_by_cause'],
                'episodes': [{'route': f"{e['location']['town']}:{e['location']['spawn_index']}", 'behavior': e['behavior'],
                              'outcome': e['outcome'], 'simulated_s': e['simulated_s'], 'collisions': contacts(e),
                              'stall_causes': [s['cause'] for s in e['stops'] if s['cause'] != 'ARRIVAL_STOP'],
                              'stops': [rounded({**{k: s.get(k) for k in ('cause', 'start_s', 'duration_s', 'remaining_m', 'reason',
                                                                          'supervised_coverage_m', 'route_path_coverage_m',
                                                                          'steering_arc_coverage_m', 'rear_axle_cross_track_m')},
                                                 **({'geometry_at_stop': stop_geometry(e['directory'], s['start_s'])}
                                                    if geometry and e.get('directory') else {})})
                                        for s in e['stops'] if s['cause'] != 'ARRIVAL_STOP']} for e in data['episode_stops']]}
    return {'task': 'CORNER_AND_TURN_DEADLOCKS',
            'before_reproduction': {'harness': 'route tracker off (previous evaluation steering and steering-arc probe)',
                                    'folder': 'output/pedestrian-suite/task1-before-20261023', **episodes('classify-before.json', geometry=True)},
            'failed_attempt': {'folder': 'output/pedestrian-suite/task1-after-20261023-failed-processing-deadline',
                               'outcome': 'All 9 episodes SENSOR_FAULT at 0.2 s: route-path corridor projection cost 690-845 ms; '
                                          'fixed with PathCorridorIndex (exactness-tested) before the verification run'},
            'after_verification': {'folder': 'output/pedestrian-suite/task1-after-20261023c', **episodes('classify-after-c.json')},
            'phase7_test_baseline': 'All five configurations stopped ~18 m short on the four Town02 spawn-25 routes (route-end turn)'}


def hold_frame_profile(folder, split):
    """Scene, sensor and safety timings of processing-deadline hold frames, the frames just
    before them, and all other frames (native harness logs)."""
    root = SUITE/folder/split
    if not root.exists():return {'status': 'MISSING', 'folder': str(root)}
    fields = ('scene_build_ms', 'semantics_and_freezing_ms', 'tracking_and_forecasts_ms', 'sensor_arrival_spread_ms', 'safety_ms')
    groups = {name: {k: [] for k in fields} for name in ('hold_frames', 'frames_before_hold', 'other_frames')}
    def add(group, r):
        scene = r.get('scene') or {};timings = scene.get('timings_ms') or {};target = groups[group]
        for key, value in (('scene_build_ms', scene.get('build_ms')), ('semantics_and_freezing_ms', timings.get('semantics_and_freezing')),
                           ('tracking_and_forecasts_ms', timings.get('tracking_and_forecasts')),
                           ('sensor_arrival_spread_ms', max((v.get('after_first_ms') or 0. for v in (r.get('sensors') or {}).values()), default=None)),
                           ('safety_ms', (r.get('control_timing_ms') or {}).get('safety'))):
            if value is not None:target[key].append(value)
    for path in sorted(root.glob('*/*/episode.jsonl.gz')):
        with gzip.open(path, 'rt', encoding='utf8') as stream:
            rows = [json.loads(line) for line in stream]
        hold = [(r.get('safety') or {}).get('reason') == 'CONTROL_PROCESSING_DEADLINE' for r in rows]
        for k, r in enumerate(rows):
            if hold[k]:add('hold_frames', r)
            elif k+1 < len(rows) and hold[k+1]:add('frames_before_hold', r)
            else:add('other_frames', r)
    q = lambda a: {'n': len(a), 'median': round(float(np.median(a)), 1)} if a else None
    return {'folder': f'output/pedestrian-suite/{folder}', 'split': split,
            'definition': 'hold = row whose safety reason is CONTROL_PROCESSING_DEADLINE; before_hold = the row immediately preceding a hold',
            **{group: {k: q(v) for k, v in values.items()} for group, values in groups.items()}}


def task3():
    cpu = load(REPRO/'eval-task2-validation.json');dml = load(REPRO/'eval-task3-dml.json')
    benchmark = load(OUT/'perf/detector-gpu-idle.json')
    def detail(folder, configuration):
        det, age, scene, spread, steps, safety = [], [], [], [], [], []
        for path in sorted((SUITE/folder).glob(f'VALIDATION/{configuration}/*/episode.jsonl.gz')):
            last = None
            with gzip.open(path, 'rt', encoding='utf8') as stream:
                for line in stream:
                    r = json.loads(line);p = r.get('perception') or {}
                    if p.get('detector_ms') is not None and p.get('frame_id') != last:det.append(p['detector_ms']);last = p.get('frame_id')
                    if p.get('frame_id') is not None:age.append(r['frame']-p['frame_id'])
                    if (r.get('scene') or {}).get('build_ms') is not None:scene.append(r['scene']['build_ms'])
                    if r.get('sensors'):spread.append(max(v['after_first_ms'] for v in r['sensors'].values()))
                    steps.append(r['step_ms'])
                    if (r.get('control_timing_ms') or {}).get('safety') is not None:safety.append(r['control_timing_ms']['safety'])
        q = lambda a: {'median': round(float(np.median(a)), 1), 'p95': round(float(np.percentile(a, 95)), 1)} if a else None
        return {'frames': len(steps), 'distinct_detection_results': len(det), 'detector_ms': q(det),
                'detection_age_frames_at_control': q(age), 'scene_build_ms': q(scene), 'sensor_arrival_spread_ms': q(spread),
                'safety_ms': q(safety), 'harness_step_ms': q(steps)}
    result = {'task': 'SENSOR_TIMING_AND_PROCESSING_STALLS',
              'detector_equivalence_idle_engine': benchmark or {'status': 'MISSING'},
              'phase7_test_hold_frame_profile': hold_frame_profile('phase7-test-20261023', 'TEST'),
              'observation_to_control': {
                  'definition': 'scripts/summarize_native_performance.py (Phase 6): sensor_age_before_safety_ms + safety + actuator_submit',
                  'phase7_test_before': performance_digest(load(ROOT/'docs/evidence/sequential-repair-20261023/phase6-native-latency.json')),
                  'b_validation_cpu': performance_digest(load(REPRO/'perf-task3-cpu.json')),
                  'b_validation_dml': performance_digest(load(REPRO/'perf-task3-dml.json')),
                  'holdout_dml': performance_digest(load(REPRO/'perf-holdout.json'))},
              'b_cpu_vs_dml_validation': {
                  'specs': 'VALIDATION indices 0-9,13 + ordinary 0-1, configuration B, identical code path',
                  'cpu': {'folder': 'output/pedestrian-suite/task2-validation-20261023', **detail('task2-validation-20261023', 'B_PHYSICAL_PREDICTIVE'),
                          'summary': compact_summary(cpu).get('B_PHYSICAL_PREDICTIVE') if cpu else None},
                  'dml': {'folder': 'output/pedestrian-suite/task3-dml-validation-20261023', **detail('task3-dml-validation-20261023', 'B_PHYSICAL_PREDICTIVE'),
                          'summary': compact_summary(dml).get('B_PHYSICAL_PREDICTIVE') if dml else None}}}
    sync = load(REPRO/'eval-task3b-risk-sync.json');asynchronous = load(REPRO/'eval-task2c-validation.json')
    if sync and asynchronous:
        result['learned_risk_off_safety_path'] = {
            'specs': 'VALIDATION, configuration D, DML detector',
            'synchronous': {'folder': 'output/pedestrian-suite/task3b-risk-sync-dml-20261023',
                            **detail('task3b-risk-sync-dml-20261023', 'D_EVIDENCE_BUDGETED'),
                            'performance': rounded(sync['summary']['D_EVIDENCE_BUDGETED']['performance'])},
            'async_frame_bound': {'folder': 'output/pedestrian-suite/task2c-validation-dml-20261023',
                                  **detail('task2c-validation-dml-20261023', 'D_EVIDENCE_BUDGETED'),
                                  'performance': rounded(asynchronous['summary']['D_EVIDENCE_BUDGETED']['performance'])}}
    return result


def performance_digest(report):
    """Per-configuration wall-clock digest of a summarize_native_performance report."""
    if not report:return {'status': 'MISSING'}
    def pick(distribution):
        return {k: distribution[k] for k in ('n', 'median', 'p95')} if distribution else None
    return {configuration: {'episodes': item['episodes'], 'frames': item['frames'],
                            'real_time_factor_median': (item.get('real_time_factor') or {}).get('median'),
                            'observation_to_control_ms': pick(item['components_ms'].get('observation_to_control_ms')),
                            'harness_step_ms': pick(item['components_ms'].get('step.total_ms')),
                            'yolo_detector_ms': pick(item['components_ms'].get('yolo_detector_ms')),
                            'learned_risk_ms': pick(item['components_ms'].get('learned_risk_ms')),
                            'processing_deadline_holds': item['processing_deadline_holds'],
                            'stale_or_fault_frames': item['stale_or_fault_frames']}
            for configuration, item in report['by_configuration'].items()}


def prediction_digest(report):
    """Path-entry predictor scores on closed-loop logs, with the constant and kinematic baselines."""
    if not report:return {'status': 'MISSING'}
    def scores(horizons):
        return {h: rounded({**{k: m.get(k) for k in ('n', 'positives', 'auroc', 'auprc', 'brier', 'ece')},
                            **{k: (m.get('at_threshold') or {}).get(k) for k in ('precision', 'recall', 'f1', 'false_positive_rate',
                                                                                  'false_negative_rate')},
                            **{k: (m.get('events') or {}).get(k) for k in ('entering_walkers', 'missed_entries', 'non_entering_walkers',
                                                                            'false_crossing_alarms')}})
                for h, m in horizons.items()}
    return {'artifact': report.get('artifact'), 'admission': report.get('admission'), 'note': report.get('note'),
            'by_configuration': {configuration: {'samples': d['samples'], 'prediction_coverage': rounded(d['prediction_coverage']),
                                                 'label_counts': d['label_counts'], 'model': scores(d['model']),
                                                 'baselines': {name: {h: rounded({k: m.get(k) for k in ('auroc', 'auprc', 'brier', 'ece')})
                                                                      for h, m in horizons.items()}
                                                               for name, horizons in d['baselines'].items()}}
                                 for configuration, d in report['datasets'].items()}}


def counterfactual_divergence(folder, split):
    """First frame where the two arms of each counterfactual pair differ before the decision time.

    Measured track sets (vehicle-frame positions at 0.1 m), applied commands
    (0.05) and ego positions (0.25 m) are compared frame by frame. Evaluator
    truth is used only for the scripted walker check.
    """
    from backend.learning.path_entry_dataset import load_episode
    root = SUITE/folder/split
    if not root.exists():return {'status': 'MISSING', 'folder': str(root)}
    result = []
    for configuration in sorted(p for p in root.iterdir() if p.is_dir()):
        arms = {}
        for path in configuration.glob('*/manifest.json'):
            counterfactual = ((load(path) or {}).get('spec') or {}).get('counterfactual')
            if counterfactual:arms.setdefault(counterfactual['pair_id'], {})[counterfactual['arm']] = path.parent
        for pair_id, by_arm in sorted(arms.items()):
            if len(by_arm) != 2:
                result.append({'configuration': configuration.name, 'pair_id': pair_id[:16], 'status': 'INCOMPLETE_PAIR'});continue
            (arm_a, dir_a), (arm_b, dir_b) = sorted(by_arm.items())
            manifest, rows_a, _ = load_episode(dir_a);_, rows_b, _ = load_episode(dir_b)
            decision = manifest['spec']['counterfactual']['decision_s']
            prefix_a = [r for r in rows_a if r['elapsed_s'] < decision-1e-6];prefix_b = [r for r in rows_b if r['elapsed_s'] < decision-1e-6]
            def tracks(row):
                return {str(t['id']): (round(t['position_m'][0], 1), round(t['position_m'][1], 1))
                        for t in (row.get('scene') or {}).get('tracks') or ()}
            def walker(row):
                return next((a['position_m'][:2] for a in row['evaluator_truth'] if a['role'] == 'ped_0'), None)
            first = {'measured_tracks': None, 'applied_command': None, 'ego_position': None, 'scripted_walker': None,
                     'applied_command_any': None, 'ego_position_any': None, 'ego_speed_any': None, 'ego_gear': None}
            for a, b in zip(prefix_a, prefix_b):
                ta, tb = tracks(a), tracks(b)
                if first['measured_tracks'] is None and ta != tb:
                    first['measured_tracks'] = {'elapsed_s': a['elapsed_s'], 'only_in_' + arm_a: sorted(set(ta.items())-set(tb.items())),
                                                'only_in_' + arm_b: sorted(set(tb.items())-set(ta.items()))}
                ca, cb = a.get('applied_command') or {}, b.get('applied_command') or {}
                gap = max(abs(ca.get(k, 0.)-cb.get(k, 0.)) for k in ('throttle', 'brake', 'steering'))
                if first['applied_command'] is None and gap > .05:
                    first['applied_command'] = {'elapsed_s': a['elapsed_s'], arm_a: {k: ca.get(k) for k in ('throttle', 'brake')},
                                                arm_b: {k: cb.get(k) for k in ('throttle', 'brake')}}
                if first['applied_command_any'] is None and gap > 0.:
                    first['applied_command_any'] = {'elapsed_s': a['elapsed_s'], arm_a: {k: ca.get(k) for k in ('throttle', 'brake', 'steering')},
                                                    arm_b: {k: cb.get(k) for k in ('throttle', 'brake', 'steering')}}
                ego_gap = math.dist(a['ego']['position_m'][:2], b['ego']['position_m'][:2])
                if first['ego_position'] is None and ego_gap > .25:
                    first['ego_position'] = {'elapsed_s': a['elapsed_s']}
                if first['ego_position_any'] is None and ego_gap > 0.:
                    first['ego_position_any'] = {'elapsed_s': a['elapsed_s'], 'gap_m': ego_gap, 'commands_equal_so_far': first['applied_command_any'] is None}
                if first['ego_speed_any'] is None and a['ego']['speed_mps'] != b['ego']['speed_mps']:
                    first['ego_speed_any'] = {'elapsed_s': a['elapsed_s'], arm_a: a['ego']['speed_mps'], arm_b: b['ego']['speed_mps']}
                if first['ego_gear'] is None and a['ego'].get('gear') != b['ego'].get('gear'):
                    first['ego_gear'] = {'elapsed_s': a['elapsed_s'], arm_a: a['ego'].get('gear'), arm_b: b['ego'].get('gear')}
                wa, wb = walker(a), walker(b)
                if first['scripted_walker'] is None and wa and wb and math.dist(wa, wb) > .05:first['scripted_walker'] = {'elapsed_s': a['elapsed_s']}
            result.append(rounded({'configuration': configuration.name, 'pair_id': pair_id[:16], 'decision_s': decision,
                                   'compared_frames': min(len(prefix_a), len(prefix_b)), 'first_divergence': first,
                                   'log_resolution': 'positions and commands are logged at 1e-3 (1 mm, 0.001); "_any" fields mean any logged difference'}))
    return result


def queue_evidence(directory):
    """Stationary vehicles ahead in the planned lane during the final stop (evaluator truth only)."""
    manifest = json.loads((directory/'manifest.json').read_text(encoding='utf8'))
    rows = [json.loads(l) for l in gzip.open(directory/'episode.jsonl.gz', 'rt', encoding='utf8')]
    route = np.asarray(manifest['route'], float)[:, :2]
    cumulative = np.r_[0., np.cumsum(np.linalg.norm(np.diff(route, axis=0), axis=1))]
    def along(point):
        distances = np.linalg.norm(route-point, axis=1);i = int(np.argmin(distances))
        return float(cumulative[i]), float(distances[i])
    if not any(r['ego']['speed_mps'] < .15 for r in rows):return None
    # Longest contiguous stop of the episode.
    intervals, start = [], None
    for k, r in enumerate(rows+[{'ego': {'speed_mps': 1.}}]):
        if r['ego']['speed_mps'] < .15 and start is None:start = k
        elif r['ego']['speed_mps'] >= .15 and start is not None:intervals.append((start, k-1));start = None
    i, end = max(intervals, key=lambda p: rows[p[1]]['elapsed_s']-rows[p[0]]['elapsed_s'])
    final = rows[i:end+1]
    leads = []
    for r in final[::10]:
        ego_s, _ = along(np.asarray(r['ego']['position_m'][:2]))
        ahead = []
        for a in r['evaluator_truth']:
            if a['kind'] != 'vehicle' or a['role'] == 'occluder':continue
            s, lateral = along(np.asarray(a['position_m'][:2]))
            if lateral < 2.5 and 0. < s-ego_s < 40.:ahead.append((s-ego_s, float(np.linalg.norm(a['velocity_mps'][:2]))))
        leads.append(min(ahead) if ahead else None)
    moving_after = rows[end+1]['elapsed_s'] if end+1 < len(rows) else None
    # When the nearest in-lane vehicle ahead started moving (> 0.5 m/s), and when the
    # ego then exceeded 0.5 m/s: the measured response to a clearing queue.
    lead_moving = ego_moving = None
    for r in rows[i:]:
        if lead_moving is None:
            ego_s, _ = along(np.asarray(r['ego']['position_m'][:2]))
            ahead = []
            for a in r['evaluator_truth']:
                if a['kind'] != 'vehicle' or a['role'] == 'occluder':continue
                s, lateral = along(np.asarray(a['position_m'][:2]))
                if lateral < 2.5 and 0. < s-ego_s < 40.:ahead.append((s-ego_s, float(np.linalg.norm(a['velocity_mps'][:2]))))
            if ahead and min(ahead)[1] > .5:lead_moving = r['elapsed_s']
        elif r['ego']['speed_mps'] > .5:
            ego_moving = r['elapsed_s'];break
    middle = final[len(final)//2]
    return rounded({'longest_stop_start_s': rows[i]['elapsed_s'], 'longest_stop_s': rows[end]['elapsed_s']-rows[i]['elapsed_s'],
                    'remaining_m': (rows[end].get('route') or {}).get('remaining_m'),
                    'nearest_vehicle_ahead_in_lane_gap_speed': [l for l in leads if l][:3],
                    'lead_vehicle_stationary_fraction': (sum(1 for l in leads if l and l[1] < .2)/len(leads)) if leads else None,
                    'safety_reason_at_stop': (middle.get('safety') or {}).get('reason'),
                    'final_safety_reason': (rows[-1].get('safety') or {}).get('reason'),
                    'predicted_person_check': predicted_person_check(middle),
                    'ego_resumed_at_s': moving_after, 'lead_vehicle_moving_at_s': lead_moving,
                    'ego_above_0_5_mps_after_lead_at_s': ego_moving,
                    'ego_response_after_lead_s': ego_moving-lead_moving if ego_moving is not None and lead_moving is not None else None})


def predicted_person_check(row):
    """Is the person RULE braked for a real walker? Nearest evaluator walker and vehicle to that track."""
    prediction = (row.get('safety') or {}).get('pedestrian_prediction') or {}
    track = next((t for t in (row.get('scene') or {}).get('tracks', ()) if str(t['id']) == str(prediction.get('track_id'))), None)
    if track is None:return None
    yaw = row['ego']['yaw_rad'];ego = np.asarray(row['ego']['position_m'][:2])
    local = np.asarray(track['position_m'][:2])
    world = ego+np.array([local[0]*math.cos(yaw)-local[1]*math.sin(yaw), local[0]*math.sin(yaw)+local[1]*math.cos(yaw)])
    def nearest(kind):
        distances = [float(np.linalg.norm(np.asarray(a['position_m'][:2])-world)) for a in row['evaluator_truth'] if a['kind'] == kind]
        return min(distances) if distances else None
    return {'track_id': prediction.get('track_id'), 'source': prediction.get('source'), 'track_vehicle_frame_m': local.tolist(),
            'track_class': track.get('class'), 'nearest_true_walker_m': nearest('walker'), 'nearest_true_vehicle_m': nearest('vehicle')}


def task4():
    root = SUITE/'phase7-test-20261023/TEST'
    cases = []
    if root.exists():
        for directory in sorted(root.glob('*/*')):
            outcome = load(directory/'outcome.json') or {}
            if outcome.get('behavior') not in ('MIXED_TRAFFIC', 'ORDINARY_CITY_JOURNEY') or outcome.get('outcome') == 'ARRIVED':continue
            entry = {'configuration': outcome['configuration'], 'behavior': outcome['behavior'],
                     'route': f"{outcome['location']['town']}:{outcome['location']['spawn_index']}", 'outcome': outcome['outcome'],
                     'simulated_s': outcome.get('simulated_s'), 'detail': (outcome.get('last_drive_stop') or {}).get('detail')}
            if outcome['outcome'] == 'TIMEOUT':
                try:entry['final_stop'] = queue_evidence(directory)
                except (OSError, ValueError, KeyError, StopIteration) as error:entry['final_stop_error'] = str(error)
            cases.append(entry)
    classified = load(REPRO/'classify-phase7-test.json')
    return {'task': 'MIXED_TRAFFIC_AND_ROUTE_COMPLETION', 'source': 'phase7 TEST logs (evaluator truth used offline only)',
            'failures': cases, 'stall_classifier_phase7_test': {k: classified[k] for k in ('stops_by_cause', 'stationary_s_by_cause')} if classified else None}


def task2():
    initial = load(REPRO/'eval-task2-validation.json');final = load(REPRO/'eval-task2c-validation.json')
    return {'task': 'UNNECESSARY_PEDESTRIAN_BRAKING',
            'v2_initial_cpu_detector': {'folder': 'output/pedestrian-suite/task2-validation-20261023',
                                        'note': 'Time-indexed layer before the hysteresis fixes; CPU detector (processing-deadline holds present)',
                                        'summary': compact_summary(initial), 'paired': rounded((initial or {}).get('paired'))},
            'superseded_runs': ['output/pedestrian-suite/task2b-validation-dml-20261023-failed-async-snapshot (async risk snapshot '
                                'raised on native mappingproxy fields -> SENSOR_FAULT at 0.25 s; fixed, fail-closed)',
                                'output/pedestrian-suite/task2c-superseded-D-hysteresis-20261023 (2 D episodes before the hazard/no-conflict '
                                'hysteresis fix)'],
            'final_dml_detector': {'folder': 'output/pedestrian-suite/task2c-validation-dml-20261023',
                                   'summary': compact_summary(final), 'paired': rounded((final or {}).get('paired')),
                                   'worker_logged_failures': worker_failures('task2c-validation-dml-20261023'),
                                   'episodes': episode_rows(final)}}


def worker_failures(folder):
    """Non-arrival episodes that carry an explicit error in the harness worker logs."""
    failures = []
    for log in sorted((SUITE/folder).glob('worker-*.log')):
        for line in log.read_text(encoding='utf8', errors='replace').splitlines():
            start = line.find('{"scenario_id"')
            if start < 0:continue
            try:record = json.loads(line[start:])
            except ValueError:continue
            if record.get('error'):
                failures.append({'scenario_id': record['scenario_id'][:16], 'configuration': record.get('configuration'),
                                 'behavior': record.get('behavior'), 'outcome': record.get('outcome'), 'error': record['error'], 'log': log.name})
    return failures


def condition_hash_differences(folder, split, evaluation):
    """Manifest fields that differ across configurations where the condition hash differs."""
    ignored = {'admission', 'risk_model_status', 'condition_hash'}
    def paths(value, prefix=''):
        if isinstance(value, dict):
            return {p: v for k, item in value.items() if not (prefix == '' and k in ignored) for p, v in paths(item, f'{prefix}/{k}').items()}
        if isinstance(value, list):
            return {p: v for i, item in enumerate(value) for p, v in paths(item, f'{prefix}[{i}]').items()}
        return {prefix: value}
    result = []
    for entry in (evaluation or {}).get('initial_conditions', ()):
        if entry.get('identical_condition_hash'):continue
        flattened = {}
        for manifest in sorted((SUITE/folder/split).glob(f"*/{entry['scenario_id'][:16]}/manifest.json")):
            flattened[manifest.parent.parent.name] = paths(json.loads(manifest.read_text(encoding='utf8')))
        keys = set().union(*flattened.values()) if flattened else set()
        differing = sorted(k for k in keys if len({json.dumps(f.get(k), sort_keys=True) for f in flattened.values()}) > 1)
        result.append({'scenario_id': entry['scenario_id'][:16], 'behavior': entry.get('behavior'),
                       'configurations': sorted(flattened), 'differing_fields': differing})
    return result


def paired_episode_deltas(evaluation, folder, split, configuration='D_EVIDENCE_BUDGETED', baseline='B_PHYSICAL_PREDICTIVE'):
    """Per-episode configuration-minus-baseline differences, largest braking difference first."""
    locations = {}
    for outcome in (SUITE/folder/split/baseline).glob('*/outcome.json'):
        location = (load(outcome) or {}).get('location') or {}
        locations[outcome.parent.name] = f"{str(location.get('town', '')).replace('_Opt', '')}:{location.get('spawn_index')}"
    episodes = {}
    for m in (evaluation or {}).get('episode_metrics', ()):
        if 'log_error' in m:continue
        episodes.setdefault((m['scenario_id'][:16], m.get('counterfactual')), {})[m['configuration']] = m
    rows = []
    for (scenario, arm), by_configuration in episodes.items():
        if configuration not in by_configuration or baseline not in by_configuration:continue
        a, b = by_configuration[configuration], by_configuration[baseline]
        rows.append(rounded({'behavior': b['behavior'], 'location': locations.get(scenario), 'counterfactual_arm': arm,
                             'outcomes': {baseline: b['outcome'], configuration: a['outcome']},
                             'unnecessary_braking_events': a['unnecessary_braking_events']-b['unnecessary_braking_events'],
                             'unnecessary_full_stops': a['unnecessary_full_stops']-b['unnecessary_full_stops'],
                             'unnecessary_stationary_s': a['unnecessary_stationary_s']-b['unnecessary_stationary_s']}))
    return sorted(rows, key=lambda r: (-r['unnecessary_braking_events'], -r['unnecessary_stationary_s']))


def task5():
    holdout = load(REPRO/'eval-holdout.json');rescored = load(REPRO/'eval-phase7-test-rescored.json')
    partition = load(ROOT/'config/pedestrian-holdout-partition.json') or {}
    lockstep = load(REPRO/'eval-task5-lockstep.json');repeat = load(REPRO/'eval-task5-lockstep-repeat.json')
    comfort = None
    if rescored:
        comfort = {configuration: rounded({'speed_signal_max_deceleration_median': s['maximum_deceleration_mps2']['median'],
                                           'position_derived_max_deceleration_median': s['maximum_deceleration_mps2'].get('position_derived_median'),
                                           'deceleration_p95_median': s.get('deceleration_p95_mps2_median'),
                                           'hard_braking_s': s.get('hard_braking_s')})
                   for configuration, s in rescored['summary'].items()}
    def runs_identical(a, b):
        if not a or not b:return None
        pairs = {(p.get('pair_id'), p.get('configuration')): p for p in a.get('counterfactual_pairs', ())}
        result = []
        for p in b.get('counterfactual_pairs', ()):
            q = pairs.get((p.get('pair_id'), p.get('configuration')))
            if q:result.append({'configuration': p.get('configuration'), 'run1_identical_prefix': q.get('observable_prefix_identical_within_tolerance'),
                                'run2_identical_prefix': p.get('observable_prefix_identical_within_tolerance')})
        return result
    return {'task': 'EXPERIMENTAL_VALIDITY',
            'background_determinism': {
                'root_cause': 'Background population was applied before the first tick of the episode, so placement scoring used the '
                              'previous episode route (provider publishes the route on tick); the first configuration of each '
                              'scenario (A) therefore differed. Fixed in PedestrianBehaviorWorld.prepare_background.',
                'phase7_test_before': [rounded({k: r[k] for k in ('scenario_id', 'behavior', 'background_population_differs',
                                                                    'background_vehicles_differ') if k in r})
                                       for r in (rescored or {}).get('initial_conditions', ()) if r.get('background_walkers') or r.get('background_vehicles')],
                'holdout_after': [rounded({k: r[k] for k in ('scenario_id', 'behavior', 'identical_condition_hash',
                                                               'identical_physical_construction', 'ego_initial_spread_m',
                                                               'scripted_walker_initial_spread_m', 'background_population_differs',
                                                               'background_vehicles_differ', 'traffic_lights', 'perception_timing',
                                                               'unrealized_walkers') if k in r})
                                  for r in (holdout or {}).get('initial_conditions', ())]},
            'counterfactual_prefixes': {'mode': 'LOCKSTEP camera semantics (stride 2, one-frame delay) for counterfactual arms only',
                                        'run1': rounded((lockstep or {}).get('counterfactual_pairs')),
                                        'run2_repeat': rounded((repeat or {}).get('counterfactual_pairs')),
                                        'run_to_run': runs_identical(lockstep, repeat),
                                        'holdout': rounded((holdout or {}).get('counterfactual_pairs')),
                                        'respawn_gear_fix_verification': {
                                            'change': 'scripts/native/run_pedestrian_suite.py reset_ego: carried-over observation set to neutral after respawn',
                                            'run1': {'folder': 'output/pedestrian-suite/task5-lockstep-cf-20261023f-gear-fix',
                                                     'pairs': rounded((load(REPRO/'eval-task5-gear-fix.json') or {}).get('counterfactual_pairs'))},
                                            'run2_repeat': {'folder': 'output/pedestrian-suite/task5-lockstep-cf-20261023f-gear-fix-repeat',
                                                            'pairs': rounded((load(REPRO/'eval-task5-gear-fix-repeat.json') or {}).get('counterfactual_pairs'))},
                                            'first_divergence_run1': counterfactual_divergence('task5-lockstep-cf-20261023f-gear-fix', 'VALIDATION'),
                                            'first_divergence_run2': counterfactual_divergence('task5-lockstep-cf-20261023f-gear-fix-repeat', 'VALIDATION')},
                                        'first_divergence': {
                                            'validation_run1': counterfactual_divergence('task5-lockstep-cf-20261023e', 'VALIDATION'),
                                            'validation_run2_repeat': counterfactual_divergence('task5-lockstep-cf-20261023e-repeat', 'VALIDATION'),
                                            'holdout': counterfactual_divergence('holdout-final-20261023', 'HOLDOUT')}},
            'comfort_metric_validation': {'source': 'phase7 TEST logs rescored', 'by_configuration': comfort,
                                          'conclusion': 'Position-derived maximum deceleration agrees with the speed-signal value; the '
                                                        '>15 m/s2 peaks are real CARLA full-brake events at low speed, not a measurement '
                                                        'artifact. p95 deceleration and hard-braking time are reported as robust statistics.'},
            'holdout_partition': {k: partition.get(k) for k in ('id', 'split', 'probe_sha256', 'suite_sha256', 'independence',
                                                                 'traffic_time_limit_s', 'locations')},
            'holdout_evaluation': {'folder': 'output/pedestrian-suite/holdout-final-20261023', 'summary': compact_summary(holdout),
                                   'paired': rounded((holdout or {}).get('paired')), 'superiority': rounded((holdout or {}).get('superiority')),
                                   'by_behavior': rounded((holdout or {}).get('by_behavior')), 'episodes': episode_rows(holdout),
                                   'performance': performance_digest(load(REPRO/'perf-holdout.json')),
                                   'prediction': prediction_digest(load(REPRO/'holdout-prediction.json')),
                                   'worker_logged_failures': worker_failures('holdout-final-20261023'),
                                   'condition_hash_differences': condition_hash_differences('holdout-final-20261023', 'HOLDOUT', holdout),
                                   'paired_d_minus_b_by_episode': paired_episode_deltas(holdout, 'holdout-final-20261023', 'HOLDOUT'),
                                   'paired_e_minus_b_by_episode': paired_episode_deltas(holdout, 'holdout-final-20261023', 'HOLDOUT',
                                                                                        configuration='E_PHYSICAL_ABLATION')}}


def differs_from_commit(report_path, hashes, commit='ae7e9e1'):
    """Archived source files of a native report whose content differs from ``commit``.

    The validator archives the exact source bytes (``source.zip``). Working
    files can have mixed line endings, so both sides are compared with LF line
    endings. Without the archive, only an exact LF/CRLF hash match is possible.
    """
    import hashlib
    import subprocess
    import zipfile
    archive = Path(report_path).parent/'source.zip'
    stored = zipfile.ZipFile(archive) if archive.exists() else None
    differing = []
    for path in sorted(hashes or ()):
        name = path.replace('\\', '/')
        shown = subprocess.run(['git', 'show', f'{commit}:{name}'], cwd=ROOT, capture_output=True)
        if shown.returncode:differing.append(name+' (absent at '+commit+')');continue
        lf = shown.stdout.replace(b'\r\n', b'\n')
        if stored is not None and name in stored.namelist():
            same = stored.read(name).replace(b'\r\n', b'\n') == lf
        else:
            same = hashes[path] in (hashlib.sha256(lf).hexdigest(), hashlib.sha256(lf.replace(b'\n', b'\r\n')).hexdigest())
        if not same:differing.append(name)
    return {'method': 'ARCHIVED_SOURCE_LF' if stored is not None else 'HASH_ONLY', 'files': differing}


def task6(crossing_reports, tests, notes=None):
    from scripts.crossing_user_acceptance import evaluate_user_plan
    pairs = []
    for path in crossing_reports:
        report = load(path)
        if not report:pairs.append({'report': str(path), 'status': 'MISSING'});continue
        pair = report.get('pair') or {};runs = pair.get('runs') or {};validation = pair.get('scenario_validation') or {}
        review = evaluate_user_plan(report);prediction = review['prediction'];strict = report.get('critical_prediction_evidence') or {}
        pairs.append({'report': str(path), 'seed': report.get('seed'), 'first': report.get('first_mode'),
                      'source_files_differing_from_ae7e9e1': differs_from_commit(path, report.get('source_hashes')),
                      'scenario_id': validation.get('scenario_id'), 'scenario_validation_passed': validation.get('passed'),
                      'gates': validation.get('gates'), 'conditions_match': pair.get('conditions_match'),
                      'runs': {mode: {k: (r or {}).get(k) for k in ('status', 'reason', 'duration_s', 'distance_m')}
                               for mode, r in runs.items()},
                      'peak_speed_kmh': {mode: max((s.get('speed_kmh', 0.) for s in report.get('samples', ()) if s.get('mode') == mode), default=None)
                                         for mode in runs},
                      'lifecycle': {k: report.get(k) for k in ('source_unchanged', 'completed_without_shortening', 'finish_completed',
                                                               'cleanup_confirmed', 'simulator_exit_confirmed')},
                      'independent_cleanup_passed': (report.get('independent_cleanup_probe') or {}).get('passed'),
                      'videos_after_exit_passed': (report.get('video_playback_after_exit') or {}).get('passed'),
                      'user_plan_review': rounded({'policy': review['policy'], 'passed': review['passed'], 'gates': review['gates'],
                                                   'first_forecast': prediction.get('first_forecast'),
                                                   'first_path_ingress_elapsed_s': prediction.get('first_path_ingress_elapsed_s'),
                                                   'path_ingress_lead_s': prediction.get('path_ingress_lead_s')}),
                      'strict_first_motion': rounded({k: strict.get(k) for k in ('first_critical_braking_forecast', 'native_first_motion_elapsed_s',
                                                                                 'predicted_before_actual_motion', 'braked_from_at_least_20_kmh')}),
                      'strict_native_acceptance': report.get('native_acceptance'), 'wall_s': rounded(report.get('wall_s')),
                      'native_worker_exit_code': report.get('native_worker_exit_code'),
                      'note': (notes or {}).get(Path(path).parent.name),
                      'error': report.get('error')})
    def backend_version(pair):
        files = pair['source_files_differing_from_ae7e9e1']['files']
        if not any(f.startswith('backend/') for f in files):return 'ae7e9e1'
        reverted = [f for f in LIVE_PATH_FILES if f not in files]
        return 'branch' if not reverted else 'branch, at ae7e9e1: '+', '.join(reverted)
    summary = {}
    for pair in pairs:
        if pair.get('status') == 'MISSING':continue
        pair['backend_version'] = backend_version(pair)
        key = f"seed {pair['seed']} {pair['first']} first | {pair['backend_version']}"
        entry = summary.setdefault(key, {'runs': 0, 'scenario_validation_passed': 0, 'predictive_braking_before_ingress': 0,
                                         'lifecycle_gates_all_passed': 0, 'strict_native_acceptance': 0})
        gates = pair['user_plan_review']['gates']
        entry['runs'] += 1
        entry['scenario_validation_passed'] += bool(pair['scenario_validation_passed'])
        entry['predictive_braking_before_ingress'] += bool(gates.get('predictive_braking_before_ingress'))
        entry['lifecycle_gates_all_passed'] += all(v for k, v in gates.items()
                                                   if k not in ('actual_scenario_outcomes', 'predictive_braking_before_ingress'))
        entry['strict_native_acceptance'] += bool(pair['strict_native_acceptance'])
    return {'task': 'FINAL_ADMISSION_AND_INTEGRATION', 'offline_tests': tests,
            'production_replay_digest': [
                {'run': 'runs/normal_city/run_55f3028020ae4f449f4dceaaf9b7efc3', 'frames': 150,
                 'ae7e9e1_modules': '439ab4f0f8b2bd7dc87472177a8e6183ea0894b3d30668a3268c1de4b1737ccc',
                 'this_branch': '439ab4f0f8b2bd7dc87472177a8e6183ea0894b3d30668a3268c1de4b1737ccc'},
                {'run': 'runs/normal_city/run_84c1fa1a0a304ec9adb3d51c929146fd (native crossing pair, Ya Rab Ostorha arm)', 'frames': 709,
                 'ae7e9e1_modules': 'cc7d0b9e8cce07793e6766a47878f649f06983115980abefe6c1085eee074174',
                 'this_branch': 'cc7d0b9e8cce07793e6766a47878f649f06983115980abefe6c1085eee074174'}],
            'original_crossing_comparison_summary': summary,
            'original_crossing_comparison': pairs}


LIVE_PATH_FILES = ('backend/core/service.py', 'backend/carla/provider.py', 'backend/computer_vision/worker.py',
                   'backend/computer_vision/service.py', 'backend/computer_vision/detector.py')


def main():
    parser = argparse.ArgumentParser();parser.add_argument('--tasks', default='1,2,3,4,5')
    parser.add_argument('--crossing-report', action='append', default=[], help='validate_crossing_pair report.json (Task 6)')
    parser.add_argument('--crossing-notes', default=None, help='JSON file: crossing-pairs folder id -> run condition note (Task 6)')
    parser.add_argument('--tests', default=None, help='JSON object, or a JSON file, with offline test results (Task 6)')
    args = parser.parse_args()
    tests = None
    if args.tests:tests = load(args.tests) if Path(args.tests).is_file() else json.loads(args.tests)
    notes = load(args.crossing_notes) if args.crossing_notes else None
    EVIDENCE.mkdir(parents=True, exist_ok=True)
    builders = {'1': ('task1-corner-deadlocks.json', task1), '2': ('task2-pedestrian-braking.json', task2),
                '3': ('task3-timing.json', task3), '4': ('task4-route-completion.json', task4),
                '5': ('task5-validity-and-holdout.json', task5),
                '6': ('task6-integration.json', lambda: task6(args.crossing_report, tests))}
    for key in args.tasks.split(','):
        name, build = builders[key]
        (EVIDENCE/name).write_text(json.dumps(build(), indent=1), encoding='utf8')
        print(json.dumps({'written': str(EVIDENCE/name)}))
    return 0


if __name__ == '__main__':sys.exit(main())
