"""Audit retained DEVELOPMENT queues; native actor truth is scoring-only."""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path

from backend.core.egypt_urban import source_fingerprint
from backend.core.recording_storage import open_recorded, stored_path
from backend.learning.egypt_budget import save_json


def front_queue(frame, roles):
    pose = frame['vehicle']['transform']
    x, y = pose['position_m'][:2]
    yaw = pose['rotation_rad']['yaw']
    rows = []
    for actor in frame['actors']:
        if not actor['class_name'].startswith('vehicle.'):
            continue
        ax, ay = actor['transform']['position_m'][:2]
        dx, dy = ax - x, ay - y
        along = dx * math.cos(yaw) + dy * math.sin(yaw)
        lateral = -dx * math.sin(yaw) + dy * math.cos(yaw)
        if 0. < along <= 45. and abs(lateral) <= 1.5:
            identity = actor['actor_id']
            rows.append({'actor_id': identity, 'initial_role': roles.get(identity),
                         'class_name': actor['class_name'], 'along_center_m': along,
                         'lateral_center_m': lateral, 'position_m': [ax, ay],
                         'speed_mps': math.hypot(*actor['linear_velocity_mps'][:2])})
    return sorted(rows, key=lambda row: row['along_center_m'])


def summarize(samples, frames, roles, window_s):
    if not math.isfinite(window_s) or window_s <= 0.:
        raise ValueError('A positive finite observation window is required')
    if not frames or not samples:
        raise ValueError('Native samples and recorded frames are required')
    final = frames[-1]
    end = final['timestamp_s']
    cutoff = end - window_s
    selected = [frame for frame in frames if cutoff <= frame['timestamp_s'] <= end]
    queue = front_queue(final, roles)
    if not queue:
        raise ValueError('No measured front-corridor vehicle; cannot infer a queue')
    lead = queue[0]
    observed = []
    nearest = 0
    for frame in selected:
        current = next((actor for actor in frame['actors'] if actor['actor_id'] == lead['actor_id']), None)
        if current is None:
            continue
        observed.append(current)
        front = front_queue(frame, roles)
        nearest += bool(front and front[0]['actor_id'] == lead['actor_id'])
    if not observed:
        raise ValueError('The final lead has no observation history')
    start = observed[0]['transform']['position_m'][:2]
    positions = [actor['transform']['position_m'][:2] for actor in observed]
    speeds = [math.hypot(*actor['linear_velocity_mps'][:2]) for actor in observed]
    rows = [sample for sample in samples if cutoff <= sample['timestamp_s'] <= end]
    if not rows:
        raise ValueError('No overlapping native sample evidence')
    scenario = rows[-1]['scenario']
    if not scenario or scenario.get('scenario_id') != 'EGYPT_URBAN_CHAOS_V1':
        raise ValueError('Egypt scenario evidence is required')
    events = {}
    for key in ('queue_lead', 'pass_obstacle_0'):
        event = scenario['events'][key]
        completed = [row for row in event['transitions'] if row['phase'] == 'COMPLETED'
                     and row['timestamp_s'] <= end]
        completion = completed[-1] if completed else None
        events[key] = {'status': event['status'], 'realized': event['realized'],
                       'measurements': event['measurements'],
                       'completed_transition': completion,
                       'completed_before_window': bool(event['status'] == 'COMPLETED'
                           and event['realized'] and completion
                           and completion['timestamp_s'] < selected[0]['timestamp_s'])}
    reasons = Counter((sample.get('stop') or {}).get('reason', 'NO_STOP_REASON') for sample in rows)
    stationary = []
    for frame in reversed(selected):
        actor = next((actor for actor in frame['actors'] if actor['actor_id'] == lead['actor_id']), None)
        if (actor is None or math.hypot(*actor['linear_velocity_mps'][:2]) > .1
                or frame['vehicle']['speed_mps'] > .1):
            break
        stationary.append(frame)
    stationary.reverse()
    return {
        'frame_id': final['frame_id'], 'timestamp_s': end,
        'observation_window': {'requested_s': window_s, 'recorded_start_s': selected[0]['timestamp_s'],
                               'recorded_end_s': end, 'frames': len(selected),
                               'native_samples': len(rows)},
        'ego_displacement_m': math.dist(selected[0]['vehicle']['transform']['position_m'][:2],
                                        final['vehicle']['transform']['position_m'][:2]),
        'final_front_queue': queue,
        'final_lead_history': {'actor_id': lead['actor_id'], 'observed_frames': len(observed),
                              'nearest_front_vehicle_frames': nearest,
                              'missing_frames': len(selected) - len(observed),
                              'maximum_displacement_from_first_m': max(math.dist(start, pos) for pos in positions),
                              'maximum_speed_mps': max(speeds)},
        'terminal_joint_stationary_observation': {
            'speed_threshold_mps': .1, 'frames': len(stationary),
            'duration_s': stationary[-1]['timestamp_s'] - stationary[0]['timestamp_s'] if stationary else 0.,
            'start_s': stationary[0]['timestamp_s'] if stationary else None,
            'end_s': stationary[-1]['timestamp_s'] if stationary else None,
            'limited_to_requested_window': len(stationary) == len(selected)},
        'scripted_events': events,
        'stop_reason_samples': dict(reasons),
        'final_density_audit': scenario['audit'],
        'interpretation': 'MEASURED_FRONT_VEHICLE_QUEUE_NOT_PROOF_OF_STUCK_SCRIPTED_HOLD',
        'unresolved': ['NPC controls and traffic-light phases are not in these actor rows',
                       'The physical cause of the downstream queue is not established',
                       'No absent actor is classified as destroyed from a local observation alone',
                       'Event completion proves its recorded stop/resumption, not continued traffic flow'],
        'runtime_policy_change_justified': False}


