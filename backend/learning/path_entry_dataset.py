"""Offline path-entry dataset builder from harness episode logs (evaluator side).

Inputs to the model come only from each row's published ControlScene track,
measured ego speed and commanded steering through ``track_features``. Native
walker poses are used after the drive for association, labels and coverage.
Every relevant walker-frame keeps an explicit status; none are silently dropped.
"""
import gzip
import hashlib
import json
import math
from pathlib import Path
import numpy as np
from ..core.kinematic_prediction import kinematic_modes
from ..core.path_entry_features import STEPS, INPUT_SIZE, FEATURE_VERSION, corridor_coordinates, steering_curvature, track_features
from ..core.pedestrian_behaviors import path_entry_labels, project_polyline, load_suite

HORIZONS = (1, 2, 3)
STATUS_CODES = {'LABELED': 0, 'IN_PATH_AT_DECISION': 1, 'MISSING_FUTURE': 2, 'POST_CONTACT': 3}


def load_episode(directory):
    directory = Path(directory)
    manifest = json.loads((directory/'manifest.json').read_text(encoding='utf8'))
    outcome = json.loads((directory/'outcome.json').read_text(encoding='utf8'))
    with gzip.open(directory/'episode.jsonl.gz', 'rt', encoding='utf8') as stream:
        rows = [json.loads(line) for line in stream if line.strip()]
    return manifest, rows, outcome


def _local(points, origin, yaw):
    d = np.asarray(points, float)[:, :2]-np.asarray(origin, float)[:2]
    c, s = math.cos(yaw), math.sin(yaw)
    return np.column_stack((d[:, 0]*c+d[:, 1]*s, -d[:, 0]*s+d[:, 1]*c))


def physical_baselines(track, *, corridor_half_width_m, curvature, front_m):
    """Existing kinematic alternatives: CV entry time and any-alternative entry per horizon."""
    grid = np.round(np.arange(31)*.1, 6)
    modes = kinematic_modes([{**track, 'id': str(track['id']), 'class': track.get('class', 'UNKNOWN')}], grid=grid)
    half = max(track.get('half_size_m') or (.3, .3))
    cv_entry = math.inf;any_entry = {h: False for h in HORIZONS}
    for mode in modes:
        points = np.asarray(mode['points'], float)
        along, offset = corridor_coordinates(points[:, 1:3], curvature)
        inside = (np.abs(offset) <= corridor_half_width_m+half) & (along >= front_m) & (along <= front_m+60.)
        if inside[0]:continue
        if inside.any():
            first = float(points[np.argmax(inside), 0])
            if mode['source'] == 'CONSTANT_VELOCITY':cv_entry = min(cv_entry, first)
            for h in HORIZONS:any_entry[h] |= first <= h+1e-9
    return cv_entry, any_entry


