"""Versioned run directories with bounded JSONL rows and separate binary assets."""
from datetime import datetime, timezone
from collections.abc import Mapping
from dataclasses import fields, is_dataclass
from enum import Enum
import hashlib
import gzip
import json
from pathlib import Path
import threading
import shutil
from .contracts import AssetReference, ExperimentMetadata, SimulationFrame, to_dict
from .events import EventType, SimulationEvent
from .logging import log, LogCategory

MAX_ROW_BYTES = 1_048_576


def queued_snapshot(value):
    """Own mutable producer data and charge a conservative memory/wire bound.

    JSON encoding happens once, on the writer. Strings include the worst-case
    escaped representation; container/object overhead is included in the charge.
    """
    kind=type(value)
    if kind is str:return value,64+len(value)*6
    if kind in (int,float,bool,type(None)):return value,64
    if isinstance(value,Mapping):
        result={};size=256
        for key,item in value.items():
            copied,charge=queued_snapshot(item);result[key]=copied
            size+=charge+128+len(str(key))*6
        return result,size
    if isinstance(value,(tuple,list)):
        result=[];size=64
        for item in value:
            copied,charge=queued_snapshot(item);result.append(copied);size+=charge+16
        return result,size
    if is_dataclass(value):return queued_snapshot({f.name:getattr(value,f.name) for f in fields(value)})
    if isinstance(value,str):return value,64+len(value)*6
    return value,64


