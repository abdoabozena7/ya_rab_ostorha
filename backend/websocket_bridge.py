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
        self.sockets = set()
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
            comparison_start = kind == 'comparison_v2' and isinstance(message.get('value'),dict) and message['value'].get('operation') == 'RUN'
            runtime = getattr(self.service, 'rl_runtime', None)
            if runtime and runtime.active and kind != 'emergency_stop':
                raise RuntimeError('Exclusive RL session owns simulation ticks and ego commands')
            if getattr(self.service, 'restarting', False):
                raise ValueError('Restarting CARLA; driving is stopped until verification completes')
            if kind=='stop_simulator':
                if getattr(self.service,'is_replay',False):raise ValueError('Replay cannot stop a native simulator')
                # This explicit global shutdown is available to an observing
                # dashboard too; it never grants that page vehicle control.
                self.service.stop_simulator()
                return True
            if comparison_start or kind in ('start_driving', 'start_journey', 'take_control', 'reconnect'):
                if getattr(self.service, 'is_replay', False):
                    raise ValueError('Replay has no native connection or control sink')
                if kind == 'start_journey' and not self.service.arbiter.machine.allow_navigation:
                    raise ValueError('Destination journeys are disabled for this provider')
                if kind == 'reconnect':
                    self.service.reconnect()
                else:
                    self.service.require_connected()
                    if kind == 'start_journey':
                        # Validate before taking control away from another dashboard.
                        options = {key:message[key] for key in ('driving_mode','pair_id') if key in message}
                        self.service.start_journey(message.get('speed_kmh', 30), **options)
                    elif comparison_start:
                        self.service.queue_dashboard_action(kind,message.get('value'))
                        self.service.release_controls()
                    elif kind == 'start_driving':
                        # Admission may reject a queued comparison. Do not take
                        # ownership away from its dashboard until this succeeds.
                        self.service.set_paused(False, driving_mode=message.get('driving_mode'))
                    else:
                        self.service.release_controls()
                    self.owner = socket
                    if not self.controller_lock.locked():
                        self.controller_lock.acquire()
                    if kind == 'take_control':
                        self.service.stop_driving('ownership_taken')
                return True
            if kind not in {'controls', 'reset', 'pause', 'stop_driving', 'journey_heartbeat', 'journey_speed', 'restart_graphics',
                            'emergency_stop', 'acknowledge_stop', 'settings', 'destination', 'save_place', 'favorite_place', 'disconnect',
                            'clear_route', 'population', 'crowd_route', 'prepare_journey_mode', 'inspector', 'recording', 'world_reset', 'scene', 'environment', 'scenario', 'safety_mode', 'comparison', 'comparison_v2'}:
                return False
            if self.owner is not socket:
                raise ValueError('Another dashboard controls this vehicle; select Start driving')
            self.service.require_connected()
            if kind == 'controls':
                if 'frame_id' not in message or 'timestamp_s' not in message:
                    raise ValueError('Controls require simulation frame_id and timestamp_s')
                # Network buffering can deliver two valid browser samples together.
                # Wait for the existing safety admission interval, then run its
                # normal freshness/range/rate checks; never waive the guard.
                from .core.contracts import CommandSource
                safety=self.service.arbiter.safety
                receipt=safety.receipts.get(CommandSource.MANUAL)
                if receipt is not None:
                    deadline = time.perf_counter() + .1
                    while (delay := safety.min_interval_s-(safety.now()-receipt)) > 0:
                        # Windows monotonic readings can advance in coarse steps.
                        # A single sleep may return inside the admission interval.
                        # Recheck the same clock as the safety layer, with a bound
                        # so a stalled clock cannot stall the connection forever.
                        if time.perf_counter() >= deadline:
                            raise ValueError('Control admission clock did not advance')
                        time.sleep(max(.001, delay))
                self.service.set_controls(frame_id=message['frame_id'], timestamp_s=message['timestamp_s'], **message.get('controls', {}))
            elif kind == 'reset':
                self.service.reset_vehicle()
            elif kind == 'pause':
                self.service.set_paused(message.get('paused'))
            elif kind == 'stop_driving':
                self.service.stop_driving(message.get('reason', 'operator_stop'))
            elif kind == 'safety_mode':
                self.service.set_safety_enabled(message.get('value'))
            elif kind == 'journey_heartbeat':
                self.service.journey_heartbeat(message.get('session_id'))
            elif kind == 'journey_speed':
                self.service.set_journey_speed(message.get('speed_kmh'))
            elif kind == 'restart_graphics':
                self.service.restart_graphics(message.get('value'))
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
            self.sockets.add(socket)
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
                self.sockets.discard(socket)
                if self.owner is socket:
                    self.service.release_controls()
                    self.owner = None
                    self.controller_lock.release()

    def close(self):
        for socket in list(self.sockets):
            socket.close()
        self.server.shutdown()
        self.thread.join(timeout=2)
