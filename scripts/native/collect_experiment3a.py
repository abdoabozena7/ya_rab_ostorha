"""Bounded native TRAIN demonstrations. No learner, model or GPU import."""
from collections import Counter, defaultdict
from dataclasses import replace
from datetime import datetime, timezone
import json
from pathlib import Path
import random
import subprocess
import time
import numpy as np
import psutil
from backend.core.contracts import to_dict
from backend.core.safety_policy import sensor_observation
from backend.rl.demonstrations import VERSION, model_arrays
from backend.rl.env import YaRabOstorhaEnv
from backend.rl.observations import ObservationAssembler, CONFIGS
from backend.rl.radar_retention import retained_radar_observation
from backend.rl.supervisor import policy_features, decide_intervention
from backend.rl.teacher import YaRabOstorhaSafetyTeacher
from .experiment2b_common import ROOT, write, read_frame, base_command
from .run_experiment2b import state, digest, used_seeds, MODEL
from .run_experiment2c import resources

DEST = ROOT / 'docs/evidence/experiment3a'
POLICY_ID = 'YA_RAB_OSTORHA_EXPERIMENT3A_TEACHER_V1'
FROZEN = ('backend/rl/teacher.py', 'backend/rl/teacher_config_v1.json',
          'backend/rl/radar.py', 'backend/rl/radar_retention.py',
          'backend/rl/observations.py', 'backend/rl/supervisor.py', 'backend/rl/reward.py')


def gpu_sample():
    try:
        run = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.used,memory.total,utilization.gpu',
            '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=5)
        return {'csv': run.stdout.strip(), 'exit_code': run.returncode}
    except (OSError, subprocess.TimeoutExpired) as error:
        return {'unavailable': repr(error)}


