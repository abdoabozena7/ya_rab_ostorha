"""Frame diagnostics and bounded sensor synchronization, without a physics clock."""
from collections import OrderedDict, deque
from dataclasses import dataclass, replace
from enum import Enum
import threading
import time
from .contracts import SensorFrame, SimulationFrame, WorldState, finite


class FrameIssue(str, Enum):
    MISSING = 'MISSING'
    LATE = 'LATE'
    STALE = 'STALE'
    DUPLICATE = 'DUPLICATE'
    OUT_OF_ORDER = 'OUT_OF_ORDER'
    TIMESTAMP_MISMATCH = 'TIMESTAMP_MISMATCH'


@dataclass(frozen=True)
class FrameDiagnostic:
    stream_id: str
    frame_id: int
    issues: frozenset[FrameIssue]
    missing_range: tuple[int, int] | None = None

    @property
    def accepted(self):
        return not self.issues & {FrameIssue.DUPLICATE, FrameIssue.STALE, FrameIssue.TIMESTAMP_MISMATCH}


class FrameTracker:
    def __init__(self, *, expected_stride=1, max_lag_frames=32, max_age_s=2, history_size=256):
        max_age_s = finite(max_age_s, 'max_age_s')
        if any(type(value) is not int for value in (expected_stride, max_lag_frames, history_size)):
            raise ValueError('Frame tracking limits must be integers')
        if expected_stride < 1 or max_lag_frames < 0 or max_age_s <= 0 or history_size < 1:
            raise ValueError('Invalid frame tracking configuration')
        self.stride, self.max_lag, self.max_age = expected_stride, max_lag_frames, max_age_s
        self.seen = OrderedDict()
        self.history_size = history_size
        self.latest_frame = -1
        self.latest_timestamp = -1

    def observe(self, stream_id, frame_id, timestamp_s):
        if type(frame_id) is not int or frame_id < 0 or finite(timestamp_s) < 0:
            raise ValueError('Invalid frame ID/time')
        issues, missing = set(), None
        if frame_id in self.seen:
            issues.add(FrameIssue.DUPLICATE)
            if abs(self.seen[frame_id]-timestamp_s) > 1e-6:
                issues.add(FrameIssue.TIMESTAMP_MISMATCH)
        elif frame_id < self.latest_frame:
            issues.update((FrameIssue.LATE, FrameIssue.OUT_OF_ORDER))
            if frame_id < self.latest_frame-self.max_lag or timestamp_s < self.latest_timestamp-self.max_age:
                issues.add(FrameIssue.STALE)
        else:
            if self.latest_frame >= 0 and frame_id > self.latest_frame+self.stride:
                issues.add(FrameIssue.MISSING)
                missing = (self.latest_frame+self.stride, frame_id-self.stride)
            if self.latest_frame >= 0 and timestamp_s <= self.latest_timestamp:
                issues.add(FrameIssue.TIMESTAMP_MISMATCH)
        result = FrameDiagnostic(stream_id, frame_id, frozenset(issues), missing)
        if result.accepted:
            self.seen[frame_id] = timestamp_s
            while len(self.seen) > self.history_size:
                self.seen.popitem(last=False)
            if frame_id > self.latest_frame:
                self.latest_frame, self.latest_timestamp = frame_id, timestamp_s
        return result


class SimulationClock:
    """Tracks native simulation time; measures host receipt separately."""
    def __init__(self, now=time.monotonic):
        self.now = now
        self.tracker = FrameTracker()
        self.frame_id = self.timestamp_s = self.received_monotonic_s = None

    def observe(self, world: WorldState):
        result = self.tracker.observe('world', world.frame_id, world.timestamp_s)
        if result.accepted and (self.frame_id is None or world.frame_id > self.frame_id):
            self.frame_id, self.timestamp_s = world.frame_id, world.timestamp_s
            self.received_monotonic_s = self.now()
        return result

    def stale(self, timeout_s):
        return self.received_monotonic_s is None or self.now()-self.received_monotonic_s > timeout_s