class BufferedRunRecorder:
    """Bounded disk writer; immutable native bytes leave the tick thread.

    Uses the existing versioned writer and checksum validation. Queue exhaustion
    or disk errors stop admission; no frames are silently dropped.
    """
    def __init__(self, recorder, *, capacity=128, maximum_bytes=64*1024*1024):
        from queue import Queue
        if type(capacity) is not int or capacity<=0 or type(maximum_bytes) is not int or maximum_bytes<=0:
            raise ValueError('Recording queue requires positive finite item/byte bounds')
        self.writer = recorder
        self.root, self.metadata = recorder.root, recorder.metadata
        # Includes command events as well as frames. Bound a short presentation
        # episode's disk lag without letting file scanning stall sensor freshness.
        self.queue = Queue(maxsize=capacity)
        self.maximum_bytes=maximum_bytes;self.queued_bytes=0
        self.stats_lock=threading.Lock();self.stopping=threading.Event()
        self.dropped_frames=0;self.dropped_events=0;self.dropped_trace_rows=0;self.first_dropped_frame=None;self.last_dropped_frame=None
        self.written_frames=0;self.incomplete=False
        if isinstance(recorder,RunRecorder):recorder.autoflush=False
        self.error = None
        self.closed = False
        if isinstance(self.root,Path):
            # A process crash or full disk must leave a durable incomplete
            # marker; absence of a final flush is never a valid finished replay.
            (self.root/'recording-status.json').write_text(json.dumps({**self.status(),
                'incomplete':True,'error':'RECORDING_NOT_FINALIZED'}),encoding='utf8')
        self.thread = threading.Thread(target=self._run, name='native-recording', daemon=True)
        self.thread.start()

    def _put(self, item, size=0):
        from queue import Full
        if self.stopping.is_set(): raise RuntimeError('Recording is closed')
        with self.stats_lock:
            rejected=self.incomplete or self.error or self.queued_bytes+size>self.maximum_bytes
            if not rejected:
                try:self.queue.put_nowait((item,size));self.queued_bytes+=size;return True
                except Full:pass
            # Stop admitting subsequent frames: the saved prefix keeps original
            # time/IDs. Control never waits for storage or raises its disk error.
            self.incomplete=True
            self._lost(item)
        return False

    def submit(self, frame, assets):
        return self._put(('frame', (frame, assets)),sum(len(data) for _,data in assets))

    def record_event(self, event):
        return self._put(('event', event))

    def record_trace(self,row):
        snapshot,size=queued_snapshot(row)
        return self._put(('trace',snapshot),size)

    def record_video(self, sensor, data):
        return self._put(('video',(sensor,data)),len(data))

    def record_safety(self, row):
        snapshot,size=queued_snapshot(row)
        return self._put(('safety',snapshot),size)

    def status(self):
        with self.stats_lock:
            return {'incomplete':self.incomplete or self.error is not None,'error':str(self.error) if self.error else None,
                    'dropped_frames':self.dropped_frames,'dropped_events':self.dropped_events,'dropped_trace_rows':self.dropped_trace_rows,
                    'first_dropped_frame':self.first_dropped_frame,'last_dropped_frame':self.last_dropped_frame,
                    'written_frames':self.written_frames,'queued_bytes':self.queued_bytes,'pending_items':self.queue.qsize(),
                    'finalized':self.closed}

    def finish(self):
        """Seal admission immediately; drain and finalize away from control."""
        self.stopping.set()

    def _lost(self,item):
        if item[0]=='frame':
            frame=item[1][0];self.dropped_frames+=1
            self.first_dropped_frame=frame.frame_id if self.first_dropped_frame is None else min(self.first_dropped_frame,frame.frame_id)
            self.last_dropped_frame=frame.frame_id if self.last_dropped_frame is None else max(self.last_dropped_frame,frame.frame_id)
        elif item[0] in ('trace','safety'):self.dropped_trace_rows+=1
        else:self.dropped_events+=1

    def _run(self):
        item=None
        try:
            while True:
                from queue import Empty
                try:item,size=self.queue.get(timeout=.05)
                except Empty:
                    if self.stopping.is_set():break
                    if isinstance(self.writer,RunRecorder):self.writer.flush()
                    continue
                kind, value = item
                if self.written_frames and self.written_frames%16 == 0 and shutil.disk_usage(self.root).free < 128*1024*1024:
                    raise OSError(28, 'Recording stopped before exhausting the disk reserve; recorded prefix preserved')
                if kind == 'event': self.writer.record_event(value)
                elif kind=='trace':self.writer.record_trace(value)
                elif kind=='safety':self.writer.record_safety(value)
                elif kind=='video':self.writer.record_video(*value)
                else:
                    frame, assets = value
                    for asset, data in assets:
                        folder, filename = asset.path.split('/', 1)
                        if self.writer.store_asset(folder, filename, data, asset.media_type) != asset:
                            raise RuntimeError('Recorded bytes differ from native sensor reference')
                    if isinstance(self.writer,RunRecorder):self.writer.record(frame,assets_verified=True)
                    else:self.writer.record(frame)
                    self.written_frames+=1
                    if self.written_frames%16==0 and isinstance(self.writer,RunRecorder):self.writer.flush()
                with self.stats_lock:self.queued_bytes-=size
                item=None
        except Exception as error:
            with self.stats_lock:
                self.error = error;self.incomplete=True
                if item is not None:self._lost(item);self.queued_bytes-=size
                while not self.queue.empty():
                    pending,pending_size=self.queue.get_nowait();self._lost(pending);self.queued_bytes-=pending_size
        finally:
            try: self.writer.close()
            except Exception as error: self.error = error
            self.closed=True
            if isinstance(self.root,Path):
                try:
                    temporary=self.root/'recording-status.tmp'
                    temporary.write_text(json.dumps(self.status(),indent=2),encoding='utf8')
                    temporary.replace(self.root/'recording-status.json')
                except OSError as error:self.error=error

    def close(self):
        self.stopping.set()
        self.thread.join(timeout=15)
        if self.thread.is_alive(): raise RuntimeError('Recording writer did not close')
        if self.error: raise RuntimeError('Recording failed: '+str(self.error))


def _json_default(value):
    # Let the C encoder traverse numeric forecast tuples directly. Walking
    # every float through to_dict in the writer thread still competes with
    # control for the GIL, even though disk writes themselves are buffered.
    if is_dataclass(value):return {field.name:getattr(value,field.name) for field in fields(value)}
    if isinstance(value,Enum):return value.value
    if isinstance(value,Mapping):return dict(value.items())
    raise TypeError(f'Object of type {type(value).__name__} is not JSON serializable')


def _json_text(value):
    return json.dumps(value,default=_json_default,allow_nan=False,separators=(',',':'))


def encode_row(value):
    row = (_json_text(value)+'\n').encode('utf-8')
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


