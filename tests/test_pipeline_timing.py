from dataclasses import replace
import math
import threading
import time
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch

from backend.carla.sensors import CarlaSensorManager
from backend.core.contracts import freeze_json, to_dict
from backend.core.control_scene import ControlSceneBuilder
from backend.core.pipeline_timing import command_trace, observed_control, sensor_timing, summarize_timing
from tests.core_packets import packet, sensor
from tests import test_control_scene as scene_fixtures
from tests import test_braking_decisions as braking_fixtures
from scripts.native.validate_crossing_pair import native_timing_counters


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


class NativeTimingCounterTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.scene, _, _ = scene_fixtures.ControlSceneTests().measured()
        cls.next_scene, _, _ = scene_fixtures.ControlSceneTests().measured(frame=2)

    def fixture(self):
        provider = NS(last_world={'frame': 1, 'timestamp': .05},
            step_timing_ms={'before_native': 2., 'native_tick': 10., 'scenario_audit': 3.,
                            'population': 1., 'telemetry_and_spectator': 4.})
        service = NS(session_id='test', observation=packet(), clock=NS(frame_id=1, timestamp_s=.05),
            application_timing={'session_id': 'test', 'frame_id': 1, 'source_frame': 1},
            control_timing_ms={'behavior': 22., 'behavior_thread_cpu': 1.5, 'since_publication': None},
            control_scene=replace(self.scene, timings_ms=freeze_json({
                'lidar_decode': 4., 'depth_decode_and_fusion': 12., 'thread_cpu': 2.5})))
        return service, provider

    def test_native_counters_are_immutable_copies_with_explicit_current_producer_identities(self):
        service, provider = self.fixture()
        counters = native_timing_counters(service, provider)
        self.assertEqual(to_dict(counters['current']),
                         {'session_id': 'test', 'frame_id': 1, 'timestamp_s': .05})
        self.assertEqual(to_dict(counters['sample']), {'frame_id': 1, 'timestamp_s': .05})
        self.assertEqual(counters['capture_point'], 'AFTER_CONTROL_BEFORE_NATIVE_STEP')
        for name, expected, binding in (
            ('provider', provider.step_timing_ms, {'frame_id': 1, 'timestamp_s': .05}),
            ('control', service.control_timing_ms, {'session_id': 'test', 'frame_id': 1, 'source_frame': 1}),
            ('scene', service.control_scene.timings_ms,
             {'session_id': 'test', 'frame_id': 1, 'timestamp_s': .05}),
        ):
            self.assertEqual(counters[name]['status'], 'AVAILABLE')
            self.assertEqual(to_dict(counters[name]['values_ms']), to_dict(expected))
            self.assertEqual(to_dict(counters[name]['binding']), binding)
            self.assertEqual(to_dict(counters[name]['unavailable_reasons']), [])
            with self.assertRaises(TypeError):
                counters[name]['values_ms']['invented'] = 0.
        self.assertEqual(counters['scene']['source'], 'service.control_scene.timings_ms')
        provider.step_timing_ms['native_tick'] = 999.
        service.control_timing_ms['behavior_thread_cpu'] = 888.
        provider.last_world['frame'] = 2
        self.assertEqual(counters['provider']['values_ms']['native_tick'], 10.)
        self.assertEqual(counters['control']['values_ms']['behavior_thread_cpu'], 1.5)
        self.assertEqual(counters['provider']['binding']['frame_id'], 1)
        self.assertEqual(counters['scene']['values_ms']['thread_cpu'], 2.5)

    def test_stale_or_missing_producer_bindings_never_look_like_current_counters(self):
        cases = (
            ('provider', lambda s, p: p.last_world.update(frame=0), 'STALE_BINDING:frame_id'),
            ('provider', lambda s, p: p.last_world.update(timestamp=0.), 'STALE_BINDING:timestamp_s'),
            ('provider', lambda s, p: setattr(p, 'last_world', None), 'BINDING_NOT_CAPTURED:frame_id'),
            ('control', lambda s, p: s.application_timing.update(frame_id=0), 'STALE_BINDING:frame_id'),
            ('control', lambda s, p: s.application_timing.update(source_frame=0), 'STALE_BINDING:source_frame'),
            ('control', lambda s, p: s.application_timing.update(session_id='old'), 'STALE_BINDING:session_id'),
            ('control', lambda s, p: s.application_timing.clear(), 'BINDING_NOT_CAPTURED:frame_id'),
            ('scene', lambda s, p: setattr(s, 'control_scene', self.next_scene), 'STALE_BINDING:frame_id'),
            ('scene', lambda s, p: setattr(s, 'control_scene', replace(s.control_scene, session_id='old')),
             'STALE_BINDING:session_id'),
            ('scene', lambda s, p: setattr(s, 'control_scene', None), 'BINDING_NOT_CAPTURED:frame_id'),
        )
        for name, invalidate, reason in cases:
            with self.subTest(producer=name, reason=reason):
                service, provider = self.fixture()
                invalidate(service, provider)
                result = native_timing_counters(service, provider)[name]
                self.assertEqual(result['status'], 'UNAVAILABLE')
                self.assertIsNone(result['values_ms'])
                self.assertIn(reason, result['unavailable_reasons'])

    def test_sample_and_current_native_frame_must_match_without_rebinding_the_sample(self):
        for field, value, reason in (
            ('frame_id', 2, 'SAMPLE_BINDING_MISMATCH:frame_id'),
            ('timestamp_s', .1, 'SAMPLE_BINDING_MISMATCH:timestamp_s'),
            ('frame_id', None, 'CURRENT_BINDING_NOT_CAPTURED:frame_id'),
        ):
            with self.subTest(field=field, value=value):
                service, provider = self.fixture()
                setattr(service.clock, field, value)
                result = native_timing_counters(service, provider)
                self.assertEqual(to_dict(result['sample']), {'frame_id': 1, 'timestamp_s': .05})
                for name in ('provider', 'control', 'scene'):
                    self.assertEqual(result[name]['status'], 'UNAVAILABLE')
                    self.assertIsNone(result[name]['values_ms'])
                    self.assertIn(reason, result[name]['unavailable_reasons'])

    def test_missing_empty_invalid_and_partial_counters_have_explicit_unavailability(self):
        for name, owner, attribute in (
            ('provider', 'provider', 'step_timing_ms'),
            ('control', 'service', 'control_timing_ms'),
            ('scene', 'scene', 'timings_ms'),
        ):
            for value, reason in ((None, 'COUNTERS_NOT_CAPTURED'), ({}, 'COUNTERS_NOT_CAPTURED'),
                                  ({'bad': float('nan')}, 'INVALID_COUNTERS:bad must be a finite number')):
                with self.subTest(producer=name, value=value):
                    service, provider = self.fixture()
                    if owner == 'scene':
                        service.control_scene = replace(service.control_scene, timings_ms=value)
                    else:
                        setattr(provider if owner == 'provider' else service, attribute, value)
                    result = native_timing_counters(service, provider)[name]
                    self.assertEqual(result['status'], 'UNAVAILABLE')
                    self.assertIsNone(result['values_ms'])
                    self.assertIn(reason, result['unavailable_reasons'])
        service, provider = self.fixture()
        del provider.step_timing_ms['native_tick']
        del service.control_timing_ms['behavior_thread_cpu']
        service.control_scene = replace(service.control_scene, timings_ms=freeze_json({'lidar_decode': 4.}))
        result = native_timing_counters(service, provider)
        for name, missing in (('provider', 'native_tick'), ('control', 'behavior_thread_cpu'), ('scene', 'thread_cpu')):
            self.assertEqual(result[name]['status'], 'PARTIAL')
            self.assertIn('COUNTER_NOT_CAPTURED:' + missing, result[name]['unavailable_reasons'])
            self.assertNotIn(missing, result[name]['values_ms'])


