from dataclasses import replace
import unittest
from backend.core.timing import *
from backend.core.control import *
from tests.core_packets import packet, sensor, command


class TimingTests(unittest.TestCase):
    def test_missing_late_duplicate_stale_and_out_of_order(self):
        tracker = FrameTracker(max_lag_frames=2, max_age_s=1)
        tracker.observe('rgb', 10, 1.)
        gap = tracker.observe('rgb', 12, 1.2)
        self.assertEqual(gap.missing_range, (11, 11))
        self.assertIn(FrameIssue.MISSING, gap.issues)
        late = tracker.observe('rgb', 11, 1.1)
        self.assertTrue(late.accepted)
        self.assertEqual(late.issues, {FrameIssue.LATE, FrameIssue.OUT_OF_ORDER})
        self.assertFalse(tracker.observe('rgb', 11, 1.1).accepted)
        self.assertIn(FrameIssue.STALE, tracker.observe('rgb', 1, .1).issues)

    def test_timestamp_mismatch_and_sensor_stride(self):
        for value in (float('nan'), float('inf'), True):
            with self.assertRaises(ValueError):
                FrameTracker(max_age_s=value)
            with self.assertRaises(ValueError):
                SensorSynchronizer(timeout_s=value)
        tracker = FrameTracker(expected_stride=4)
        tracker.observe('gnss', 4, .2)
        self.assertNotIn(FrameIssue.MISSING, tracker.observe('gnss', 8, .4).issues)
        self.assertFalse(tracker.observe('gnss', 12, .1).accepted)
        self.assertIn(FrameIssue.TIMESTAMP_MISMATCH, tracker.observe('gnss', 8, .41).issues)

    def test_clock_keeps_host_receipt_separate_from_simulation_time(self):
        now = [100.]
        clock = SimulationClock(now=lambda: now[0])
        clock.observe(packet().world)
        self.assertEqual(clock.timestamp_s, .05)
        self.assertEqual(clock.received_monotonic_s, 100.)
        now[0] += 2
        self.assertTrue(clock.stale(.75))
        clock.observe(packet().world)
        self.assertTrue(clock.stale(.75))  # Duplicate packets cannot freshen stalled time.

    def test_required_optional_and_asynchronous_arrivals(self):
        sync = SensorSynchronizer(required=('rgb', 'depth', 'imu'), optional=('radar',))
        sync.receive(sensor('depth'))  # Arrives before the vehicle anchor.
        sync.begin(packet())
        sync.receive(sensor('imu'))
        self.assertEqual(sync.drain(), [])
        sync.receive(sensor('rgb'))
        result, = sync.drain()
        self.assertTrue(result.complete)
        self.assertEqual(result.missing_optional_sensors, ('radar',))
        self.assertEqual({item.frame_id for item in result.sensors}, {1})

    def test_timeout_marks_incomplete_without_neighbor_substitution(self):
        now = [0.]
        sync = SensorSynchronizer(required=('rgb',), timeout_s=.2, now=lambda: now[0])
        sync.begin(packet())
        sync.receive(sensor('rgb', 2, .1))
        now[0] = .21
        result, = sync.drain()
        self.assertFalse(result.complete)
        self.assertEqual(result.missing_required_sensors, ('rgb',))
        self.assertEqual(result.sensors, ())
        late = sync.receive(sensor('rgb'))
        self.assertIn(FrameIssue.STALE, late.issues)

    def test_duplicate_time_mismatch_and_ordered_emission(self):
        sync = SensorSynchronizer(required=('imu',))
        sync.begin(packet())
        sync.begin(packet(2, .1))
        sync.receive(sensor('imu', 2, .1))
        self.assertEqual(sync.drain(), [])
        sync.receive(sensor())
        self.assertIn(FrameIssue.DUPLICATE, sync.receive(sensor()).issues)
        self.assertEqual([frame.frame_id for frame in sync.drain()], [1, 2])
        sync = SensorSynchronizer(required=('imu',))
        sync.begin(packet())
        sync.receive(sensor(timestamp_s=.06))
        result, = sync.drain(force=True)
        self.assertFalse(result.complete)

    def test_bounded_pending_and_sensor_stride_configuration(self):
        sync = SensorSynchronizer(required=('imu',), max_pending=2, sensor_frame_strides={'imu': 2})
        for index in range(1, 5):
            sync.begin(packet(index, index*.05))
        result = sync.drain(force=True)
        self.assertEqual([frame.frame_id for frame in result], [1, 2, 3, 4])
        self.assertTrue(all(not frame.complete for frame in result))
        self.assertEqual(sync.pending, {})
        sync = SensorSynchronizer(max_pending=2)
        for index in range(1, 8):
            sync.receive(sensor(frame_id=index, timestamp_s=index*.05))
        self.assertLessEqual(len(sync.pending), 2)
        self.assertTrue(sync.diagnostics)