def episode(env, root, condition, ledger):
    ledger['attempts'] += 1
    write(root / 'budget-ledger.json', {'attempts': ledger['attempts'], 'steps': ledger['steps']})
    began = time.monotonic()
    directory = root / ('TRAIN_' + str(condition['seed']))
    directory.mkdir()
    teacher = YaRabOstorhaSafetyTeacher()
    shadow = YaRabOstorhaSafetyTeacher()
    assembler = ObservationAssembler(CONFIGS['lightweight'], lambda _: (_ for _ in ()).throw(
        AssertionError('Lightweight dataset must not read image binaries')))
    counts = Counter(); components = defaultdict(float); edges = []; timing = []
    previous_braking = False
    raw, initial = env.reset(seed=condition['seed'], options={'parameters': condition['parameters']})
    info = initial
    assert initial['reset_cleanup_verified']
    assert initial['actor_inventory'] == {'vehicles': 2, 'sensors': 7, 'walkers': 0, 'controllers': 0}
    recording = Path(initial['recording_path'])
    write(directory / 'context.json', {'schema': VERSION, 'split': 'TRAIN', **condition,
        'episode_id': initial['episode_id'], 'initial_configuration': initial['initial_configuration'],
        'recording_path': str(recording), 'reset_cleanup_verified': True,
        'actor_inventory': initial['actor_inventory'], 'source_hashes': ledger['hashes']})
    with (recording / 'telemetry/frames.jsonl').open() as frames, \
            (directory / 'transitions.jsonl').open('w', encoding='utf8') as transitions, \
            (directory / 'evaluation.jsonl').open('w', encoding='utf8') as evaluation:
        frame, observation = read_frame(frames, info)
        clean = sensor_observation(replace(frame, ground_truth=None, actors=()))
        projected = assembler.append(clean, [0., 0., 0.])
        for index in range(240):
            if time.monotonic() >= ledger['collection_deadline']:
                raise TimeoutError('Collection deadline: stop and safely finalize partial episode')
            for key in raw:
                np.testing.assert_array_equal(raw[key], projected[key])
            vector = info.get('next_base_proposed_action', info['base_proposed_action'])
            base = base_command(observation, vector)
            features = policy_features(raw, vector)
            np.testing.assert_array_equal(features, policy_features(projected, vector))
            started = time.perf_counter()
            adapted = retained_radar_observation(observation)
            decision = teacher.propose(adapted, base)
            timing.append((time.perf_counter() - started) * 1000)
            assert to_dict(decision) == to_dict(shadow.propose(retained_radar_observation(clean), base))
            expected, admission = decide_intervention(adapted, base, decision.action, POLICY_ID)
            assert admission['decision'] != 'REJECTED'
            braking = decision.action[0] > 0
            if braking != previous_braking:
                edges.append({'elapsed_s': frame.timestamp_s - initial['timestamp_s'], 'braking': braking,
                              'decision': decision.decision, 'reason': decision.diagnostics['reason']})
            previous_braking = braking
            source_frame, source_time = frame.frame_id, frame.timestamp_s
            raw_source = {key: value.tolist() for key, value in raw.items()}
            source_sensors = to_dict(observation)
            started = time.perf_counter()
            raw, reward, terminated, truncated, info = env.step(decision.action)
            step_ms = (time.perf_counter() - started) * 1000
            ledger['steps'] += 1
            assert info['outcome'] != 'SIMULATOR_FAILURE' and info['observation_valid']
            assert env.observation_space.contains(raw) and info['tick_owner'] == 'simulation-worker'
            assert info['frame_id'] == source_frame + 1 and abs(info['timestamp_s'] - source_time - .05) < 1e-6
            assert info['intervention']['accepted'] == admission['accepted']
            assert info['intervention']['decision'] != 'REJECTED'
            assert not info['intervention']['steering_adjustment_rejected']
            np.testing.assert_allclose(info['applied_action'],
                [expected.steering, expected.throttle, expected.brake], atol=1e-5, rtol=0)
            np.testing.assert_allclose(info['native_applied_action'], info['applied_action'], atol=1e-5, rtol=0)
            assert abs(info['applied_action'][0] - base.steering) < 1e-5
            assert info['applied_command']['source'] == expected.source.value
            sample_id = initial['episode_id'] + ':' + str(index)
            record = {'sample_id': sample_id, 'episode_id': initial['episode_id'], 'step_index': index,
                'model_inputs': {'sensor_features_47': features.tolist()},
                'teacher_targets': {'decision': decision.decision, 'intervention': list(decision.action),
                                    'proposed_safety_action': to_dict(decision.proposal)},
                'validated_actions': {'base_proposed_control': to_dict(base), 'admission': info['intervention'],
                    'final_applied_command': info['applied_command'], 'native_applied_action': info['native_applied_action'],
                    'result_frame': info['frame_id'], 'result_timestamp_s': info['timestamp_s'],
                    'application_verified': True},
                'sensor_provenance': {'source_frame': source_frame, 'timestamp_s': source_time,
                    'sensor_only_observation': source_sensors, 'lightweight_history': raw_source,
                    'recorder_reference': str(recording), 'ground_truth_replacement_invariant': True},
                'teacher_diagnostics_only': {'state': decision.state, **decision.diagnostics,
                                             'teacher_wall_ms': timing[-1], 'physics_capture_wall_ms': step_ms}}
            model_arrays(record)
            next_frame, next_observation = read_frame(frames, info)
            evaluation_record = {'sample_id': sample_id, 'source_frame': source_frame,
                'result_frame': next_frame.frame_id, 'reward': reward, 'reward_components': info['reward_components'],
                'reward_measurements': info['reward_measurements'], 'terminal_metrics': info.get('episode_metrics'),
                'outcome': info['outcome'],
                'terminated': terminated, 'truncated': truncated,
                'termination_reason': info['termination_reason'], 'truncation_reason': info['truncation_reason'],
                'ground_truth': to_dict(next_frame.ground_truth),
                'collision_events': info.get('collision_events', [])}
            transitions.write(json.dumps(record, allow_nan=False, separators=(',', ':')) + '\n')
            evaluation.write(json.dumps(evaluation_record, allow_nan=False, separators=(',', ':')) + '\n')
            transitions.flush(); evaluation.flush()
            counts[decision.decision] += 1
            counts['accepted_brake_actions'] += int(admission['accepted'])
            counts['verified_actions_and_isolation'] += 1
            counts['missing_foreground'] += int(not decision.diagnostics['foreground_valid'])
            for key, value in info['reward_components'].items(): components[key] += value
            frame, observation = next_frame, next_observation
            clean = sensor_observation(replace(frame, ground_truth=None, actors=()))
            projected = assembler.append(clean, info['applied_action'])
            if terminated or truncated:
                break
        else:
            raise RuntimeError('No outcome at maximum steps')
    outcome = json.loads((recording / 'outcome.json').read_text())
    assert abs(sum(components.values()) - outcome['reward']) < 1e-6
    result = {'seed': condition['seed'], 'split': 'TRAIN', 'episode_id': initial['episode_id'],
        'parameters': condition['parameters'], 'directory': str(directory), 'recording_path': str(recording),
        'outcome': outcome, 'counts': dict(counts), 'brake_release_edges': edges,
        'brief_transition_pairs_le_150ms': sum(b['elapsed_s'] - a['elapsed_s'] <= .150001 for a, b in zip(edges, edges[1:])),
        'reward_components': dict(components), 'wall_s': time.monotonic() - began,
        'teacher_wall_ms': {'median': float(np.median(timing)), 'p95': float(np.percentile(timing, 95)), 'max': max(timing)}}
    write(directory / 'episode.json', result)
    print(json.dumps({'completed': ledger['attempts'], 'seed': condition['seed'], 'outcome': outcome['outcome'],
        'progress_m': outcome['metrics']['forward_progress_m'], 'steps': outcome['steps'], 'counts': dict(counts)}), flush=True)
    return result


