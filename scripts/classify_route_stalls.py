"""Classify every stationary interval of native harness episodes (evaluator side, after driving).

Each stop of at least ``--min-stop-s`` is assigned one cause from the logged
safety/navigation state, the stop-frame coverage dumps (measured grid probed
along the supervised path, the steering arc and the route-tracker path) and
independent evaluator truth (native actor poses, never a controller input):

  ARRIVAL_STOP                    final stop of an arrived journey
  TRAFFIC_SIGNAL                  route controller stopped for a light/sign
  SENSOR_OR_PROCESSING            freshness/processing holds or faults
  LEGITIMATE_TRAFFIC_BLOCKAGE     a vehicle is inside the route corridor ahead
  PEDESTRIAN_HAZARD               pedestrian braking while a walker is in or enters the corridor within 3 s
  EXCESSIVE_PEDESTRIAN_CAUTION    pedestrian braking without such a walker
  ARTIFICIAL_PROBE_DEADLOCK       probe blocked while the route path has measured clearance
  OFF_ROUTE_ALIGNMENT             the car stopped more than 1 m off its planned lane (steering defect)
  UNOBSERVED_SPACE_ON_ROUTE       route path enters unmeasured space within the stopping clearance
  PHYSICAL_OBSTACLE_IN_CORRIDOR   route path blocked by a measured surface with an actor there
  OCCUPIED_ON_ROUTE_STATIC        route path blocked by a measured surface with no actor there
  NAVIGATION_HOLD                 the base driver itself braked
  UNCLASSIFIED
"""
import argparse
import collections
import gzip
import json
from pathlib import Path
import sys
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.core.pedestrian_behaviors import project_polyline  # noqa: E402

PEDESTRIAN_WORDS = ('person who may cross', 'Evidence budget', 'Protective braking', 'crossing limit', 'speculative')
RELEASE_REASONS = ('Risk cleared; releasing', 'Holding measured clearance/TTC hysteresis', 'Release hysteresis',
                   'Observed forward stopping corridor is clear', 'Monitoring resumes')
CLEARANCE_M = 3.


def load(directory):
    manifest = json.loads((directory/'manifest.json').read_text(encoding='utf8'))
    outcome = json.loads((directory/'outcome.json').read_text(encoding='utf8'))
    with gzip.open(directory/'episode.jsonl.gz', 'rt', encoding='utf8') as stream:rows = [json.loads(line) for line in stream]
    dumps = []
    for path in sorted((directory/'stops').glob('stop_*.npz')) if (directory/'stops').exists() else ():
        with np.load(path) as data:dumps.append(json.loads(str(data['meta'])))
    return manifest, outcome, rows, dumps


def corridor_actors(row, route, ego_s, half_width, front, horizon_m=20.):
    """Evaluator: actors inside the planned route corridor ahead of the ego front."""
    found = []
    for actor in row.get('evaluator_truth') or ():
        s, d = project_polyline(np.asarray([actor['position_m'][:2]]), route)
        reach = half_width+max(actor['half_size_m'])
        if ego_s+front-1. <= s[0] <= ego_s+front+horizon_m and abs(d[0]) <= reach:
            found.append({'kind': actor['kind'], 'role': actor['role'], 'ahead_m': float(s[0]-ego_s-front),
                          'speed_mps': float(np.hypot(*actor['velocity_mps'][:2]))})
    return found


def walker_entering(rows, i, route, ego_s, half_width, front, horizon_s=3.):
    t0 = rows[i]['timestamp_s']
    for row in rows[i:]:
        if row['timestamp_s'] > t0+horizon_s:break
        if any(a['kind'] == 'walker' for a in corridor_actors(row, route, ego_s, half_width, front, horizon_m=30.)):return True
    return False


