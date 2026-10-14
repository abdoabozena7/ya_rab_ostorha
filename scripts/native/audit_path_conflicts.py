"""Replay recorded LiDAR through RULE's side/rear tracker; no native driving.

This audits decisions on an existing trajectory, not counterfactual physics.
Actor poses and identities never enter the tracker.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import time

import numpy as np

from backend.core.contracts import SensorKind
from backend.core.path_conflicts import LidarPathConflicts
from backend.core.replay import ReplayReader
from backend.core.safety_policy import sensor_observation


def audit(recording, output):
    reader = ReplayReader(recording)
    tracker = LidarPathConflicts()
    counts = Counter()
    conflicts = []
    durations = []
    started = time.perf_counter()
    for frame in reader.frames():
        if not frame.complete:
            tracker.reset()
            counts['incomplete_frames'] += 1
            continue
        observation = sensor_observation(frame)
        lidar = next(s for s in frame.sensors if s.kind == SensorKind.LIDAR)
        points = np.fromfile(reader.asset_path(lidar), dtype='<f4').reshape(-1, 4)[:, :3]
        points = points + np.asarray(lidar.metadata['mount_transform']['position_m'])
        began = time.perf_counter()
        assessment = tracker.assess(points, observation)
        durations.append((time.perf_counter() - began) * 1000)
        counts['evaluated_frames'] += 1
        if assessment['conflict']:
            conflict = assessment['conflict']
            counts['conflict_frames'] += 1
            counts['rear_conflict_frames' if conflict['center_m'][0] < 0 else 'front_side_conflict_frames'] += 1
            conflicts.append({'frame_id': frame.frame_id, 'timestamp_s': frame.timestamp_s,
                              'ego_speed_mps': observation.ego.speed_mps, **conflict})
    report = {'recording': str(reader.root), 'scope': 'OFFLINE_RECORDED_SENSOR_REPLAY',
              'counts': dict(counts), 'tracker_p95_ms': float(np.percentile(durations, 95)),
              'elapsed_wall_s': time.perf_counter() - started,
              'limitation': 'Existing recorded trajectory only; no new driving or collision outcome inferred.'}
    output.mkdir(parents=True, exist_ok=True)
    (output / 'summary.json').write_text(json.dumps(report, indent=2), encoding='utf8')
    (output / 'conflicts.jsonl').write_text(''.join(json.dumps(c) + '\n' for c in conflicts), encoding='utf8')
    print(json.dumps(report), flush=True)
    return report


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('recording', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    audit(args.recording, args.output)
