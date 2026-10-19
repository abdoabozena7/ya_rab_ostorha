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
        self.snapshot_lock = threading.Lock()
        self.snapshot_cache = None
        self.snapshot_key = None
        self.owner = None
        self.sockets = set()
        self.server = serve(self.handle, host, port, max_size=16_384,compression=None,
                            origins=[None, f"http://127.0.0.1:{http_port}",
                                     f"http://localhost:{http_port}", f"http://{host}:{http_port}"])
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True,
                                       name="simulation-websocket")

    def start(self):
        self.thread.start()

    def snapshot_payload(self):
        # Share serialization across all connected pages. Control admission,
        # pong liveness and acknowledgements remain per connection.
        with self.snapshot_lock:
            now=time.monotonic()
            key=(getattr(self.service,'session_id',None),getattr(self.service,'sequence',None))
            if self.snapshot_cache and self.snapshot_key==key and now-self.snapshot_cache[0]<.05:
                return self.snapshot_cache[1]
            snapshot=getattr(self.service,'stream_snapshot',self.service.snapshot)()
            payload=json.dumps(snapshot,allow_nan=False)
            self.snapshot_cache=(time.monotonic(),payload)
            self.snapshot_key=key
            return payload

    def process_message(self, socket, message):
        """Ownership changes and command admission are atomic across dashboards."""
        with self.ownership_lock:
            kind = message.get('type')
            presentation_start = kind == 'presentation' and isinstance(message.get('value'),dict) and message['value'].get('operation') in ('RESTART','START_GUIDED','PRELOAD')
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
            if kind=='presentation' and isinstance(message.get('value'),dict) and message['value'].get('operation')=='FINISH':
                if getattr(self.service,'is_replay',False):raise ValueError('Replay cannot finish a native simulator')
                # Finish is an explicit global close of this saved comparison.
                # Identity/phase checks reject active or unrelated attempts;
                # a reconnect may safely repeat it after native shutdown.
                self.service.presentation.finish(message['value'].get('id'))
                return True
            if kind=='emergency_stop':
                # An explicit emergency request must also work before this
                # page starts its first drive. Transfer only after the stop.
                self.service.emergency_stop()
                self.owner=socket
                if not self.controller_lock.locked():self.controller_lock.acquire()
                return True
            if presentation_start or comparison_start or kind in ('start_driving', 'start_journey', 'take_control', 'reconnect'):
                if getattr(self.service, 'is_replay', False):
                    raise ValueError('Replay has no native connection or control sink')
                if kind == 'start_journey' and not self.service.arbiter.machine.allow_navigation:
                    raise ValueError('Destination journeys are disabled for this provider')
                if kind == 'reconnect':
                    self.service.reconnect()
                else:
                    self.service.require_connected()
                    if presentation_start:
                        value=message['value']
                        if value.get('operation')=='PRELOAD':
                            if self.service.presentation.preload(value.get('page_id'),replace=value.get('replace') is True) is False:return True
                        elif value.get('operation')=='START_GUIDED' and value.get('prepared_id'):
                            self.service.presentation.choose_preloaded(value['prepared_id'],value.get('first_mode'),value.get('page_id'))
                        else:
                            options=({'guided':True,'first_mode':value.get('first_mode','NORMAL'),'scene':value.get('scene','DENSE_CHAOS')}
                                if value.get('operation')=='START_GUIDED' else {})
                            self.service.presentation.start(value.get('speed_kmh',120 if options.get('guided') else 50),seed=value.get('seed'),**options)
                    elif kind == 'start_journey':
                        # Validate before taking control away from another dashboard.
                        options = {key:message[key] for key in ('driving_mode','pair_id','benchmark') if key in message}
                        self.service.start_journey(message.get('speed_kmh', 30), **options)
                    elif comparison_start:
                        self.service.queue_dashboard_action(kind,message.get('value'))
                        self.service.release_controls()
                    elif kind == 'start_driving':
                        if getattr(self.service,'presentation',None) and self.service.presentation.busy:
                            raise ValueError('Stop the presentation before enabling manual driving')
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
                            'clear_route', 'population', 'crowd_route', 'prepare_journey_mode', 'inspector', 'recording', 'world_reset', 'scene', 'environment', 'scenario', 'safety_mode', 'comparison', 'comparison_v2', 'presentation'}:
                return False
            if self.owner is not socket:
                raise ValueError('Another dashboard controls this vehicle; select Start driving')
            self.service.require_connected()
            presentation = getattr(self.service, 'presentation', None)
            if presentation and presentation.busy and kind in ('destination', 'population', 'crowd_route',
                    'prepare_journey_mode', 'recording', 'world_reset', 'scene', 'environment', 'scenario', 'safety_mode', 'comparison', 'comparison_v2','journey_speed','restart_graphics'):
                raise ValueError('Stop the presentation before changing its setup')
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
            elif kind == 'presentation':
                value = message.get('value')
                if isinstance(value,dict) and value.get('operation')=='NEXT':
                    self.service.presentation.request_next(value.get('id'),value.get('expected_arm'),value.get('expected_phase'))
                elif isinstance(value,dict) and value.get('operation')=='RETRY_STEP':
                    self.service.presentation.retry_step(value.get('id'))
                elif isinstance(value,dict) and value.get('operation')=='FINISH':
                    self.service.presentation.finish(value.get('id'))
                elif isinstance(value,dict) and value.get('operation')=='VALIDATION_TIMEOUT':
                    self.service.presentation.inject_validation_timeout()
                elif not isinstance(value, dict) or value.get('operation') != 'PLAYBACK_FINISHED':
                    raise ValueError('Unknown presentation operation')
                else:self.service.presentation.playback_finished(value.get('id'))
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
        last_sent=None;last_sent_at=-float('inf')
        pending_ping = None
        last_ping = -float('inf')
        try:
            while True:
                # Native WebSocket ping/pong works when hidden tabs throttle JS.
                # Only a received pong from the current owner renews intent.
                now = time.monotonic()
                if pending_ping and pending_ping[0].is_set():
                    with self.ownership_lock:
                        if self.owner is socket and hasattr(self.service, 'navigation_transport_heartbeat'):
                            self.service.navigation_transport_heartbeat(pending_ping[1])
                    pending_ping = None
                if now-last_ping >= .2 and pending_ping is None and hasattr(self.service,'session_id'):
                    pending_ping = (socket.ping(), self.service.session_id)
                    last_ping = now
                message=None
                try:
                    message = json.loads(socket.recv(timeout=.01))
                    if not isinstance(message, dict):
                        raise ValueError('Expected an object')
                    if self.process_message(socket, message):
                        acknowledged = message.get('sequence')
                except TimeoutError:
                    pass
                except (ValueError, TypeError, RuntimeError) as error:
                    socket.send(json.dumps({'type': 'error', 'error': str(error), 'sequence':message.get('sequence') if isinstance(message,dict) else None}))
                payload=self.snapshot_payload()
                prefix=json.dumps({'type':'snapshot','controller':self.owner is socket,'acknowledged':acknowledged})
                current=(payload,prefix)
                if current!=last_sent or time.monotonic()-last_sent_at>=.1:
                    socket.send(prefix[:-1]+(','+payload[1:] if len(payload)>2 else '}'))
                    last_sent=current;last_sent_at=time.monotonic()
                time.sleep(.005)
        except ConnectionClosed:
            pass
        finally:
            with self.ownership_lock:
                self.sockets.discard(socket)
                if self.owner is socket:
                    presentation=getattr(self.service,'presentation',None)
                    held_choice=bool(presentation and (presentation.data.get('status') in ('AWAITING_NEXT','RESULTS','FINISHING') or
                        presentation.data.get('status')=='CHOOSING' and presentation.data.get('awaiting_choice')))
                    if hasattr(self.service, 'journey') and (self.service.journey.get('status') in ('RUNNING', 'STARTING') or
                            presentation and presentation.busy and not held_choice):
                        try: self.service.stop_driving('dashboard_disconnected')
                        except (ValueError, RuntimeError): pass
                    self.service.release_controls()
                    self.owner = None
                    self.controller_lock.release()

    def close(self):
        for socket in list(self.sockets):
            socket.close()
        self.server.shutdown()
        self.thread.join(timeout=2)