def classify_interval(rows, start, end, manifest, outcome, dumps, final):
    route = np.asarray(manifest['route'], float)[:, :2];front = float(manifest['ego_front_m']);half = float(manifest['corridor_half_width_m'])
    middle = rows[(start+end)//2];sample = rows[start:end+1]
    ego_s = float(project_polyline(np.asarray([middle['ego']['position_m'][:2]]), route)[0][0])
    # The holding cause is the reason on frames where a safety brake was applied;
    # release/hysteresis frames belong to the trigger that started them.
    trigger = None;attributed = []
    for k in range(max(0, start-40), end+1):
        r = rows[k];reason_r = str((r.get('safety') or {}).get('reason'))
        if not any(word in reason_r for word in RELEASE_REASONS):trigger = reason_r
        applied_r = r.get('applied_command') or {}
        if k >= start and applied_r.get('source') == 'SAFETY' and applied_r.get('brake', 0.) >= .2:
            attributed.append((trigger or reason_r, str((r.get('safety') or {}).get('status'))))
    if not attributed:attributed = [(str((r.get('safety') or {}).get('reason')), str((r.get('safety') or {}).get('status'))) for r in sample]
    reasons = collections.Counter(a[0] for a in attributed)
    statuses = collections.Counter(a[1] for a in attributed)
    navigation = collections.Counter(str((r.get('speed') or {}).get('navigation_stop_reason')) for r in sample)
    reason, _ = reasons.most_common(1)[0];status, _ = statuses.most_common(1)[0];nav, _ = navigation.most_common(1)[0]
    t0, t1 = sample[0]['timestamp_s'], sample[-1]['timestamp_s']
    stop_dumps = [d for d in dumps if t0-.5 <= d['timestamp_s'] <= t1+.5]
    probes = {}
    for d in stop_dumps:
        for name, p in d['probes'].items():probes.setdefault(name, []).append(p)
    def median_cov(name):
        values = [p['coverage_m'] for p in probes.get(name, ())]
        return float(np.median(values)) if values else None
    route_cov = median_cov('route_tracker');supervised = [d['safety'].get('observed_road_range_m') for d in stop_dumps]
    supervised = float(np.median([v for v in supervised if v is not None])) if any(v is not None for v in supervised) else None
    route_fail = next((p['first_failure'] for p in probes.get('route_tracker', ()) if p['first_failure']), None)
    cross = [abs(d['tracker']['rear_axle_cross_track_m']) for d in stop_dumps
             if (d.get('tracker') or {}).get('rear_axle_cross_track_m') is not None]
    cross_track = float(np.median(cross)) if cross else None
    actors = corridor_actors(middle, route, ego_s, half, front)
    applied = sample[len(sample)//2].get('applied_command') or {};base = sample[len(sample)//2].get('base_command') or {}
    evidence = {'start_s': round(sample[0]['elapsed_s'], 2), 'duration_s': round(t1-t0, 2),
                'remaining_m': (middle.get('route') or {}).get('remaining_m'), 'reason': reason, 'status': status,
                'navigation_stop_reason': nav, 'supervised_coverage_m': supervised, 'route_path_coverage_m': route_cov,
                'steering_arc_coverage_m': median_cov('steering_arc'), 'straight_coverage_m': median_cov('straight'),
                'route_path_first_failure': route_fail, 'corridor_actors': actors[:4], 'stop_dumps': len(stop_dumps),
                'rear_axle_cross_track_m': cross_track, 'braking_reasons': dict(reasons.most_common(4)),
                'coverage_probe': (middle.get('safety') or {}).get('coverage_probe')}
    if final and outcome.get('outcome') == 'ARRIVED':return 'ARRIVAL_STOP', evidence
    if 'traffic light' in nav.lower() or 'stop sign' in nav.lower():return 'TRAFFIC_SIGNAL', evidence
    if status in ('SENSOR_DELAY_HOLD', 'SENSOR_FAULT_STOP') or 'PROCESSING_DEADLINE' in reason:return 'SENSOR_OR_PROCESSING', evidence
    if any(a['kind'] == 'vehicle' for a in actors):return 'LEGITIMATE_TRAFFIC_BLOCKAGE', evidence
    if any(w in reason for w in PEDESTRIAN_WORDS):
        entering = walker_entering(rows, start, route, ego_s, half, front)
        evidence['walker_in_or_entering_corridor_3s'] = entering
        return ('PEDESTRIAN_HAZARD' if entering else 'EXCESSIVE_PEDESTRIAN_CAUTION'), evidence
    if supervised is not None and route_cov is not None and supervised < CLEARANCE_M+.5 and route_cov >= CLEARANCE_M+1.:
        return 'ARTIFICIAL_PROBE_DEADLOCK', evidence
    if cross_track is not None and cross_track > 1.:
        # The vehicle left its planned lane before stopping (steering/alignment).
        return 'OFF_ROUTE_ALIGNMENT', evidence
    if route_cov is not None and route_cov < CLEARANCE_M+1. and route_fail:
        if route_fail['occupied_samples']:
            return ('PHYSICAL_OBSTACLE_IN_CORRIDOR' if actors else 'OCCUPIED_ON_ROUTE_STATIC'), evidence
        return 'UNOBSERVED_SPACE_ON_ROUTE', evidence
    if actors:return 'PHYSICAL_OBSTACLE_IN_CORRIDOR', evidence
    if base.get('brake', 0.) > .5 and applied.get('source') == 'NAVIGATION':return 'NAVIGATION_HOLD', evidence
    return 'UNCLASSIFIED', evidence


def episode_stops(directory, min_stop_s):
    manifest, outcome, rows, dumps = load(directory)
    stops = [];i = 0;n = len(rows)
    while i < n:
        if rows[i]['ego']['speed_mps'] < .15 and rows[i]['elapsed_s'] > 1.:
            j = i
            while j+1 < n and rows[j+1]['ego']['speed_mps'] < .15:j += 1
            if rows[j]['timestamp_s']-rows[i]['timestamp_s'] >= min_stop_s or j == n-1:
                cause, evidence = classify_interval(rows, i, j, manifest, outcome, dumps, final=j == n-1)
                stops.append({'cause': cause, **evidence})
            i = j+1
        else:i += 1
    return {'directory': str(directory).replace('\\', '/'), 'scenario_id': manifest['scenario_id'], 'behavior': manifest['behavior'],
            'configuration': (manifest.get('admission') or {}).get('configuration'), 'location': manifest['spec']['location'],
            'outcome': outcome.get('outcome'), 'simulated_s': outcome.get('simulated_s'), 'distance_m': outcome.get('distance_m'),
            'stops': stops}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--roots', required=True);parser.add_argument('--out', required=True)
    parser.add_argument('--min-stop-s', type=float, default=2.)
    args = parser.parse_args()
    episodes = []
    for root in args.roots.split(','):
        for outcome in sorted(Path(root).rglob('outcome.json')):
            if (outcome.parent/'episode.jsonl.gz').exists() and (outcome.parent/'manifest.json').exists():
                episodes.append(episode_stops(outcome.parent, args.min_stop_s))
    totals = collections.Counter(s['cause'] for e in episodes for s in e['stops'])
    seconds = collections.Counter()
    for e in episodes:
        for s in e['stops']:seconds[s['cause']] += s['duration_s']
    report = {'source': 'LIVE_NATIVE_CARLA_HARNESS_LOGS_AND_STOP_DUMPS', 'episodes': len(episodes),
              'stops_by_cause': dict(totals), 'stationary_s_by_cause': {k: round(v, 2) for k, v in seconds.items()}, 'episode_stops': episodes}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, indent=1, default=float), encoding='utf8')
    for e in episodes:
        print(f"{e['configuration'][:1]} {e['behavior'][:20]:20} {e['location']['town'][:8]}:{e['location']['spawn_index']:<3} {e['outcome'][:24]:24} {e['distance_m']}m")
        for s in e['stops']:
            print(f"    {s['cause']:30} t{s['start_s']:6.1f} dur{s['duration_s']:6.1f} rem{s['remaining_m']} sup{s['supervised_coverage_m']} arc{s['steering_arc_coverage_m']} route{s['route_path_coverage_m']} | {s['reason'][:60]}")
    print(json.dumps({'stops_by_cause': report['stops_by_cause'], 'stationary_s_by_cause': report['stationary_s_by_cause']}))
    return 0


if __name__ == '__main__':sys.exit(main())
