from dataclasses import replace
import io
import json
import logging
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import MagicMock
from backend.core.contracts import *
from backend.core.events import *
from backend.core.logging import JsonFormatter, LogCategory, log
from backend.core.lifecycle import *
from backend.core.recording import RunRecorder
from backend.core.replay import ReplayReader, ReplaySession
from backend.core.evaluation import *
from tests.core_packets import packet, sensor, command, metadata, TRANSFORM


class RecordingReplayTests(unittest.TestCase):
    def test_run_roundtrip_seek_pause_events_and_explicit_fixture_provenance(self):
        with tempfile.TemporaryDirectory() as directory:
            with RunRecorder(directory, metadata()) as recorder:
                recorder.record(packet())
                recorder.record(packet(2, .1))
                recorder.record_event(SimulationEvent(EventType.EmergencyStop, 2, .1, {'reason': 'test-only'}))
                root = recorder.root
            with self.assertRaisesRegex(ValueError, 'Test fixture'):
                ReplayReader(root)
            reader = ReplayReader(root, allow_test_data=True)
            self.assertEqual(list(reader.frames()), [packet(), packet(2, .1)])
            self.assertEqual(reader.seek(.09).frame_id, 1)
            self.assertEqual(reader.seek(99).frame_id, 2)
            self.assertEqual([event.event_type for event in reader.events()],
                             [EventType.RunRecordingStarted, EventType.EmergencyStop, EventType.RunRecordingStopped])
            now = [10.]
            session = ReplaySession(reader, now=lambda: now[0])
            now[0] += .1
            self.assertEqual(session.current().frame_id, 2)
            session.set_paused(True)
            session.seek(.05)
            now[0] += 5
            self.assertEqual(session.current().frame_id, 1)
            self.assertEqual(session.mode, 'REPLAY')
            session.close()
            with self.assertRaises(RuntimeError):
                session.current()

    def test_assets_reference_files_not_json_bytes_and_missing_files_fail(self):
        with tempfile.TemporaryDirectory() as directory:
            with RunRecorder(directory, metadata()) as recorder:
                asset = recorder.store_asset('rgb', '1.png', b'test fixture bytes, not a sensor image', 'image/png')
                observed = replace(sensor('rgb'), kind=SensorKind.RGB, data={}, units={}, asset=asset)
                recorder.record(packet(sensors=(observed,)))
                with self.assertRaises(ValueError):
                    recorder.record(packet(2, .1, sensors=(replace(observed, frame_id=2, timestamp_s=.1,
                                                                asset=AssetReference('rgb/missing.png', 'image/png')),)))
            reader = ReplayReader(recorder.root, allow_test_data=True)
            self.assertEqual(reader.asset_path(reader.frame_at(0).sensors[0]).read_bytes(), b'test fixture bytes, not a sensor image')
            self.assertNotIn('test fixture bytes', (recorder.root/'telemetry/frames.jsonl').read_text())

    def test_duplicate_out_of_order_and_closed_recording_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            recorder = RunRecorder(directory, metadata())
            recorder.record(packet(2, .1))
            for frame in (packet(2, .1), packet()):
                with self.assertRaises(ValueError):
                    recorder.record(frame)
            recorder.close()
            recorder.close()
            with self.assertRaises(RuntimeError):
                recorder.record(packet(3, .15))

    def test_truncated_invalid_or_empty_run_does_not_replay(self):
        with tempfile.TemporaryDirectory() as directory:
            with RunRecorder(directory, metadata()) as recorder:
                pass
            with self.assertRaisesRegex(ValueError, 'no recorded'):
                ReplayReader(recorder.root, allow_test_data=True)
            path = recorder.root/'telemetry/frames.jsonl'
            path.write_text(json.dumps(to_dict(packet())))
            with self.assertRaisesRegex(ValueError, 'truncated'):
                ReplayReader(recorder.root, allow_test_data=True)


class EventLoggingTests(unittest.TestCase):
    def test_all_event_types_filter_unsubscribe_and_immutable_payloads(self):
        bus, received, emergencies = EventBus(), [], []
        stop = bus.subscribe(received.append)
        bus.subscribe(emergencies.append, EventType.EmergencyStop)
        for kind in EventType:
            event = SimulationEvent(kind, None, None, {'details': [1]})
            bus.publish(event)
        self.assertEqual(len(received), len(EventType))
        self.assertEqual(len(emergencies), 1)
        with self.assertRaises(TypeError):
            received[0].payload['value'] = 2
        stop()
        bus.publish(SimulationEvent(EventType.SimulationStopped, 1, .05, {}))
        self.assertEqual(len(received), len(EventType))

    def test_subscriber_failure_is_visible_and_other_subscriber_still_receives(self):
        bus, received = EventBus(), []
        def fail(_):
            raise ValueError('recorder failed')
        bus.subscribe(fail)
        bus.subscribe(received.append)
        with self.assertRaises(RuntimeError):
            bus.publish(SimulationEvent(EventType.ConnectionLost, None, None, {}))
        self.assertEqual(len(received), 1)

    def test_structured_logs_keep_run_frame_simulation_time_and_utc(self):
        stream = io.StringIO()
        logger = logging.getLogger('simulation')
        handler = logging.StreamHandler(stream)
        handler.setFormatter(JsonFormatter())
        old_level, old_propagate = logger.level, logger.propagate
        logger.setLevel(logging.INFO)
        logger.propagate = False
        logger.addHandler(handler)
        try:
            log(LogCategory.SAFETY, 'expired', frame_id=100, timestamp_s=5., run_id='test-run', source='MANUAL')
            record = json.loads(stream.getvalue())
            self.assertEqual((record['frame_id'], record['simulation_timestamp_s'], record['run_id']), (100, 5., 'test-run'))
            self.assertIn('timestamp_utc', record)
            with self.assertRaises(ValueError):
                log(LogCategory.CONTROL, 'invalid', throttle=float('nan'))
        finally:
            logger.removeHandler(handler)
            logger.setLevel(old_level)
            logger.propagate = old_propagate