def episode_samples(directory, *, label_config, stride_s=.1, relevance_m=50.):
    manifest, rows, outcome = load_episode(directory)
    route = np.asarray(manifest['route'], float)[:, :2];front = float(manifest['ego_front_m'])
    half_width = float(manifest['corridor_half_width_m'])
    length = float(label_config['corridor_length_m']);radius = float(label_config['association_radius_m'])
    times = np.array([r['timestamp_s'] for r in rows])
    ego_xy = np.array([r['ego']['position_m'][:2] for r in rows]);ego_s, _ = project_polyline(ego_xy, route)
    walkers = {}
    for i, row in enumerate(rows):
        for actor in row['evaluator_truth']:
            if actor['kind'] != 'walker':continue
            entry = walkers.setdefault(actor['id'], {'t': [], 'xy': [], 'role': actor['role'], 'half': max(actor['half_size_m'])})
            entry['t'].append(row['timestamp_s']);entry['xy'].append(actor['position_m'][:2])
    for entry in walkers.values():
        entry['t'] = np.asarray(entry['t']);entry['xy'] = np.asarray(entry['xy'])
        entry['s'], entry['d'] = project_polyline(entry['xy'], route)
    contacts = {}
    for contact in outcome.get('contacts') or ():
        contacts[contact['other_actor_id']] = min(contacts.get(contact['other_actor_id'], math.inf), contact['timestamp_s'])
    spec = manifest['spec'];scripts = {p['role']: p['script'] for p in spec['pedestrians']}
    realization = outcome.get('realization') or {}
    samples = [];coverage = {'relevant': 0, 'associated': 0, 'unobserved': 0, 'ambiguous': 0, 'scene_mismatch': 0,
                             'duplicate_tracks': 0}
    next_t = None
    for i, row in enumerate(rows):
        t = row['timestamp_s']
        if next_t is not None and t < next_t-1e-6:continue
        next_t = t+stride_s
        scene = row.get('scene')
        ego_pose = row['ego']['position_m'];yaw = row['ego']['yaw_rad']
        present = {wid: w for wid, w in walkers.items() if np.any(np.abs(w['t']-t) < 1e-6)}
        local_truth = {}
        for wid, w in present.items():
            k = int(np.argmin(np.abs(w['t']-t)))
            local_truth[wid] = _local(w['xy'][k:k+1], ego_pose, yaw)[0]
        relevant = {wid: p for wid, p in local_truth.items() if front < p[0] <= front+relevance_m and abs(p[1]) <= 20.}
        coverage['relevant'] += len(relevant)
        if not scene or scene.get('frame_id') != row['frame'] or not scene.get('motion_tracking_complete'):
            coverage['scene_mismatch'] += len(relevant);continue
        tracks = scene['tracks']
        positions = np.array([tr['position_m'][:2] for tr in tracks]) if tracks else np.zeros((0, 2))
        truth_ids = list(local_truth);truth_xy = np.array([local_truth[w] for w in truth_ids]) if truth_ids else np.zeros((0, 2))
        steering = (row.get('base_command') or {}).get('steering', row['ego']['steering'])
        curvature = steering_curvature(steering)
        for wid, p in relevant.items():
            distances = np.linalg.norm(positions-p, axis=1) if len(positions) else np.zeros(0)
            near = np.flatnonzero(distances <= radius)
            if not len(near):coverage['unobserved'] += 1;continue
            # One person may publish a depth-person track and a demoted geometry
            # track. Identity is ambiguous only when another walker competes.
            owned = [int(k) for k in near
                     if np.sum(np.linalg.norm(truth_xy-np.asarray(tracks[int(k)]['position_m'][:2]), axis=1) <= radius) == 1]
            if len(owned) != len(near):coverage['ambiguous'] += 1;continue
            coverage['associated'] += 1;coverage['duplicate_tracks'] += len(owned)-1
            w = walkers[wid];decision_front = float(ego_s[i])+front
            labels = path_entry_labels(t, decision_front, w['t'], w['s'], w['d'], radius_m=w['half'],
                corridor_half_width_m=half_width, corridor_length_m=length, horizons=HORIZONS, contact_t=contacts.get(wid))
            for k in owned:
                track = tracks[k]
                features = track_features(track, timestamp_s=scene['timestamp_s'], odometry_origin_m=scene['odometry_origin_m'],
                    odometry_yaw_rad=scene['odometry_yaw_rad'], ego_speed_mps=row['ego']['speed_mps'], steering=steering,
                    corridor_half_width_m=half_width, front_m=front, observation_age_s=max(0., t-scene['timestamp_s']))
                cv_entry, any_entry = physical_baselines(track, corridor_half_width_m=half_width, curvature=curvature, front_m=front)
                role = w['role']
                samples.append({'inputs': features['inputs'], 'labels': labels, 'cv_entry_s': cv_entry,
                    'physical_any_entry': [any_entry[h] for h in HORIZONS],
                    'meta': {'episode': Path(directory).name, 'scenario_id': manifest['scenario_id'], 'split': manifest['split'],
                             'behavior': manifest['behavior'], 'role': role, 'script': scripts.get(role, 'BACKGROUND'),
                             'realized': (realization.get(role) or {}).get('realized'), 'walker_id': wid, 'track_id': str(track['id']),
                             'timestamp_s': t, 'elapsed_s': row['elapsed_s'], 'ego_speed_mps': row['ego']['speed_mps'],
                             'track_class': track.get('class'), 'history_span_s': features['history_span_s'],
                             'duplicate': len(owned) > 1, 'counterfactual': (spec.get('counterfactual') or {}).get('arm'),
                             'configuration': (manifest.get('admission') or {}).get('configuration')}})
    return samples, coverage, {'scenario_id': manifest['scenario_id'], 'outcome': outcome.get('outcome'),
                               'realization': realization, 'rows': len(rows)}


