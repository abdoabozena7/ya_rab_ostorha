"""Strict, ordered demonstration input loader. No learner or simulator access."""
import json
from pathlib import Path
import numpy as np

VERSION = 'YA_RAB_OSTORHA_DEMONSTRATIONS_V1'
DECISIONS = {'NO_INTERVENTION', 'BRAKE_INTERVENTION', 'RELEASE_TO_BASE_DRIVER'}
RECORD_KEYS = {'sample_id', 'episode_id', 'step_index', 'model_inputs',
               'teacher_targets', 'validated_actions', 'sensor_provenance',
               'teacher_diagnostics_only'}


def model_arrays(record):
    """Explicit projection: metadata, teacher state and evaluation never enter X."""
    if set(record) != RECORD_KEYS:
        raise ValueError('Undeclared demonstration channels')
    inputs = record['model_inputs']
    if not isinstance(inputs, dict) or set(inputs) != {'sensor_features_47'}:
        raise ValueError('Undeclared model inputs')
    features = np.asarray(inputs['sensor_features_47'])
    targets = record['teacher_targets']
    if set(targets) != {'decision', 'intervention', 'proposed_safety_action'}:
        raise ValueError('Undeclared teacher targets')
    action = np.asarray(targets['intervention'])
    if (features.shape != (47,) or features.dtype.kind not in 'fiu' or
            not np.isfinite(features).all() or np.any(np.abs(features) > 1)):
        raise ValueError('Invalid 47-dimensional sensor inputs')
    if targets['decision'] not in DECISIONS:
        raise ValueError('Unknown teacher decision')
    expected = [1., 1., 0.] if targets['decision'] == 'BRAKE_INTERVENTION' else [-1., 0., 0.]
    if action.shape != (3,) or action.dtype.kind not in 'fiu' or not np.array_equal(action, expected):
        raise ValueError('Decision and supervisory action disagree')
    return features.astype(np.float32), action.astype(np.float32)


def load_episode(path):
    """Preserve a whole episode's order; never split or shuffle individual frames."""
    previous = None
    with Path(path).open(encoding='utf8') as stream:
        for line in stream:
            record = json.loads(line)
            x, y = model_arrays(record)
            provenance = record['sensor_provenance']
            frame = provenance['source_frame']
            timestamp = provenance['timestamp_s']
            if (type(frame) is not int or frame < 0 or type(record['step_index']) is not int or
                    record['step_index'] < 0 or isinstance(timestamp, bool) or
                    not isinstance(timestamp, (int, float)) or not np.isfinite(timestamp) or timestamp < 0):
                raise ValueError('Invalid episode frame/time provenance')
            if previous is None:
                if record['step_index'] != 0:
                    raise ValueError('Episode must begin at step zero')
            elif (record['episode_id'] != previous[0] or record['step_index'] != previous[1] + 1 or
                  frame != previous[2] + 1 or abs(timestamp - previous[3] - .05) > 1e-6):
                raise ValueError('Mixed, duplicate or misaligned episode frames')
            applied = record['validated_actions']
            if (type(applied['result_frame']) is not int or applied['result_frame'] != frame + 1 or
                    not np.isfinite(applied['result_timestamp_s']) or
                    abs(applied['result_timestamp_s'] - timestamp - .05) > 1e-6):
                raise ValueError('Action must belong to the next physics step')
            if applied['admission']['decision'] == 'REJECTED' or applied['application_verified'] is not True:
                raise ValueError('Unverified teacher action')
            previous = (record['episode_id'], record['step_index'], frame, timestamp)
            yield x, y
