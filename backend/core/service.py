"""Application worker: canonical observations in, validated command data out."""
import copy
import statistics
from dataclasses import replace
import threading
import time
import uuid
from collections import deque, OrderedDict, Counter
from .contracts import CommandSource, ControlCommand, SensorFrame, SimulationFrame, finite, to_dict
from .control import CommandArbiter, ControlMode, ControlSafetyLayer, ControlStateMachine, safe_command
from .dashboard import dashboard_frame
from .events import EventBus, EventType, SimulationEvent
from .lifecycle import ConnectionLifecycle, ConnectionState
from .logging import LogCategory, log
from .timing import FrameIssue, SimulationClock, SensorSynchronizer


class SimulationService:
    CONTROL_TTL = .35

    def __init__(self, provider, recorder=None, *, required_sensors=(), optional_sensors=(), sensor_timeout_s=.25, now=time.monotonic):
        from .safety_policy import ObservationHistory
        self.policy_history = ObservationHistory()
        self.provider, self.recorder, self.now = provider, recorder, now
        self.lock = threading.RLock()
        self.stop_event = threading.Event()
        self.thread = None
        self.clock = SimulationClock(now)
        self.synchronizer = SensorSynchronizer(required_sensors, optional_sensors, timeout_s=sensor_timeout_s, now=now)
        self.arbiter = CommandArbiter(ControlSafetyLayer(command_timeout_s=self.CONTROL_TTL, now=now))
        self.arbiter.machine.allow_navigation = getattr(provider, 'allow_navigation', False)
        self.session_id = uuid.uuid4().hex
        self.journey = {'status': 'IDLE', 'reason': None, 'speed_kmh': 20}
        self.navigation_heartbeat_at = -float('inf')
        self.restart_result = None
        self.restarting = False
        self.recent_ticks = deque(maxlen=100)
        self.observation_latencies_ms = deque(maxlen=100)
        self.frame_tick_started = OrderedDict()
        self.lifecycle = ConnectionLifecycle(now=now)
        self.events = EventBus()
        self.events.subscribe(self._log_event)
        self.events.subscribe(self._record_event)
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
        self.collision_events = deque(maxlen=50)
        self.camera_cache = OrderedDict()
        self.sensor_frame_cache = OrderedDict()
        self.synchronization_issues = Counter()
        self.synchronization_missing_frames = 0
        self.synchronized_frames = 0
        self.dashboard_result = None
        self.reconfiguring = False
        self.reconnecting = False
        from queue import Queue
        self.rl_requests = Queue(maxsize=16)
        self.rl_runtime = None
        self.active_safety = None
        self.safety_command = None
        if getattr(provider, 'sensor_suite', False) is True:
            from .active_safety import ActiveSafetySupervisor
            self.active_safety = ActiveSafetySupervisor()
            self.provider.active_safety_configuration = to_dict(self.active_safety.config)

    def set_safety_enabled(self, value):
        with self.lock:
            self._require_normal_runtime()
            self.require_connected()
            if not isinstance(value, dict) or set(value) != {'enabled'} or type(value['enabled']) is not bool:
                raise ValueError('Safety comparison requires an explicit enabled boolean')
            if self.active_safety is None:
                raise ValueError('YA RAB OSTORHA requires the real sensor suite')
            if self.observation.vehicle.speed_mps > .15:
                raise ValueError('Stop the vehicle before changing the safety comparison mode')
            self._clear_safety_command()
            self.active_safety.enabled = value['enabled']
            self.active_safety.reset()
            self._event(EventType.ControlChanged, safety_enabled=value['enabled'], safety_type='RULE_BASED_SAFETY')

    def _clear_safety_command(self):
        if self.safety_command is not None and self.arbiter.safety.latest.get(CommandSource.SAFETY) == self.safety_command:
            self.arbiter.safety.latest.pop(CommandSource.SAFETY, None)
            self.arbiter.safety.receipts.pop(CommandSource.SAFETY, None)
        self.safety_command = None

    def _active_safety_step(self):
        supervisor = self.active_safety
        if supervisor is None: return
        mode = self.arbiter.machine.mode
        if not supervisor.enabled or mode not in (ControlMode.MANUAL, ControlMode.AUTOMATIC):
            self._clear_safety_command(); supervisor.reset()
            supervisor.status.update(status='DISABLED_COMPARISON' if not supervisor.enabled else
                'SUSPENDED_RL' if mode == ControlMode.TRAINING else 'SENSOR_FAULT_STOP' if supervisor.last_fault else 'STANDBY',
                reason=supervisor.last_fault or 'Monitoring resumes with normal forward driving')
            self.provider.active_safety_status = supervisor.snapshot()
            return
        frame_id, timestamp_s = self._context()
        base = self.arbiter.choose(frame_id=frame_id, timestamp_s=timestamp_s, connected=self._live(),
                                   exclude_sources=(CommandSource.SAFETY,))
        if base.source not in (CommandSource.MANUAL, CommandSource.NAVIGATION):
            self._clear_safety_command(); supervisor.reset()
            self.provider.active_safety_status = supervisor.snapshot()
            return
        try:
            history = self.policy_history.snapshot()
            if not history or self.now()-self.state_at > supervisor.config.maximum_sensor_wall_age_s:
                raise ValueError('Fresh complete safety observations unavailable')
            observation = history[-1]
            if self.clock.timestamp_s-observation.timestamp_s > supervisor.config.teacher.maximum_observation_age_s:
                raise ValueError('Safety sensor simulation freshness limit exceeded')
            base = replace(base, frame_id=observation.frame_id, timestamp_s=observation.timestamp_s)
            was_active = supervisor.active
            if supervisor.previous_s == observation.timestamp_s:
                # Reuse only within the same enforced freshness limits. Never call
                # the stateful teacher twice or change the driver's steering.
                candidate = replace(base, source=CommandSource.SAFETY, throttle=0.,
                    brake=max(base.brake, supervisor.brake)) if supervisor.active else None
                if candidate is not None:
                    from .safety_policy import ProposedSafetyAction, admit_proposal
                    proposal = ProposedSafetyAction(candidate, supervisor.config.version,
                        observation.frame_id, observation.timestamp_s, True, supervisor.status['reason'])
                    admitted = admit_proposal(observation, base, proposal,
                        supervisor.validator.validate((observation,), base, proposal))
                    if not admitted.accepted: raise ValueError(admitted.reason)
                    candidate = admitted.command
            else:
                candidate = supervisor.evaluate(observation, base, self.provider.get_sensor_asset,
                                                as_of_timestamp_s=self.clock.timestamp_s)
            if candidate is None:
                self._clear_safety_command()
            else:
                # Preserve the previous receipt/order so normal safety rate and
                # monotonic-command admission checks also apply on every refresh.
                self.safety_command = self.arbiter.submit(candidate, frame_id=frame_id,
                    timestamp_s=timestamp_s, connected=True)
            if supervisor.active != was_active:
                self._event(EventType.ControlChanged, ya_rab_ostorha=supervisor.snapshot())
        except (ValueError, KeyError, OSError, TypeError, ArithmeticError) as error:
            self._clear_safety_command()
            supervisor.reset()
            supervisor.status.update(status='SENSOR_FAULT_STOP', risk='UNKNOWN', reason=str(error))
            supervisor.last_fault = str(error)
            self.stop_driving('ya_rab_ostorha_sensor_fault')
        self.provider.active_safety_status = supervisor.snapshot()

    @property
    def name(self):
        return getattr(self.provider, 'name', None) or (self.observation.world.provider if self.observation else 'carla')

    def _context(self):
        if self.observation:
            return self.observation.frame_id, self.observation.timestamp_s
        return (self.clock.frame_id, self.clock.timestamp_s) if self.clock.frame_id is not None else (0, 0.)

    def _event(self, kind, **payload):
        if kind == EventType.ControlChanged:
            payload.setdefault('mode', self.arbiter.machine.mode.value)
        frame_id, timestamp_s = self._context() if self.observation else (None, None)
        self.events.publish(SimulationEvent(kind, frame_id, timestamp_s, payload))

    def _log_event(self, event):
        category = {EventType.EmergencyStop: LogCategory.SAFETY, EventType.ControlChanged: LogCategory.CONTROL,
                    EventType.ConnectionLost: LogCategory.CONNECTION, EventType.VehicleSpawned: LogCategory.VEHICLE,
                    EventType.VehicleDestroyed: LogCategory.VEHICLE, EventType.CollisionDetected: LogCategory.VEHICLE,
                    EventType.SensorStarted: LogCategory.SENSOR, EventType.SensorStopped: LogCategory.SENSOR}.get(event.event_type, LogCategory.SIMULATION)
        log(category, event.event_type.value, frame_id=event.frame_id, timestamp_s=event.timestamp_s,
            run_id=getattr(getattr(self.recorder, 'metadata', None), 'run_id', None), **dict(event.payload))

    def _record_event(self, event):
        if self.recorder and hasattr(self.recorder, 'record_event'):
            self.recorder.record_event(event)

    def _change_recording(self, value):
        if not isinstance(value, dict) or set(value) != {'enabled'} or type(value['enabled']) is not bool:
            raise ValueError('Recording requires an explicit enabled boolean')
        if value['enabled']:
            if self.recorder: raise ValueError('A recording is already active')
            from datetime import datetime, timezone
            from pathlib import Path
            from .contracts import ExperimentMetadata, DataOrigin
            from .recording import RunRecorder
            directory = Path(__file__).resolve().parents[2] / 'runs' / 'normal_city'
            environment=self.provider.environment_state()
            label='Controlled scenario native run' if environment and environment.get('mode')=='TRAINING' else 'Living city native run'
            self.recorder = RunRecorder(directory, ExperimentMetadata('run_'+uuid.uuid4().hex,
                label, self.name, DataOrigin.REAL_SIMULATION,
                created_at_utc=datetime.now(timezone.utc).isoformat(), config=self.provider.recording_metadata()))
            self._event(EventType.ControlChanged, recording='STARTED', population=self.provider.population_state())
            return {'enabled': True, 'path': str(self.recorder.root)}
        if not self.recorder: raise ValueError('No recording is active')
        self._event(EventType.ControlChanged, recording='STOPPED')
        recorder = self.recorder; self.recorder = None
        recorder.close()
        return {'enabled': False, 'path': str(recorder.root)}

    @staticmethod
    def safe_controls():
        return {'throttle': 0, 'brake': 1, 'steering': 0, 'parkingbrake': 0}

    def start(self, *, threaded=True):
        if self.thread is not None or self.provider is None or self.closed:
            raise RuntimeError('A provider and an unstarted worker are required')
        if self.observation is None:
            initial = self.provider.get_simulation_frame()
            if not isinstance(initial, SimulationFrame):
                raise RuntimeError('Provider did not supply a canonical connection snapshot')
            self.clock.observe(initial.world)
            self.synchronizer.begin(initial)
            self._ingest_provider_sensors()
            for frame in self.synchronizer.drain():
                self._publish(frame)
                self._record(frame)
        if threaded:
            self.thread = threading.Thread(target=self._run, name='simulation-worker', daemon=True)
            self.thread.start()

    def step_once(self):
        """Controlled experiment step through the same safety/arbitration worker."""
        if self.thread is not None or self.closed:
            raise RuntimeError('Manual stepping requires an open, unthreaded service')
        self._iteration()

    def _drain_collision_events(self):
        from .contracts import to_dict
        drain = getattr(self.provider, 'drain_collision_events', None)
        if drain:
            for collision in drain():
                with self.lock:
                    self.collision_events.append(collision)
                    if getattr(self.provider,'scenario_outcomes_enabled',False) is True and not (self.rl_runtime and self.rl_runtime.active):
                        outcome=self.provider.observe_scenario_collision(collision)
                        if outcome is not None:
                            self.events.publish(SimulationEvent(EventType.ControlChanged,collision.frame_id,collision.timestamp_s,
                                {'scenario_outcome':outcome,'mode':self.arbiter.machine.mode.value}))
                    if self.arbiter.machine.mode == ControlMode.AUTOMATIC:
                        self._stop_navigation('collision')
                # Event-driven collisions can arrive after their native anchor frame.
                # Preserve their actual frame/time instead of relabelling a later frame.
                self.events.publish(SimulationEvent(EventType.CollisionDetected,
                                                    collision.frame_id, collision.timestamp_s,
                                                    {'collision': to_dict(collision)}))

    def _ingest_provider_sensors(self):
        drain = getattr(self.provider, 'drain_sensor_frames', None)
        if drain:
            for sensor in drain():
                self.ingest_sensor(sensor)

    def _record(self, frame):
        if not self.recorder:
            return
        if hasattr(self.recorder, 'store_asset') and hasattr(self.provider, 'get_sensor_asset'):
            for sensor in frame.sensors:
                if sensor.asset:
                    folder, filename = sensor.asset.path.split('/', 1)
                    stored = self.recorder.store_asset(folder, filename, self.provider.get_sensor_asset(sensor.asset), sensor.asset.media_type)
                    if stored != sensor.asset:
                        raise RuntimeError('Recorded sensor bytes differ from the native frame reference')
        self.recorder.record(frame)

    def submit_control(self, command):
        with self.lock:
            self._require_normal_runtime()
            self.require_connected()
            previous = self.arbiter.machine.mode
            frame_id, timestamp_s = self._context()
            known_timestamp = self.clock.tracker.seen.get(command.frame_id)
            if command.frame_id == frame_id and abs(command.timestamp_s-timestamp_s) > 1e-6 or known_timestamp is not None and abs(command.timestamp_s-known_timestamp) > 1e-6:
                raise ValueError('Control frame ID/timestamp does not match its observation')
            result = self.arbiter.submit(command, frame_id=frame_id, timestamp_s=timestamp_s, connected=True)
            self.command_at = self.now()
            if previous in (ControlMode.AI, ControlMode.ASSISTED, ControlMode.AUTOMATIC) and result.source == CommandSource.MANUAL:
                if previous == ControlMode.AUTOMATIC:
                    self._stop_navigation('manual_intervention', manual=True)
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
            if self.rl_runtime and self.rl_runtime.active:
                return  # A dashboard disconnect cannot release the RL owner's commands.
            if self.arbiter.machine.mode == ControlMode.AUTOMATIC or self.journey['status'] == 'STARTING':
                self._stop_navigation('controls_released')
            self.arbiter.safety.clear()
            # Release is immediate, not the grace period of a new connection.
            self.arbiter.safety.armed_at = self.now()-self.CONTROL_TTL-1
            self.command_at = 0.

    def _stop_navigation(self, reason, *, status='PAUSED', manual=False):
        if hasattr(self.provider, 'stop_navigation'):
            self.provider.stop_navigation()
        self.navigation_heartbeat_at = -float('inf')
        self.actions = deque((a, v) for a, v in self.actions if a != 'start_journey')
        self.journey.update(status=status, reason=reason)
        self.arbiter.safety.latest.pop(CommandSource.NAVIGATION, None)
        self.arbiter.safety.receipts.pop(CommandSource.NAVIGATION, None)
        if self.arbiter.machine.mode == ControlMode.AUTOMATIC:
            self.arbiter.machine.transition(ControlMode.MANUAL if manual else ControlMode.PAUSED, connected=True)
        self._event(EventType.ControlChanged, journey=copy.deepcopy(self.journey))

    def stop_driving(self, reason='operator_stop'):
        with self.lock:
            self._require_normal_runtime()
            self.require_connected()
            self._stop_navigation(reason)
            if self.arbiter.machine.mode == ControlMode.MANUAL:
                self.arbiter.machine.transition(ControlMode.PAUSED, connected=True)
            self.release_controls()
            # Keep native ticks/cameras running while the safety brake stops the car.
            if self.paused:
                self.actions.append(('pause', False))

    def start_journey(self, speed_kmh=20):
        self._require_normal_runtime()
        if not self.arbiter.machine.allow_navigation:
            raise ValueError('Destination journeys are unavailable in this mode')
        speed = finite(speed_kmh)
        if not 5 <= speed <= 30:
            raise ValueError('Journey speed must be 5–30 km/h')
        with self.lock:
            self._require_normal_runtime()
            self.require_connected()
            if not getattr(self.provider, 'route_state', lambda: None)():
                raise ValueError('Choose a valid destination and show its route before starting')
            if self.dashboard_result and self.dashboard_result.get('action')=='destination' and self.dashboard_result.get('status') in ('PENDING', 'REJECTED'):
                raise ValueError('Choose a valid destination and show its route before starting the journey')
            if self.arbiter.machine.mode == ControlMode.EMERGENCY_STOP:
                raise ValueError('Acknowledge the emergency stop before starting')
            self.release_controls()
            self.navigation_heartbeat_at = self.now()
            self.journey = {'status': 'STARTING', 'reason': None, 'speed_kmh': speed}
            self.actions.append(('start_journey', speed))

    def journey_heartbeat(self, session_id):
        with self.lock:
            if session_id != self.session_id:
                raise ValueError('Journey heartbeat belongs to a previous CARLA session')
            if self.journey['status'] not in ('STARTING', 'RUNNING'):
                return
            self.navigation_heartbeat_at = self.now()

    def set_journey_speed(self, speed_kmh):
        speed = finite(speed_kmh)
        if not 5 <= speed <= 30:
            raise ValueError('Journey speed must be 5–30 km/h')
        with self.lock:
            self.require_connected()
            if self.arbiter.machine.mode != ControlMode.AUTOMATIC:
                raise ValueError('Start a destination journey before changing its live speed')
            self.journey['speed_kmh'] = speed
            self._event(EventType.ControlChanged, journey=copy.deepcopy(self.journey))

    def _navigation_step(self):
        if self.arbiter.machine.mode != ControlMode.AUTOMATIC:
            return
        if self.now()-self.navigation_heartbeat_at > self.CONTROL_TTL:
            self._stop_navigation('dashboard_heartbeat_timeout')
            return
        receipt = self.arbiter.safety.receipts.get(CommandSource.NAVIGATION)
        if receipt is not None and self.now()-receipt < self.arbiter.safety.min_interval_s:
            # A slow startup tick can be followed immediately by the next tick.
            # Keep the still-valid selected command; never bypass the rate guard.
            return
        route = self.provider.route_state()
        if self.provider.navigation_done():
            if self.observation.vehicle.speed_mps < .15:
                self._stop_navigation('destination_reached' if route['arrived'] else 'route_ended_before_destination',
                                      status='ARRIVED' if route['arrived'] else 'ERROR')
            else:
                frame_id, timestamp_s = self._context()
                self.arbiter.submit(safe_command(frame_id, timestamp_s, source=CommandSource.NAVIGATION),
                                    frame_id=frame_id, timestamp_s=timestamp_s, connected=True)
            return
        frame_id, timestamp_s = self._context()
        command = self.provider.navigation_command(frame_id, timestamp_s, self.journey['speed_kmh'])
        self.arbiter.submit(command, frame_id=frame_id, timestamp_s=timestamp_s, connected=True)
        self.command_at = self.now()

    def emergency_stop(self):
        with self.lock:
            self.require_connected()
            self._stop_navigation('emergency_stop')
            self.arbiter.emergency_stop(connected=True)
            self._event(EventType.EmergencyStop, reason='explicit_operator_request')

    def acknowledge_stop(self):
        with self.lock:
            self.require_connected()
            self.arbiter.acknowledge_stop(connected=True)

    def reset_vehicle(self):
        self._require_normal_runtime()
        self.require_connected()
        self.release_controls()
        with self.lock:
            self._require_normal_runtime()
            self.actions.append(('reset', None))

    def set_paused(self, paused):
        self._require_normal_runtime()
        if type(paused) is not bool:
            raise ValueError('paused must be boolean')
        with self.lock:
            self._require_normal_runtime()
            self.require_connected()
            if self.arbiter.machine.mode == ControlMode.AUTOMATIC:
                self._stop_navigation('operator_pause')
            target = ControlMode.PAUSED if paused else ControlMode.MANUAL
            self.arbiter.machine.transition(target, connected=True)
            self.release_controls()
            if not paused:
                self.arbiter.safety.clear()
            self.actions.append(('pause', paused))

    def dashboard_catalog(self):
        self.require_connected()
        return self.provider.dashboard_catalog()

    def queue_dashboard_action(self, action, value):
        with self.lock:
            self._require_normal_runtime()
            self.require_connected()
            if action not in ('settings', 'destination', 'save_place', 'favorite_place', 'clear_route', 'population', 'inspector', 'recording', 'world_reset', 'scene', 'environment', 'scenario'):
                raise ValueError('Unknown dashboard operation')
            if self.recorder and action in ('settings','world_reset'):
                raise ValueError('Finish recording before changing sensor configuration')
            scenario_rebuild=action=='scenario' and (not isinstance(value,dict) or value.get('operation') in ('load','reset','cleanup'))
            if self.recorder and (action=='environment' or scenario_rebuild):
                raise ValueError('Finish recording before rebuilding scenario actors or changing environment mode')
            if action=='world_reset':
                active = self.provider.runtime.active or {'quality':'Low','resolution':'1280x720'}
                self.restart_graphics({k:active[k] for k in ('quality','resolution')}, operation='WORLD_RESET')
                return
            self.release_controls()
            self.dashboard_result = {'action': action, 'status': 'PENDING'}
            self.actions.append((action, value))

    def reconnect(self):
        with self.lock:
            self._require_normal_runtime()
            if self.restarting:
                raise ValueError('CARLA restart is still running')
            if self.closed:
                if self.reconnecting:
                    return
                self.reconnecting = True
                threading.Thread(target=self._reopen, name='native-reconnect', daemon=True).start()
                return
            self.release_controls()
            self.actions.append(('reconnect', None))

    def restart_graphics(self, value, operation='GRAPHICS'):
        self._require_normal_runtime()
        launch = self.provider.validate_graphics(value)
        with self.lock:
            self._require_normal_runtime()
            self.require_connected()
            if self.restarting or self.recorder:
                raise ValueError('Finish recording or the current restart first')
            if self.observation.vehicle.speed_mps > .15:
                raise ValueError('Stop the vehicle before restarting CARLA')
            previous = dict(self.provider.runtime.active or {'quality':'Low','resolution':'1280x720','offscreen':False})
            self.stop_driving('graphics_restart')
            self.restarting = True
            self.restart_result = {'status':'STOPPING', 'requested':launch}
            self.restart_configuration = self.provider.restart_configuration()
            self.restart_configuration['restart_operation'] = operation
            threading.Thread(target=self._restart_native, args=(launch, previous),
                             name='native-graphics-restart', daemon=True).start()

    def _restart_native(self, launch, previous):
        try:
            self.close()
            if self.provider.cleanup_errors:
                raise RuntimeError('Native actor cleanup failed: '+'; '.join(self.provider.cleanup_errors))
            # Windows libcarla retains streaming handles beyond Client lifetime.
            # The host shuts down this process before an independent helper kills
            # UE and creates a fresh SDK session. No live control is resumed.
            self.provider.restart_handler(launch, previous, self.restart_configuration)
        except Exception as error:
            self.restarting = False
            self.restart_result = {'status':'FAILED', 'requested':launch, 'error':str(error)}

    def _reopen(self):
        provider, now = self.provider, self.now
        try:
            if self.thread:
                self.thread.join(timeout=15)
                if self.thread.is_alive():
                    raise RuntimeError('Previous native worker is still running')
            provider.connect()
            fresh = SimulationService(provider, required_sensors=provider.required_sensors,
                                      sensor_timeout_s=self.synchronizer.timeout_s, now=now)
            fresh.restarting = self.restarting
            fresh.restart_result = self.restart_result
            fresh.pause_on_first_observation = True
            fresh.events = EventBus()
            # Replace complete state atomically; WebSocket observers cannot see a
            # partially initialized service while reconnect is in progress.
            self.__dict__.update(fresh.__dict__)
            self.events.subscribe(self._log_event)
            self.events.subscribe(self._record_event)
            self.start()
            # The first verified frame establishes DISCONNECTED -> MANUAL ->
            # PAUSED in _publish. Do not race it with a premature transition.
        except Exception as error:
            self.error = str(error)
            self.reconnecting = False

    def _live(self):
        controlled_idle = self.rl_runtime is not None and self.rl_runtime.active and not self.rl_runtime.expired()
        return self.observation is not None and self.lifecycle.state == ConnectionState.CONNECTED and self.error is None and not self.closed and not self.reconfiguring and (controlled_idle or self.now()-self.state_at < 1)

    def snapshot(self):
        with self.lock:
            status = getattr(self.provider, 'restart_status', lambda: None)()
            if isinstance(status, dict) and isinstance(status.get('status'), str):
                self.restart_result = status
                self.restarting = status['status'] not in ('APPLIED','ROLLED_BACK','FAILED')
                if status.get('operation')=='WORLD_RESET' and status['status'] in ('APPLIED','ROLLED_BACK') and not getattr(self,'native_reset_reported',False):
                    self.dashboard_result = {'action':'world_reset','status':'APPLIED',
                                             'result':{'map':getattr(self.provider,'map_name',None),
                                                       'native_reset':{'status':'NATIVE_PROCESS_RESTART','reason':'Windows libcarla requires retirement of the old SDK process'}},
                                             'operationId':self.session_id}
                    self.native_reset_reported = True
            live = self._live()
            if not live and self.lifecycle.state == ConnectionState.CONNECTED and not self.reconfiguring:
                self.arbiter.disconnect()
                self.lifecycle.fail(self.error or 'Observation receipt timeout')
                self._event(EventType.ConnectionLost, reason=self.lifecycle.error)
            view = dashboard_frame(self.observation) if live else {'vehicle': None, 'world': None, 'sensors': {}, 'canonical': None}
            return {'sequence': self.sequence, 'connected': live, 'available': live,
                    'sessionId': self.session_id, 'journey': copy.deepcopy(self.journey),
                    'rlRuntime': self.rl_runtime.status() if self.rl_runtime else {'active':False,'tick_owner':'simulation-worker'},
                    'navigationAvailable': self.arbiter.machine.allow_navigation,
                    'safetySystem': self.active_safety.snapshot() if self.active_safety else
                        {'enabled':False,'active':False,'type':'RULE_BASED_SAFETY','status':'SENSORS_UNAVAILABLE','risk':'UNKNOWN','intervention_count':0},
                    'restartResult': copy.deepcopy(self.restart_result),
                    'restarting': self.restarting, 'recording': bool(self.recorder),
                    'performance': {'nativeTickRateHz': 0 if self.recent_ticks and self.now()-self.recent_ticks[-1]>.5 else
                        (len(self.recent_ticks)-1)/(self.recent_ticks[-1]-self.recent_ticks[0])
                        if len(self.recent_ticks)>1 and self.recent_ticks[-1]>self.recent_ticks[0] else None,
                        'renderFps': None, 'clock': 'WALL_TIME',
                        'observationPipelineLatencyMs': {
                            'definition':'Native step request to complete synchronized publication; excludes display latency',
                            'samples':len(self.observation_latencies_ms),
                            'median':statistics.median(self.observation_latencies_ms) if self.observation_latencies_ms else None,
                            'maximum':max(self.observation_latencies_ms) if self.observation_latencies_ms else None},
                        'sensorWallRatesHz': getattr(self.provider,'get_sensor_wall_rates',lambda:{})(),
                        'gpu': getattr(getattr(self.provider, 'runtime', None), 'gpu', None)},
                    'provider': self.name, 'mode': self.arbiter.machine.mode.value,
                    'connectionState': self.lifecycle.state.value,
                    'error': self.error or (self.lifecycle.error if self.lifecycle.state == ConnectionState.ERROR else None),
                    **view, 'sensorRatesHz': dict(self.sensor_rates) if live else {},
                    'sensorErrors': getattr(self.provider, 'sensor_errors', lambda: {})() if live else {},
                    'sensorRegistry': getattr(self.provider, 'sensor_registry', lambda: {})() if live else {},
                    'collisionEvents': [to_dict(e) for e in self.collision_events] if live else [],
                    'dashboardResult': copy.deepcopy(self.dashboard_result),
                    'route': getattr(self.provider, 'route_state', lambda: None)() if live else None,
                    'population': getattr(self.provider, 'population_state', lambda: None)() if live else None,
                    'environment': self._environment_snapshot() if live else None,
                    'nearbyActors': getattr(self.provider, 'ground_truth_debug', lambda: None)() if live else None,
                    'synchronization': {'completeFrames': self.synchronized_frames,
                                        'incompleteFrames': self.synchronization_missing_frames,
                                        'issues': {issue.value: self.synchronization_issues[issue.value] for issue in FrameIssue},
                                        'pendingFrames': len(self.synchronizer.pending)},
                    'backendStepMs': self.backend_step_ms,
                    'controlSource': self.arbiter.last_selection.source.value if self.arbiter.last_selection else None,
                    'controlExpired': self.now()-self.command_at > self.CONTROL_TTL}

    def _environment_snapshot(self):
        state = getattr(self.provider, 'environment_state', lambda: None)()
        if isinstance(state,dict):
            frames = self.policy_history.snapshot()
            state['observation_status'] = {'status':self.policy_history.status,'history_frames':len(frames),
                'frame_id':frames[-1].frame_id if frames else None,'privileged_data_excluded':True,
                'policy_active':bool(self.active_safety and self.active_safety.enabled and self.arbiter.machine.mode in (ControlMode.MANUAL,ControlMode.AUTOMATIC))}
            state['safety_policy'] = self.active_safety.snapshot() if self.active_safety else state.get('safety_policy')
            return state
        return None

    def require_connected(self):
        if not self.snapshot()['connected']:
            self.release_controls()
            raise RuntimeError('Simulator telemetry unavailable; commands suspended')

    def get_vehicle_state(self):
        return self.snapshot()

    def get_sensor_frame(self, name):
        with self.lock:
            self.require_connected()
            if name == 'collision' and self.collision_events:
                return {'sensor_id': name, 'kind': 'COLLISION', 'event_driven': True,
                        'actor_id': getattr(self.provider, 'sensor_registry', lambda: {})().get(name, {}).get('actorId'),
                        'collision': to_dict(self.collision_events[-1])}
            for sensor in self.observation.sensors:
                if sensor.sensor_id == name:
                    return to_dict(sensor)
            raise KeyError(name)

    def get_camera_frame(self, frame_id=None):
        with self.lock:
            self.require_connected()
            if frame_id is not None:
                frame, metadata = self.camera_cache.get(frame_id, (None, None))
                return frame, copy.deepcopy(metadata)
            return self.frame, copy.deepcopy(self.frame_metadata)

    def get_sensor_asset(self, name, frame_id=None):
        with self.lock:
            self.require_connected()
            frame_id = self.observation.frame_id if frame_id is None else frame_id
            for sensor in self.sensor_frame_cache.get(frame_id, ()):
                if sensor.sensor_id == name and sensor.asset:
                    return self.provider.get_sensor_asset(sensor.asset), {'frame': sensor.frame_id,
                        'timestamp': sensor.timestamp_s, 'contentType': sensor.asset.media_type}
            raise KeyError(name)

    def ingest_sensor(self, sensor: SensorFrame):
        if not isinstance(sensor, SensorFrame):
            raise ValueError('Expected canonical SensorFrame')
        result = self.synchronizer.receive(sensor)
        self.synchronization_issues.update(issue.value for issue in result.issues)
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
            tick_started = self.frame_tick_started.pop(observation.frame_id,None)
            if tick_started is not None and observation.complete:
                self.observation_latencies_ms.append((self.now()-tick_started)*1000)
            self.policy_history.append(observation)
            fresh_recovery = (not first and observation.frame_id > self.observation.frame_id
                              and self.lifecycle.state == ConnectionState.ERROR
                              and self.lifecycle.error == 'Observation receipt timeout'
                              and self.error is None)
            self.observation = observation
            if getattr(self.provider,'scenario_outcomes_enabled',False) is True and not (self.rl_runtime and self.rl_runtime.active):
                outcome=self.provider.observe_scenario(observation)
                if outcome is not None:self._event(EventType.ControlChanged,scenario_outcome=outcome)
            view = dashboard_frame(observation)
            self.state, self.world, self.sensors = view['vehicle'], view['world'], view['sensors']
            self.state_at = self.now()
            self.sequence += 1
            self.sensor_frame_cache[observation.frame_id] = observation.sensors
            while len(self.sensor_frame_cache)>32:
                self.sensor_frame_cache.popitem(last=False)
            if observation.complete:
                self.synchronized_frames += 1
            else:
                self.synchronization_missing_frames += 1
            rates = getattr(self.provider, 'get_sensor_rates', None)
            if rates:
                self.sensor_rates = rates()
            self.frame = self.frame_metadata = None
            for sensor in observation.sensors:
                if sensor.sensor_id == 'frontCamera' and sensor.asset and hasattr(self.provider, 'get_sensor_asset'):
                    self.frame = self.provider.get_sensor_asset(sensor.asset)
                    self.frame_metadata = {'frame': sensor.frame_id, 'timestamp': sensor.timestamp_s,
                                           'contentType': sensor.asset.media_type}
                    self.camera_cache[sensor.frame_id] = (self.frame, self.frame_metadata)
                    while len(self.camera_cache)>32:
                        self.camera_cache.popitem(last=False)
            if first:
                generation = self.lifecycle.begin()
                self.lifecycle.connected(generation)
                self.arbiter.machine.transition(ControlMode.MANUAL, connected=True)
                self.arbiter.safety.clear()
                if getattr(self, 'pause_on_first_observation', False):
                    self.arbiter.machine.transition(ControlMode.PAUSED, connected=True)
                    self.pause_on_first_observation = False
                self.started_session = True
                self._event(EventType.SimulationStarted, provider=observation.world.provider)
                self._event(EventType.VehicleSpawned, actor_id=observation.vehicle.actor_id)
            elif fresh_recovery:
                # A new validated native frame can restore observation availability,
                # while driving remains suspended until the operator starts again.
                generation = self.lifecycle.begin(); self.lifecycle.connected(generation)
                self.arbiter.machine.transition(ControlMode.MANUAL, connected=True)
                self.arbiter.machine.transition(ControlMode.EMERGENCY_STOP if self.arbiter.safety.emergency
                                               else ControlMode.PAUSED, connected=True)
            for sensor in observation.sensors:
                if sensor.sensor_id not in self.sensor_ids:
                    self.sensor_ids.add(sensor.sensor_id)
                    self._event(EventType.SensorStarted, sensor_id=sensor.sensor_id)
            for collision in observation.collisions:
                from .contracts import to_dict
                self._event(EventType.CollisionDetected, collision=to_dict(collision))

    def _iteration(self, training_command=None):
        started = self.now()
        with self.lock:
            if training_command is not None and self.actions:
                raise RuntimeError('Normal operations were queued during exclusive RL tick ownership')
            actions = list(self.actions)
            self.actions.clear()
        for action, value in actions:
            if action == 'start_journey':
                try:
                    with self.lock:
                        if self.journey['status'] != 'STARTING' or self.now()-self.navigation_heartbeat_at > self.CONTROL_TTL:
                            raise ValueError('Dashboard heartbeat expired before journey start')
                        if self.paused:
                            self.provider.set_paused(False); self.paused = False
                        result = self.provider.start_navigation(value)
                        self.arbiter.safety.clear()
                        self.arbiter.machine.transition(ControlMode.AUTOMATIC, connected=True, explicit=True)
                        self.journey.update(status='RUNNING', reason=None, route_id=result['id'])
                        self._event(EventType.ControlChanged, journey=copy.deepcopy(self.journey))
                except (ValueError, ImportError) as error:
                    self._stop_navigation(str(error), status='ERROR')
            elif action in ('settings', 'destination', 'save_place', 'favorite_place', 'clear_route', 'population', 'inspector', 'recording', 'scene', 'environment', 'scenario'):
                # Route guidance, saved places and recording do not rebuild
                # native actors. Keep fresh observations available while these
                # actions run; the normal receipt watchdog still applies.
                self.reconfiguring = action in ('settings', 'population', 'scene', 'scenario', 'environment')
                try:
                    sensor_change = action == 'settings' and isinstance(value, dict) and any(k in value for k in (
                        'camera_resolution', 'camera_fov', 'camera_postprocess', 'camera_motion_blur',
                        'camera_bloom', 'simulation_hz', 'vehicle', 'spawn_index'))
                    sensor_change = sensor_change or action=='scenario' and isinstance(value,dict) and value.get('operation') in ('load','reset')
                    if sensor_change:
                        self.policy_history.clear()
                        if self.active_safety: self.active_safety.reset()
                        self._clear_safety_command()
                        self._drain_collision_events()
                        self._ingest_provider_sensors()
                        for pending in self.synchronizer.drain(force=True):
                            self._publish(pending); self._record(pending)
                    result = self._change_recording(value) if action == 'recording' else self.provider.dashboard_action(action, value)
                    self.dashboard_result = {'action': action, 'status': 'PENDING' if action in ('settings','scene','population','scenario','environment') else 'APPLIED', 'result': result,
                                             'operationId': uuid.uuid4().hex}
                    if action == 'destination':
                        self.journey.update(status='READY', reason=None)
                    self._event(EventType.ControlChanged, dashboard_action=action, value=value,
                                population=getattr(self.provider, 'population_state', lambda: None)())
                    if action=='scenario' and value.get('operation')=='stop' and result.get('outcome'):
                        self._event(EventType.ControlChanged,scenario_outcome=result['outcome'])
                    if sensor_change:
                        self.synchronizer = SensorSynchronizer(self.synchronizer.required, self.synchronizer.optional,
                                                               timeout_s=self.synchronizer.timeout_s, now=self.now)
                        self.camera_cache.clear(); self.sensor_frame_cache.clear()
                        self.policy_history.clear()
                except ValueError as error:
                    self.dashboard_result = {'action': action, 'status': 'REJECTED', 'error': str(error),
                                             'operationId': uuid.uuid4().hex}
                    if action == 'destination':
                        self.journey.update(status='ERROR',reason=str(error))
                finally:
                    if self.reconfiguring:
                        self.state_at = self.now()
                    self.reconfiguring = False
            elif action == 'reconnect':
                # Reconfirm the actual server, not merely the browser socket.
                client = self.provider.connection.client
                if client.get_server_version() != self.provider.connection.api_version:
                    raise RuntimeError('CARLA server/API version mismatch during reconnect')
                client.get_world().get_snapshot()
                self.error = None
                self.lifecycle.disconnect()
                generation = self.lifecycle.begin(); self.lifecycle.connected(generation)
                self.arbiter.machine.transition(ControlMode.EMERGENCY_STOP if self.arbiter.safety.emergency
                                               else ControlMode.PAUSED, connected=True)
                self.arbiter.safety.clear(); self.state_at = self.now()
            elif action == 'reset':
                self.policy_history.clear()
                if self.active_safety: self.active_safety.reset()
                self._clear_safety_command()
                self._drain_collision_events()
                self._ingest_provider_sensors()
                for pending in self.synchronizer.drain(force=True):
                    self._publish(pending)
                    self._record(pending)
                old_actor_id = self.observation.vehicle.actor_id if self.observation else None
                self.provider.reset_vehicle()
                self.synchronizer = SensorSynchronizer(self.synchronizer.required, self.synchronizer.optional,
                                                       timeout_s=self.synchronizer.timeout_s, now=self.now)
                self.camera_cache.clear(); self.sensor_frame_cache.clear()
                self._event(EventType.VehicleDestroyed, actor_id=old_actor_id)
            else:
                self.provider.set_paused(value)
                self.paused = value
        with self.lock:
            if training_command is None:
                self._navigation_step()
                self._active_safety_step()
                chosen = self._choose()
            else:
                if self.active_safety:
                    self._clear_safety_command(); self.active_safety.reset()
                    self.active_safety.status.update(status='SUSPENDED_RL', reason='Exclusive RL interface owns commands')
                    self.provider.active_safety_status = self.active_safety.snapshot()
                chosen = training_command
        if (training_command is not None and self.rl_runtime and self.rl_runtime.supervisor) or chosen == self.safety_command:
            self.provider.apply_control_confirmed(chosen)
        else:self.provider.apply_control(chosen)
        native_step_started = self.now()
        self.provider.step()
        # Native weather/population setters become observable on the following
        # simulation step. Publish APPLIED only with that step's real state.
        if self.dashboard_result and self.dashboard_result.get('operationId') and self.dashboard_result['status']=='PENDING':
            action = self.dashboard_result['action']
            if action in ('settings','scene','population','scenario','environment'):
                result = self.provider.environment_state() if action in ('scenario','environment') else self.provider.population_state() if action=='population' else self.provider.dashboard_tools.settings()
                self.dashboard_result = {**self.dashboard_result,'status':'APPLIED','result':result}
        self._drain_collision_events()
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
            self.frame_tick_started[observation.frame_id] = native_step_started
            while len(self.frame_tick_started)>32:self.frame_tick_started.popitem(last=False)
            self.recent_ticks.append(self.now())
            observation = replace(observation, control=chosen)
            self.synchronizer.begin(observation)
            self._ingest_provider_sensors()
            for synchronized in self.synchronizer.drain():
                self._publish(synchronized)
                self._record(synchronized)
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
                    if self._process_rl_request():
                        continue
                    if self.rl_runtime and self.rl_runtime.active:
                        if self.rl_runtime.expired():
                            self.rl_runtime.close(reason='lease_expired')
                        else:
                            self.stop_event.wait(.01)
                            continue
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
            if self.rl_runtime and self.rl_runtime.active:
                self.rl_runtime.close(reason='service_shutdown')
            self._close_provider()

    def _require_normal_runtime(self):
        if self.rl_runtime and self.rl_runtime.active:
            raise RuntimeError('Exclusive RL session owns simulation ticks and ego commands')

    def rl_request(self, operation, **data):
        """Queue work to the existing simulation thread; caller never ticks."""
        from concurrent.futures import Future, TimeoutError
        from queue import Full
        if self.closed or self.thread is None or not self.thread.is_alive():
            raise RuntimeError('A running native service worker is required')
        future=Future()
        try:self.rl_requests.put_nowait((operation,data,future))
        except Full:raise RuntimeError('RL request queue is full') from None
        try:return future.result(timeout=65)
        except TimeoutError:
            future.cancel()
            raise RuntimeError('RL worker request timed out; inspect runtime before retrying') from None

    def _process_rl_request(self):
        from queue import Empty
        try:operation,data,future=self.rl_requests.get_nowait()
        except Empty:return False
        if not future.set_running_or_notify_cancel():return True
        try:
            if self.rl_runtime is None:
                from ..rl.runtime import RLRuntime
                self.rl_runtime=RLRuntime(self)
            result=self.rl_runtime.dispatch(operation,**data)
        except Exception as error:
            future.set_exception(error if isinstance(error,(ValueError,RuntimeError)) else RuntimeError('RL runtime error: '+str(error)))
        else:future.set_result(result)
        return True

    def _close_provider(self):
        if self.closed:
            return
        try:
            if self.provider:
                try:
                    if self.provider.is_connected():
                        self.provider.apply_control(safe_command(*self._context()))
                finally:
                    try:
                        self._drain_collision_events()
                        self._ingest_provider_sensors()
                        for pending in self.synchronizer.drain(force=True):
                            self._publish(pending)
                            self._record(pending)
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
                self.policy_history.clear()
                self.arbiter.disconnect()
                self.lifecycle.disconnect()
                self.observation = self.state = self.world = self.frame = self.frame_metadata = None
                self.sensors = {}
                self.camera_cache.clear()
                self.sensor_frame_cache.clear()

    def close(self):
        self.release_controls()
        self.stop_event.set()
        if self.thread:
            self.thread.join(timeout=15)
            if self.thread.is_alive():
                raise RuntimeError('Simulator worker did not stop; actor cleanup is not confirmed')
        else:
            self._close_provider()