def read_trace_row(root, row):
    """Resolve a checksummed, losslessly stored large control prediction."""
    if 'prediction_asset' not in row:return row
    reference=AssetReference(**row['prediction_asset'])
    path=resolve_asset(root,reference)
    with gzip.open(path,'rb') as stream:
        data=stream.read(32*MAX_ROW_BYTES+1)
    if len(data)>32*MAX_ROW_BYTES:raise ValueError('Control prediction asset exceeds its size bound')
    return {**row,'prediction':json.loads(data)}


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
        self.autoflush=True
        self.trace_file=None
        self.safety_file=None
        self.video_file=None
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

    def record(self, frame: SimulationFrame, *, assets_verified=False):
        if not isinstance(frame, SimulationFrame) or frame.world.provider != self.metadata.provider:
            raise ValueError('Frame must match recorder contract/provider provenance')
        with self.lock:
            if self.closed:
                raise RuntimeError('Recorder is closed')
            if self.last_frame is not None and (frame.frame_id <= self.last_frame or frame.timestamp_s <= self.last_timestamp):
                raise ValueError('Recording frames must increase; duplicates/out-of-order frames are rejected')
            for sensor in frame.sensors:
                if sensor.asset and not assets_verified:
                    resolve_asset(self.root, sensor.asset)
            self.frames_file.write(encode_row(frame))
            if self.autoflush:self.frames_file.flush()
            self.last_frame, self.last_timestamp = frame.frame_id, frame.timestamp_s

    def record_event(self, event):
        if not isinstance(event, SimulationEvent):
            raise ValueError('Expected a SimulationEvent')
        with self.lock:
            if self.closed:
                raise RuntimeError('Recorder is closed')
            self.events_file.write(encode_row(event))
            if self.autoflush:self.events_file.flush()

    def flush(self):
        with self.lock:
            self.frames_file.flush();self.events_file.flush()
            if self.trace_file:self.trace_file.flush()
            if self.safety_file:self.safety_file.flush()

    def record_trace(self,row):
        with self.lock:
            if self.closed:raise RuntimeError('Recorder is closed')
            if self.trace_file is None:self.trace_file=(self.root/'telemetry/comparison-controls.jsonl').open('xb')
            wire=dict(row)
            if 'prediction' in wire:
                data=_json_text(wire['prediction']).encode('utf8')
                if len(data)>MAX_ROW_BYTES//2:
                    if len(data)>32*MAX_ROW_BYTES:raise ValueError('Control prediction asset exceeds its size bound')
                    compressed=gzip.compress(data,compresslevel=1,mtime=0)
                    digest=hashlib.sha256(compressed).hexdigest()
                    filename='telemetry/prediction-'+digest+'.json.gz'
                    target=self.root/filename
                    if not target.exists():
                        with target.open('xb') as stream:stream.write(compressed)
                    wire.pop('prediction')
                    wire.update(trace_version=2,prediction_asset=to_dict(AssetReference(filename,'application/gzip',len(compressed),digest)))
            self.trace_file.write(encode_row(wire))
            if self.autoflush:self.trace_file.flush()

    def record_safety(self, row):
        with self.lock:
            if self.closed: raise RuntimeError('Recorder is closed')
            if self.safety_file is None: self.safety_file=(self.root/'telemetry/safety-v2.jsonl').open('xb')
            self.safety_file.write(encode_row(row))
            if self.autoflush: self.safety_file.flush()

    def record_video(self, sensor, data):
        if sensor.sensor_id != 'drivingCamera' or not sensor.asset:
            raise ValueError('Expected original native driving-camera bytes')
        folder,filename=sensor.asset.path.split('/',1)
        stored=self.store_asset(folder,filename,data,sensor.asset.media_type)
        if stored != sensor.asset: raise ValueError('Driving-camera bytes changed before recording')
        with self.lock:
            if self.video_file is None:self.video_file=(self.root/'telemetry/video-frames.jsonl').open('xb')
            self.video_file.write(encode_row({'sensor_id':sensor.sensor_id,'frame_id':sensor.frame_id,
                'timestamp_s':sensor.timestamp_s,'asset':to_dict(sensor.asset),'calibration':to_dict(sensor.metadata),
                'world_transform':to_dict(sensor.transform)}))
            if self.autoflush:self.video_file.flush()

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
                if self.trace_file:self.trace_file.close()
                if self.safety_file:self.safety_file.close()
                if self.video_file:self.video_file.close()
                self.closed = True
                log(LogCategory.RECORDING, 'RunRecordingStopped', run_id=self.metadata.run_id,
                    frame_id=self.last_frame, timestamp_s=self.last_timestamp)

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
