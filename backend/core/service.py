"""Application worker: canonical observations in, validated command data out."""
import copy
from dataclasses import replace
import threading
import time
from collections import deque
from .contracts import CommandSource, ControlCommand, SensorFrame, SimulationFrame, finite
from .control import CommandArbiter, ControlMode, ControlSafetyLayer, safe_command
from .dashboard import dashboard_frame
from .events import EventBus, EventType, SimulationEvent
from .lifecycle import ConnectionLifecycle, ConnectionState
from .logging import LogCategory, log
from .timing import FrameIssue, SimulationClock, SensorSynchronizer


class SimulationService:
    CONTROL_TTL = .35

    def __init__(self, provider, recorder=None, *, required_sensors=(), optional_sensors=(), sensor_timeout_s=.25, now=time.monotonic):
        self.provider, self.recorder, self.now = provider, recorder, now
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.thread = None
        self.clock = SimulationClock(now)
        self.synchronizer = SensorSynchronizer(required_sensors, optional_sensors, timeout_s=sensor_timeout_s, now=now)
        self.arbiter = CommandArbiter(ControlSafetyLayer(command_timeout_s=self.CONTROL_TTL, now=now))
        self.lifecycle = ConnectionLifecycle(now=now)
        self.events = EventBus()
        self.events.subscribe(self._log_event)
        if recorder and hasattr(recorder, 'record_event'):
            self.events.subscribe(recorder.record_event)
        self.actions = deque()
        self.observation = None
        self.state = self.world = None  # Existing dashboard compatibility view only.
        self.state_at = 0.
        self.sensors, self.sensor_rates = {}, {}
        self.frame = self.frame_metadata = None
        self.error = None
        self.sequence = 0
        self.paused = False
        self.backend_step_ms = None
        self.command_at = 0.
        self.last_control_key = None
        self.started_session = False
        self.sensor_ids = set()
        self.closed = False

    @property
    def name(self):
        return getattr(self.provider, 'name', None) or (self.observation.world.provider if self.observation else 'carla')

    def _context(self):
        if self.observation:
            return self.observation.frame_id, self.observation.timestamp_s
        return (self.clock.frame_id, self.clock.timestamp_s) if self.clock.frame_id is not None else (0, 0.)

    def _event(self, kind, **payload):
        frame_id, timestamp_s = self._context() if self.observation else (None, None)
        self.events.publish(SimulationEvent(kind, frame_id, timestamp_s, payload))

    def _log_event(self, event):
        category = {EventType.EmergencyStop: LogCategory.SAFETY, EventType.ControlChanged: LogCategory.CONTROL,
                    EventType.ConnectionLost: LogCategory.CONNECTION, EventType.VehicleSpawned: LogCategory.VEHICLE,
                    EventType.VehicleDestroyed: LogCategory.VEHICLE, EventType.CollisionDetected: LogCategory.VEHICLE,
                    EventType.SensorStarted: LogCategory.SENSOR, EventType.SensorStopped: LogCategory.SENSOR}.get(event.event_type, LogCategory.SIMULATION)
        log(category, event.event_type.value, frame_id=event.frame_id, timestamp_s=event.timestamp_s,
            run_id=getattr(getattr(self.recorder, 'metadata', None), 'run_id', None), **dict(event.payload))

    @staticmethod
    def safe_controls():
        return {'throttle': 0, 'brake': 1, 'steering': 0, 'parkingbrake': 0}

    def start(self):
        if self.thread is not None or self.provider is None or self.closed:
            raise RuntimeError('A provider and an unstarted worker are required')
        if self.observation is None:
            initial = self.provider.get_simulation_frame()
            if not isinstance(initial, SimulationFrame):
                raise RuntimeError('Provider did not supply a canonical connection snapshot')
            self.clock.observe(initial.world)
            self.synchronizer.begin(initial)
            for frame in self.synchronizer.drain():
                self._publish(frame)
                if self.recorder:
                    self.recorder.record(frame)
        self.thread = threading.Thread(target=self._run, name='simulation-worker', daemon=True)
        self.thread.start()

    def submit_control(self, command):
        with self.lock:
            self.require_connected()
            previous = self.arbiter.machine.mode
            frame_id, timestamp_s = self._context()
            known_timestamp = self.clock.tracker.seen.get(command.frame_id)
            if command.frame_id == frame_id and abs(command.timestamp_s-timestamp_s) > 1e-6 or known_timestamp is not None and abs(command.timestamp_s-known_timestamp) > 1e-6:
                raise ValueError('Control frame ID/timestamp does not match its observation')
            result = self.arbiter.submit(command, frame_id=frame_id, timestamp_s=timestamp_s, connected=True)
            self.command_at = self.now()
            if previous in (ControlMode.AI, ControlMode.ASSISTED) and result.source == CommandSource.MANUAL:
                self._event(EventType.ControlChanged, source='MANUAL', manual_intervention=True)
            return result

    def set_controls(self, *, frame_id=None, timestamp_s=None, **command):
        # Compatibility for the existing browser's left-positive pedal policy.
        allowed = {'throttle', 'brake', 'steering', 'parkingbrake', 'gear'}
        if set(command)-allowed:
            raise ValueError('Unknown control field')
        for key, value in command.items():
            finite(value, key)
            if key == 'gear':
                if type(value) is not int or value not in (-1, 0, 1):
                    raise ValueError('Select reverse, neutral or automatic drive')
            elif not (-1 if key == 'steering' else 0) <= value <= 1:
                raise ValueError('Control outside range')
        with self.lock:
            current_frame, current_time = self._context()
            gear = command.get('gear')
            prior = self.arbiter.safety.latest.get(CommandSource.MANUAL)
            if gear is None:
                gear = prior.gear if prior and prior.gear is not None else (0 if self.observation and self.observation.vehicle.gear == 0 else -1 if self.observation and self.observation.vehicle.reverse else 1)
            reverse = gear == -1
            request = ControlCommand(current_frame if frame_id is None else frame_id,
                                     current_time if timestamp_s is None else timestamp_s,
                                     command.get('throttle', 0.), command.get('brake', 0.), -command.get('steering', 0.),
                                     reverse, bool(command.get('parkingbrake', 0)), CommandSource.MANUAL, gear)
            return self.submit_control(request)

    def _choose(self):
        frame_id, timestamp_s = self._context()
        chosen = self.arbiter.choose(frame_id=frame_id, timestamp_s=timestamp_s, connected=self._live())
        if self.observation and chosen.source == CommandSource.SAFETY and self.arbiter.reason != 'SAFETY':
            chosen = replace(chosen, reverse=self.observation.vehicle.reverse,
                             gear=0 if self.observation.vehicle.gear == 0 else -1 if self.observation.vehicle.reverse else None)
        key = (chosen.source, chosen.throttle, chosen.brake, chosen.steering, chosen.reverse, chosen.handbrake, chosen.gear)
        if key != self.last_control_key:
            self.last_control_key = key
            self._event(EventType.ControlChanged, source=chosen.source.value, reason=self.arbiter.reason,
                        throttle=chosen.throttle, brake=chosen.brake, steering=chosen.steering)
        return chosen

    def effective_controls(self, now=None):
        with self.lock:
            clock = self.arbiter.safety.now
            if now is not None:
                self.arbiter.safety.now = lambda: now
            try:
                chosen = self._choose()
            finally:
                self.arbiter.safety.now = clock
            controls = {'throttle': chosen.throttle, 'brake': chosen.brake,
                        'steering': -chosen.steering, 'parkingbrake': int(chosen.handbrake)}
            if chosen.gear is not None:
                controls['gear'] = chosen.gear
            return controls

    def release_controls(self):
        with self.lock:
            self.arbiter.safety.clear()
            # Release is immediate, not the grace period of a new connection.
            self.arbiter.safety.armed_at = self.now()-self.CONTROL_TTL-1
            self.command_at = 0.

    def emergency_stop(self):
        with self.lock:
            self.require_connected()
            self.arbiter.emergency_stop(connected=True)
            self._event(EventType.EmergencyStop, reason='explicit_operator_request')

    def acknowledge_stop(self):
        with self.lock:
            self.require_connected()
            self.arbiter.acknowledge_stop(connected=True)

    def reset_vehicle(self):
        self.require_connected()
        self.release_controls()
        with self.lock:
            self.actions.append(('reset', None))

    def set_paused(self, paused):
        if type(paused) is not bool:
            raise ValueError('paused must be boolean')
        with self.lock:
            self.require_connected()
            target = ControlMode.PAUSED if paused else ControlMode.MANUAL
            self.arbiter.machine.transition(target, connected=True)
            self.release_controls()
            if not paused:
                self.arbiter.safety.clear()
            self.actions.append(('pause', paused))

    def _live(self):
        return self.observation is not None and self.lifecycle.state == ConnectionState.CONNECTED and self.error is None and not self.closed and self.now()-self.state_at < 1

    def snapshot(self):
        with self.lock:
            live = self._live()
            if not live and self.lifecycle.state == ConnectionState.CONNECTED:
                self.arbiter.disconnect()
                self.lifecycle.fail(self.error or 'Observation receipt timeout')
                self._event(EventType.ConnectionLost, reason=self.lifecycle.error)
            view = dashboard_frame(self.observation) if live else {'vehicle': None, 'world': None, 'sensors': {}, 'canonical': None}
            return {'sequence': self.sequence, 'connected': live, 'available': live,
                    'provider': self.name, 'mode': self.arbiter.machine.mode.value,
                    'connectionState': self.lifecycle.state.value,
                    'error': self.error or (self.lifecycle.error if self.lifecycle.state == ConnectionState.ERROR else None),
                    **view, 'sensorRatesHz': dict(self.sensor_rates) if live else {},
                    'sensorErrors': {}, 'backendStepMs': self.backend_step_ms,
                    'controlSource': self.arbiter.last_selection.source.value if self.arbiter.last_selection else None,
                    'controlExpired': self.now()-self.command_at > self.CONTROL_TTL}

    def require_connected(self):
        if not self.snapshot()['connected']:
            self.release_controls()
            raise RuntimeError('Simulator telemetry unavailable; commands suspended')

    def get_vehicle_state(self):
        return self.snapshot()

    def get_sensor_frame(self, name):
        with self.lock:
            self.require_connected()
            for sensor in self.observation.sensors:
                if sensor.sensor_id == name:
                    from .contracts import to_dict
                    return to_dict(sensor)
            raise KeyError(name)

    def get_camera_frame(self):
        with self.lock:
            self.require_connected()
            return self.frame, copy.deepcopy(self.frame_metadata)

    def ingest_sensor(self, sensor: SensorFrame):
        if not isinstance(sensor, SensorFrame):
            raise ValueError('Expected canonical SensorFrame')
        result = self.synchronizer.receive(sensor)
        if result.issues:
            log(LogCategory.SENSOR, 'Sensor frame diagnostic', frame_id=sensor.frame_id, timestamp_s=sensor.timestamp_s,
                sensor_id=sensor.sensor_id, issues=sorted(issue.value for issue in result.issues))
        return result

    def _publish(self, observation):
        if not isinstance(observation, SimulationFrame):
            raise RuntimeError('Provider must return one canonical SimulationFrame')
        if self.provider and observation.world.provider != self.provider.name:
            raise RuntimeError('Observation provider does not match its adapter')
        with self.lock:
            first = self.observation is None
            self.observation = observation
            view = dashboard_frame(observation)
            self.state, self.world, self.sensors = view['vehicle'], view['world'], view['sensors']
            self.state_at = self.now()
            self.sequence += 1
            if first:
                generation = self.lifecycle.begin()
                self.lifecycle.connected(generation)
                self.arbiter.machine.transition(ControlMode.MANUAL, connected=True)
                self.arbiter.safety.clear()
                self.started_session = True
                self._event(EventType.SimulationStarted, provider=observation.world.provider)
                self._event(EventType.VehicleSpawned, actor_id=observation.vehicle.actor_id)
            for sensor in observation.sensors:
                if sensor.sensor_id not in self.sensor_ids:
                    self.sensor_ids.add(sensor.sensor_id)
                    self._event(EventType.SensorStarted, sensor_id=sensor.sensor_id)
            for collision in observation.collisions:
                from .contracts import to_dict
                self._event(EventType.CollisionDetected, collision=to_dict(collision))

    def _iteration(self):
        started = self.now()
        with self.lock:
            actions = list(self.actions)
            self.actions.clear()
        for action, value in actions:
            if action == 'reset':
                old_actor_id = self.observation.vehicle.actor_id if self.observation else None
                self.provider.reset_vehicle()
                self._event(EventType.VehicleDestroyed, actor_id=old_actor_id)
            else:
                self.provider.set_paused(value)
                self.paused = value
        with self.lock:
            chosen = self._choose()
        self.provider.apply_control(chosen)
        self.provider.step()
        observation = self.provider.get_simulation_frame()
        if not isinstance(observation, SimulationFrame):
            raise RuntimeError('Expected canonical observations from one native frame')
        diagnostic = self.clock.observe(observation.world)
        if FrameIssue.MISSING in diagnostic.issues:
            log(LogCategory.SIMULATION, 'Missing native frame range', frame_id=observation.frame_id,
                timestamp_s=observation.timestamp_s, missing_range=diagnostic.missing_range)
        if diagnostic.issues & {FrameIssue.OUT_OF_ORDER, FrameIssue.STALE, FrameIssue.TIMESTAMP_MISMATCH}:
            raise RuntimeError('Provider returned invalid simulation frame/time ordering')
        duplicate = FrameIssue.DUPLICATE in diagnostic.issues
        if duplicate and not self.paused:
            raise RuntimeError('Provider frame did not advance')
        if not duplicate:
            observation = replace(observation, control=chosen)
            self.synchronizer.begin(observation)
            for synchronized in self.synchronizer.drain():
                self._publish(synchronized)
                if self.recorder:
                    self.recorder.record(synchronized)
        elif self.observation:
            self.state_at = self.now()  # Explicit native pause; no new observations are recorded.
        if any(name == 'reset' for name, _ in actions):
            self._event(EventType.VehicleSpawned, actor_id=observation.vehicle.actor_id)
        self.backend_step_ms = (self.now()-started)*1000

    def _run(self):
        try:
            while not self.stop_event.is_set():
                started = self.now()
                try:
                    self._iteration()
                except Exception as error:
                    self.release_controls()
                    with self.lock:
                        self.error = str(error)
                        self.arbiter.disconnect()
                        self.lifecycle.fail(error)
                        self._event(EventType.ConnectionLost, reason=str(error))
                    break
                self.stop_event.wait(max(0, getattr(self.provider, 'fixed_delta', .05)-(self.now()-started)))
        finally:
            self._close_provider()

    def _close_provider(self):
        if self.closed:
            return
        try:
            if self.provider:
                try:
                    if self.provider.is_connected():
                        self.provider.apply_control(safe_command(*self._context()))
                finally:
                    self.provider.close()
                errors = getattr(self.provider, 'cleanup_errors', [])
                if errors:
                    raise RuntimeError('; '.join(errors))
                if self.started_session:
                    self._event(EventType.VehicleDestroyed, actor_id=self.observation.vehicle.actor_id if self.observation else None)
        except Exception as error:
            self.error = '; '.join(filter(None, [self.error, 'Actor cleanup unconfirmed: '+str(error)]))
        finally:
            try:
                try:
                    for pending in self.synchronizer.drain(force=True):
                        if self.recorder:
                            self.recorder.record(pending)
                    for sensor_id in self.sensor_ids:
                        self._event(EventType.SensorStopped, sensor_id=sensor_id, cleanup_confirmed=self.error is None)
                    if self.started_session:
                        self._event(EventType.SimulationStopped, cleanup_error=self.error)
                finally:
                    if self.recorder:
                        self.recorder.close()
            finally:
                self.closed = True
                self.arbiter.disconnect()
                self.lifecycle.disconnect()
                self.observation = self.state = self.world = self.frame = self.frame_metadata = None
                self.sensors = {}

    def close(self):
        self.release_controls()
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=15)
            if self.thread.is_alive():
                raise RuntimeError('Simulator worker did not stop; actor cleanup is not confirmed')
        else:
            self._close_provider()