class EvaluationTests(unittest.TestCase):
    def test_ttc_and_route_edge_cases(self):
        self.assertEqual(time_to_collision(10., 2.), 5.)
        self.assertIsNone(time_to_collision(10., 0.))
        self.assertIsNone(time_to_collision(10., -2.))
        self.assertEqual(time_to_collision(0., 2.), 0.)
        self.assertIsNone(time_to_collision(1e308, 1e-308))
        for values in ((-1, 2), (float('nan'), 2), (10, float('inf'))):
            with self.assertRaises(ValueError):
                time_to_collision(*values)
        self.assertEqual(route_completion_percent(5, 10), 50.)
        self.assertEqual(route_completion_percent(20, 10), 100.)
        with self.assertRaises(ValueError):
            route_completion_percent(2, 0)

    def test_known_packet_metrics_and_completed_braking_episode(self):
        collision = CollisionEvent(3, 2., 1, 2, (3., 4., 0.), 'test-coordinate-frame')
        actor = ActorState(1, 0., 2, 'vehicle', TRANSFORM, (0., 0., 0.))
        frames = [replace(packet(1, 0., speed=10., accel=-2., brake=1), ground_truth=SimulatorGroundTruth(1, 0., (GroundTruthObject(actor, 12.),))),
                  packet(2, 1., speed=5., accel=-4., x=7., brake=1), packet(3, 2., speed=0., accel=0., x=9., collisions=(collision,))]
        events = [SimulationEvent(EventType.ControlChanged, 2, 1., {'manual_intervention': True}),
                  SimulationEvent(EventType.EmergencyStop, 2, 1., {})]
        result = evaluate(frames, events, ttc_samples=((10., 2.), (15., 3.), (10., -1.)), route_progress=(9., 20.))
        self.assertEqual(result.collision_count, 1)
        self.assertEqual(result.collision_impulse_total_ns, 5.)
        self.assertEqual(result.minimum_object_distance_m, 12.)
        self.assertEqual(result.minimum_ttc_s, 5.)
        self.assertEqual(result.maximum_deceleration_mps2, 4.)
        self.assertEqual(result.maximum_jerk_mps3, 4.)
        self.assertEqual(result.average_speed_mps, 5.)
        self.assertEqual(result.braking_distance_m, 9.)
        self.assertEqual((result.manual_intervention_count, result.emergency_stop_count), (1, 1))
        self.assertEqual(result.route_completion_percent, 45.)

    def test_unknown_metrics_are_null_and_invalid_sequences_fail(self):
        result = evaluate([])
        self.assertIsNone(result.average_speed_mps)
        self.assertIsNone(result.minimum_object_distance_m)
        self.assertIsNone(result.minimum_ttc_s)
        self.assertIsNone(result.braking_distance_m)
        self.assertEqual(result.simulation_duration_s, 0.)
        with self.assertRaises(ValueError):
            evaluate([packet(), packet()])
        self.assertIsNone(evaluate([packet(), packet(2, .1, brake=1)]).braking_distance_m)


class LifecycleTests(unittest.TestCase):
    def test_timeout_generation_and_allowed_reconnection(self):
        now = [0.]
        lifecycle = ConnectionLifecycle(.2, now=lambda: now[0])
        attempt = lifecycle.begin()
        with self.assertRaises(RuntimeError):
            lifecycle.begin()
        now[0] = .3
        self.assertEqual(lifecycle.poll(), ConnectionState.ERROR)
        self.assertFalse(lifecycle.connected(attempt))
        generation = lifecycle.begin()
        self.assertTrue(lifecycle.connected(generation))
        lifecycle.disconnect()
        self.assertEqual(lifecycle.state, ConnectionState.DISCONNECTED)

    def test_successful_connection_clean_disconnect_and_reconnect(self):
        provider = MagicMock()
        provider.is_connected.return_value = True
        supervisor = ConnectionSupervisor(.5)
        supervisor.connect(provider)
        self.assertEqual(supervisor.lifecycle.state, ConnectionState.CONNECTED)
        supervisor.disconnect()
        provider.close.assert_called_once()
        supervisor.connect(provider)
        supervisor.disconnect()
        self.assertEqual(provider.connect.call_count, 2)
        self.assertEqual(provider.close.call_count, 2)

    def test_late_completion_is_cleaned_and_cannot_claim_connection(self):
        released = threading.Event()
        provider = MagicMock()
        provider.connect.side_effect = lambda: released.wait(1)
        provider.is_connected.return_value = True
        supervisor = ConnectionSupervisor(.02)
        try:
            with self.assertRaises(TimeoutError):
                supervisor.connect(provider)
            with self.assertRaises(RuntimeError):
                supervisor.connect(provider)
        finally:
            released.set()
            supervisor.thread.join(1)
        self.assertEqual(supervisor.lifecycle.state, ConnectionState.ERROR)
        provider.close.assert_called_once()

    def test_provider_failure_and_failed_native_confirmation_never_connect(self):
        for error in (True, False):
            provider = MagicMock()
            if error:
                provider.connect.side_effect = RuntimeError('unavailable')
            provider.is_connected.return_value = False
            supervisor = ConnectionSupervisor(.5)
            with self.assertRaises(RuntimeError):
                supervisor.connect(provider)
            self.assertEqual(supervisor.lifecycle.state, ConnectionState.ERROR)
            provider.close.assert_called_once()
