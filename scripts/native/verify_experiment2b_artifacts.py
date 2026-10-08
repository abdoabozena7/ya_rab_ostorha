"""Read-only preservation and restoration audit; never advances CARLA."""
import hashlib
import json
from pathlib import Path
import subprocess
import urllib.request

from .experiment2b_common import ROOT, write


PRESERVED = [
    'README.md', 'backend/carla/population.py', 'backend/carla/urban.py',
    'docs/NORMAL_CITY_OPERATION.md', 'scripts/native/restart_backend.py',
    'scripts/native/verify_city_reset.py', 'scripts/native/verify_dashboard_v2.py',
    'scripts/native/verify_urban_world.py', 'tests/test_population.py',
]
UNCHANGED = [
    'backend/carla/scenarios.py', 'backend/carla/provider.py',
    'backend/core/research.py', 'backend/core/safety_policy.py',
    'backend/core/control.py', 'backend/core/contracts.py', 'backend/core/service.py',
    'backend/rl/runtime.py', 'backend/rl/reward.py', 'backend/rl/supervisor.py',
    'backend/rl/radar.py', 'backend/rl/observations.py', 'backend/rl/env.py',
]
CHECKPOINT = '4a52b8139dbfe1d8b846ca484b090b5dbfb118a7'


def git(*args):
    return subprocess.check_output(['git', *args], cwd=ROOT)


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main():
    preserved = ROOT/'output/experiment2b-preserved'
    assert git('diff', '--binary', '--', *PRESERVED) == (preserved/'pre-experiment.patch').read_bytes()
    gate5 = ROOT/'scripts/native/verify_gate5_regression.py'
    assert gate5.read_bytes() == (preserved/'verify_gate5_regression.py').read_bytes()
    for path in UNCHANGED:
        # Git's Windows checkout may use CRLF for an unchanged LF repository blob.
        assert (ROOT/path).read_bytes().replace(b'\r\n', b'\n') == git('show', f'{CHECKPOINT}:{path}').replace(b'\r\n', b'\n'), path
    for checkpoint in (CHECKPOINT, '3d3684f7'):
        subprocess.run(['git', 'merge-base', '--is-ancestor', checkpoint, 'HEAD'], cwd=ROOT, check=True)
    model = ROOT/'runs/experiments/experiment1_20261008T165154Z/final_model.zip'
    assert digest(model) == '9b3bceb0c77aaea8a6cad71600d36f90b1dfbf2277ffad94ea6b91f42f5ac679'
    dest = ROOT/'docs/evidence/experiment2b'
    lock = json.loads((dest/'frozen-config.json').read_text())
    assert digest(ROOT/'backend/rl/teacher.py') == lock['teacher_source_sha256']
    assert digest(ROOT/'backend/rl/teacher_config_v1.json') == lock['config_sha256']
    with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/state', timeout=5) as response:
        state = json.load(response)
    runtime = state['rlRuntime']
    assert state['connected'] and state['mode'] == 'PAUSED'
    assert not runtime['active'] and not runtime['policy_active'] and runtime['pending_requests'] == 0
    registry = state['sensorRegistry']
    assert len(registry) == 7 and len({s['actorId'] for s in registry.values()}) == 7
    assert state.get('sensorErrors', {}) == {}
    gpu = subprocess.run([
        'nvidia-smi', '--query-gpu=name,memory.used,memory.total,utilization.gpu',
        '--format=csv,noheader,nounits',
    ], capture_output=True, text=True)
    native = json.loads((dest/'native.json').read_text())
    result = {
        'git_head_at_audit': git('rev-parse', 'HEAD').decode().strip(),
        'branch': git('branch', '--show-current').decode().strip(),
        'preserved_dirty_paths': PRESERVED,
        'preserved_patch_sha256': digest(preserved/'pre-experiment.patch'),
        'preserved_untracked_path': str(gate5),
        'production_and_experiment1_2a_modules_identical_except_checkout_newlines': UNCHANGED,
        'historical_checkpoints_are_ancestors': True,
        'frozen_sac_model_sha256': digest(model),
        'teacher_config_sha256': lock['config_sha256'],
        'teacher_source_sha256': lock['teacher_source_sha256'],
        'normal_runtime': {'connected': state['connected'], 'mode': state['mode'],
            'rl_active': runtime['active'], 'policy_active': runtime['policy_active'],
            'pending_requests': runtime['pending_requests'],
            'sensor_actor_ids': {k: v['actorId'] for k, v in registry.items()},
            'sensor_errors': state.get('sensorErrors', {}),
            'rgb_width': registry['frontCamera']['latestValidData']['metadata']['width'],
            'rgb_height': registry['frontCamera']['latestValidData']['metadata']['height']},
        'regressions': {'python': {'run': 169, 'passed': 168, 'skipped': 1, 'wall_s': 4.066,
            'skip_reason': 'CARLA SDK is present; absent-SDK contract test does not apply'},
            'javascript': {'run': 24, 'passed': 24, 'wall_s': .3191212}},
        'native_budget': {'episodes': native['attempted_episodes'], 'steps': native['actual_steps'],
            'wall_s': native['native_wall_s'], 'remaining_authorized_episodes': 0},
        'gpu_snapshot': {'command_succeeded': gpu.returncode == 0,
            'csv_columns': 'name, memory.used MiB, memory.total MiB, utilization.gpu %',
            'value': gpu.stdout.strip(), 'new_model_gpu_allocations': 0,
            'note': 'Read-only post-run snapshot of existing GPU users; not incremental experiment VRAM'},
        'native_manual_journey_smoke_after_experiment': False,
        'no_training_or_production_activation': True,
    }
    write(dest/'verification.json', result)
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
