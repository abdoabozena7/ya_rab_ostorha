"""Offline TRAIN data audit. Counterfactual replay is diagnostic, never a label."""
from collections import Counter, defaultdict
import hashlib
import json
from pathlib import Path
import time
import numpy as np
import psutil
from backend.core.contracts import from_dict, ControlCommand, SensorKind
from backend.core.safety_policy import SensorObservation
from backend.rl.demonstrations import load_episode
from backend.rl.radar_retention import retained_radar_observation
from backend.rl.supervisor import policy_features
from backend.rl.teacher import YaRabOstorhaSafetyTeacher
from .experiment2b_common import ROOT, write, rows
from .collect_experiment3a import DEST


def forbidden_keys(value):
    prohibited = {'ground_truth', 'actor_id', 'actors', 'transform', 'route', 'reward', 'outcome',
                  'future_trajectory', 'future_trigger', 'seed', 'scenario_parameters'}
    if isinstance(value, dict):
        return (set(value) & prohibited) | set().union(*(forbidden_keys(v) for v in value.values()), set())
    if isinstance(value, list):
        return set().union(*(forbidden_keys(v) for v in value), set())
    return set()


def main():
    began = time.perf_counter(); process = psutil.Process(); cpu = process.cpu_times()
    native = json.loads((DEST / 'native.json').read_text())
    root = Path(native['dataset']); protocol = json.loads((root / 'protocol.json').read_text())
    assert protocol['split'] == 'TRAIN' and not protocol['training_launched']
    assert native['attempted_episodes'] <= 12
    counts = Counter(); states = Counter(); state_decisions = defaultdict(Counter)
    all_x = []; all_y = []; examples = []; episodes = []
    unnecessary_by_decision = Counter(); history_valid_counts = Counter()
    measurements = defaultdict(list); acceleration_clipped = 0
    unique_samples = set(); unique_frames = set(); assets = set(); canonical = {}; coarse = {}
    exact_conflicts = 0; coarse_conflicts = 0; exact_duplicates = 0
    tolerance = np.asarray(([.1/15, .5/10, .02/2, .02, .02, .02, .2/50, .2/20, .1/10, 1., 1.] * 4) + [.02]*3)
    for directory in sorted(root.glob('TRAIN_*')):
        path = directory / 'transitions.jsonl'
        records = rows(path)
        arrays = list(load_episode(path))
        evaluation = rows(directory / 'evaluation.jsonl')
        context = json.loads((directory / 'context.json').read_text())
        assert context['split'] == 'TRAIN' and context['seed'] not in protocol['previous_train_seed_ids']
        assert 0 <= context['seed'] <= 999 and len(records) == len(arrays) == len(evaluation)
        stateful = YaRabOstorhaSafetyTeacher(); history = []; previous = None
        window_action_disagreements = 0; window_enum_disagreements = 0; frame_action_disagreements = 0
        local_counts = Counter(); edges = []; previous_braking = False
        for record, (x, y), diagnostic in zip(records, arrays, evaluation):
            provenance = record['sensor_provenance']; raw_values = provenance['lightweight_history']
            raw = {k: np.asarray(v, dtype=np.int8 if k.endswith('_valid') else np.float64 if k == 'frame_time' else np.float32)
                   for k, v in raw_values.items()}
            observation = from_dict(SensorObservation, provenance['sensor_only_observation'])
            base = from_dict(ControlCommand, record['validated_actions']['base_proposed_control'])
            vector = [base.steering, base.throttle, base.brake]
            np.testing.assert_array_equal(x, policy_features(raw, vector))
            assert not forbidden_keys(record['model_inputs'])
            assert not forbidden_keys(provenance['sensor_only_observation'])
            assert provenance['ground_truth_replacement_invariant']
            assert observation.frame_id == provenance['source_frame'] == base.frame_id
            assert abs(observation.timestamp_s - base.timestamp_s) < 1e-6
            assert diagnostic['sample_id'] == record['sample_id'] and diagnostic['source_frame'] == observation.frame_id
            assert diagnostic['result_frame'] == record['validated_actions']['result_frame']
            assert record['sample_id'] not in unique_samples and observation.frame_id not in unique_frames
            unique_samples.add(record['sample_id']); unique_frames.add(observation.frame_id)
            for channel in observation.channels:
                assert channel.frame_id == observation.frame_id and abs(channel.sensor_timestamp_s - observation.timestamp_s) < 1e-6
                if channel.asset:
                    asset_path = Path(context['recording_path']) / channel.asset.path
                    # Recorder owns each binary once; no re-encoding or image copies.
                    assert asset_path.is_file() and asset_path.stat().st_size == channel.asset.byte_count
                    assets.add(str(asset_path))
            valid = raw['history_valid'].astype(bool)
            times = raw['frame_time'][valid]
            assert len(times) == min(4, record['step_index'] + 1)
            history_valid_counts[len(times)] += 1
            assert np.array_equal(times[:, 0], np.arange(observation.frame_id - len(times) + 1, observation.frame_id + 1))
            assert np.all(np.abs(np.diff(times[:, 1]) - .05) < 1e-6)
            np.testing.assert_allclose(raw['previous_action'][-1],
                previous['validated_actions']['native_applied_action'] if previous else [0., 0., 0.], atol=1e-6)
            admitted = record['validated_actions']['admission']
            assert admitted['decision'] != 'REJECTED'
            command = from_dict(ControlCommand, record['validated_actions']['final_applied_command'])
            assert command.frame_id == observation.frame_id and abs(command.timestamp_s - observation.timestamp_s) < 1e-6
            np.testing.assert_allclose(record['validated_actions']['native_applied_action'],
                [command.steering, command.throttle, command.brake], atol=1e-5)
            assert abs(command.steering - base.steering) < 1e-5
            if admitted['accepted']:
                assert admitted['feasibility']['physical_limits_verified'] and admitted['feasibility']['surrounding_hazards_checked']
                counts['accepted_brake_actions'] += 1
            # Reproduce the original stateful label using only actual measured inputs.
            adapted = retained_radar_observation(observation)
            label = record['teacher_targets']['decision']
            reproduced = stateful.propose(adapted, base)
            assert reproduced.decision == label and list(reproduced.action) == record['teacher_targets']['intervention']
            counts[label] += 1; local_counts[label] += 1
            states[record['teacher_diagnostics_only']['state']] += 1
            state_decisions[record['teacher_diagnostics_only']['state']][label] += 1
            history.append((adapted, base))
            single = YaRabOstorhaSafetyTeacher().propose(adapted, base)
            frame_action_disagreements += int(single.action != reproduced.action)
            window = YaRabOstorhaSafetyTeacher()
            for item, proposed in history[-4:]: replayed = window.propose(item, proposed)
            window_action_disagreements += int(replayed.action != reproduced.action)
            window_enum_disagreements += int(replayed.decision != label)
            braking = y[0] > 0
            if braking != previous_braking:
                edges.append({'sample_id': record['sample_id'], 'step': record['step_index'],
                    'elapsed_s': observation.timestamp_s - records[0]['sensor_provenance']['timestamp_s'],
                    'braking': bool(braking), 'decision': label,
                    'speed_mps': observation.ego.speed_mps,
                    'forward_range_m': record['teacher_diagnostics_only']['forward_range_m'],
                    'reason': record['teacher_diagnostics_only']['reason']})
            previous_braking = braking
            counts['distinct_braking_bouts'] += int(braking and (previous is None or previous['teacher_targets']['intervention'][0] <= 0))
            counts['missing_foreground'] += int(not x[42])
            counts['history_padding_rows'] += int((~valid).sum())
            counts['unnecessary_braking_heuristic_steps'] += int(diagnostic['reward_measurements']['unnecessary_braking'] > 0)
            unnecessary_by_decision[label] += int(diagnostic['reward_measurements']['unnecessary_braking'] > 0)
            teacher_info = record['teacher_diagnostics_only']
            for key, field in (('speed', 'ego_speed_mps'), ('range', 'forward_range_m'),
                               ('closing', 'closing_velocity_mps'), ('teacher_ms', 'teacher_wall_ms'),
                               ('capture_ms', 'physics_capture_wall_ms')):
                measurements[key].append(teacher_info[field])
            acceleration_clipped += int(abs(raw['imu'][-1, 0]) > 10.)
            key = x.tobytes()
            if key in canonical:
                exact_duplicates += 1; exact_conflicts += int(canonical[key] != label)
            else: canonical[key] = label
            coarse_key = np.rint(x / tolerance).astype(np.int64).tobytes()
            if coarse_key in coarse: coarse_conflicts += int(coarse[coarse_key] != label)
            else: coarse[coarse_key] = label
            all_x.append(x); all_y.append(y); previous = record
        result = json.loads((Path(context['recording_path']) / 'outcome.json').read_text())
        episode = {'seed': context['seed'], 'episode_id': context['episode_id'], 'parameters': context['parameters'],
            'valid_transitions': len(records), 'outcome': result['outcome'], 'metrics': result['metrics'],
            'decision_counts': dict(local_counts), 'brake_release_edges': edges,
            'brief_transition_pairs_le_150ms': sum(b['elapsed_s'] - a['elapsed_s'] <= .150001 for a, b in zip(edges, edges[1:])),
            'single_frame_reset_action_disagreements': frame_action_disagreements,
            'four_frame_reset_action_disagreements': window_action_disagreements,
            'four_frame_reset_enum_disagreements': window_enum_disagreements}
        episodes.append(episode)
        if len(examples) < 3: examples.append({'seed': context['seed'], 'transitions': edges})
    assert len(unique_samples) == native['actual_steps']
    x = np.asarray(all_x); y = np.asarray(all_y)
    # Derived audit/manifest are excluded to avoid recursive self-checksums and
    # allow repeat audits without changing the immutable collection manifest.
    manifests = [{'path': str(p.relative_to(root)), 'bytes': p.stat().st_size,
                  'sha256': hashlib.sha256(p.read_bytes()).hexdigest()} for p in sorted(root.rglob('*'))
                 if p.is_file() and p.name not in ('audit.json', 'manifest.json')]
    dataset_bytes = sum(item['bytes'] for item in manifests)
    recorder_roots = {Path(e['recording_path']) for e in native['episodes']}
    recorder_bytes = sum(p.stat().st_size for r in recorder_roots for p in r.rglob('*') if p.is_file())
    resource_deltas = []
    first, last = native['memory_cpu_samples'][0], native['memory_cpu_samples'][-1]
    for start in first:
        finish = next((p for p in last if p['pid'] == start['pid']), None)
        if finish: resource_deltas.append({'pid': start['pid'], 'name': start['name'], 'runner': start['runner'],
                                          'cpu_s': finish['cpu_s'] - start['cpu_s']})
    end_cpu = process.cpu_times()
    result = {'experiment': protocol['experiment'], 'dataset': str(root), 'split': 'TRAIN',
        'episodes': episodes, 'episode_count': len(episodes), 'valid_transitions': len(unique_samples),
        'outcome_counts': dict(Counter(e['outcome'] for e in episodes)),
        'decision_counts': {key: counts[key] for key in ('NO_INTERVENTION', 'BRAKE_INTERVENTION', 'RELEASE_TO_BASE_DRIVER')},
        'decision_percentages': {key: 100 * counts[key] / len(unique_samples) for key in ('NO_INTERVENTION', 'BRAKE_INTERVENTION', 'RELEASE_TO_BASE_DRIVER')},
        'counts': dict(counts), 'teacher_state_counts': dict(states),
        'state_decision_counts': {key: dict(value) for key, value in state_decisions.items()},
        'model_input_shape': list(x.shape), 'target_shape': list(y.shape),
        'observation_alignment_errors': 0, 'duplicate_source_frames': 0, 'stale_sensor_channels': 0,
        'missing_required_sensor_channels': 0, 'privileged_input_fields': 0,
        'stateful_sensor_only_replay_mismatches': 0, 'feasibility_rejections': 0, 'native_application_mismatches': 0,
        'exact_duplicate_feature_vectors': exact_duplicates, 'exact_label_conflicts': exact_conflicts,
        'coarsened_label_conflicts': coarse_conflicts, 'coarsening_tolerances_normalized': tolerance.tolist(),
        'single_frame_reset_action_disagreements': sum(e['single_frame_reset_action_disagreements'] for e in episodes),
        'four_frame_reset_action_disagreements': sum(e['four_frame_reset_action_disagreements'] for e in episodes),
        'four_frame_reset_enum_disagreements': sum(e['four_frame_reset_enum_disagreements'] for e in episodes),
        'window_replay_caveat': 'Resetting the rule state is diagnostic, not a proof that 47 inputs cannot encode state via previous actions. Preserve ordered episodes; history sufficiency is not established.',
        'examples': examples, 'unique_original_sensor_assets': len(assets), 'duplicated_sensor_binaries': 0,
        'weighted_average_speed_mps': sum(e['metrics']['distance_traveled_m'] for e in episodes) / sum(e['metrics']['duration_s'] for e in episodes),
        'total_distance_m': sum(e['metrics']['distance_traveled_m'] for e in episodes),
        'total_simulated_duration_s': sum(e['metrics']['duration_s'] for e in episodes),
        'native_brief_chatter_count': sum(e['brief_transition_pairs_le_150ms'] for e in episodes),
        'unnecessary_braking_heuristic_by_decision': dict(unnecessary_by_decision),
        'current_longitudinal_acceleration_feature_clipped_steps': acceleration_clipped,
        'valid_history_rows_distribution': dict(history_valid_counts),
        'sensor_and_latency_summary': {key: {'min': min(v), 'max': max(v), 'median': float(np.median(v)),
                                            'p95': float(np.percentile(v, 95))} for key, v in measurements.items()},
        'dataset_bytes': dataset_bytes, 'recorder_bytes': recorder_bytes, 'total_storage_bytes': dataset_bytes + recorder_bytes,
        'process_cpu_deltas_collection': resource_deltas,
        'sampled_private_mib_max': max(p['private_mib'] for sample in native['memory_cpu_samples'] for p in sample if p['runner']),
        'audit_wall_s': time.perf_counter() - began, 'audit_cpu_s': end_cpu.user + end_cpu.system - cpu.user - cpu.system,
        'audit_private_mib': process.memory_info().private / 2**20,
        'bc_readiness': 'Small sequential feasibility pilot only; three public decisions collapse to two intervention actions. No generalization or teacher optimality claim.'}
    write(root / 'manifest.json', manifests); write(root / 'audit.json', result); write(DEST / 'audit.json', result)
    print(json.dumps({key: result[key] for key in ('episode_count', 'valid_transitions', 'outcome_counts',
        'decision_counts', 'single_frame_reset_action_disagreements', 'four_frame_reset_action_disagreements',
        'dataset_bytes', 'recorder_bytes', 'audit_wall_s')}), flush=True)


if __name__ == '__main__':
    main()
