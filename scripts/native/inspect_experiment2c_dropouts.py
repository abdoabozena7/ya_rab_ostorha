"""Read the sixteen authentic dropout frames; ground truth is diagnostic only."""
import ast
import json
import math
from collections import defaultdict
from pathlib import Path
import numpy as np
from backend.core.contracts import SimulationFrame, SensorKind, from_dict
from backend.rl.radar import measured_heights, foreground_index
from .experiment2b_common import ROOT, write


def diagnostic_geometry():
    tree = ast.parse((ROOT/'scripts/native/diagnose_experiment1_recordings.py').read_text())
    nodes = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in
             ('rotation', 'world_hits', 'leader_masks')]
    scope = {'np': np, 'math': math}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), 'offline-geometry', 'exec'), scope)
    return scope


def main():
    geometry = diagnostic_geometry()
    previous = json.loads((ROOT/'docs/evidence/experiment2b/analysis.json').read_text())
    native = json.loads((ROOT/'docs/evidence/experiment2b/native.json').read_text())
    requested = defaultdict(set)
    for example in previous['radar_no_foreground_examples']:
        requested[example['seed']].add(example['step']-1)
    results = []
    for episode in native['episodes']:
        if episode['controller'] != 'TEACHER' or episode['seed'] not in requested:
            continue
        path = Path(episode['recording_path'])
        metadata = json.loads((path/'metadata.json').read_text())
        with (path/'telemetry/frames.jsonl').open() as stream:
            for index, line in enumerate(stream):
                if index not in requested[episode['seed']]:
                    continue
                frame = from_dict(SimulationFrame, json.loads(line))
                sensor = next(s for s in frame.sensors if s.kind == SensorKind.RADAR)
                points, hits = geometry['world_hits'](sensor)
                _, inside = geometry['leader_masks'](frame, metadata, points, hits)
                order = np.argsort(points[:, 0], kind='stable')
                nearest = points[order[:32]].astype(np.float32)
                heights, fitted = measured_heights(nearest)
                rank = np.flatnonzero(inside[order])+1
                body = points[inside]
                assert len(rank) and int(rank.min()) > 32 and foreground_index(nearest) is None
                results.append({'seed': episode['seed'], 'split': episode['split'],
                    'step': index+1, 'frame_id': frame.frame_id,
                    'raw_return_count': len(points), 'raw_lead_return_count': len(body),
                    'lead_min_distance_rank': int(rank.min()), 'lead_max_distance_rank': int(rank.max()),
                    'nearest32_max_depth_m': float(nearest[:, 0].max()),
                    'lead_depth_range_m': [float(body[:, 0].min()), float(body[:, 0].max())],
                    'lead_azimuth_range_rad': [float(body[:, 1].min()), float(body[:, 1].max())],
                    'lead_altitude_range_rad': [float(body[:, 2].min()), float(body[:, 2].max())],
                    'ground_plane_fitted': bool(fitted),
                    'nearest32_max_measured_height_m': float(heights.max()),
                    'raw_projection_keeps_all_returns': True, 'nearest32_retains_lead': False})
    assert len(results) == 16
    write(ROOT/'docs/evidence/experiment2c/root-cause.json', {'frames': results,
        'source_path': ['backend/carla/sensor_decoders.py:decode_sensor',
                        'backend/core/safety_policy.py:sensor_observation',
                        'backend/rl/observations.py:ObservationAssembler.append',
                        'backend/rl/teacher.py:YaRabOstorhaSafetyTeacher.propose'],
        'root_cause': 'Raw radar preserves target returns. Independent nearest-distance top-32 truncation in the assembler and teacher discards every lead return on these sixteen frames, before foreground screening.'})
    print(json.dumps(results, indent=2))


if __name__ == '__main__':
    main()