class ControlTests(unittest.TestCase):
    def fixture(self, automation=False):
        now = [10.]
        safety = ControlSafetyLayer(now=lambda: now[0], max_rate_hz=20)
        machine = ControlStateMachine(allow_automation=automation)
        machine.transition(ControlMode.MANUAL, connected=True)
        return CommandArbiter(safety, machine), now

    def test_clamp_invalid_numbers_and_brake_power_interlock(self):
        for field in ('command_timeout_s', 'max_sim_age_s', 'future_tolerance_s', 'max_rate_hz'):
            for value in (float('nan'), float('inf'), True):
                with self.assertRaises(ValueError):
                    ControlSafetyLayer(**{field: value})
        data = command().__dict__
        normalized = ControlSafetyLayer.normalize({**data, 'throttle': 2., 'brake': -.2, 'steering': -3.})
        self.assertEqual((normalized.throttle, normalized.brake, normalized.steering), (1., 0., -1.))
        self.assertEqual(ControlSafetyLayer.normalize({**data, 'brake': .3}).throttle, 0)
        self.assertEqual(ControlSafetyLayer.normalize({**data, 'handbrake': True}).throttle, 0)
        for value in (float('nan'), float('inf'), True, '1'):
            with self.assertRaises(ValueError):
                ControlSafetyLayer.normalize({**data, 'throttle': value})

    def test_timestamp_validation_rate_limits_and_timeout(self):
        arbiter, now = self.fixture()
        for value in (command(frame_id=2), command(timestamp_s=2)):
            with self.assertRaises(ValueError):
                arbiter.submit(value, frame_id=1, timestamp_s=.05, connected=True)
        with self.assertRaises(ValueError):
            arbiter.submit(command(timestamp_s=0), frame_id=20, timestamp_s=1., connected=True)
        arbiter.submit(command(), frame_id=1, timestamp_s=.05, connected=True)
        with self.assertRaises(ValueError):
            arbiter.submit(command(), frame_id=1, timestamp_s=.05, connected=True)
        now[0] += .4
        chosen = arbiter.choose(frame_id=2, timestamp_s=.1, connected=True)
        self.assertEqual((chosen.throttle, chosen.brake), (0., 1.))
        self.assertEqual(arbiter.machine.mode, ControlMode.PAUSED)

    def test_no_automatic_ai_and_allowed_transitions(self):
        arbiter, _ = self.fixture()
        self.assertEqual(arbiter.machine.mode, ControlMode.MANUAL)
        with self.assertRaises(ValueError):
            arbiter.machine.transition(ControlMode.ASSISTED, connected=True, explicit=True)
        with self.assertRaises(ValueError):
            arbiter.submit(command(CommandSource.AI), frame_id=1, timestamp_s=.05, connected=True)
        with self.assertRaises(RuntimeError):
            arbiter.submit(command(), frame_id=1, timestamp_s=.05, connected=False)

    def test_safety_then_manual_override_then_ai_and_no_resumption(self):
        arbiter, now = self.fixture(automation=True)
        arbiter.machine.transition(ControlMode.ASSISTED, connected=True, explicit=True)
        arbiter.machine.transition(ControlMode.AI, connected=True, explicit=True)
        arbiter.submit(command(CommandSource.AI), frame_id=1, timestamp_s=.05, connected=True)
        self.assertEqual(arbiter.choose(frame_id=1, timestamp_s=.05, connected=True).source, CommandSource.AI)
        arbiter.submit(command(), frame_id=1, timestamp_s=.05, connected=True)
        self.assertEqual(arbiter.machine.mode, ControlMode.MANUAL)
        self.assertEqual(arbiter.choose(frame_id=1, timestamp_s=.05, connected=True).source, CommandSource.MANUAL)
        arbiter.submit(command(CommandSource.SAFETY, brake=1, throttle=0), frame_id=1, timestamp_s=.05, connected=True)
        self.assertEqual(arbiter.choose(frame_id=1, timestamp_s=.05, connected=True).source, CommandSource.SAFETY)
        now[0] += .4
        self.assertEqual(arbiter.choose(frame_id=2, timestamp_s=.1, connected=True).throttle, 0)
        self.assertNotIn(CommandSource.AI, arbiter.safety.latest)

    def test_emergency_stop_latch_acknowledgement_and_disconnect(self):
        arbiter, _ = self.fixture()
        arbiter.submit(command(), frame_id=1, timestamp_s=.05, connected=True)
        arbiter.emergency_stop(connected=True)
        self.assertEqual(arbiter.choose(frame_id=1, timestamp_s=.05, connected=True).brake, 1)
        with self.assertRaises(RuntimeError):
            arbiter.submit(command(), frame_id=1, timestamp_s=.05, connected=True)
        with self.assertRaises(ValueError):
            arbiter.machine.transition(ControlMode.MANUAL, connected=True)
        with self.assertRaises(ValueError):
            arbiter.machine.transition(ControlMode.PAUSED, connected=True)
        arbiter.acknowledge_stop(connected=True)
        self.assertEqual(arbiter.machine.mode, ControlMode.PAUSED)
        arbiter.disconnect()
        self.assertEqual(arbiter.machine.mode, ControlMode.DISCONNECTED)
        self.assertEqual(arbiter.safety.latest, {})
