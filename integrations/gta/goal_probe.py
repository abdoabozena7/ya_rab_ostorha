"""Owned finite-flow/goal experiment using the existing native supervisor."""
import argparse
import json
from pathlib import Path
import subprocess
import live_probe as live
import preflight

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
ROOT = PROJECT/'.runtime-proof/gta-goal-driver-20261031/runs'
BUILD = live.build
VALIDATE = live.validate_scenario
NATIVE = live.native


def validate(config):
    if (config['traffic_vehicles'], config['on_foot_pedestrians'], config['local_moving_cars'],
            config['local_motorcycles'], config['designated_crossers']) != (60, 100, 4, 2, 6):
        raise ValueError('Unregistered finite-flow population')
    original = dict(config, local_moving_cars=6, local_motorcycles=4, designated_crossers=24)
    VALIDATE(original)
    return config


def build(output):
    return BUILD(output, native_source='goal_runtime.cpp', scenario='goal-scenario.json', duration_ms=360000)


def native(output, request):
    request['mode'] = 'GOAL'
    preflight.write_json(output/'sensor-request.json', request)
    return NATIVE(output, request)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--build-only', action='store_true')
    args = parser.parse_args()
    live.ROOT = ROOT
    live.validate_scenario, live.build, live.native = validate, build, native
    original_output = live.output_path
    live.output_path = lambda p, check='native-goal-journey': original_output(p, check)
    if args.build_only:
        output = live.output_path(args.output, 'goal-build')
        subprocess.run(['cmd.exe', '/d', '/c', 'npm run build:dashboard'], cwd=PROJECT, check=True)
        build(output)
        return 0
    live.ordinary(args.output)
    result = json.loads((args.output/'live-result.json').read_text())
    if 'finite_flow_observed' not in result:
        from goal_acceptance import finalize
        result.update(finalize(args.output))
    preflight.write_json(args.output/'goal-result.json', result)
    keys = ('finite_flow_observed', 'reverse_escape_observed', 'destination_reached', 'native_sensor_streams',
            'fault_stops_observed', 'cleanup_confirmed', 'files_restored', 'protected_inputs_unchanged')
    return int(not all(result.get(k) for k in keys))


if __name__ == '__main__':
    raise SystemExit(main())
