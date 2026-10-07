"""Stream cached telemetry; only one connection may control the vehicle."""

import json
import threading
import time


class WebSocketBridge:
    def __init__(self, service, host, port, http_port):
        from websockets.sync.server import serve
        self.service = service
        self.controller_lock = threading.Lock()
        self.ownership_lock = threading.RLock()
        self.owner = None
        self.server = serve(self.handle, host, port, max_size=16_384,
                            origins=[None, f"http://127.0.0.1:{http_port}",
                                     f"http://localhost:{http_port}", f"http://{host}:{http_port}"])
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True,
                                       name="simulation-websocket")

    def start(self):
        self.thread.start()

    def process_message(self, socket, message):
        """Ownership changes and command admission are atomic across dashboards."""
        with self.ownership_lock:
            kind = message.get('type')
            if kind in ('start_driving', 'reconnect'):
                if getattr(self.service, 'is_replay', False):
                    raise ValueError('Replay has no native connection or control sink')
                if kind == 'reconnect':
                    self.service.reconnect()
                else:
                    self.service.require_connected()
                    self.service.release_controls()
                    self.service.set_paused(False)
                    self.owner = socket
                    if not self.controller_lock.locked():
                        self.controller_lock.acquire()
                return True
            if kind not in {'controls', 'reset', 'pause', 'emergency_stop', 'acknowledge_stop', 'settings', 'destination', 'save_place', 'disconnect'}:
                return False
            if self.owner is not socket:
                raise ValueError('Another dashboard controls this vehicle; select Start driving')
            self.service.require_connected()
            if kind == 'controls':
                if 'frame_id' not in message or 'timestamp_s' not in message:
                    raise ValueError('Controls require simulation frame_id and timestamp_s')
                self.service.set_controls(frame_id=message['frame_id'], timestamp_s=message['timestamp_s'], **message.get('controls', {}))
            elif kind == 'reset':
                self.service.reset_vehicle()
            elif kind == 'pause':
                self.service.set_paused(message.get('paused'))
            elif kind == 'emergency_stop':
                self.service.emergency_stop()
            elif kind == 'acknowledge_stop':
                self.service.acknowledge_stop()
            elif kind == 'disconnect':
                self.service.close()
                self.owner = None
                self.controller_lock.release()
            else:
                self.service.queue_dashboard_action(kind, message.get('value'))
            return True

    def handle(self, socket):
        from websockets.exceptions import ConnectionClosed
        with self.ownership_lock:
            if not getattr(self.service, 'is_replay', False) and self.controller_lock.acquire(blocking=False):
                self.owner = socket
        acknowledged = None
        try:
            while True:
                try:
                    message = json.loads(socket.recv(timeout=.05))
                    if not isinstance(message, dict):
                        raise ValueError('Expected an object')
                    if self.process_message(socket, message):
                        acknowledged = message.get('sequence')
                except TimeoutError:
                    pass
                except (ValueError, TypeError, RuntimeError) as error:
                    socket.send(json.dumps({'type': 'error', 'error': str(error)}))
                snapshot = self.service.snapshot()
                socket.send(json.dumps({'type': 'snapshot', **snapshot,
                                        'controller': self.owner is socket,
                                        'acknowledged': acknowledged}, allow_nan=False))
                time.sleep(.01)
        except ConnectionClosed:
            pass
        finally:
            with self.ownership_lock:
                if self.owner is socket:
                    self.service.release_controls()
                    self.owner = None
                    self.controller_lock.release()

    def close(self):
        self.server.shutdown()
        self.thread.join(timeout=2)