class SensorSynchronizer:
    """Anchor on a native vehicle/world frame. Never substitute adjacent frames.

    Required completion may emit before optional sensors arrive; a timeout or
    explicit capacity eviction emits an incomplete frame. Late data for a closed
    frame is reported and discarded. Receipt ordering is independent of frame ID.
    """
    def __init__(self, required=(), optional=(), *, timeout_s=.25, max_pending=64, sensor_frame_strides=None, now=time.monotonic):
        self.required, self.optional = frozenset(required), frozenset(optional)
        timeout_s = finite(timeout_s, 'timeout_s')
        if self.required & self.optional or timeout_s <= 0 or type(max_pending) is not int or max_pending < 1:
            raise ValueError('Invalid sensor synchronization configuration')
        self.timeout_s, self.max_pending, self.now = timeout_s, max_pending, now
        self.pending, self.trackers = {}, {}
        self.sensor_frame_strides = dict(sensor_frame_strides or {})
        if any(type(value) is not int or value < 1 for value in self.sensor_frame_strides.values()):
            raise ValueError('Sensor frame strides must be positive integers')
        self.ready = deque()
        self.diagnostics = deque(maxlen=256)
        self.closed_through = -1
        self.lock = threading.RLock()

    def begin(self, frame: SimulationFrame):
        with self.lock:
            if frame.frame_id <= self.closed_through:
                return FrameDiagnostic('world', frame.frame_id, frozenset({FrameIssue.LATE}))
            entry = self.pending.setdefault(frame.frame_id, {'started': self.now(), 'anchor': None, 'sensors': {}})
            if entry['anchor'] is not None:
                return FrameDiagnostic('world', frame.frame_id, frozenset({FrameIssue.DUPLICATE}))
            entry['anchor'] = replace(frame, sensors=())
            for sensor in frame.sensors:
                self.receive(sensor)
            self._bound_pending()
            return FrameDiagnostic('world', frame.frame_id, frozenset())

    def receive(self, sensor: SensorFrame):
        with self.lock:
            tracker = self.trackers.setdefault(sensor.sensor_id, FrameTracker(expected_stride=self.sensor_frame_strides.get(sensor.sensor_id, 1)))
            result = tracker.observe(sensor.sensor_id, sensor.frame_id, sensor.timestamp_s)
            if sensor.frame_id <= self.closed_through:
                return FrameDiagnostic(sensor.sensor_id, sensor.frame_id, result.issues | {FrameIssue.LATE, FrameIssue.STALE})
            if not result.accepted:
                return result
            if self.required | self.optional and sensor.sensor_id not in self.required | self.optional:
                raise ValueError('Sensor not configured for this synchronizer')
            entry = self.pending.setdefault(sensor.frame_id, {'started': self.now(), 'anchor': None, 'sensors': {}})
            if entry['anchor'] and abs(sensor.timestamp_s-entry['anchor'].timestamp_s) > 1e-6:
                result = FrameDiagnostic(sensor.sensor_id, sensor.frame_id, result.issues | {FrameIssue.TIMESTAMP_MISMATCH})
                self.diagnostics.append(result)
                return result
            entry['sensors'][sensor.sensor_id] = sensor
            self._bound_pending()
            return result

    def _bound_pending(self):
        while len(self.pending) > self.max_pending:
            frame_id = min(self.pending)
            entry = self.pending.pop(frame_id)
            self.closed_through = max(self.closed_through, frame_id)
            if entry['anchor']:
                if len(self.ready) >= self.max_pending:
                    raise RuntimeError('Synchronizer output queue overflow; drain completed frames')
                self.ready.append(self._assemble(entry))
            else:
                self.diagnostics.append(FrameDiagnostic('unanchored', frame_id, frozenset({FrameIssue.STALE})))

    def _assemble(self, entry):
        anchor = entry['anchor']
        matched = {name: sensor for name, sensor in entry['sensors'].items()
                   if abs(sensor.timestamp_s-anchor.timestamp_s) <= 1e-6}
        return replace(anchor, sensors=tuple(matched[name] for name in sorted(matched)),
                       missing_required_sensors=tuple(sorted(self.required-set(matched))),
                       missing_optional_sensors=tuple(sorted(self.optional-set(matched))))

    def drain(self, *, force=False):
        with self.lock:
            output = list(self.ready)
            self.ready.clear()
            for frame_id in sorted(tuple(self.pending)):
                entry = self.pending[frame_id]
                expired = self.now()-entry['started'] >= self.timeout_s
                over_capacity = len(self.pending) > self.max_pending
                anchor = entry['anchor']
                if anchor is None:
                    if expired or over_capacity or force:
                        del self.pending[frame_id]
                        self.closed_through = max(self.closed_through, frame_id)
                        continue  # No vehicle/world observation exists; cannot invent an anchor.
                    break
                matched = {name: sensor for name, sensor in entry['sensors'].items()
                           if abs(sensor.timestamp_s-anchor.timestamp_s) <= 1e-6}
                missing = self.required-set(matched)
                if missing and not (expired or over_capacity or force):
                    break
                output.append(self._assemble(entry))
                del self.pending[frame_id]
                self.closed_through = frame_id
            return output


SynchronizedFrame = SimulationFrame