def main():
    current = state()
    assert current['connected'] and current['mode'] == 'PAUSED' and not current['rlRuntime']['active']
    used = used_seeds('TRAIN')  # Metadata seed IDs only; no held-out trajectories opened.
    seeds = random.Random(314161).sample([seed for seed in range(1000) if seed not in used], 12)
    # Predeclared physical conditions, not calibrated against TEST trajectories.
    # v_ego, gap, trigger, brake, v_lead. All within existing scenario bounds.
    parameters = [(8., 20., 2., 1., 5.), (9., 23., 1.4, .8, 5.),
        (7., 18., 1.2, .9, 4.), (10., 26., 2.4, .75, 5.5),
        (8.5, 22., 1.8, .65, 6.), (7.5, 19., 2.6, 1., 5.5),
        (9.5, 24., 1., .9, 4.5), (6.5, 20., 1.6, .8, 5.5),
        (8., 25., 2.2, .7, 4.), (9., 21., 1.3, 1., 6.),
        (7.25, 22., 2.8, .75, 4.75), (10., 27., 1.7, .85, 6.5)]
    conditions = [{'seed': seed, 'parameters': dict(ego_speed_mps=v, following_distance_m=d,
        trigger_s=t, lead_brake=b, lead_speed_mps=lead, time_limit_s=12.)}
        for seed, (v, d, t, b, lead) in zip(seeds, parameters)]
    hashes = {name: digest(ROOT / name) for name in FROZEN}
    frozen = json.loads((ROOT / 'docs/evidence/experiment2b/frozen-config.json').read_text())
    assert hashes['backend/rl/teacher.py'] == frozen['teacher_source_sha256']
    assert hashes['backend/rl/teacher_config_v1.json'] == frozen['config_sha256']
    root = ROOT / 'runs/demonstrations' / datetime.now(timezone.utc).strftime('experiment3a_%Y%m%dT%H%M%SZ')
    root.mkdir(parents=True, exist_ok=False)
    protocol = {'experiment': 'YA RAB OSTORHA Experiment 3A', 'schema': VERSION, 'split': 'TRAIN',
        'conditions': conditions, 'seed_draw': 314161, 'previous_train_seed_ids': sorted(used),
        'selection_uses_outcomes': False, 'historical_test_outcomes_inspected': False,
        'maximum_native_episodes': 12, 'maximum_total_native_wall_s': 180,
        'collection_stop_at_total_wall_s': 150, 'restoration_reserve_s': 30,
        'frozen_source_hashes': hashes, 'frozen_sac_sha256': digest(MODEL),
        'model_inputs_dim': 47, 'intervention_dim': 3, 'history_frames': 4, 'fixed_delta_seconds': .05,
        'episode_split_only': True, 'gpu_models_loaded': False, 'training_launched': False,
        'git_head': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()}
    write(root / 'protocol.json', protocol); write(DEST / 'protocol.json', protocol)
    print(json.dumps({'predeclared': conditions, 'dataset': str(root)}), flush=True)
    restart = [str(ROOT / '.venv-carla/Scripts/python.exe'), '-m', 'scripts.native.restart_experiment3a_backend']
    native_began = time.monotonic()
    subprocess.run(restart, cwd=ROOT, check=True)
    ledger = {'attempts': 0, 'steps': 0, 'collection_deadline': native_began + 150, 'hashes': hashes}
    samples = [resources()]; gpu = [gpu_sample()]; episodes = []; failure = None; budget_stop = None
    cpu = psutil.Process().cpu_times(); collection_began = time.monotonic()
    env = YaRabOstorhaEnv(profile='lightweight', split='TRAIN', scenario='SUDDEN_BRAKING',
        max_steps=240, baseline_id='BASIC_AGENT_WITH_SUPERVISOR', supervisor=True, policy_id=POLICY_ID)
    try:
        for condition in conditions:
            expected_wall = max(20., max((e['wall_s'] for e in episodes), default=0.) * 1.25)
            if time.monotonic() + expected_wall >= ledger['collection_deadline']:
                budget_stop = 'Insufficient reserved time for another complete episode'; break
            episodes.append(episode(env, root, condition, ledger))
            write(root / 'episodes.json', episodes); samples.append(resources())
            if episodes[-1]['outcome']['outcome'] != 'SUCCESS':
                failure = 'Non-successful demonstration retained; stop collection without tuning'; break
    except Exception as error:
        failure = repr(error)
        print(json.dumps({'stopped': failure}), flush=True)
    finally:
        env.close()
        closed = env.last_close_info
        samples.append(resources()); gpu.append(gpu_sample())
        end_cpu = psutil.Process().cpu_times()
        collection_wall = time.monotonic() - collection_began
        # Always restore the normal host after releasing the exclusive tick lease.
        assert closed and closed['restored'] and closed['actor_inventory'] == {'vehicles': 1, 'sensors': 7, 'walkers': 0, 'controllers': 0}
        assert hashes == {name: digest(ROOT / name) for name in hashes}
        assert digest(MODEL) == protocol['frozen_sac_sha256']
        subprocess.run([*restart, '--restore-normal'], cwd=ROOT, check=True)
        final = state()
        assert final['connected'] and final['mode'] == 'PAUSED'
        assert not final['rlRuntime']['active'] and not final['environment']['safety_policy']['active']
        result = {'experiment': protocol['experiment'], 'dataset': str(root), 'episodes': episodes,
            'attempted_episodes': ledger['attempts'], 'actual_steps': ledger['steps'],
            'collection_wall_s_including_close': collection_wall,
            'total_native_wall_s_including_reload_and_restore': time.monotonic() - native_began,
            'runner_collection_cpu_s': end_cpu.user + end_cpu.system - cpu.user - cpu.system,
            'memory_cpu_samples': samples, 'gpu_samples': gpu,
            'close_info': closed, 'normal_backend_restored': True, 'tick_lease_released': True,
            'final_mode': final['mode'], 'failure': failure, 'budget_stop': budget_stop,
            'source_and_model_hashes_unchanged': True}
        write(root / 'result.json', result); write(DEST / 'native.json', result)
        print(json.dumps({'dataset': str(root), 'attempts': ledger['attempts'], 'steps': ledger['steps'],
            'native_wall_s': result['total_native_wall_s_including_reload_and_restore'],
            'failure': failure, 'budget_stop': budget_stop}), flush=True)
    if failure:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
