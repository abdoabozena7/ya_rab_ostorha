"""Read recorded observations, never a SimulationProvider or physics model."""
from bisect import bisect_right
import json
from pathlib import Path
import threading
import time
from .contracts import DataOrigin, ExperimentMetadata, SimulationFrame, from_dict
from .events import SimulationEvent
from .recording import MAX_ROW_BYTES, resolve_asset


class ReplayReader:
    def __init__(self, run_directory, *, allow_test_data=False):
        self.root = Path(run_directory).resolve()
        self.metadata = from_dict(ExperimentMetadata, json.loads((self.root/'metadata.json').read_text(encoding='utf-8-sig')))
        if self.metadata.data_origin != DataOrigin.REAL_SIMULATION and not allow_test_data:
            raise ValueError('Test fixture recordings cannot be opened in the user dashboard')
        self.path = self.root/'telemetry/frames.jsonl'
        self.index = []  # Only offsets/timestamps are indexed; image/cloud bytes stay on disk.
        with self.path.open('rb') as file:
            previous = None
            while True:
                offset = file.tell()
                row = file.readline(MAX_ROW_BYTES+1)
                if not row:
                    break
                frame = self._decode(row)
                if previous and (frame.frame_id <= previous.frame_id or frame.timestamp_s <= previous.timestamp_s):
                    raise ValueError('Replay contains duplicate/out-of-order frames')
                self.index.append((frame.timestamp_s, offset, frame.frame_id))
                previous = frame
        if not self.index:
            raise ValueError('Run contains no recorded observations')
        self.timestamps = [entry[0] for entry in self.index]

    def _decode(self, row):
        if len(row) > MAX_ROW_BYTES or not row.endswith(b'\n'):
            raise ValueError('Oversized or truncated recording row')
        frame = from_dict(SimulationFrame, json.loads(row))
        if frame.world.provider != self.metadata.provider:
            raise ValueError('Replay provider provenance mismatch')
        return frame

    def frame_at(self, index):
        if type(index) is not int or not 0 <= index < len(self.index):
            raise ValueError('Replay frame index out of range')
        with self.path.open('rb') as file:
            file.seek(self.index[index][1])
            return self._decode(file.readline(MAX_ROW_BYTES+1))

    def seek(self, timestamp_s):
        from .contracts import finite
        timestamp_s = finite(timestamp_s)
        return self.frame_at(max(0, min(len(self.index)-1, bisect_right(self.timestamps, timestamp_s)-1)))

    def frames(self):
        for index in range(len(self.index)):
            yield self.frame_at(index)

    def events(self):
        with (self.root/'events/events.jsonl').open('rb') as file:
            while True:
                row = file.readline(MAX_ROW_BYTES+1)
                if not row:
                    break
                if len(row) > MAX_ROW_BYTES or not row.endswith(b'\n'):
                    raise ValueError('Invalid event row')
                yield from_dict(SimulationEvent, json.loads(row))

    def asset_path(self, sensor):
        if sensor.asset is None:
            raise ValueError('Recorded sensor has no file reference')
        return resolve_asset(self.root, sensor.asset)


class ReplaySession:
    mode = 'REPLAY'

    def __init__(self, reader, now=time.monotonic):
        self.reader, self.now = reader, now
        self.lock = threading.RLock()
        self.base_timestamp_s = reader.index[0][0]
        self.started = now()
        self.paused = False
        self.closed = False

    def current(self):
        with self.lock:
            if self.closed:
                raise RuntimeError('Replay is closed')
            target = self.base_timestamp_s + (0 if self.paused else self.now()-self.started)
            return self.reader.seek(target)

    def set_paused(self, paused):
        if type(paused) is not bool:
            raise ValueError('Replay paused must be boolean')
        with self.lock:
            if paused == self.paused:
                return
            if paused:
                self.base_timestamp_s += self.now()-self.started
            self.started, self.paused = self.now(), paused

    def seek(self, timestamp_s):
        with self.lock:
            frame = self.reader.seek(timestamp_s)
            self.base_timestamp_s, self.started = frame.timestamp_s, self.now()
            return frame

    def close(self):
        with self.lock:
            self.closed = True
