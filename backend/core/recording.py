"""Versioned run directories with bounded JSONL rows and separate binary assets."""
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import threading
from .contracts import AssetReference, ExperimentMetadata, SimulationFrame, to_dict
from .events import EventType, SimulationEvent
from .logging import log, LogCategory

MAX_ROW_BYTES = 1_048_576


class BufferedRunRecorder:
    """Bounded demo disk writer; immutable native bytes leave the tick thread.

    Uses the existing versioned writer and checksum validation. Queue exhaustion
    or disk errors stop admission; no frames are silently dropped.
    """
    def __init__(self, recorder):
        from queue import Queue
        self.writer = recorder
        self.root, self.metadata = recorder.root, recorder.metadata
        # Includes command events as well as frames. Bound a short presentation
        # episode's disk lag without letting file scanning stall sensor freshness.
        self.queue = Queue(maxsize=640)
        self.error = None
        self.closed = False
        self.thread = threading.Thread(target=self._run, name='comparison-recording', daemon=True)
        self.thread.start()

    def _put(self, item):
        from queue import Full
        if self.error: raise RuntimeError('Demo recording failed: '+str(self.error))
        if self.closed: raise RuntimeError('Demo recording is closed')
        try: self.queue.put(item, timeout=.1)
        except Full: raise RuntimeError('Demo recording queue exhausted; disk cannot keep up')

    def submit(self, frame, assets):
        self._put(('frame', (frame, assets)))

    def record_event(self, event):
        self._put(('event', event))

    def _run(self):
        try:
            while True:
                item = self.queue.get()
                if item is None: break
                kind, value = item
                if kind == 'event': self.writer.record_event(value)
                else:
                    frame, assets = value
                    for asset, data in assets:
                        folder, filename = asset.path.split('/', 1)
                        if self.writer.store_asset(folder, filename, data, asset.media_type) != asset:
                            raise RuntimeError('Recorded bytes differ from native sensor reference')
                    self.writer.record(frame)
        except Exception as error:
            self.error = error
        finally:
            try: self.writer.close()
            except Exception as error: self.error = error

    def close(self):
        if self.closed: return
        if self.thread.is_alive(): self.queue.put(None, timeout=10)
        self.thread.join(timeout=15)
        self.closed = True
        if self.thread.is_alive(): raise RuntimeError('Demo recording writer did not close')
        if self.error: raise RuntimeError('Demo recording failed: '+str(self.error))


def encode_row(value):
    row = (json.dumps(to_dict(value), allow_nan=False, separators=(',', ':'))+'\n').encode('utf-8')
    if len(row) > MAX_ROW_BYTES:
        raise ValueError('Recording row exceeds 1 MiB; store large sensor payloads as asset references')
    return row


def resolve_asset(root, asset):
    target = (Path(root)/asset.path).resolve()
    if not target.is_relative_to(Path(root).resolve()):
        raise ValueError('Asset escaped its run directory')
    if not target.is_file():
        raise ValueError(f'Missing recorded asset: {asset.path}')
    if asset.byte_count is not None and target.stat().st_size != asset.byte_count:
        raise ValueError('Recorded asset length mismatch')
    if asset.sha256:
        with target.open('rb') as file:
            if hashlib.file_digest(file, 'sha256').hexdigest() != asset.sha256:
                raise ValueError('Recorded asset checksum mismatch')
    return target


class RunRecorder:
    def __init__(self, output_directory, metadata: ExperimentMetadata):
        if not isinstance(metadata, ExperimentMetadata):
            raise ValueError('Run metadata is required')
        self.metadata = metadata
        self.root = Path(output_directory)/metadata.run_id
        self.root.mkdir(parents=True, exist_ok=False)
        for name in ('telemetry', 'rgb', 'depth', 'lidar', 'events'):
            (self.root/name).mkdir()
        (self.root/'metadata.json').write_bytes(encode_row(metadata))
        self.frames_file = (self.root/'telemetry/frames.jsonl').open('xb')
        self.events_file = (self.root/'events/events.jsonl').open('xb')
        self.lock = threading.RLock()
        self.last_frame = self.last_timestamp = None
        self.closed = False
        self.record_event(SimulationEvent(EventType.RunRecordingStarted, None, None, {'run_id': metadata.run_id}))
        log(LogCategory.RECORDING, 'RunRecordingStarted', run_id=metadata.run_id)

    def store_asset(self, folder, filename, data, media_type):
        if folder not in ('rgb', 'depth', 'lidar') or not isinstance(data, bytes):
            raise ValueError('Assets require bytes in a declared sensor folder')
        asset = AssetReference(f'{folder}/{filename}', media_type, len(data), hashlib.sha256(data).hexdigest())
        target = self.root/asset.path
        if target.parent != self.root/folder:
            raise ValueError('Asset filename must not contain directories')
        with self.lock:
            if self.closed:
                raise RuntimeError('Recorder is closed')
            with target.open('xb') as file:
                file.write(data)
        return asset

    def record(self, frame: SimulationFrame):
        if not isinstance(frame, SimulationFrame) or frame.world.provider != self.metadata.provider:
            raise ValueError('Frame must match recorder contract/provider provenance')
        with self.lock:
            if self.closed:
                raise RuntimeError('Recorder is closed')
            if self.last_frame is not None and (frame.frame_id <= self.last_frame or frame.timestamp_s <= self.last_timestamp):
                raise ValueError('Recording frames must increase; duplicates/out-of-order frames are rejected')
            for sensor in frame.sensors:
                if sensor.asset:
                    resolve_asset(self.root, sensor.asset)
            self.frames_file.write(encode_row(frame))
            self.frames_file.flush()
            self.last_frame, self.last_timestamp = frame.frame_id, frame.timestamp_s

    def record_event(self, event):
        if not isinstance(event, SimulationEvent):
            raise ValueError('Expected a SimulationEvent')
        with self.lock:
            if self.closed:
                raise RuntimeError('Recorder is closed')
            self.events_file.write(encode_row(event))
            self.events_file.flush()

    def close(self):
        with self.lock:
            if self.closed:
                return
            try:
                self.record_event(SimulationEvent(EventType.RunRecordingStopped, self.last_frame, self.last_timestamp,
                                                  {'run_id': self.metadata.run_id}))
            finally:
                self.frames_file.close()
                self.events_file.close()
                self.closed = True
                log(LogCategory.RECORDING, 'RunRecordingStopped', run_id=self.metadata.run_id,
                    frame_id=self.last_frame, timestamp_s=self.last_timestamp)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
