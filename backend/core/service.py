"""Application worker: canonical observations in, validated command data out."""
import copy
import statistics
from dataclasses import replace, is_dataclass
import threading
import time
import uuid
import traceback
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

    def __init__(self, provider, recorder=None, *, required_sensors=(), optional_sensors=(), sensor_timeout_s=.25, now=time.monotonic, validation_budget=None):
        self.native_validation_budget = validation_budget
        from .safety_policy import ObservationHistory
        from .recording import RunRecorder,BufferedRunRecorder
        if isinstance(recorder,RunRecorder):recorder=BufferedRunRecorder(recorder)
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
        self.journey = {'status': 'IDLE', 'reason': None, 'speed_kmh': 30}
        self.manual_driving_mode = 'ROBOSPHERE'
        self.manual_stop_reason = None
        from .journey_comparison import JourneyComparison
        self.journey_comparison = JourneyComparison()
        self.prepared_journey_pair = None
        self.journey_observer = {}
        self.journey_auto_recording = False
        self.journey_recording_stop_pending = None
        self.motion_snapshot=None
        self.navigation_heartbeat_at = -float('inf')
        self.restart_result = None
        self.restarting = False
        self.simulator_stop = {'status':'IDLE'}
        self.simulator_start = {'status':'IDLE'}
        self.startup_ticket = None
        self.recent_ticks = deque(maxlen=100)
        self.observation_latencies_ms = deque(maxlen=100)
        self.control_timing_ms = {}
        self.publication_at = None
        self.frame_tick_started = OrderedDict()
        self.lifecycle = ConnectionLifecycle(now=now)
        self.events = EventBus()
        self.events.subscribe(self._log_event)
        self.events.subscribe(self._record_event)
        self.actions = deque()
        self.observation = None
        self.state = self.world = None  # Existing dashboard compatibility view only.
        self.dashboard_view = None
        self.state_at = 0.
        self.safety_observed_at=None
        self.navigation_ready_frame=None
        self.last_recording=recorder if isinstance(recorder,BufferedRunRecorder) else None
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
        self.render_pose_cache = OrderedDict()
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
        self.safety_decision_key = None
        self.safety_decision_command = None
        self.control_scene = None
        self.control_scene_builder = None
        self.control_scene_error = None
        self.control_scene_ego_actor_id = None
        self.control_decision_prediction = None
        self.comparison = None
        self.comparison_v2 = None
        self.historical_comparison = None
        self.stop_diagnostics = None
        self.base_driver_command = None
        self.safety_fault = None
        self.runtime_fault = None
        self.safety_processing_wait_at = None
        self.last_drive_stop = None
        self.rear_assist = False
        if getattr(provider, 'sensor_suite', False) is True:
            from .research_safety import ResearchSafetySupervisor
            self.active_safety = ResearchSafetySupervisor()
            self.provider.active_safety_configuration = to_dict(self.active_safety.config)
            self.provider.active_safety_configuration['learned_safety'] = copy.deepcopy(self.active_safety.learned_config)
            if getattr(provider, 'scenario_outcomes_enabled', False):
                factory=getattr(provider,'create_comparison',None)
                if factory:self.comparison=factory(self)
                self.historical_comparison = self.comparison
                v2_factory = getattr(provider,'create_comparison_v2',None)
                if v2_factory: self.comparison_v2 = v2_factory(self)

    def set_safety_enabled(self, value):
        with self.lock:
            if self._comparison_busy():
                raise ValueError('Restart with a comparison button to change demo safety')
            self._require_normal_runtime()
            self.require_connected()
            if not isinstance(value, dict) or set(value) not in ({'enabled'}, {'enabled','controller'}) or type(value['enabled']) is not bool:
                raise ValueError('Safety comparison requires an explicit enabled boolean')
            if self.active_safety is None:
                raise ValueError('YA RAB OSTORHA requires the real sensor suite')
            if self.observation.vehicle.speed_mps > .15:
                raise ValueError('Stop the vehicle before changing the safety comparison mode')
            if 'controller' in value:
                environment = getattr(self.provider, 'environment_state', lambda: {})()
                self.active_safety.set_controller(value['controller'], controlled_validation=
                    isinstance(environment,dict) and environment.get('mode')=='TRAINING')
            self._clear_safety_command()
            self.active_safety.enabled = value['enabled']
            self.active_safety.reset()
            self._event(EventType.ControlChanged, safety_enabled=value['enabled'], safety_type=self.active_safety.snapshot()['type'],
                        safety_controller=getattr(self.active_safety,'controller','RULE'))

    def _clear_safety_command(self):
        if self.safety_command is not None and self.arbiter.safety.latest.get(CommandSource.SAFETY) == self.safety_command:
            self.arbiter.safety.latest.pop(CommandSource.SAFETY, None)
            self.arbiter.safety.receipts.pop(CommandSource.SAFETY, None)
        self.safety_command = None

    def _active_safety_step(self):
        supervisor = self.active_safety
        if supervisor is None: return
        mode = self.arbiter.machine.mode
        observer_only = self._normal_driving()
        if observer_only:
            self._clear_safety_command()
        if not supervisor.enabled or mode not in (ControlMode.MANUAL, ControlMode.AUTOMATIC):
            self._clear_safety_command(); supervisor.reset()
            # A past receipt fault is not proof that today's sensors are absent.
            # Recover the health indication while held, without resuming a drive
            # or releasing the arbiter's parking/ordinary-stop command.
            if supervisor.enabled and mode == ControlMode.PAUSED and supervisor.last_fault and not supervisor.last_fault.startswith('MODEL_FAILURE:'):
                try:
                    self._current_safety_observation(supervisor)
                except ValueError:
                    pass
                else:
                    supervisor.last_fault = None
                    if hasattr(supervisor, 'guard'): supervisor.guard.last_fault = None
            supervisor.status.update(status='DISABLED_COMPARISON' if not supervisor.enabled else
                'SUSPENDED_RL' if mode == ControlMode.TRAINING else 'SENSOR_FAULT_STOP' if supervisor.last_fault else 'STANDBY',
                actual_generator='BASE_DRIVER',
                reason='Safety disabled for research comparison' if not supervisor.enabled else
                    supervisor.last_fault or 'Monitoring resumes with normal forward driving')
            self.provider.active_safety_status = supervisor.snapshot()
            return
        frame_id, timestamp_s = self._context()
        base = self.arbiter.choose(frame_id=frame_id, timestamp_s=timestamp_s, connected=self._live(),
                                   exclude_sources=(CommandSource.SAFETY,))
        if base.source not in (CommandSource.MANUAL, CommandSource.NAVIGATION):
            self._clear_safety_command(); supervisor.reset()
            self.provider.active_safety_status = supervisor.snapshot()
            return
        stage = 'observation_freshness'
        observation = None
        evaluation_started = self.now()
        try:
            observation, receipt = self._current_safety_observation(supervisor)
            self.control_timing_ms['sensor_age_before_safety_ms'] = (self.now()-receipt)*1000
            if self.control_scene and self.control_scene.observation.frame_id == observation.frame_id:
                supervisor.measured_space = self.control_scene.space
                if hasattr(supervisor,'guard'):supervisor.guard.measured_space = self.control_scene.space
            else:
                supervisor.measured_space = None
                if hasattr(supervisor,'guard'):supervisor.guard.measured_space = None
            base = replace(base, frame_id=observation.frame_id, timestamp_s=observation.timestamp_s)
            if hasattr(supervisor,'cap_mps'):
                supervisor.cap_mps = min(self.journey.get('speed_kmh',30)/3.6,
                    getattr(self.provider,'navigation_speed_limit_mps',30/3.6))
            was_active = supervisor.active
            # A sensor frame does not identify a driving intent. In particular,
            # a cached forward brake cannot be admitted as a reverse proposal.
            path = getattr(supervisor, 'forward_path', None)
            intent = (base.throttle, base.brake, base.steering, base.reverse,
                      base.gear, base.handbrake, base.source,
                      repr(path) if path is not None else None)
            decision_key = (self.session_id, observation.frame_id, observer_only, intent)
            if supervisor.previous_s == observation.timestamp_s and self.safety_decision_key != decision_key:
                supervisor.reset()
            if supervisor.previous_s == observation.timestamp_s and self.safety_decision_key == decision_key:
                stage = 'cached_proposal_admission'
                # Reuse only within the same enforced freshness limits. Never call
                # the stateful teacher twice or change the driver's steering.
                candidate = self.safety_decision_command
                if candidate is not None:
                    from .safety_policy import ProposedSafetyAction, admit_proposal
                    proposal = ProposedSafetyAction(candidate, supervisor.config.version,
                        observation.frame_id, observation.timestamp_s, True, supervisor.status['reason'])
                    admitted = admit_proposal(observation, base, proposal,
                        supervisor.validator.validate((observation,), base, proposal))
                    if not admitted.accepted: raise ValueError(admitted.reason)
                    candidate = admitted.command
            else:
                stage = 'supervisor_evaluation'
                candidate = supervisor.evaluate(observation, base, self.provider.get_sensor_asset,
                                                as_of_timestamp_s=self.clock.timestamp_s)
            self.safety_decision_key = decision_key
            self.safety_decision_command = candidate
            stage = 'processing_freshness'
            if self.now()-receipt > supervisor.config.maximum_sensor_wall_age_s:
                raise ValueError('Safety processing exceeded sensor wall freshness limit')
            self.safety_processing_wait_at = None
            self.journey_observer = supervisor.snapshot()
            if observer_only:
                # The same sensor observer supplies measured comparison metrics.
                # Its proposals never enter the standard CARLA driver's commands.
                self._clear_safety_command()
            elif candidate is None:
                self._clear_safety_command()
            else:
                stage = 'command_admission'
                # Preserve the previous receipt/order so normal safety rate and
                # monotonic-command admission checks also apply on every refresh.
                self.safety_command = self.arbiter.submit(candidate, frame_id=frame_id,
                    timestamp_s=timestamp_s, connected=True)
            if supervisor.active != was_active and not observer_only:
                event_safety = supervisor.snapshot()
                if event_safety.get('prediction'):
                    prediction = event_safety.pop('prediction')
                    event_safety['prediction_reference'] = {k:prediction[k] for k in
                        ('session_id','evaluation_frame','prediction_source_frame','decision_source')}
                self._event(EventType.ControlChanged, ya_rab_ostorha=event_safety)
        except (ValueError, KeyError, OSError, TypeError, ArithmeticError) as error:
            self._clear_safety_command()
            sensor_delay = not observer_only and stage == 'processing_freshness'
            if (not observer_only and mode == ControlMode.AUTOMATIC and stage == 'observation_freshness'
                    and str(error) == 'Fresh complete safety observations unavailable'):
                # A complete same-time frame can arrive late under host load.
                # It cannot authorize motion; only the fixed full-brake hold
                # may wait briefly for its successor in the active journey.
                from .contracts import SensorKind
                history=self.policy_history.snapshot()
                delayed=history[-1] if history else None
                required={SensorKind.RADAR,SensorKind.LIDAR,SensorKind.DEPTH,SensorKind.IMU}
                if (delayed is not None and self.clock.timestamp_s is not None and
                        0 <= self.clock.timestamp_s-delayed.timestamp_s <= supervisor.config.teacher.maximum_observation_age_s and
                        required <= {c.kind for c in delayed.channels} and
                        all(c.frame_id==delayed.frame_id and abs(c.sensor_timestamp_s-delayed.timestamp_s)<=1e-6
                            for c in delayed.channels)):
                    sensor_delay=True;observation=delayed
                    receipt=self.state_at if self.safety_observed_at is None else self.safety_observed_at
            self.safety_fault = {'stage': stage, 'exception_type': type(error).__name__,
                'message': str(error), 'traceback': traceback.format_exc(), 'observer_only': observer_only,
                'evaluation_frame': frame_id, 'timestamp_s': timestamp_s,
                'sensor_frame': to_dict(observation) if observation else None,
                'assessed_scene': supervisor.snapshot(),
                'sensor_wall_age_s': self.now()-receipt if observation else None,
                'processing_ms': (self.now()-evaluation_started)*1000,
                'base_command': to_dict(base)}
            supervisor.reset()
            model_failure = str(error).startswith('MODEL_FAILURE:')
            if sensor_delay and self.safety_processing_wait_at is None:
                self.safety_processing_wait_at = self.now()
            recovering = sensor_delay and self.now()-self.safety_processing_wait_at < 1.
            supervisor.status.update(status='OBSERVER_FAULT' if observer_only else
                'SENSOR_DELAY_HOLD' if recovering else 'MODEL_FAILURE_STOP' if model_failure else 'SENSOR_FAULT_STOP', risk='UNKNOWN',
                reason=str(error), observer_error=str(error) if observer_only else None,
                frame_id=frame_id, timestamp_s=timestamp_s)
            supervisor.last_fault = None if observer_only or recovering else str(error)
            if recovering:
                # Reject the expired proposal. Only a full stop reaches CARLA
                # on this tick; the still-owned journey awaits the next fresh
                # frame. Operator stops and invalid or unsynchronized inputs
                # remain terminal, and repeated delays expire after 1 s.
                hold = replace(base, frame_id=frame_id, timestamp_s=timestamp_s,
                    source=CommandSource.SAFETY, throttle=0., brake=1.)
                self.safety_command = self.arbiter.submit(hold, frame_id=frame_id,
                    timestamp_s=timestamp_s, connected=True)
                supervisor.brake=1.;supervisor.active=True;supervisor.started_s=observation.timestamp_s
                supervisor.status.update(active=True, actual_generator='SENSOR_FRESHNESS',
                    decision_source='SENSOR_FRESHNESS', reason='Sensor delay; holding until the next fresh sensor frame')
                self.safety_decision_key = self.safety_decision_command = None
            self.journey_observer = supervisor.snapshot()
            self._event(EventType.ControlChanged, safety_fault=copy.deepcopy(self.safety_fault))
            if not observer_only and not recovering:
                self.stop_driving('ya_rab_ostorha_model_failure' if model_failure else 'ya_rab_ostorha_sensor_fault', failure=True)
        self.provider.active_safety_status = supervisor.snapshot()

    def _normal_driving(self):
        mode = self.arbiter.machine.mode
        return (mode == ControlMode.AUTOMATIC and self.journey.get('driving_mode') == 'NORMAL' or
                mode == ControlMode.MANUAL and self.manual_driving_mode == 'NORMAL')

    def _current_safety_observation(self, supervisor):
        from .contracts import SensorKind
        history = self.policy_history.snapshot()
        receipt = self.state_at if self.safety_observed_at is None else self.safety_observed_at
        if not history or not 0 <= self.now()-receipt <= supervisor.config.maximum_sensor_wall_age_s:
            raise ValueError('Fresh complete safety observations unavailable')
        observation = history[-1]
        if self.clock.timestamp_s is None or not 0 <= self.clock.timestamp_s-observation.timestamp_s <= supervisor.config.teacher.maximum_observation_age_s:
            raise ValueError('Safety sensor simulation freshness limit exceeded')
        if not {SensorKind.RADAR,SensorKind.LIDAR,SensorKind.DEPTH,SensorKind.IMU} <= {c.kind for c in observation.channels} or any(
                c.frame_id != observation.frame_id or abs(c.sensor_timestamp_s-observation.timestamp_s)>1e-6 for c in observation.channels):
            raise ValueError('Safety sensors are stale or unsynchronized')
        return observation, receipt

    def _required_after_sensor_rebuild(self):
        required=getattr(self.provider,'required_sensors',None)
        return required if isinstance(required,(tuple,list,set,frozenset)) else self.synchronizer.required

    def _audit_command(self, command):
        """Capture every applied brake source, including arbiter/freshness stops."""
        safety = self.active_safety.snapshot() if self.active_safety else {}
        source = safety.get('decision_source', safety.get('actual_generator', 'RULE')) if command == self.safety_command else (
            'DRIVER' if command.source == CommandSource.MANUAL else 'NAVIGATION' if command.source == CommandSource.NAVIGATION else
            ('MODEL' if self.active_safety.last_fault.startswith('MODEL_FAILURE:') else 'SENSOR_FAILURE')
                if self.active_safety and self.active_safety.last_fault else 'COMMAND_WATCHDOG')
        reason = safety.get('reason') if command == self.safety_command else self.arbiter.reason
        if command.source == CommandSource.NAVIGATION and command.brake > .01:
            reason = getattr(self.provider,'navigation_stop_reason',None) or reason
        if command.source == CommandSource.MANUAL and self.manual_stop_reason and command.brake > .01:
            reason = self.manual_stop_reason
        if command != self.safety_command:
            if getattr(self, 'runtime_fault', None) and self.error:
                source = 'RUNTIME_FAILURE'
                reason = self.runtime_fault['message']
            elif self.active_safety and self.active_safety.last_fault and self.journey.get('reason') in (
                    None, 'ya_rab_ostorha_sensor_fault', 'ya_rab_ostorha_model_failure'):
                reason = self.active_safety.last_fault
            elif self.arbiter.reason in ('disconnected','command_timeout') or self.journey.get('reason') == 'dashboard_heartbeat_timeout':
                source = 'COMMUNICATION_FAILURE'
                reason = self.journey.get('reason') if self.journey.get('reason') == 'dashboard_heartbeat_timeout' else self.arbiter.reason
            elif command.source in (CommandSource.SYSTEM, CommandSource.SAFETY) and self.journey.get('reason'):
                reason = self.journey['reason']
                if reason in ('operator_stop','operator_pause','controls_released','comparison_v2_stop'): source = 'DRIVER'
                elif reason == 'destination_reached': source = 'NAVIGATION'
                elif reason == 'emergency_stop': source = 'EMERGENCY_PROTECTION'
                elif reason in ('focus_lost','workspace_changed','page_closed','ownership_taken'): source = 'VEHICLE_HOLD'
            elif self.arbiter.machine.mode == ControlMode.PAUSED:
                source = 'VEHICLE_HOLD'
                reason = self.journey.get('reason') or 'Vehicle held; explicit driving start required'
        braking_sources = []
        if command == self.safety_command and safety.get('base_driver_brake', 0) > .01:
            braking_sources.append('DRIVER' if safety.get('base_command_source') == 'MANUAL' else 'NAVIGATION')
        if command.brake > .01 or command.handbrake:
            if command != self.safety_command or command.brake > safety.get('base_driver_brake', 0)+1e-6:
                braking_sources.append(source)
            elif braking_sources:
                source = braking_sources[0]
        frame_id, stamp = self._context()
        geometry = getattr(getattr(self, 'provider', None), 'vehicle_geometry', None)
        self.stop_diagnostics = {'version': 2, 'session_id': self.session_id, 'evaluation_frame': frame_id,
            'timestamp_s': stamp, 'braking': command.brake > .01 or command.handbrake, 'decision_source': source,
            'braking_sources': braking_sources,
            'reason': reason,
            'base_command': to_dict(getattr(self, 'base_driver_command', None)),
            'applied_command': to_dict(command), 'safety': safety,
            'vehicle_geometry': to_dict(geometry) if is_dataclass(geometry) else None,
            'safety_fault': copy.deepcopy(getattr(self, 'safety_fault', None)),
            'runtime_fault': copy.deepcopy(getattr(self, 'runtime_fault', None)),
            'sensor_wall_age_s': self.now()-(self.state_at if self.safety_observed_at is None else self.safety_observed_at),
            'control_timing_ms': dict(getattr(self,'control_timing_ms',{})),
            'sensor_ages_s': {s.sensor_id: stamp-s.sensor_timestamp_s for s in self.observation.sensors} if self.observation else {},
            'ego_render_pose': to_dict(self.observation.vehicle.transform) if self.observation else None}
        prediction = safety.get('prediction')
        if prediction and self.observation:
            reference = getattr(self,'render_pose_cache',{}).get(prediction['evaluation_frame'])
            if reference is None and prediction['evaluation_frame'] == self.observation.frame_id:
                reference = to_dict(self.observation.vehicle.transform)
            if reference is not None: prediction['render_reference'] = reference
            else: prediction.pop('render_reference',None)
        if self.recorder and hasattr(self.recorder,'record_safety'):
            self.recorder.record_safety(copy.deepcopy(self.stop_diagnostics))
        if getattr(self, 'journey_recording_stop_pending', None):
            self.journey_recording_stop_pending['applied'] = True

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
            if self.last_recording and not self.last_recording.closed:
                raise ValueError('Previous recording is still finalizing; control remains available')
            from datetime import datetime, timezone
            from pathlib import Path
            from .contracts import ExperimentMetadata, DataOrigin
            from .recording import RunRecorder
            directory = Path(__file__).resolve().parents[2] / 'runs' / 'normal_city'
            environment=self.provider.environment_state()
            label='Controlled scenario native run' if environment and environment.get('mode')=='TRAINING' else 'Living city native run'
            self.recorder = RunRecorder(directory, ExperimentMetadata('run_'+uuid.uuid4().hex,
                label, self.name, DataOrigin.REAL_SIMULATION,
                seed=(environment.get('scenario') or {}).get('random_seed') if environment else None,
                created_at_utc=datetime.now(timezone.utc).isoformat(), config=self.provider.recording_metadata()))
            from .recording import BufferedRunRecorder
            self.recorder = BufferedRunRecorder(self.recorder)
            self.last_recording=self.recorder
            self._event(EventType.ControlChanged, recording='STARTED', population=self.provider.population_state())
            return {'enabled': True, 'path': str(self.recorder.root)}
        if not self.recorder: raise ValueError('No recording is active')
        self._event(EventType.ControlChanged, recording='STOPPED')
        recorder = self.recorder; self.recorder = None
        from .recording import BufferedRunRecorder
        if isinstance(recorder, BufferedRunRecorder):
            recorder.finish()
        else:recorder.close()
        return {'enabled': False, 'path': str(recorder.root),
                'status':recorder.status() if hasattr(recorder,'status') else None}

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
                    self.journey_comparison.collision(collision)
                    if self.journey_auto_recording and self.recorder:
                        self.recorder.record_event(SimulationEvent(EventType.CollisionDetected,
                            collision.frame_id, collision.timestamp_s, {'collision': to_dict(collision)}))
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
        if hasattr(self.recorder, 'submit'):
            assets = [(sensor.asset, self.provider.get_sensor_asset(sensor.asset))
                      for sensor in frame.sensors if sensor.asset]
            self.recorder.submit(frame, assets)
            if self.comparison: self.comparison.record(frame)
            return
        if hasattr(self.recorder, 'store_asset') and hasattr(self.provider, 'get_sensor_asset'):
            for sensor in frame.sensors:
                if sensor.asset:
                    folder, filename = sensor.asset.path.split('/', 1)
                    stored = self.recorder.store_asset(folder, filename, self.provider.get_sensor_asset(sensor.asset), sensor.asset.media_type)
                    if stored != sensor.asset:
                        raise RuntimeError('Recorded sensor bytes differ from the native frame reference')
        self.recorder.record(frame)
        if self.comparison:
            self.comparison.record(frame)

    def submit_control(self, command):
        with self.lock:
            self._require_normal_runtime()
            self.require_connected()
            previous = self.arbiter.machine.mode
            frame_id, timestamp_s = self._context()
            known_timestamp = self.clock.tracker.seen.get(command.frame_id)
            if command.frame_id == frame_id and abs(command.timestamp_s-timestamp_s) > 1e-6 or known_timestamp is not None and abs(command.timestamp_s-known_timestamp) > 1e-6:
                raise ValueError('Control frame ID/timestamp does not match its observation')
            self.manual_stop_reason = None
            result = self.arbiter.submit(command, frame_id=frame_id, timestamp_s=timestamp_s, connected=True)
            if command.source in (CommandSource.MANUAL, CommandSource.NAVIGATION):
                self.base_driver_command = command
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
        if self.journey.get('status') in ('STARTING','RUNNING') or status == 'ERROR':
            frame_id, stamp = self._context()
            fault = self.runtime_fault if reason == 'runtime_failure' else self.safety_fault
            self.last_drive_stop = {'reason':reason,'status':status,'frame_id':frame_id,'timestamp_s':stamp,
                'detail':fault.get('message') if fault and status == 'ERROR' else reason}
        if self.journey_comparison.active:
            if self.observation:
                self.journey_comparison.sample(self.observation, getattr(self.provider, 'route_state', lambda: None)(), self.journey_observer)
            self.journey_comparison.finish(reason, 'ERROR' if status == 'ERROR' else 'INTERRUPTED')
        if self.journey_auto_recording:
            self.journey_auto_recording = False
            # Seal only after the terminal command has reached the provider and
            # its audit row has been queued, including the original exception.
            self.journey_recording_stop_pending = {
                'mode': self.journey.get('driving_mode') or 'UNPAIRED', 'applied': False}
        if hasattr(self.provider, 'stop_navigation'):
            self.provider.stop_navigation()
        self.navigation_heartbeat_at = -float('inf')
        self.actions = deque((a, v) for a, v in self.actions if a != 'start_journey')
        self.journey.update(status=status, reason=reason)
        self.maneuver_status={'action':'HOLD','phase':status,'reason':reason,'selected_path':None}
        if self.active_safety:
            self.active_safety.forward_path=None
            if hasattr(self.active_safety,'guard'):self.active_safety.guard.forward_path=None
        self.arbiter.safety.latest.pop(CommandSource.NAVIGATION, None)
        self.arbiter.safety.receipts.pop(CommandSource.NAVIGATION, None)
        if self.arbiter.machine.mode == ControlMode.AUTOMATIC:
            self.arbiter.machine.transition(ControlMode.MANUAL if manual else ControlMode.PAUSED, connected=True)
        self._event(EventType.ControlChanged, journey=copy.deepcopy(self.journey))

    def _finish_journey_recording(self):
        pending = self.journey_recording_stop_pending
        if not pending or not pending['applied']:
            return
        self.journey_recording_stop_pending = None
        run = self.journey_comparison.data['runs'].get(pending['mode'])
        if run:
            run['stop_diagnostics'] = copy.deepcopy(self.stop_diagnostics)
            self.journey_comparison.save()
        if self.recorder:
            self._change_recording({'enabled': False})

    def stop_driving(self, reason='operator_stop', *, cancel_comparison=True, failure=False):
        with self.lock:
            self._require_normal_runtime()
            self.require_connected()
            if cancel_comparison and self.comparison_v2: self.comparison_v2.request_stop(reason)
            self._stop_navigation(reason, status='ERROR' if failure else 'PAUSED')
            if self.arbiter.machine.mode == ControlMode.MANUAL:
                self.arbiter.machine.transition(ControlMode.PAUSED, connected=True)
            self.release_controls()
            # Keep native ticks/cameras running while the safety brake stops the car.
            if self.paused:
                self.actions.append(('pause', False))

    def _comparison_busy(self):
        return bool(self.comparison and self.comparison.busy or self.comparison_v2 and self.comparison_v2.busy)

    def start_journey(self, speed_kmh=30, *, driving_mode=None, pair_id=None):
        if self._comparison_busy():
            raise ValueError('Stop/Reset the comparison before starting another journey')
        self._require_normal_runtime()
        if not self.arbiter.machine.allow_navigation:
            raise ValueError('Destination journeys are unavailable in this mode')
        speed = finite(speed_kmh)
        if not 5 <= speed <= 30:
            raise ValueError('Journey speed must be 5–30 km/h')
        with self.lock:
            self._require_normal_runtime()
            self.require_connected()
            if driving_mode is not None:
                from .journey_comparison import validate_mode
                validate_mode(driving_mode)
                if self.active_safety is None or not hasattr(self.provider, 'journey_manifest'):
                    raise ValueError('Mode comparison requires native CARLA and its sensor suite')
                environment = getattr(self.provider, 'environment_state', lambda: {})()
                if environment and environment.get('mode') == 'TRAINING':
                    raise ValueError('Return to Living city before starting an ordinary comparison')
                population = getattr(self.provider, 'population_state', lambda: {})() or {}
                crowding = population.get('route_crowding')
                if crowding and crowding.get('status') != 'READY':
                    raise ValueError('Wait for confirmed route traffic before starting')
                if self.recorder or self.last_recording and not self.last_recording.closed:
                    raise ValueError('Wait for the current recording to finish')
                if self.journey['status'] in ('STARTING', 'RUNNING') or abs(self.observation.vehicle.speed_mps) > .15:
                    raise ValueError('Stop the vehicle before selecting a journey mode')
                if pair_id is not None and (pair_id != self.prepared_journey_pair or pair_id != self.journey_comparison.data['pair_id']):
                    raise ValueError('Prepare this comparison mode again before starting')
            if not getattr(self.provider, 'route_state', lambda: None)():
                raise ValueError('Choose a valid destination and show its route before starting')
            if self.dashboard_result and self.dashboard_result.get('action')=='destination' and self.dashboard_result.get('status') in ('PENDING', 'REJECTED'):
                raise ValueError('Choose a valid destination and show its route before starting the journey')
            if self.arbiter.machine.mode == ControlMode.EMERGENCY_STOP:
                raise ValueError('Acknowledge the emergency stop before starting')
            self.release_controls()
            self.navigation_heartbeat_at = self.now()
            self.journey = {'status': 'STARTING', 'reason': None, 'speed_kmh': speed}
            self.last_drive_stop = None
            self.safety_processing_wait_at = None
            if driving_mode is not None:
                self.journey.update(driving_mode=driving_mode, pair_id=pair_id)
                self.manual_driving_mode = driving_mode
            self.actions.append(('start_journey', speed))

    def journey_heartbeat(self, session_id):
        with self.lock:
            if session_id != self.session_id:
                raise ValueError('Journey heartbeat belongs to a previous CARLA session')
            if self.journey['status'] not in ('STARTING', 'RUNNING'):
                return
            self.navigation_heartbeat_at = self.now()

    def set_journey_speed(self, speed_kmh):
        if self._comparison_busy():
            raise ValueError('Comparison speed is fixed by the selected scenario')
        speed = finite(speed_kmh)
        if not 5 <= speed <= 30:
            raise ValueError('Journey speed must be 5–30 km/h')
        with self.lock:
            self.require_connected()
            if self.arbiter.machine.mode != ControlMode.AUTOMATIC:
                raise ValueError('Start a destination journey before changing its live speed')
            self.journey['speed_kmh'] = speed
            if self.journey_comparison.active:
                self.journey_comparison.active['setup']['live_speed_changed'] = True
                self.journey_comparison.event('Target speed changed', self.clock.timestamp_s, f'{speed} km/h')
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
            frame_id, timestamp_s = self._context()
            self.base_driver_command = safe_command(frame_id, timestamp_s, source=CommandSource.NAVIGATION)
            if self.observation.vehicle.speed_mps < .15:
                self._stop_navigation('destination_reached' if route['arrived'] else 'route_ended_before_destination',
                                      status='ARRIVED' if route['arrived'] else 'ERROR')
            else:
                self.arbiter.submit(self.base_driver_command,
                                    frame_id=frame_id, timestamp_s=timestamp_s, connected=True)
            return
        frame_id, timestamp_s = self._context()
        command = self.provider.navigation_command(frame_id, timestamp_s, self.journey['speed_kmh'])
        self.base_driver_command = command
        geometry=getattr(self.provider,'vehicle_geometry',None)
        if geometry is not None and self.active_safety:
            self.active_safety.geometry=geometry
            if hasattr(self.active_safety,'guard'):self.active_safety.guard.geometry=geometry
        planner=getattr(self.provider,'navigation_planner',None)
        if self.journey.get('driving_mode') == 'NORMAL':
            planner = None
        if planner is not None and getattr(planner,'lateral_deadline',float('inf'))<=self.now():
            self._stop_navigation('motion_validation_expired');return
        if planner is not None and not self._comparison_busy():
            from .motion_scene import advance_scene
            history=self.policy_history.snapshot();scene=getattr(self,'motion_scene',None)
            if history and scene is not None:
                observation=history[-1]
                try:
                    points,motion=advance_scene(scene,observation)
                    road=self.provider.local_road_context(self.session_id)
                    cap=min(self.journey['speed_kmh']/3.6,getattr(self.provider,'navigation_speed_limit_mps',30/3.6))
                    command,self.maneuver_status=planner.evaluate(observation,command,motion,points,road,cap)
                    self.maneuver_status['render_reference']=copy.deepcopy(self.render_pose_cache.get(observation.frame_id))
                except (ValueError,KeyError,TypeError,ArithmeticError) as error:
                    # An asynchronous forecast cannot create an emergency stop.
                    # Fresh synchronous RULE still checks the existing forward
                    # route; stale motion admits no acceleration or lane change.
                    if planner.phase!='FOLLOW':command=replace(command,throttle=0.,brake=.5)
                    else:command=replace(command,throttle=min(command.throttle,.2))
                    self.maneuver_status={'action':'RULE_FOLLOW','phase':planner.phase,'reason':str(error),'selected_path':None,'experimental':True}
            else:
                command=replace(command,throttle=0.,brake=1.)
                self.maneuver_status={'action':'HOLD','phase':'FOLLOW','reason':'Waiting for measured motion','selected_path':None,'experimental':True}
            if self.active_safety:
                self.active_safety.geometry=planner.geometry
                self.active_safety.forward_path=self.maneuver_status.get('selected_path')
                if hasattr(self.active_safety,'guard'):
                    self.active_safety.guard.geometry=planner.geometry
                    self.active_safety.guard.forward_path=self.active_safety.forward_path
            self.provider.navigation_stop_reason=self.maneuver_status['reason'] if command.brake>.01 else None
        elif planner is None:
            self.maneuver_status={'action':'RULE_FOLLOW','phase':'FOLLOW','reason':'Maneuver prototype did not pass native acceptance',
                'experimental':True,'selected_path':None,'target_speed_kmh':self.journey['speed_kmh']}
        recovery=getattr(self.provider,'navigation_recovery',None)
        from .congestion_recovery import CongestionRecovery
        if not isinstance(recovery,CongestionRecovery):recovery=None
        if self.journey.get('driving_mode') == 'NORMAL':recovery=None
        recovery_selected=False
        if recovery is not None and not self._comparison_busy():
            if self.now()>=getattr(recovery,'validation_deadline',float('inf')):
                self._stop_navigation('recovery_validation_expired');return
            try:
                from .motion_scene import advance_scene
                observation,_=self._current_safety_observation(self.active_safety)
                scene=getattr(self,'motion_scene',None)
                if scene is None:raise ValueError('Recovery requires measured motion')
                points,motion=advance_scene(scene,observation)
                road=self.provider.local_road_context(self.session_id)
                selected,status=recovery.evaluate(observation,command,motion,motion.get('_observed_space'),road,wall=self.now())
                self.maneuver_status=status
                self.maneuver_status['render_reference']=copy.deepcopy(self.render_pose_cache.get(observation.frame_id))
                if selected is not None:
                    command=selected;recovery_selected=True
                    self.provider.navigation_stop_reason=status['reason'] if command.brake>.01 else None
                    if status['action']=='REPLAN':self.provider.replan_after_recovery()
                path=status.get('selected_path') if selected is not None and not selected.reverse else None
                self.active_safety.forward_path=path
                if hasattr(self.active_safety,'guard'):self.active_safety.guard.forward_path=path
            except (ValueError,KeyError,TypeError,ArithmeticError) as error:
                if recovery.intent or recovery.phase!='FOLLOW':
                    # A missing scene must not switch back into forward gear
                    # while an active reverse maneuver is still moving.
                    actual=self.observation.vehicle
                    command=replace(command,throttle=0.,brake=1.,reverse=actual.reverse,
                        gear=-1 if actual.reverse else 0 if actual.gear==0 else 1);recovery_selected=True
                    self.active_safety.forward_path=None
                    if hasattr(self.active_safety,'guard'):self.active_safety.guard.forward_path=None
                self.maneuver_status={'action':'HOLD' if recovery_selected else 'RULE_FOLLOW','phase':recovery.phase,
                    'reason':str(error),'selected_path':None,'experimental':True}
        self.rear_assist = False
        if planner is None and not recovery_selected and self.active_safety and self.journey.get('driving_mode') == 'ROBOSPHERE':
            from .normal_navigation import sensor_navigation_command
            command, sensor_reason, self.rear_assist = sensor_navigation_command(
                command, self.active_safety.status, frame_id=frame_id, timestamp_s=timestamp_s,
                speed_mps=max(0., self.observation.vehicle.speed_mps),
                target_speed_mps=min(self.journey['speed_kmh']/3.6,
                    getattr(self.provider, 'navigation_speed_limit_mps', self.journey['speed_kmh']/3.6)),
                normal_mode=False)
            if sensor_reason:self.provider.navigation_stop_reason = sensor_reason
        self.arbiter.submit(command, frame_id=frame_id, timestamp_s=timestamp_s, connected=True)
        self.command_at = self.now()

    def emergency_stop(self):
        with self.lock:
            self.require_connected()
            if self.comparison_v2: self.comparison_v2.request_stop('emergency_stop')
            self._stop_navigation('emergency_stop')
            self.arbiter.emergency_stop(connected=True)
            self._event(EventType.EmergencyStop, reason='explicit_operator_request')

    def acknowledge_stop(self):
        with self.lock:
            self.require_connected()
            self.arbiter.acknowledge_stop(connected=True)

    def reset_vehicle(self):
        if self.comparison and self.comparison.busy and self.comparison is not self.comparison_v2:
            raise ValueError('Use Stop/Reset demo to reset the comparison')
        self._require_normal_runtime()
        self.require_connected()
        self.release_controls()
        with self.lock:
            self._require_normal_runtime()
            self.stop_driving('vehicle_reset')
            self.actions.append(('reset', None))

    def set_paused(self, paused, *, driving_mode=None):
        if self._comparison_busy() and not paused:
            raise ValueError('Stop/Reset demo before enabling manual driving')
        self._require_normal_runtime()
        if type(paused) is not bool:
            raise ValueError('paused must be boolean')
        if driving_mode is not None:
            if paused: raise ValueError('Choose a manual protection mode only when enabling keyboard driving')
            from .journey_comparison import validate_mode
            validate_mode(driving_mode)
            if self.active_safety is None:
                raise ValueError('Manual protection modes require the native CARLA sensor suite')
        with self.lock:
            self._require_normal_runtime()
            self.require_connected()
            if self.arbiter.machine.mode == ControlMode.AUTOMATIC:
                self._stop_navigation('operator_pause')
            if driving_mode is not None:self.manual_driving_mode=driving_mode
            self.manual_stop_reason=None
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
            if action == 'comparison':
                if not self.comparison:
                    raise ValueError('Live comparison unavailable')
                if self.comparison_v2 and self.comparison_v2.busy:
                    raise ValueError('Stop comparison_v2 before using historical comparisons')
                if self.historical_comparison is not None: self.comparison = self.historical_comparison
                self.comparison.request(value)
                self.dashboard_result = {'action': action, 'status': 'PENDING'}
                return
            if action == 'comparison_v2':
                if not self.comparison_v2: raise ValueError('comparison_v2 requires live CARLA sensors')
                self.comparison_v2.request(value)
                self.dashboard_result = {'action': action, 'status': 'PENDING'}
                return
            if self._comparison_busy():
                raise ValueError('Stop/Reset the comparison before changing its configuration')
            if action == 'prepare_journey_mode':
                from .journey_comparison import validate_mode
                if not isinstance(value, dict) or set(value) != {'mode', 'pair_id'}:
                    raise ValueError('Choose a saved comparison and its mode')
                validate_mode(value['mode'])
                if not value['pair_id'] or value['pair_id'] != self.journey_comparison.data['pair_id']:
                    raise ValueError('The comparison changed. Refresh Results')
                if self.recorder or self.journey_comparison.active or self.arbiter.machine.mode != ControlMode.PAUSED or abs(self.observation.vehicle.speed_mps) > .15:
                    raise ValueError('Stop the vehicle and finish its recording before preparing a mode')
            if action not in ('prepare_journey_mode', 'settings', 'destination', 'save_place', 'favorite_place', 'clear_route', 'population', 'crowd_route', 'inspector', 'recording', 'world_reset', 'scene', 'environment', 'scenario'):
                raise ValueError('Unknown dashboard operation')
            live_camera_view = action == 'settings' and isinstance(value, dict) and set(value) == {'camera_view'}
            if self.recorder and action in ('settings','world_reset','crowd_route') and not live_camera_view:
                raise ValueError('Finish recording before changing sensor configuration')
            if action == 'crowd_route' and (self.arbiter.machine.mode != ControlMode.PAUSED or
                    self.journey['status'] == 'STARTING' or abs(self.observation.vehicle.speed_mps) > .15):
                raise ValueError('Stop the vehicle before crowding its route')
            scenario_rebuild=action=='scenario' and (not isinstance(value,dict) or value.get('operation') in ('load','reset','cleanup'))
            if self.recorder and (action=='environment' or scenario_rebuild):
                raise ValueError('Finish recording before rebuilding scenario actors or changing environment mode')
            if action=='world_reset':
                active = self.provider.runtime.active or {'quality':'Low','resolution':'1280x720'}
                self.restart_graphics({k:active[k] for k in ('quality','resolution')}, operation='WORLD_RESET')
                return
            if not live_camera_view:self.release_controls()
            if not live_camera_view and action in ('destination','clear_route','population','crowd_route','settings','scene','environment','scenario'):
                self.prepared_journey_pair = None
            self.dashboard_result = {'action': action, 'status': 'PENDING'}
            self.actions.append((action, value))

    def reconnect(self):
        with self.lock:
            self._require_normal_runtime()
            if self.simulator_stop['status']=='STOPPING':
                raise ValueError('CARLA is still stopping')
            if self.simulator_stop['status']=='STOPPED':
                raise ValueError('CARLA is stopped. Run Start-YA-RAB-OSTORHA.ps1 to start it again.')
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

    def can_stop_simulator(self):
        connection=getattr(self.provider,'connection',None)
        return (getattr(self.provider,'name',None)=='carla' and
            getattr(connection,'host',None) in ('127.0.0.1','localhost','::1') and
            callable(getattr(getattr(self.provider,'runtime',None),'stop',None)) and
            callable(getattr(self.provider,'shutdown_handler',None)))

    def can_start_simulation(self):
        return (getattr(getattr(self.provider,'connection',None),'host',None) in ('127.0.0.1','localhost','::1')
                and callable(getattr(self.provider,'startup_handler',None)))

    def can_reset_simulation(self):
        return (getattr(getattr(self.provider,'connection',None),'host',None) in ('127.0.0.1','localhost','::1')
                and callable(getattr(self.provider,'reset_handler',None)))

    def reset_simulation(self):
        """Flush the drive and rebuild the engine/SDK with clean session defaults."""
        with self.lock:
            self._require_normal_runtime()
            if not self.can_reset_simulation():raise ValueError('Local simulation reset is unavailable')
            if self.restarting or self.simulator_stop['status']=='STOPPING':raise ValueError('Wait for the current restart or shutdown')
            if self.simulator_start['status']=='STARTING':return dict(self.simulator_start)
            self.simulator_start={'status':'STARTING','operation':'RESET'}
            self._stop_navigation('application_reset');self.release_controls()
            threading.Thread(target=self._start_simulation_native,args=(True,),name='native-session-reset',daemon=True).start()
            return dict(self.simulator_start)

    def start_simulation(self):
        """One explicit local action starts the engine and a stopped sensor session."""
        with self.lock:
            self._require_normal_runtime()
            if self._live():return {'status':'READY'}
            if self.restarting or self.simulator_stop['status']=='STOPPING':
                raise ValueError('Wait for CARLA to finish stopping or restarting')
            if not self.can_start_simulation():raise ValueError('Local simulation startup is unavailable')
            if self.simulator_start['status']=='STARTING':return dict(self.simulator_start)
            self.simulator_start={'status':'STARTING'}
            threading.Thread(target=self._start_simulation_native,name='native-startup',daemon=True).start()
            return dict(self.simulator_start)

    def _start_simulation_native(self,reset=False):
        try:
            self.close()
            handler=self.provider.reset_handler if reset else self.provider.startup_handler
            self.startup_ticket=handler(self.simulator_stop)
        except Exception as error:
            with self.lock:self.simulator_start={'status':'FAILED','error':str(error)}

    def stop_simulator(self):
        """Explicit local operator shutdown; keep the dashboard host available."""
        with self.lock:
            self._require_normal_runtime()
            if not self.can_stop_simulator():raise ValueError('Only this local CARLA runtime can be stopped')
            if self.simulator_start['status']=='STARTING':raise ValueError('Wait for simulation startup to finish')
            if self.restarting:raise ValueError('Wait for the CARLA restart to finish')
            if self.simulator_stop['status'] in ('STOPPING','STOPPED'):return
            self.simulator_stop={'status':'STOPPING','launch':copy.deepcopy(getattr(self.provider.runtime,'active',None))}
            self._stop_navigation('simulator_shutdown')
            self.release_controls()
            threading.Thread(target=self._stop_simulator_native,name='native-gpu-release',daemon=True).start()

    def _stop_simulator_native(self):
        warning=None;launch=self.simulator_stop.get('launch')
        try:self.close()
        except Exception as error:warning=str(error)
        try:
            # Windows libcarla can abort its host if UE exits while retained
            # streaming handles still exist. An SDK-free helper retires this
            # host first, kills the verified engine, then serves the stopped UI.
            self.provider.shutdown_handler({'status':'STOPPING','launch':launch,'cleanup_warning':warning or self.error})
        except Exception as error:
            with self.lock:self.simulator_stop={'status':'FAILED','error':str(error),'cleanup_warning':warning,'launch':launch}

    def restart_graphics(self, value, operation='GRAPHICS'):
        if self._comparison_busy():
            raise ValueError('Stop/Reset demo before restarting graphics')
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
            self.restart_configuration['previous_camera']=dict(self.provider.camera_settings)
            if isinstance(value,dict) and 'preset' in value:
                from ..graphics import camera
                self.restart_configuration['camera'].update(camera(value['preset']))
                self.restart_configuration['graphics_preset']=value['preset']
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
            view = self.dashboard_view if live else {'vehicle': None, 'world': None, 'sensors': {}, 'canonical': None}
            result = {'sequence': self.sequence, 'connected': live, 'available': live,
                    'sessionId': self.session_id, 'journey': copy.deepcopy(self.journey),
                    'journeyComparison': self.journey_comparison.snapshot(),
                    'comparisonDemo': self.historical_comparison.snapshot() if self.historical_comparison else self.comparison.snapshot() if self.comparison else None,
                    'comparisonV2': self.comparison_v2.snapshot() if self.comparison_v2 else None,
                    'stopDiagnostics': copy.deepcopy(self.stop_diagnostics),
                    'lastDriveStop': copy.deepcopy(self.last_drive_stop),
                    'controlScene': self.control_scene.snapshot(self.clock.timestamp_s, self.now())
                        if self.control_scene and self.clock.timestamp_s is not None else None,
                    'controlSceneError': self.control_scene_error,
                    'controlDecisionPrediction': {k:self.control_decision_prediction.get(k) for k in (
                        'evaluation_frame','timestamp_s','used_for_applied_decision','decision_source',
                        'selected_candidate','shield_rejection')} if self.control_decision_prediction else None,
                    'rearAssist': self.rear_assist if live and self.journey.get('status') == 'RUNNING' else False,
                    'rlRuntime': self.rl_runtime.status() if self.rl_runtime else {'active':False,'tick_owner':'simulation-worker'},
                    'navigationAvailable': self.arbiter.machine.allow_navigation,
                    'safetySystem': self.active_safety.snapshot() if self.active_safety else
                        {'enabled':False,'active':False,'type':'RULE_BASED_SAFETY','status':'SENSORS_UNAVAILABLE','risk':'UNKNOWN','intervention_count':0},
                    'restartResult': copy.deepcopy(self.restart_result),
                    'restarting': self.restarting, 'recording': bool(self.recorder),
                    'recordingStatus':self.last_recording.status() if self.last_recording else None,
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
                    'manualDrivingMode': self.manual_driving_mode,
                    'controlExpired': self.now()-self.command_at > self.CONTROL_TTL}
        # Registry serialization can traverse large sensor payloads. It is a
        # display operation, never work protected by the control lock.
        result['sensorRegistry'] = getattr(self.provider, 'sensor_registry', lambda: {})() if live else {}
        result['displayCamera'] = self.provider.driving_camera()[1] if live and hasattr(self.provider,'driving_camera') else None
        motion=getattr(self,'motion_snapshot',None)
        result['motionQuality']=motion.get('motionQuality') if motion and motion.get('session_id')==self.session_id else None
        normal_automatic = self.journey.get('driving_mode') == 'NORMAL' and self.journey.get('status') in ('STARTING','RUNNING')
        normal_manual = self.arbiter.machine.mode == ControlMode.MANUAL and self.manual_driving_mode == 'NORMAL'
        if normal_automatic or normal_manual:
            result['safetySystem'].update(enabled=False, active=False, status='STANDARD_DRIVER',
                actual_generator='BASE_DRIVER', intervention_count=0,
                reason=('Manual pedals and steering; sensors observe only; obstacle protection off'
                        if normal_manual else 'Native route and signal follower; sensors observe only; obstacle protection off'))
        result['maneuver']=copy.deepcopy(getattr(self,'maneuver_status',None))
        result['simulatorStop']={'available':self.can_stop_simulator(),**copy.deepcopy(self.simulator_stop)}
        if self.startup_ticket and self.simulator_start['status']=='STARTING':
            try:
                import json
                from pathlib import Path
                ticket=json.loads(Path(self.startup_ticket).read_text(encoding='utf8'))
                self.simulator_start=ticket.get('startup',self.simulator_start)
            except (OSError,ValueError):pass
        result['simulatorStart']={'available':self.can_start_simulation(),**copy.deepcopy(self.simulator_start)}
        result['simulatorReset']={'available':self.can_reset_simulation()}
        return result

    def _environment_snapshot(self):
        compact=getattr(self.provider,'operator_environment_state',None)
        state=compact() if compact else getattr(self.provider,'environment_state',lambda:None)()
        if isinstance(state,dict):
            frames = self.policy_history.snapshot()
            state['observation_status'] = {'status':self.policy_history.status,'history_frames':len(frames),
                'frame_id':frames[-1].frame_id if frames else None,'privileged_data_excluded':True,
                'policy_active':bool(self.active_safety and self.active_safety.enabled and self.arbiter.machine.mode in (ControlMode.MANUAL,ControlMode.AUTOMATIC))}
            state['safety_policy'] = self.active_safety.snapshot() if self.active_safety else state.get('safety_policy')
            return state
        return None

    def require_connected(self):
        # Commands and heartbeat admission need availability, not a complete
        # dashboard serialization (which used to run inside their outer lock).
        with self.lock:
            if not self._live():
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

    def get_camera_frame(self, frame_id=None, view=None):
        with self.lock:
            self.require_connected()
            if view=='driving' and hasattr(self.provider,'driving_camera'):
                return self.provider.driving_camera(frame_id)
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
            # Measured geometry is published by the sensor owner, independently
            # of dashboard, detection, OCR and optional model workers.
            if observation.complete and getattr(self.provider, 'sensor_suite', False) is True:
                try:
                    from .control_scene import ControlSceneBuilder
                    if (self.control_scene_builder is None or self.control_scene_builder.session_id != self.session_id or
                            self.control_scene_ego_actor_id != observation.vehicle.actor_id):
                        self.control_scene_builder = ControlSceneBuilder(self.session_id,
                            getattr(self.provider, 'vehicle_geometry', None))
                        self.control_scene_ego_actor_id = observation.vehicle.actor_id
                    history = self.policy_history.snapshot()
                    if history:
                        self.control_scene = self.control_scene_builder.build(history[-1],
                            self.provider.get_sensor_asset, received_wall_s=min(
                                (c.metadata.get('received_monotonic_s',self.now()) for c in observation.sensors
                                 if c.sensor_id in self.synchronizer.required),default=self.now()),
                            semantic_result=getattr(self,'control_perception',None).latest(self.session_id)
                                if getattr(self,'control_perception',None) else None)
                        # Copy the sizeable frozen forecast only when an
                        # admitted maneuver/recovery actually consumes it.
                        self.motion_scene = (self.control_scene.legacy_scene()
                            if getattr(self.provider,'navigation_planner',None) is not None or
                               getattr(self.provider,'navigation_recovery',None) is not None else None)
                        self.control_scene_error = None
                except (ValueError, KeyError, OSError, TypeError, ArithmeticError) as error:
                    self.control_scene_error = str(error)
            if observation.complete:
                arrivals=[s.metadata.get('received_monotonic_s',self.now()) for s in observation.sensors
                          if s.sensor_id in self.synchronizer.required]
                self.safety_observed_at=min(arrivals,default=self.now())
            fresh_recovery = (not first and observation.frame_id > self.observation.frame_id
                              and self.lifecycle.state == ConnectionState.ERROR
                              and self.lifecycle.error == 'Observation receipt timeout'
                              and self.error is None)
            self.observation = observation
            self.render_pose_cache[observation.frame_id] = to_dict(observation.vehicle.transform)
            while len(self.render_pose_cache)>32: self.render_pose_cache.popitem(last=False)
            if getattr(self.provider,'scenario_outcomes_enabled',False) is True and not (self.rl_runtime and self.rl_runtime.active):
                outcome=self.provider.observe_scenario(observation)
                if outcome is not None:self._event(EventType.ControlChanged,scenario_outcome=outcome)
            view = dashboard_frame(observation)
            self.dashboard_view = view
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
                self._event(EventType.CollisionDetected, collision=to_dict(collision))
            self.publication_at = self.now()

    def _iteration(self, training_command=None):
        started = self.now()
        with self.lock:
            if training_command is not None and self.actions:
                raise RuntimeError('Normal operations were queued during exclusive RL tick ownership')
            actions = list(self.actions)
            self.actions.clear()
        for action, value in actions:
            if action == 'comparison_v2':
                try:
                    self.comparison_v2.execute(value)
                    self.dashboard_result = {'action': action, 'status': 'APPLIED'}
                except Exception as error:
                    import traceback
                    traceback.print_exc()
                    self.comparison_v2.finish('failure')
                    self.comparison_v2.queued = False
                    self.comparison_v2.error = str(error)
                    self.dashboard_result = {'action': action, 'status': 'REJECTED', 'error': str(error)}
            elif action == 'comparison':
                try:
                    with self.lock:
                        self.comparison.execute(value)
                        self.dashboard_result = {'action': action, 'status': 'APPLIED', 'operationId': uuid.uuid4().hex}
                except (ValueError, RuntimeError) as error:
                    self.dashboard_result = {'action': action, 'status': 'REJECTED', 'error': str(error), 'operationId': uuid.uuid4().hex}
            elif action == 'start_journey':
                journey = None
                try:
                    with self.lock:
                        journey = self.journey
                        if self.journey['status'] != 'STARTING' or self.now()-self.navigation_heartbeat_at > self.CONTROL_TTL:
                            raise ValueError('Dashboard heartbeat expired before journey start')
                        if self.paused:
                            self.provider.set_paused(False); self.paused = False
                    # BasicAgent route planning can outlast the browser lease.
                    # Allow genuine heartbeats and operator cancellation while
                    # planning; this worker remains the only native tick owner.
                    driving_mode = journey.get('driving_mode')
                    if driving_mode:
                        manifest = self.provider.journey_manifest(value)
                        self.active_safety.set_controller('RULE')
                        self.active_safety.enabled = True
                        self.active_safety.reset()
                        self.journey_observer = {}
                        result = self.provider.start_navigation(value, driving_mode=driving_mode)
                    else:
                        result = self.provider.start_navigation(value)
                    with self.lock:
                        if self.journey is not journey or journey['status'] != 'STARTING':
                            self.provider.stop_navigation()
                        elif self.now()-self.navigation_heartbeat_at > self.CONTROL_TTL:
                            self._stop_navigation('dashboard_heartbeat_timeout')
                        else:
                            if driving_mode:
                                recording = self._change_recording({'enabled': True})
                                self.journey_auto_recording = True
                                self.journey_comparison.begin(driving_mode, manifest,
                                    pair_id=journey.get('pair_id'), recording=recording['path'])
                                journey['pair_id'] = self.journey_comparison.data['pair_id']
                                self.prepared_journey_pair = None
                            self.arbiter.safety.clear()
                            # Keep ego held until two new synchronized, actually
                            # fresh frames arrive after controller construction.
                            self.navigation_ready_frame=self.observation.frame_id+2
                            self.journey.update(status='STARTING', reason=None, route_id=result['id'])
                            self._event(EventType.ControlChanged, journey=copy.deepcopy(self.journey))
                except (ValueError, ImportError, RuntimeError, OSError) as error:
                    with self.lock:
                        if self.journey is journey and journey['status'] == 'STARTING':
                            self._stop_navigation(str(error), status='ERROR')
                        else:
                            self.provider.stop_navigation()
            elif action == 'prepare_journey_mode':
                self.reconfiguring = True
                try:
                    manifest = self.journey_comparison.data['manifest']
                    self.provider.prepare_journey_comparison(manifest)
                    self.provider.set_paused(False)
                    self.paused = False
                    self.session_id = uuid.uuid4().hex
                    self.policy_history.clear()
                    self.journey_observer = {}
                    self.motion_snapshot = None
                    self._clear_safety_command()
                    if self.active_safety: self.active_safety.reset()
                    self.synchronizer = SensorSynchronizer(self._required_after_sensor_rebuild(), self.synchronizer.optional,
                        timeout_s=self.synchronizer.timeout_s, now=self.now)
                    self.camera_cache.clear(); self.sensor_frame_cache.clear(); self.render_pose_cache.clear()
                    self.prepared_journey_pair = value['pair_id']
                    self.journey = {'status':'READY', 'reason':None, 'speed_kmh':manifest['speed_kmh'],
                        'prepared_mode':value['mode'], 'prepared_pair_id':value['pair_id']}
                    self.dashboard_result = {'action':action, 'status':'APPLIED', 'operationId':uuid.uuid4().hex}
                except (ValueError, RuntimeError) as error:
                    self.prepared_journey_pair = None
                    self.dashboard_result = {'action':action, 'status':'REJECTED', 'error':str(error)}
                finally: self.reconfiguring = False
            elif action in ('settings', 'destination', 'save_place', 'favorite_place', 'clear_route', 'population', 'crowd_route', 'inspector', 'recording', 'scene', 'environment', 'scenario'):
                # Route guidance, saved places and recording do not rebuild
                # native actors. Keep fresh observations available while these
                # actions run; the normal receipt watchdog still applies.
                live_camera_view = action == 'settings' and isinstance(value, dict) and set(value) == {'camera_view'}
                self.reconfiguring = not live_camera_view and action in ('settings', 'population', 'scene', 'scenario', 'environment', 'crowd_route')
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
                    self.dashboard_result = {'action': action, 'status': 'PENDING' if action in ('settings','scene','population','scenario','environment','crowd_route') else 'APPLIED', 'result': result,
                                             'operationId': uuid.uuid4().hex}
                    if action == 'destination':
                        self.journey.update(status='READY', reason=None)
                    self._event(EventType.ControlChanged, dashboard_action=action, value=value,
                                population=getattr(self.provider, 'population_state', lambda: None)())
                    if action=='scenario' and value.get('operation')=='stop' and result.get('outcome'):
                        self._event(EventType.ControlChanged,scenario_outcome=result['outcome'])
                    if sensor_change:
                        self.synchronizer = SensorSynchronizer(self._required_after_sensor_rebuild(), self.synchronizer.optional,
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
                if self.comparison_v2 and self.comparison_v2.busy:
                    self.comparison_v2.finish('vehicle_reset')
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
                self.synchronizer = SensorSynchronizer(self._required_after_sensor_rebuild(), self.synchronizer.optional,
                                                       timeout_s=self.synchronizer.timeout_s, now=self.now)
                self.camera_cache.clear(); self.sensor_frame_cache.clear()
                self._event(EventType.VehicleDestroyed, actor_id=old_actor_id)
            else:
                self.provider.set_paused(value)
                self.paused = value
        control_requested = self.now()
        with self.lock:
            control_acquired = self.now()
            self.control_timing_ms = {
                'lock_wait': (control_acquired-control_requested)*1000,
                'since_publication': (control_acquired-self.publication_at)*1000 if self.publication_at is not None else None,
            }
            if training_command is None:
                if self.navigation_ready_frame is not None:
                    if self.journey['status']!='STARTING':self.navigation_ready_frame=None
                    elif self.now()-self.navigation_heartbeat_at>self.CONTROL_TTL:
                        self.navigation_ready_frame=None;self._stop_navigation('dashboard_heartbeat_timeout')
                    elif (self.observation.complete and self.observation.frame_id>=self.navigation_ready_frame
                          and (self.active_safety is None or (self.safety_observed_at is not None
                          and self.now()-self.safety_observed_at<=self.active_safety.config.maximum_sensor_wall_age_s))):
                        self.navigation_ready_frame=None
                        self.arbiter.machine.transition(ControlMode.AUTOMATIC,connected=True,explicit=True)
                        self.journey.update(status='RUNNING')
                        self._event(EventType.ControlChanged,journey=copy.deepcopy(self.journey))
                if self.comparison:
                    try:
                        self.comparison.before_control()
                    except (ValueError, RuntimeError, ImportError) as error:
                        self.comparison.finish('initialization_error')
                        self.comparison.phase = 'ERROR'
                        self.comparison.error = str(error)
                navigation_started = self.now()
                self._navigation_step()
                safety_started = self.now()
                self.control_timing_ms['navigation'] = (safety_started-navigation_started)*1000
                self._active_safety_step()
                if self.journey_comparison.active and self.journey.get('status') == 'RUNNING':
                    self.journey_comparison.sample(self.observation, self.provider.route_state(), self.journey_observer)
                self.control_timing_ms['safety'] = (self.now()-safety_started)*1000
                chosen = self._choose()
            else:
                if self.active_safety:
                    self._clear_safety_command(); self.active_safety.reset()
                    self.active_safety.status.update(status='SUSPENDED_RL', reason='Exclusive RL interface owns commands')
                    self.provider.active_safety_status = self.active_safety.snapshot()
                chosen = training_command
        if chosen.source != CommandSource.NAVIGATION or chosen.brake > .01:
            self.rear_assist = False
        if (training_command is not None and self.rl_runtime and self.rl_runtime.supervisor) or chosen == self.safety_command:
            self.provider.apply_control_confirmed(chosen)
        else:self.provider.apply_control(chosen)
        self._audit_command(chosen)
        native_step_started = self.now()
        self.provider.step()
        # Native weather/population setters become observable on the following
        # simulation step. Publish APPLIED only with that step's real state.
        if self.dashboard_result and self.dashboard_result.get('operationId') and self.dashboard_result['status']=='PENDING':
            action = self.dashboard_result['action']
            if action in ('settings','scene','population','scenario','environment','crowd_route'):
                if action == 'crowd_route':
                    population = self.provider.population_state()
                    result = {'population': population, 'crowding': population.get('route_crowding')}
                else:
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
            if (self.comparison and self.comparison.busy or
                    self.active_safety and self.active_safety.enabled):
                # Protected driving has one physics tick owner. Wait for that
                # tick's existing GPU sensors before advancing physics again;
                # this keeps the validated RULE simulation-age gate intact.
                deadline = self.now() + min(.2, self.synchronizer.timeout_s)
                while (self.observation is None or self.observation.frame_id < observation.frame_id) and self.now() < deadline:
                    self.stop_event.wait(.002)
                    self._ingest_provider_sensors()
                    for synchronized in self.synchronizer.drain():
                        self._publish(synchronized)
                        self._record(synchronized)
        elif self.observation:
            self.state_at = self.now()  # Explicit native pause; no new observations are recorded.
        if any(name == 'reset' for name, _ in actions):
            self._event(EventType.VehicleSpawned, actor_id=observation.vehicle.actor_id)
        self._finish_journey_recording()
        self.backend_step_ms = (self.now()-started)*1000
        if self.comparison:
            with self.lock:
                self.comparison.after_tick()

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
                    with self.lock:
                        frame_id, stamp = self._context()
                        self.runtime_fault = {'stage':'simulation_iteration', 'exception_type':type(error).__name__,
                            'message':str(error), 'traceback':traceback.format_exc(),
                            'evaluation_frame':frame_id, 'timestamp_s':stamp,
                            'sensor_frames':to_dict(self.observation.sensors) if self.observation else [],
                            'base_command':to_dict(self.base_driver_command)}
                        self.error = str(error)
                        self._event(EventType.ConnectionLost, reason=str(error), runtime_fault=copy.deepcopy(self.runtime_fault))
                        self._stop_navigation('runtime_failure', status='ERROR')
                        self.release_controls()
                        self.arbiter.disconnect()
                        self.lifecycle.fail(error)
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
            from ..learning.rl.maneuver_runtime import ManeuverRuntime
            maneuver=operation.startswith('maneuver_')
            if self.rl_runtime is not None and isinstance(self.rl_runtime,ManeuverRuntime)!=maneuver:
                if self.rl_runtime.active:raise RuntimeError('Another environment owns the native session')
                self.rl_runtime=None
            if self.rl_runtime is None:
                if maneuver:self.rl_runtime=ManeuverRuntime(self)
                else:
                    from ..rl.runtime import RLRuntime
                    self.rl_runtime=RLRuntime(self)
            if maneuver:operation=operation.removeprefix('maneuver_')
            result=self.rl_runtime.dispatch(operation,**data)
        except Exception as error:
            future.set_exception(error if isinstance(error,(ValueError,RuntimeError)) else RuntimeError('RL runtime error: '+str(error)))
        else:future.set_result(result)
        return True

    def _close_provider(self):
        if self.closed:
            return
        if getattr(self,'control_perception',None):self.control_perception.close()
        try:
            if self.provider:
                try:
                    if self.provider.is_connected():
                        terminal = safe_command(*self._context())
                        self.provider.apply_control(terminal)
                        self._audit_command(terminal)
                        self._finish_journey_recording()
                finally:
                    try:
                        self._drain_collision_events()
                        self._ingest_provider_sensors()
                        for pending in self.synchronizer.drain(force=True):
                            self._publish(pending)
                            self._record(pending)
                    finally:
                        try:
                            if self.comparison:
                                self.comparison.finish('service_shutdown')
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
                            self._record(pending)
                    for sensor_id in self.sensor_ids:
                        self._event(EventType.SensorStopped, sensor_id=sensor_id, cleanup_confirmed=self.error is None)
                    if self.started_session:
                        self._event(EventType.SimulationStopped, cleanup_error=self.error)
                finally:
                    if self.recorder:
                        self.recorder.close()
                    if self.last_recording and self.last_recording is not self.recorder:
                        self.last_recording.close()
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
