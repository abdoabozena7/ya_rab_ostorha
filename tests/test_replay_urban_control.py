import pickle
import unittest
from pathlib import Path
from unittest.mock import patch

from backend.core.contracts import freeze_json, freeze_float_rows, _FrozenJSONSequence
from scripts.replay_urban_control import capture_live_prediction, compare_reports, digest


class UrbanReplayTests(unittest.TestCase):
    def report(self):
        payload = {'command': {'throttle': 0.1, 'brake': 0., 'gear': 1},
                   'prediction': {'tracks': [{'history': [[1., 2.]]}]},
                   'behavior': {'reason': 'FOLLOW'}, 'shield': [True, 'OK', {}]}
        return {'recording': 'saved', 'first': 1, 'last': 1, 'clock': {'behavior_age_ms': 100},
                'history_sha256': 'history', 'expected_frames': [1],
                'rows': [{'frame': 1, 'payload': payload, 'output_sha256': digest(payload)}]}

    def test_exact_command_and_complete_payload_compared_not_only_hashes(self):
        baseline, candidate = self.report(), self.report()
        candidate['rows'][0]['payload']['command']['gear'] = -1
        self.assertFalse(compare_reports(baseline, candidate)['equivalent'])
        candidate = self.report()
        candidate['rows'][0]['payload']['prediction']['tracks'][0]['history'][0][0] = 2.
        self.assertFalse(compare_reports(baseline, candidate)['equivalent'])

    def test_matched_clocks_history_and_all_frames_required(self):
        baseline = self.report()
        for key, value in [('clock', {'behavior_age_ms': 101}), ('history_sha256', 'other'),
                           ('rows', []), ('expected_frames', [1, 2])]:
            candidate = self.report()
            candidate[key] = value
            self.assertFalse(compare_reports(baseline, candidate)['equivalent'], key)
        candidate = self.report()
        candidate['rows'][0]['total_ms'] = 99999
        self.assertTrue(compare_reports(baseline, candidate)['equivalent'])

    def test_live_graph_capture_preserves_frozen_rows_and_aliases(self):
        import io
        import numpy as np
        points = freeze_float_rows(np.array([[0., 1.], [2., 3.]]))
        shared = [{'points': points}]
        value = {'tracks': shared, 'trajectories': shared, 'frozen': freeze_json({'points': points})}
        class KeepOpen(io.BytesIO):
            def close(self):
                pass

        stream = KeepOpen()
        with patch.object(Path, 'mkdir'), patch.object(Path, 'open', return_value=stream):
            capture_live_prediction(value, Path('unused.pkl'))
        restored = pickle.loads(stream.getvalue())
        self.assertIs(restored['tracks'], restored['trajectories'])
        self.assertIs(restored['tracks'][0]['points'], restored['frozen']['points'])
        self.assertIs(type(restored['tracks'][0]['points']), _FrozenJSONSequence)
        self.assertEqual(digest(value), digest(restored))
