"""Compare freezing on a trusted local pre-freeze graph; never native timing."""
import argparse
import ast
import gc
import hashlib
import json
import pickle
from pathlib import Path
import statistics
import time

import numpy as np

from backend.core import contracts
from backend.core.egypt_urban import source_fingerprint
from backend.learning.egypt_budget import save_json


def main():
    parser = argparse.ArgumentParser(description=__doc__ + ' Only load trusted local Python/pickle evidence.')
    parser.add_argument('--sample', type=Path, required=True)
    parser.add_argument('--oracle', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--samples', type=int, default=1000)
    args = parser.parse_args()
    if args.samples < 1:
        parser.error('--samples must be positive')
    old_source = args.oracle.read_text(encoding='utf8')
    old_tree = ast.parse(old_source)
    new_tree = ast.parse(Path(contracts.__file__).read_text(encoding='utf8'))
    old_function = next(node for node in old_tree.body
                        if isinstance(node, ast.FunctionDef) and node.name == 'freeze_json')
    for tree in (old_tree, new_tree):
        tree.body = [node for node in tree.body
                     if not (isinstance(node, ast.FunctionDef) and node.name == 'freeze_json')]
    if ast.dump(old_tree) != ast.dump(new_tree):
        raise ValueError('Oracle helpers/types differ; this comparison isolates freeze_json only')
    namespace = dict(vars(contracts))
    exec(compile(ast.get_source_segment(old_source, old_function), str(args.oracle), 'exec'), namespace)
    original = namespace['freeze_json']
    with args.sample.open('rb') as stream:
        payload = pickle.load(stream)
    if (payload['trajectories'] is not payload['control_trajectories']
            or type(payload['trajectories'][0]['points']) is not contracts._FrozenJSONSequence
            or type(payload['trajectories'][0]['points'][0]) is not contracts._FrozenJSONSequence):
        raise ValueError('Expected the captured shared, pre-frozen trajectory graph')
    if contracts.to_dict(original(payload)) != contracts.to_dict(contracts.freeze_json(payload)):
        raise ValueError('Complete frozen payloads differ')
    functions = {'original': original, 'optimized': contracts.freeze_json}
    samples = {name: [] for name in functions}
    was_enabled = gc.isenabled()
    gc.disable()
    try:
        for _ in range(20):
            for freeze in functions.values():
                freeze(payload)
        for index in range(args.samples):
            names = ('original', 'optimized') if index % 2 == 0 else ('optimized', 'original')
            for name in names:
                began = time.perf_counter_ns()
                functions[name](payload)
                samples[name].append((time.perf_counter_ns() - began) / 1e6)
    finally:
        if was_enabled:
            gc.enable()
    report = {
        'scope': 'OFFLINE_REAL_PRE_FREEZE_GRAPH_MICROBENCHMARK_NOT_NATIVE_TIMING',
        'native_acceptance': False, 'source_sha256': source_fingerprint(),
        'original_contracts_sha256': hashlib.sha256(args.oracle.read_bytes()).hexdigest(),
        'optimized_contracts_sha256': hashlib.sha256(Path(contracts.__file__).read_bytes()).hexdigest(),
        'live_sample_sha256': hashlib.sha256(args.sample.read_bytes()).hexdigest(),
        'script_sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'evaluation_frame': payload['evaluation_frame'], 'tracks': len(payload['tracks']),
        'physical_modes': len(payload['trajectories']), 'equal_complete_values': True,
        'frozen_rows_and_shared_trajectory_input_verified': True,
        'samples_per_implementation': args.samples,
        'method': 'Unprofiled perf_counter_ns, alternating order, 20 warmups, cyclic GC disabled/restored',
        'timing_ms': {name: {'median': statistics.median(values),
                             'p95': float(np.percentile(values, 95)),
                             'p99': float(np.percentile(values, 99))}
                      for name, values in samples.items()},
        'raw_samples_ms': samples,
        'limitations': 'One captured prediction; no end-to-end or native timing/gate improvement established'}
    save_json(args.output, report)
    print(json.dumps({'output': str(args.output), 'timing_ms': report['timing_ms']}))


if __name__ == '__main__':
    main()
