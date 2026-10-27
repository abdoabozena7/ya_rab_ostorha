"""Read-only dashboard service for recorded observations; never ticks a world."""
from .core.contracts import to_dict, SensorKind
from .core.dashboard import dashboard_frame
from .core.replay import ReplaySession
from .core.logging import log, LogCategory


class ReplayService:
    is_replay = True

    def __init__(self, reader, now=None):
        self.session = ReplaySession(reader, **({'now': now} if now else {}))
        self.error = None
        self.frame_indices = {entry[2]: i for i, entry in enumerate(reader.index)}
        log(LogCategory.REPLAY, 'Replay opened', run_id=reader.metadata.run_id)

    def snapshot(self):
        frame = self.session.current()
        diagnostic = self.session.reader.safety_at(frame.frame_id)
        return {'connected': False, 'available': True, 'provider': 'replay', 'mode': 'REPLAY',
                'sessionId': diagnostic.get('session_id') if diagnostic else self.session.reader.metadata.run_id,
                'safetySystem': diagnostic.get('safety') if diagnostic else None, 'stopDiagnostics': diagnostic,
                'connectionState': 'DISCONNECTED', 'error': None, 'sequence': frame.frame_id,
                'controller': False, 'controlSource': frame.control.source.value if frame.control else None,
                'replay': {'runId': self.session.reader.metadata.run_id,
                           'recordedProvider': self.session.reader.metadata.provider,
                           'paused': self.session.paused, 'dataOrigin': self.session.reader.metadata.data_origin.value},
                **dashboard_frame(frame)}

    get_vehicle_state = snapshot

    def require_connected(self):
        raise RuntimeError('MODE: REPLAY — recorded observations only; native commands are disabled')

    def release_controls(self):
        pass  # Replay has no command sink.

    def get_sensor_frame(self, name):
        for sensor in self.session.current().sensors:
            if sensor.sensor_id == name:
                return to_dict(sensor)
        raise KeyError(name)

    def get_camera_frame(self, frame_id=None):
        frame = self.session.current() if frame_id is None else self.session.reader.frame_at(self.frame_indices[frame_id]) if frame_id in self.frame_indices else None
        if frame is None:
            return None, None
        for sensor in frame.sensors:
            if sensor.kind == SensorKind.RGB and sensor.asset:
                return self.session.reader.asset_bytes(sensor), {'frame': sensor.frame_id, 'timestamp': sensor.timestamp_s,
                                                                           'contentType': sensor.asset.media_type}
        return None, None

    def get_sensor_asset(self, name, frame_id=None):
        frame = self.session.current() if frame_id is None else self.session.reader.frame_at(self.frame_indices[frame_id]) if frame_id in self.frame_indices else None
        if frame:
            for sensor in frame.sensors:
                if sensor.sensor_id == name and sensor.asset:
                    return self.session.reader.asset_bytes(sensor), {'frame': sensor.frame_id,
                        'timestamp': sensor.timestamp_s, 'contentType': sensor.asset.media_type}
        raise KeyError(name)

    def set_paused(self, paused):
        self.session.set_paused(paused)

    def seek(self, timestamp_s):
        return self.session.seek(timestamp_s)

    def close(self):
        self.session.close()
        log(LogCategory.REPLAY, 'Replay closed', run_id=self.session.reader.metadata.run_id)