def artifact(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return {'path': str(path.resolve()), 'bytes': path.stat().st_size, 'sha256': digest.hexdigest()}


def audit(report_path, window_s):
    report_bytes = report_path.read_bytes()
    report = json.loads(report_bytes)
    if (report.get('scenario_id') != 'EGYPT_URBAN_CHAOS_V1'
            or report.get('seed') not in (1703, 2707, 3709)):
        raise ValueError('Only retained Egypt DEVELOPMENT evidence is allowed')
    run = report['pair']['runs']['NORMAL']
    root = Path(run['recording']).resolve()
    metadata = json.loads((root / 'metadata.json').read_text(encoding='utf-8-sig'))
    if (metadata['config']['seed_partition'] != 'DEVELOPMENT'
            or metadata['config']['scenario_seed'] != report['seed']
            or metadata['config']['driver_id'] != run['driver_id']):
        raise ValueError('Recording and native report provenance do not match')
    samples = [sample for sample in report['samples'] if sample['mode'] == 'NORMAL']
    if not samples:
        raise ValueError('No Normal native samples')
    roles = {actor['id']: actor['role'] for actor in report['pair']['manifest']['initial_conditions']['actors']}
    path = root / 'telemetry' / 'frames.jsonl'
    stored = stored_path(path)
    before = artifact(stored)
    frames = []
    previous = None
    with open_recorded(path, 'rt') as stream:
        for line in stream:
            frame = json.loads(line)
            if previous and (frame['frame_id'] <= previous[0] or frame['timestamp_s'] <= previous[1]):
                raise ValueError('Duplicate or unordered recorded observations')
            previous = frame['frame_id'], frame['timestamp_s']
            if samples[-1]['timestamp_s'] - window_s <= frame['timestamp_s'] <= samples[-1]['timestamp_s']:
                frames.append(frame)
    if not frames or (frames[-1]['frame_id'], frames[-1]['timestamp_s']) != (
            samples[-1]['frame'], samples[-1]['timestamp_s']):
        raise ValueError('Final native sample and recorded observation are not frame/time aligned')
    result = summarize(samples, frames, roles, window_s)
    if before != artifact(stored) or report_path.read_bytes() != report_bytes:
        raise ValueError('Evidence changed during audit')
    return {'native_report': artifact(report_path),
            'recording_metadata': artifact(root / 'metadata.json'),
            'recorded_frames': before, 'seed': report['seed'],
            'historical_source_sha256': report['source_sha256'],
            'recording': str(root), **result}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('native_reports', type=Path, nargs='+')
    parser.add_argument('--window-s', type=float, default=30.)
    parser.add_argument('--report', type=Path, required=True)
    args = parser.parse_args()
    fingerprint = source_fingerprint()
    report = {'scope': 'READ_ONLY_HISTORICAL_DEVELOPMENT_QUEUE_AUDIT',
              'native_acceptance': False, 'native_execution_performed': False,
              'current_source_sha256': fingerprint,
              'script': artifact(Path(__file__)),
              'findings': [audit(path, args.window_s) for path in args.native_reports]}
    if source_fingerprint() != fingerprint:
        raise ValueError('Current source changed during audit')
    save_json(args.report, report)
    print(json.dumps({'report': str(args.report), 'findings': [
        {'seed': finding['seed'], 'lead': finding['final_lead_history'],
         'events': finding['scripted_events']} for finding in report['findings']]}, indent=2))


if __name__ == '__main__':
    main()