class SensorDecodeCpuTimingTests(unittest.TestCase):
    def fixture(self, decode, *, sensor_id='imu', blueprint='sensor.other.imu'):
        from tests.test_carla_provider import fixture, transform
        world, ego, _, _ = fixture()
        actor = Mock(id=151, is_alive=True, attributes={})
        actor.destroy.return_value = True
        world.spawn_actor.return_value = actor
        manager = CarlaSensorManager(world, ego)
        manager.spawn(sensor_id, blueprint, transform(), {'sensor_tick': .05}, decode)
        self.addCleanup(manager.close)
        return manager, actor.listen.call_args.args[0], NS(frame=1, timestamp=.05, transform=transform())

    def test_same_callback_thread_cpu_delta_is_separate_from_original_wall_clocks_and_payload(self):
        original = replace(sensor(), metadata={'original': 'retained'})
        threads = []
        readings = iter((7., 7.003))
        def thread_clock():
            threads.append(threading.get_ident())
            return next(readings)
        def decode(data):
            threads.append(threading.get_ident())
            return original
        manager, callback, data = self.fixture(decode)
        manager.capture_times[1] = (49.9, 899.9)
        with patch('backend.carla.sensors.monotonic', side_effect=(50.02, 50.06, 50.08)), \
             patch('backend.carla.sensors.time.thread_time', side_effect=thread_clock) as cpu:
            self.assertTrue(callback(data, 50., 900.))
        result, = manager.drain_frames()
        self.assertEqual(threads, [threading.get_ident()]*3)
        self.assertEqual(cpu.call_count, 2)
        self.assertEqual(to_dict(result.data), to_dict(original.data))
        self.assertEqual(result.frame_id, original.frame_id)
        self.assertEqual(result.sensor_timestamp_s, original.sensor_timestamp_s)
        clocks = result.metadata
        self.assertEqual(clocks['original'], 'retained')
        for key, expected in (('received_monotonic_s', 50.), ('received_unix_s', 900.),
                              ('capture_monotonic_s', 49.9), ('capture_unix_s', 899.9),
                              ('encoded_monotonic_s', 50.06)):
            self.assertEqual(clocks[key], expected)
        self.assertEqual(clocks['capture_clock'], 'NATIVE_TICK_REQUEST')
        self.assertAlmostEqual(clocks['queue_wait_ms'], 20.)
        self.assertAlmostEqual(clocks['decode_duration_ms'], 60.)
        self.assertAlmostEqual(clocks['decode_thread_cpu_ms'], 3.)
        self.assertTrue(math.isfinite(clocks['decode_thread_cpu_ms']))
        self.assertGreaterEqual(clocks['decode_thread_cpu_ms'], 0.)
        self.assertEqual(manager.latest()['imu']['receivedMonotonic'], 50.)

    def test_decode_cpu_metadata_preserves_original_lidar_bytes_and_schema(self):
        import hashlib
        import struct
        from backend.core.contracts import SensorKind
        from backend.carla.sensor_decoders import decode_sensor
        def decode(data):
            return decode_sensor(manager, 'lidar', SensorKind.LIDAR, data, data.transform, {'sensor_tick': .05})
        manager, callback, data = self.fixture(decode, sensor_id='lidar', blueprint='sensor.lidar.ray_cast')
        data.raw_data = struct.pack('<4f', 1., 2., 3., .5)
        data.channels, data.horizontal_angle = 16, .25
        self.assertTrue(callback(data))
        result, = manager.drain_frames()
        self.assertEqual(manager.asset_bytes(result.asset), data.raw_data)
        self.assertEqual(result.asset.sha256, hashlib.sha256(data.raw_data).hexdigest())
        self.assertEqual(result.asset.byte_count, len(data.raw_data))
        self.assertEqual(result.asset.path, 'lidar/lidar-151-1.bin')
        self.assertEqual((result.frame_id, result.timestamp_s, result.sensor_timestamp_s), (1, .05, .05))
        self.assertEqual(to_dict(result.data), {})
        self.assertEqual(to_dict(result.units), {'x': 'm', 'y': 'm', 'z': 'm', 'intensity': 'unitless'})
        self.assertEqual(result.metadata['point_count'], 1)
        self.assertEqual(result.metadata['dtype'], 'little-endian float32')
        self.assertEqual(result.metadata['channels'], 16)
        self.assertEqual(result.metadata['horizontal_angle_rad'], .25)
        self.assertTrue(math.isfinite(result.metadata['decode_thread_cpu_ms']))
        self.assertGreaterEqual(result.metadata['decode_thread_cpu_ms'], 0.)

    def test_real_thread_clock_does_not_count_decode_sleep_as_cpu(self):
        def decode(data):
            # Outlast Windows' quantized thread CPU accounting.
            time.sleep(.1)
            return sensor()
        manager, callback, data = self.fixture(decode)
        self.assertTrue(callback(data))
        result, = manager.drain_frames()
        cpu = result.metadata['decode_thread_cpu_ms']
        wall = result.metadata['decode_duration_ms']
        self.assertTrue(math.isfinite(cpu))
        self.assertGreaterEqual(cpu, 0.)
        self.assertGreaterEqual(wall-cpu, 50.)
        self.assertEqual(result.metadata['capture_clock'], 'SENSOR_RECEIPT_PROXY')

    def test_decode_warmup_schema_and_payload_errors_do_not_publish_fake_measurements(self):
        from backend.signals.multirate import SensorWarmup
        def invalid_schema(data):
            return replace(sensor(), data={'compass_rad': float('nan')})
        for decode, error, warmup in (
            (Mock(side_effect=SensorWarmup('waiting for samples')), 'waiting for samples', True),
            (Mock(side_effect=ValueError('bad native bytes')), 'bad native bytes', False),
            (lambda data: object(), 'Unexpected decoded sensor payload: imu', False),
            (invalid_schema, 'value must be a finite number', False),
        ):
            with self.subTest(error=error):
                manager, callback, data = self.fixture(decode)
                self.assertFalse(callback(data))
                self.assertEqual(manager.drain_frames(), ())
                self.assertEqual(manager.latest(), {})
                self.assertEqual((manager.warmup if warmup else manager.errors)['imu'], error)
                self.assertEqual(manager.active_callbacks, 0)


if __name__ == '__main__':
    unittest.main()
