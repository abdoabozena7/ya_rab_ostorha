import copy
import json
from pathlib import Path
import tempfile
import unittest

from scripts.audit_egypt_queue import audit, summarize


class QueueAuditTests(unittest.TestCase):
    def evidence(self):
        def actor(identity, x):
            return {'actor_id': identity, 'class_name': 'vehicle.test',
                    'transform': {'position_m': [x, 0., 0.]},
                    'linear_velocity_mps': [0., 0., 0.]}
        frames = [{'frame_id': frame, 'timestamp_s': float(frame),
                   'vehicle': {'speed_mps': 0., 'transform': {'position_m': [0., 0., 0.],
                                            'rotation_rad': {'yaw': 0.}}},
                   'actors': [actor(7, 9.), actor(8, 15.)]} for frame in (10, 11, 12)]
        event = {'status': 'COMPLETED', 'realized': True, 'measurements': {'resumed_m': 1.1},
                 'transitions': [{'phase': 'COMPLETED', 'timestamp_s': 5., 'frame_id': 5}]}
        samples = [{'timestamp_s': 12., 'stop': {'reason': 'UNKNOWN_SPACE'},
                    'scenario': {'scenario_id': 'EGYPT_URBAN_CHAOS_V1', 'audit': {},
                                 'events': {'queue_lead': copy.deepcopy(event),
                                            'pass_obstacle_0': copy.deepcopy(event)}}}]
        return samples, frames

    def test_completed_event_does_not_identify_unrelated_physical_lead(self):
        samples, frames = self.evidence()
        result = summarize(samples, frames, {7: 'ordinary_traffic', 8: 'queue_lead'}, 3.)
        self.assertEqual(result['final_front_queue'][0]['initial_role'], 'ordinary_traffic')
        self.assertTrue(result['scripted_events']['queue_lead']['completed_before_window'])
        self.assertFalse(result['runtime_policy_change_justified'])
        self.assertEqual(result['final_lead_history']['nearest_front_vehicle_frames'], 3)

    def test_completion_and_continuous_presence_are_not_inferred(self):
        samples, frames = self.evidence()
        samples[0]['scenario']['events']['queue_lead']['transitions'] = []
        frames[1]['actors'] = []
        result = summarize(samples, frames, {7: 'queue_lead'}, 3.)
        self.assertFalse(result['scripted_events']['queue_lead']['completed_before_window'])
        self.assertEqual(result['final_lead_history']['missing_frames'], 1)
        self.assertEqual(result['terminal_joint_stationary_observation']['frames'], 1)
        self.assertEqual(result['terminal_joint_stationary_observation']['duration_s'], 0.)

    def test_absent_corridor_or_invalid_window_cannot_be_reported_as_queue(self):
        samples, frames = self.evidence()
        for value in (float('nan'), float('inf'), 0.):
            with self.subTest(window=value), self.assertRaises(ValueError):
                summarize(samples, frames, {}, value)
        frames[-1]['actors'] = []
        with self.assertRaises(ValueError):
            summarize(samples, frames, {}, 3.)

    def test_native_final_sample_cannot_be_joined_to_a_different_recorded_frame(self):
        samples, frames = self.evidence()
        samples[0].update(frame=13, mode='NORMAL')
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'telemetry').mkdir()
            (root / 'metadata.json').write_text(json.dumps({'config': {
                'seed_partition': 'DEVELOPMENT', 'scenario_seed': 1703, 'driver_id': 'NORMAL'}}))
            (root / 'telemetry' / 'frames.jsonl').write_text(
                ''.join(json.dumps(frame) + '\n' for frame in frames))
            report = {'scenario_id': 'EGYPT_URBAN_CHAOS_V1', 'seed': 1703, 'samples': samples,
                      'pair': {'runs': {'NORMAL': {'recording': str(root), 'driver_id': 'NORMAL'}},
                               'manifest': {'initial_conditions': {'actors': []}}}}
            path = root / 'report.json'
            path.write_text(json.dumps(report))
            with self.assertRaisesRegex(ValueError, 'frame/time aligned'):
                audit(path, 3.)
