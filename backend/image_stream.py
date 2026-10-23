"""Independent image sockets: one unacknowledged JPEG, no control ownership."""
import json
import math
import struct
import threading
import time

from .core.host_clock import monotonic

PROTOCOL = 'ostorha-image-v1'
MAX_IMAGE_BYTES = 4*1024*1024
DISPLAY_FIELDS = frozenset(('displayedFrames', 'displayFps', 'p95IntervalMs', 'imageLatencyMs',
    'decodeMs', 'droppedLate', 'droppedSuperseded', 'droppedSession', 'droppedOutOfOrder',
    'clockUncertaintyMs', 'completedWindows', 'failedWindows', 'renderedAtUnixMs'))


def image_packet(data, metadata, session_id, camera_id):
    if not isinstance(data, bytes) or not data or len(data) > MAX_IMAGE_BYTES:
        raise ValueError('Image payload exceeds the bounded JPEG protocol')
    if metadata.get('contentType') != 'image/jpeg':
        raise ValueError('Image stream requires an original JPEG')
    header = {'protocol': PROTOCOL, 'session_id': session_id, 'camera_id': camera_id,
        'frame_id': metadata['frame'], 'simulation_timestamp_s': metadata['timestamp'],
        'width': metadata['width'], 'height': metadata['height'], 'content_type': 'image/jpeg',
        'capture_monotonic_s': metadata.get('captureMonotonic'),
        'capture_unix_s': metadata.get('captureUnix'), 'capture_clock': metadata.get('captureClock'),
        'received_monotonic_s': metadata.get('receivedMonotonic'),
        'encoded_monotonic_s': metadata.get('encodedMonotonic'), 'sent_monotonic_s': monotonic(),
        'jpeg_encode_ms': metadata.get('jpegEncodeMs'), 'payload_bytes': len(data),
        'image_sha256':metadata.get('sha256'),
        'fov_deg': metadata.get('fovDeg'), 'mount_transform': metadata.get('mountTransform'),
        'world_transform': metadata.get('worldTransform')}
    if (type(header['frame_id']) is not int or header['frame_id'] < 0 or
            not isinstance(header['simulation_timestamp_s'], (int, float)) or
            not math.isfinite(header['simulation_timestamp_s']) or header['simulation_timestamp_s'] < 0 or
            any(type(header[k]) is not int or not 0 < header[k] <= 4096 for k in ('width', 'height'))):
        raise ValueError('Invalid native image identity, dimensions or timestamp')
    encoded = json.dumps(header, allow_nan=False, separators=(',', ':')).encode('utf8')
    return struct.pack('!I', len(encoded))+encoded+data


def display_metrics(value):
    if not isinstance(value, dict) or set(value)-DISPLAY_FIELDS:
        raise ValueError('Unknown image presentation metric')
    if any(type(v) not in (int, float) or not math.isfinite(v) or v < 0 for v in value.values()):
        raise ValueError('Image presentation metrics must be finite nonnegative numbers')
    return dict(value)


class ImageStreamBridge:
    def __init__(self, service):
        self.service = service
        self.lock = threading.Lock()
        self.sockets = set()
        self.sent = self.expired = self.ack_timeouts = 0

    def handle(self, socket):
        from websockets.exceptions import ConnectionClosed
        from .core.logging import log, LogCategory
        identity = str(id(socket))
        with self.lock:
            if len(self.sockets) >= 8:
                socket.close(1013, 'Image-stream connection limit reached')
                return
            self.sockets.add(socket)
        try:
            request = json.loads(socket.recv(timeout=3))
            if not isinstance(request, dict) or request.get('type') != 'subscribe':
                raise ValueError('Image stream requires an explicit subscription')
            session = request.get('session_id')
            camera = request.get('camera_id')
            if not isinstance(session, str) or session != self.service.session_id:
                raise ValueError('Image subscription belongs to another session')
            if camera not in ('frontCamera', 'drivingCamera'):
                raise ValueError('Unknown image-stream camera')
            client_time = request.get('client_unix_ms')
            if type(client_time) not in (int, float) or not math.isfinite(client_time):
                raise ValueError('Image clock handshake requires a finite client timestamp')
            socket.send(json.dumps({'type':'image_stream', 'protocol':PROTOCOL, 'session_id':session,
                'camera_id':camera, 'client_unix_ms':client_time, 'server_unix_ms':time.time()*1000,
                'maximum_image_age_ms':250, 'maximum_in_flight':1}))
            previous = None
            last_status = -float('inf')
            while True:
                if session != self.service.session_id:
                    socket.send(json.dumps({'type':'image_status', 'status':'SESSION_CHANGED'}))
                    return
                data, metadata = self.service.get_stream_image(camera)
                key = metadata.get('frame') if metadata else None
                now = monotonic()
                capture = metadata.get('captureMonotonic') if metadata else None
                if data and key != previous and capture is not None and now-capture > .25:
                    previous = key
                    with self.lock:
                        self.expired += 1
                elif data and key != previous:
                    socket.send(image_packet(data, metadata, session, camera))
                    previous = key
                    with self.lock:
                        self.sent += 1
                    try:
                        ack = json.loads(socket.recv(timeout=1))
                    except TimeoutError:
                        with self.lock:
                            self.ack_timeouts += 1
                        raise ValueError('Image acknowledgement deadline exceeded')
                    if (not isinstance(ack, dict) or ack.get('type') != 'ack' or
                            ack.get('session_id') != session or ack.get('frame_id') != key):
                        raise ValueError('Image acknowledgement identity mismatch')
                    metrics = display_metrics(ack.get('metrics', {}))
                    with self.service.lock:
                        self.service.display_metrics[identity] = {'sessionId':session,
                            'cameraId':camera, 'observedAtUnix':time.time(), **metrics}
                        while len(self.service.display_metrics) > 8:
                            del self.service.display_metrics[next(iter(self.service.display_metrics))]
                    continue
                if now-last_status >= .5:
                    socket.send(json.dumps({'type':'image_status', 'status':'WAITING',
                        'session_id':session, 'camera_id':camera}))
                    last_status = now
                time.sleep(.002)
        except ConnectionClosed:
            pass
        except (ValueError, KeyError, TypeError, TimeoutError, RuntimeError) as error:
            log(LogCategory.SENSOR, 'Image stream closed', error=str(error))
            try:
                socket.send(json.dumps({'type':'image_status', 'status':'ERROR', 'error':str(error)}))
            except ConnectionClosed:
                pass
            socket.close(1008, str(error)[:120])
        finally:
            with self.lock:
                self.sockets.discard(socket)
            with self.service.lock:
                self.service.display_metrics.pop(identity, None)

    def snapshot(self):
        with self.lock:
            return {'connections':len(self.sockets), 'sentFrames':self.sent,
                'droppedExpired':self.expired, 'ackTimeouts':self.ack_timeouts,
                'maximumInFlightPerConnection':1}

    def close(self):
        with self.lock:
            sockets = list(self.sockets)
        for socket in sockets:
            socket.close()
