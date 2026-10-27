from dataclasses import replace
import unittest
from unittest.mock import patch

from backend.core.contracts import freeze_json, to_dict
from backend.core.control_scene import ControlSceneBuilder
from backend.core.pipeline_timing import command_trace, observed_control, sensor_timing, summarize_timing
from tests.core_packets import packet, sensor
from tests import test_control_scene as scene_fixtures
from tests import test_braking_decisions as braking_fixtures


class PipelineTimingTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scene, cls.command, reader = scene_fixtures.ControlSceneTests().measured()
        cls.reader = staticmethod(reader)

    def trace(self):
        keys = ('first_required_sensor_received', 'last_required_sensor_received', 'required_sensors_encoded',
                'frame_complete', 'scene_build_started', 'prediction_started', 'prediction_completed',
                'scene_published', 'maneuver_selection_started', 'maneuver_selection_completed',
                'execution_shield_started', 'execution_shield_completed', 'application_checked',
                'carla_control_called', 'carla_control_returned')
        stages = dict(zip(keys, (100., 100.02, 100.03, 100.04, 100.05, 100.06, 100.08,
                                100.09, 100.1, 100.12, 100.13, 100.14, 100.15, 100.16, 100.17)))
        scene = replace(self.scene, timing_metadata=freeze_json({
            'source': 'LIVE_SYNCHRONIZER_HOST_MONOTONIC', 'issues': []}))
        timing = {'session_id': 'test', 'frame_id': self.command.frame_id,
                  'source_frame': scene.observation.frame_id, 'simulation_age_s': .05,
                  'fresh_aligned': True, 'stages_monotonic_s': stages}
        return command_trace(timing, scene, self.command, acknowledged=True, actor_id=1)

    def observation(self):
        frame = packet(self.command.frame_id + 1, self.command.timestamp_s + .05)
        return replace(frame, vehicle=replace(frame.vehicle, **{
            k: getattr(self.command, k) for k in ('throttle', 'brake', 'steering', 'reverse', 'handbrake')}))

    def test_required_sensor_callbacks_encoding_and_sync_completion_are_distinct(self):
        first = replace(sensor('first'), metadata={'received_monotonic_s': 100., 'encoded_monotonic_s': 100.04})
        last = replace(sensor('last'), metadata={'received_monotonic_s': 100.02, 'encoded_monotonic_s': 100.03})
        optional = replace(sensor('optional'), metadata={'received_monotonic_s': 1., 'encoded_monotonic_s': 2.})
        result = sensor_timing(packet(sensors=(first, last, optional)), ('first', 'last'), 100.05)
        self.assertEqual(result['issues'], [])
        self.assertEqual(result['stages'], {
            'first_required_sensor_received': 100., 'last_required_sensor_received': 100.02,
            'required_sensors_encoded': 100.04, 'frame_complete': 100.05})

    def test_missing_or_invalid_sensor_clocks_never_look_like_zero_latency(self):
        result = sensor_timing(packet(sensors=(sensor(),)), ('imu', 'missing'), 100.)
        self.assertIsNone(result['stages']['first_required_sensor_received'])
        self.assertIsNone(result['stages']['required_sensors_encoded'])
        self.assertEqual(len(result['issues']), 4)
        broken = replace(sensor(), metadata={'received_monotonic_s': 100., 'encoded_monotonic_s': 99.})
        self.assertIn('SENSOR_CLOCK_ORDER:imu', sensor_timing(packet(sensors=(broken,)), ('imu',), 100.)['issues'])

    def test_scene_uses_separate_timing_not_policy_calibration_or_replay_epoch(self):
        timing = {'source': 'LIVE_SYNCHRONIZER_HOST_MONOTONIC', 'issues': [],
                  'stages': {'first_required_sensor_received': 100., 'frame_complete': 100.08}}
        with patch('backend.core.control_scene.monotonic', return_value=100.1):
            built = ControlSceneBuilder('test').build(self.scene.observation, self.reader,
                received_wall_s=100., sensor_timing=timing)
        self.assertEqual(built.stages_wall_s['frame_complete'], 100.08)
        self.assertEqual(built.stages_wall_s['scene_build_started'], 100.1)
        self.assertEqual(built.timing_metadata['source'], 'LIVE_SYNCHRONIZER_HOST_MONOTONIC')
        self.assertTrue(all('received_monotonic_s' not in c.calibration for c in built.observation.channels))
        self.assertIsNone(self.scene.stages_wall_s['frame_complete'])
        self.assertIn('SENSOR_TIMING_NOT_CAPTURED', self.scene.timing_metadata['issues'])
        self.assertFalse(built.usable(built.observation.timestamp_s, 100.251))
        self.assertFalse(built.usable(built.observation.timestamp_s + .101, 100.1))

    def test_rpc_acknowledgement_is_not_physical_application_evidence(self):
        trace = self.trace()
        self.assertAlmostEqual(trace['intervals_ms']['sensor_to_rpc_return_ms'], 170.)
        self.assertEqual(trace['application_status'], 'SUBMITTED_NOT_OBSERVED')
        self.assertTrue(trace['server_acknowledged'])
        self.assertIsNone(trace['exact_physical_application_timestamp_s'])
        observed = observed_control(trace, self.observation(), 100.19)
        self.assertEqual(observed['application_status'], 'MATCHING_CONTROL_STATE')
        self.assertAlmostEqual(observed['sensor_to_observed_control_ms'], 190.)
        self.assertTrue(observed['application_time_is_upper_bound'])
        self.assertFalse(observed['command_identity_proven'])
        self.assertIsNone(observed['exact_physical_application_timestamp_s'])
        self.assertAlmostEqual(observed['sensor_simulation_age_at_observation_s'], .05)

    def test_control_echo_cannot_substitute_for_actual_vehicle_state(self):
        trace = self.trace()
        observation = self.observation()
        wrong = replace(observation, control=self.command, vehicle=replace(observation.vehicle, brake=1., throttle=0.))
        result = observed_control(trace, wrong, 100.19)
        self.assertEqual(result['application_status'], 'CONTROL_STATE_MISMATCH')
        self.assertIsNone(result['sensor_to_observed_control_ms'])
        for frame, wall, status in (
            (packet(self.command.frame_id, self.command.timestamp_s), 100.19, 'NO_NEW_NATIVE_FRAME'),
            (replace(observation, vehicle=replace(observation.vehicle, actor_id=99)), 100.19, 'VEHICLE_CHANGED'),
            (observation, 100.15, 'INVALID_HOST_CLOCK'),
        ):
            self.assertEqual(observed_control(trace, frame, wall)['application_status'], status)

    def test_p95_target_is_strict_and_missing_or_mismatched_frames_prevent_a_pass(self):
        trace = self.trace()
        observed = observed_control(trace, self.observation(), 100.19)
        result = summarize_timing([trace, observed])
        self.assertTrue(result['proposed_target_met'])
        self.assertFalse(result['native_acceptance'])
        self.assertFalse(result['real_time_verified'])
        exactly = {**observed, 'sensor_to_observed_control_ms': 200.}
        self.assertFalse(summarize_timing([trace, exactly])['proposed_target_met'])
        for rows in ([trace], [trace, {**observed, 'application_status': 'CONTROL_STATE_MISMATCH'}],
                     [{**trace, 'timing_issues': ['SENSOR_CLOCK_ORDER:first']}, observed],
                     [{**trace, 'fresh_at_check': False}, observed],
                     [trace, {**observed, 'sensor_to_observed_control_ms': -1.}]):
            result = summarize_timing(rows)
            self.assertFalse(result['complete_timing_evidence'])
            self.assertIsNone(result['proposed_target_met'])
        for rows in ([], [trace, trace], [trace, {**observed, 'trace_id': 'unrelated'}]):
            with self.assertRaises(ValueError):
                summarize_timing(rows)

    def test_service_records_submission_and_later_native_observation_without_a_control_change(self):
        service, _, _ = braking_fixtures.fixture(driving_mode='NORMAL')
        captured = []
        original = command_trace
        with patch('backend.core.pipeline_timing.command_trace',
                   side_effect=lambda *a, **k: captured.append(original(*a, **k)) or captured[-1]):
            service._iteration()
        self.assertEqual(len(captured), 1)
        self.assertEqual(service.application_observation['trace_id'], captured[0]['trace_id'])
        self.assertEqual(captured[0]['command'], to_dict(service.provider.apply_control.call_args.args[0]))
        self.assertIsNone(service.application_observation['exact_physical_application_timestamp_s'])


if __name__ == '__main__':
    unittest.main()