def build_split(episode_dirs, out_path, *, split, suite=None):
    """Write X/y/status arrays and per-sample metadata; returns the summary."""
    suite = suite or load_suite();label_config = suite['label']
    inputs = [];labels = [];statuses = [];cv = [];physical = [];meta = [];episodes = []
    coverage = {'relevant': 0, 'associated': 0, 'unobserved': 0, 'ambiguous': 0, 'scene_mismatch': 0, 'duplicate_tracks': 0}
    for directory in sorted(episode_dirs):
        try:samples, counts, episode = episode_samples(directory, label_config=label_config, stride_s=label_config['sample_stride_s'])
        except (OSError, ValueError, KeyError) as error:
            episodes.append({'directory': str(directory), 'error': str(error)});continue
        if episode.get('scenario_id') and any(m['split'] != split for m in [s['meta'] for s in samples]):
            raise ValueError('Episode split differs from the requested dataset split')
        episodes.append({'directory': str(directory), **episode, 'samples': len(samples), 'coverage': counts})
        for key in coverage:coverage[key] += counts[key]
        for sample in samples:
            inputs.append(sample['inputs'])
            labels.append([sample['labels'][f'{h}s']['label'] if sample['labels'][f'{h}s']['label'] is not None else -1 for h in HORIZONS])
            statuses.append([STATUS_CODES[sample['labels'][f'{h}s']['status']] for h in HORIZONS])
            cv.append(sample['cv_entry_s']);physical.append(sample['physical_any_entry']);meta.append(sample['meta'])
    X = np.stack(inputs).astype(np.float32) if inputs else np.zeros((0, STEPS, INPUT_SIZE), np.float32)
    y = np.asarray(labels, np.int8).reshape(-1, len(HORIZONS));status = np.asarray(statuses, np.int8).reshape(-1, len(HORIZONS))
    out_path = Path(out_path);out_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out_path, X=X, y=y, status=status, cv_entry_s=np.asarray(cv, np.float32),
                        physical_any_entry=np.asarray(physical, bool).reshape(-1, len(HORIZONS)))
    out_path.with_suffix('.meta.jsonl').write_text(''.join(json.dumps(m)+'\n' for m in meta), encoding='utf8')
    summary = {'split': split, 'feature_version': FEATURE_VERSION, 'samples': len(X), 'episodes': episodes,
               'coverage': coverage, 'prediction_coverage': coverage['associated']/coverage['relevant'] if coverage['relevant'] else None,
               'label_counts': {f'{h}s': {name: int(np.sum(status[:, k] == code)) for name, code in STATUS_CODES.items()}
                                for k, h in enumerate(HORIZONS)},
               'positives': {f'{h}s': int(np.sum(y[:, k] == 1)) for k, h in enumerate(HORIZONS)},
               'negatives': {f'{h}s': int(np.sum(y[:, k] == 0)) for k, h in enumerate(HORIZONS)},
               'sha256': hashlib.sha256(out_path.read_bytes()).hexdigest()}
    out_path.with_suffix('.summary.json').write_text(json.dumps(summary, indent=1), encoding='utf8')
    return summary
