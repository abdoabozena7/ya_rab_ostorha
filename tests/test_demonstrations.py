import copy
import json
import tempfile
import unittest
from pathlib import Path
from backend.rl.demonstrations import model_arrays, load_episode


def record(step=0):
    return {'sample_id': 'episode:' + str(step), 'episode_id': 'episode', 'step_index': step,
        'model_inputs': {'sensor_features_47': [0.] * 47},
        'teacher_targets': {'decision': 'NO_INTERVENTION', 'intervention': [-1., 0., 0.],
                            'proposed_safety_action': None},
        'validated_actions': {'result_frame': 11 + step, 'result_timestamp_s': 1.05 + .05 * step,
                              'application_verified': True, 'admission': {'decision': 'NO_INTERVENTION'}},
        'sensor_provenance': {'source_frame': 10 + step, 'timestamp_s': 1. + .05 * step},
        'teacher_diagnostics_only': {'state': 'MONITORING'}}


class DemonstrationsTests(unittest.TestCase):
    def test_strict_inputs_and_no_evaluation_flattening(self):
        for field in ('ground_truth', 'seed', 'teacher_state', 'reward', 'future_trigger'):
            r = record(); r['model_inputs'][field] = 1
            with self.assertRaises(ValueError): model_arrays(r)
        r = record(); r['evaluation_only'] = {}
        with self.assertRaises(ValueError): model_arrays(r)
        x, y = model_arrays(record())
        self.assertEqual(x.shape, (47,)); self.assertEqual(y.shape, (3,))

    def test_invalid_features_and_contradictory_labels(self):
        for v in ([0.] * 46, [float('nan')] * 47, [1.1] * 47, [True] * 47):
            r = record(); r['model_inputs']['sensor_features_47'] = v
            with self.assertRaises(ValueError): model_arrays(r)
        r = record(); r['teacher_targets']['decision'] = 'BRAKE_INTERVENTION'
        with self.assertRaises(ValueError): model_arrays(r)

    def test_metadata_is_not_model_input(self):
        r = record(); altered = copy.deepcopy(r)
        altered['teacher_diagnostics_only'] = {'state': 'SAFE_STOP', 'reward': 10000}
        self.assertEqual(model_arrays(r)[0].tolist(), model_arrays(altered)[0].tolist())

    def test_episode_order_alignment_and_verified_application(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'episode.jsonl'
            def write(records): path.write_text(''.join(json.dumps(r) + '\n' for r in records))
            write([record(), record(1)])
            self.assertEqual(len(list(load_episode(path))), 2)
            bad = record(1); bad['validated_actions']['application_verified'] = False
            invalid_time = record(); invalid_time['sensor_provenance']['timestamp_s'] = float('nan')
            invalid_result = record(); invalid_result['validated_actions']['result_timestamp_s'] = float('nan')
            for records in ([record(), record()], [record(1)], [record(), bad], [invalid_time], [invalid_result]):
                write(records)
                with self.assertRaises(ValueError): list(load_episode(path))


if __name__ == '__main__':
    unittest.main()
