"""Independent RULE/MODEL paired runs. Historical comparison semantics stay intact."""
import copy
from dataclasses import replace
import hashlib
import json
import math
from pathlib import Path
import secrets
import uuid
from .comparison import ComparisonDemo, ROOT
from ..core.contracts import from_dict, to_dict
from ..core.scenarios import ScenarioSpec
from ..core.predictive_safety import PredictiveSafetySupervisor
from ..core.events import EventType

DIRECTORY = ROOT/'output/comparison_v2'


def failure_termination(reason):
    return reason in ('failure', 'ya_rab_ostorha_sensor_fault',
        'ya_rab_ostorha_model_failure', 'dashboard_heartbeat_timeout') or reason.startswith('MODEL_FAILURE')


def pose_audit(expected, actual):
    a = {r['name']: r for r in expected}; b = {r['name']: r for r in actual}
    if a.keys() != b.keys(): return {'passed': False, 'reason': 'Actor identities differ'}
    errors = [math.dist(a[k]['transform']['position_m'], b[k]['transform']['position_m']) for k in a]
    velocities = [math.dist(a[k]['velocity_mps'], b[k]['velocity_mps']) for k in a]
    angles = [abs((a[k]['transform']['rotation_rad'][axis]-b[k]['transform']['rotation_rad'][axis]+math.pi)%(2*math.pi)-math.pi) for k in a for axis in ('roll','pitch','yaw')]
    passed = (all(a[k]['blueprint'] == b[k]['blueprint'] for k in a) and
              max(errors, default=0) <= .05 and max(velocities, default=0) <= .1 and max(angles, default=0) <= .01)
    return {'passed': passed, 'maximum_position_error_m': max(errors, default=0),
            'maximum_velocity_error_mps': max(velocities, default=0), 'maximum_rotation_error_rad': max(angles, default=0)}


class ComparisonV2(ComparisonDemo):
    def __init__(self, service):
        super().__init__(service)
        self.agent_options = {'ignore_vehicles': True, 'ignore_traffic_lights': False, 'ignore_stop_signs': False}
        self.pair = None; self.side = None; self.queued = False; self.original_safety = None
        self.metrics_v2 = {}; self.last_stamp = None; self.attempt = None
        self.experiment_reservation = None
        self.stop_requested = None
        self._budget_snapshot = None; self._budget_at = -float('inf')
        self.lights = []; self.original_lights = []
        from ..learning.experiment_budget import ExperimentBudget
        self.validation_budget = getattr(service, 'native_validation_budget', None)
        self.experiment_budget = self.validation_budget or ExperimentBudget()
        DIRECTORY.mkdir(parents=True, exist_ok=True)
        path = DIRECTORY/'active-pair.json'
        if path.exists():
            self.pair = json.loads(path.read_text()); self.results = self.pair.get('results', {})
            for attempt in self.pair.get('attempts', []):
                if attempt['phase'] in ('RESETTING','RUNNING'):
                    attempt.update(phase='INTERRUPTED', reason='backend_restarted')
            self.latest = self.pair.get('latest_result')
            if self.pair.get('attempts') and (not self.latest or
                    self.pair['attempts'][-1]['phase'] == 'INTERRUPTED' and
                    self.latest.get('attempt_id') != self.pair['attempts'][-1].get('attempt_id')):
                attempt = self.pair['attempts'][-1]
                result = self.results.get(attempt.get('side'))
                self.latest = result if result and result.get('attempt_id') == attempt.get('attempt_id') else {
                    'side': attempt.get('side'), 'status': 'INTERRUPTED', 'completed': False,
                    'attempt_id': attempt.get('attempt_id'),
                    'reason': attempt.get('reason', 'backend_restarted'), 'recording': attempt.get('recording')}
            self.save()

    @property
    def busy(self): return self.queued or super().busy

    def save(self):
        self.pair['results'] = self.results
        self.pair['latest_result'] = getattr(self, 'latest', None)
        for path in (DIRECTORY/'active-pair.json', DIRECTORY/(self.pair['pair_id']+'.json')):
            temporary = path.with_suffix('.tmp'); temporary.write_text(json.dumps(self.pair, indent=2), encoding='utf8'); temporary.replace(path)

    def request(self, value):
        if not isinstance(value, dict) or set(value)-{'operation','side'} or value.get('operation') not in ('RUN','STOP'):
            raise ValueError('comparison_v2 requires RUN or STOP and RULE or MODEL side')
        if value['operation'] == 'RUN':
            if value.get('side') not in ('RULE','MODEL'): raise ValueError('Choose RULE or MODEL')
            if self.busy or self.service.comparison and self.service.comparison.busy: raise ValueError('A comparison is already active')
            if value['side'] == 'MODEL':
                if self.validation_budget: raise ValueError('This separately authorized validation session permits RULE only; MODEL remains experimental')
                from ..learning.supervised.motion import PredictiveModel
                PredictiveModel()  # Admission only; training is never started here.
        if self.service.arbiter.machine.mode.value == 'EMERGENCY_STOP': raise ValueError('Acknowledge emergency stop explicitly')
        if value['operation'] == 'RUN':
            budget = self.experiment_budget.status()
            remaining=budget.get('remaining_s', budget['hard_cap_s']-budget['charged_s'])
            if remaining<=1:raise ValueError('90-minute experiment hard cap reached')
            self.experiment_reservation = self.experiment_budget.reserve('comparison_v2_run',min(600,remaining)); self.error=None
            self.stop_requested = None
            self.side = value['side']
            self.queued = True; self.service.actions.append(('comparison_v2', dict(value)))
        else:
            self.request_stop('comparison_v2_stop')
            self.service.stop_driving('comparison_v2_stop')
        self._budget_at = -float('inf')

    def request_stop(self, reason):
        # Only the simulation worker may finish a run or manipulate native actors.
        # Also covers RUN already copied from the action queue but not executed.
        if (self.busy or self.experiment_reservation) and self.phase != 'STOPPING': self.stop_requested = reason

    def execute(self, value):
        self.queued = False; s = self.service
        if value['operation'] == 'STOP':
            self.finish('interrupted'); s.stop_driving('comparison_v2_stop'); return
        if self.stop_requested:
            self.latest = {'side': self.side, 'status': 'INTERRUPTED', 'completed': False,
                'reason': self.stop_requested, 'recording': None}
            if self.pair: self.save()
            self.phase = 'FINISHED'; self.finish(self.stop_requested)
            self.stop_requested = None
            return
        self.side = value['side']
        if self.pair is None or len(self.results) == 2:
            seed = 2000+secrets.randbelow(1000)
            from .urban_chaos import compile_urban
            spec, destination = compile_urban(s.provider, seed, clear_scripted_route=True)
            spec = replace(spec, scenario_id='predictive_comparison_v2', timeout=180.,
                failure_conditions={'max_collision_episodes': 1}, metadata={**spec.metadata,
                    'comparison_v2': True, 'preserve_traffic_lights': True})
            self.pair = {'version': 2, 'pair_id': uuid.uuid4().hex, 'seed': seed,
                'spec': to_dict(spec), 'destination': destination, 'results': {},
                'matching_scope': 'Persisted initial conditions; reactive traffic trajectories may diverge'}
            self.results = {}; self.save()
        self.original_safety = s.active_safety
        s.comparison = self
        # Base owns actor/sensor reset and prime lifecycle; use its WITH arm only
        # for setup. Its result/finish policy is replaced below.
        self.spec = from_dict(ScenarioSpec, self.pair['spec']); self.destination = self.pair['destination']
        p = s.provider; launch = p.runtime.active or {}; camera = p.camera_settings; weather = p.world.world.get_weather()
        self.group = ('URBAN_CHAOS', self.pair['seed'], launch.get('quality'), launch.get('resolution'),
            camera.get('camera_resolution'), float(camera.get('camera_fov',90)), bool(camera.get('camera_postprocess',False)),
            float(camera.get('camera_bloom',0.)), tuple(float(getattr(weather,k,0.)) for k in
            ('cloudiness','precipitation','wetness','sun_altitude_angle','sun_azimuth_angle','fog_density')))
        p.comparison_v2_admitting = 'approved_initial_states' not in self.pair
        try: super().execute({'mode':'WITH', 'scenario':'URBAN_CHAOS', 'seed':self.pair['seed']})
        finally: p.comparison_v2_admitting = False
        self.spec=p.scenarios.spec; self.pair['spec']=to_dict(self.spec); self.save()
        self.lights = list(p.world.world.get_actors().filter('traffic.traffic_light*'))
        self.original_lights = [(light,light.get_state(),light.is_frozen()) for light in self.lights]
        groups=set()
        for light in self.lights:
            group=tuple(sorted(member.id for member in light.get_group_traffic_lights()))
            if group not in groups: light.reset_group(); groups.add(group)
        for light in self.lights: light.freeze(True)
        self.attempt = {'attempt_id': uuid.uuid4().hex, 'side': self.side, 'phase': 'RESETTING'}
        self.pair.setdefault('attempts', []).append(self.attempt); self.save()
        s.active_safety = PredictiveSafetySupervisor(self.side, s.session_id)
        p.active_safety_status = s.active_safety.snapshot()
        self.metrics_v2 = {'unnecessary_waiting_s': 0., 'harsh_braking_events': 0,
            'emergency_intervention_s': 0., 'duration_s': 0., 'destination_arrived': False}
        self.last_stamp = None; self.harsh = False

    def before_control(self):
        import time
        if self.stop_requested:
            self.finish(self.stop_requested); return
        if self.experiment_reservation and time.monotonic()-self.experiment_reservation[1] >= self.experiment_reservation[2]-1:
            self.finish('failure'); raise ValueError('Experiment wall-clock allowance reached')
        was_prepared = self.prepared
        was_phase = self.phase
        if self.phase == 'RESETTING':
            self.service.provider.scenarios.run.update(pair_id=self.pair['pair_id'],
                comparison_v2_side=self.side,comparison_version=2)
        super().before_control()
        if self.stop_requested:
            self.finish(self.stop_requested); return
        if self.phase == 'RUNNING' and was_phase != 'RUNNING':
            for light in self.lights: light.freeze(False)
        if self.attempt and self.phase == 'RUNNING' and self.attempt['phase'] != 'RUNNING':
            self.attempt.update(phase='RUNNING', recording=self.recording_path); self.save()
        if self.prepared and not was_prepared:
            run = self.service.provider.scenarios.run
            states = run['initial_states']['actors']
            signature = run['comparison_initial_condition_id']
            if 'approved_initial_states' not in self.pair:
                self.pair['approved_initial_states'] = copy.deepcopy(states)
                self.pair['configuration_id'] = signature
                self.pair['route'] = copy.deepcopy(run['route'])
            audit = pose_audit(self.pair['approved_initial_states'], states)
            audit['configuration_matches'] = self.pair['configuration_id'] == signature
            lights=[{'id':str(light.id),'opendrive_id':light.get_opendrive_id(),'state':str(light.get_state()),
                'green_s':light.get_green_time(),'yellow_s':light.get_yellow_time(),'red_s':light.get_red_time(),
                'elapsed_s':light.get_elapsed_time()} for light in self.lights]
            if 'approved_traffic_lights' not in self.pair: self.pair['approved_traffic_lights']=lights
            expected={light['id']:light for light in self.pair['approved_traffic_lights']}
            audit['traffic_lights_match'] = len(expected)==len(lights) and all(
                light['id'] in expected and light['state']==expected[light['id']]['state'] and
                all(abs(light[key]-expected[light['id']][key])<=.06 for key in ('green_s','yellow_s','red_s','elapsed_s')) for light in lights)
            if not audit['passed'] or not audit['configuration_matches'] or not audit['traffic_lights_match']:
                self.finish('initial_conditions_mismatch')
                raise ValueError('Pair initial conditions failed admission: '+json.dumps(audit))
            run.update(pair_id=self.pair['pair_id'], comparison_v2_side=self.side,
                approved_initial_conditions=audit, comparison_version=2)
            self.pair['latest_initial_audit'] = audit; self.save()

    def record(self, frame):
        if self.phase != 'RUNNING': return
        s = self.service; safety = s.active_safety.snapshot()
        dt = 0. if self.last_stamp is None else max(0., frame.timestamp_s-self.last_stamp)
        self.last_stamp = frame.timestamp_s; m = self.metrics_v2; m['duration_s'] += dt
        if safety.get('emergency_active'): m['emergency_intervention_s'] += dt
        if frame.vehicle.speed_mps < .2 and safety.get('active') and safety.get('risk') == 'CLEAR' and safety.get('base_driver_brake', 0) < .01:
            m['unnecessary_waiting_s'] += dt
        harsh = (frame.vehicle.longitudinal_acceleration_mps2 or 0) < -3.
        if harsh and not self.harsh: m['harsh_braking_events'] += 1
        self.harsh = harsh; self.last_safety = safety
        s.recorder.record_trace({'version': 2, 'pair_id': self.pair['pair_id'], 'side': self.side,
            'frame_id': frame.frame_id, 'timestamp_s': frame.timestamp_s,
            'safety': safety, 'pre_protection_command': safety.get('pre_protection_command'),
            'applied_command': to_dict(frame.control), 'actual_vehicle_controls': {
                k: getattr(frame.vehicle,k) for k in ('throttle','brake','steering')},
            'weight_checksums': {'heads': safety.get('model_weights_sha256'),
                'gru': s.active_safety.model.metadata['base_weights_sha256'] if s.active_safety.model else None}})

    def after_tick(self):
        if self.phase != 'RUNNING': return
        if self.stop_requested:
            self.finish(self.stop_requested); return
        s = self.service; p = s.provider
        import time
        if self.experiment_reservation and time.monotonic()-self.experiment_reservation[1] >= self.experiment_reservation[2]-1:
            self.finish('failure'); return
        if p.scenarios.metrics.get('collision_count', 0): self.finish('collision')
        elif s.active_safety.last_fault: self.finish('failure')
        elif s.journey.get('status') == 'ARRIVED':
            pos = s.observation.vehicle.transform.position_m
            if math.dist(pos, self.destination['location']) <= 5. and s.observation.vehicle.speed_mps < .15:
                self.finish('destination_arrived')
            else: self.finish('arrival_verification_failed')
        elif p.scenarios.phase == 'FINISHED': self.finish(p.scenarios.outcome['reason'])
        elif s.journey['status'] != 'RUNNING':
            reason=s.journey.get('reason') or 'interrupted'
            self.finish('failure' if reason in ('dashboard_heartbeat_timeout','ya_rab_ostorha_sensor_fault','ya_rab_ostorha_model_failure') else reason)

    def finish(self, reason):
        s = self.service
        if self.phase not in ('RESETTING','RUNNING','STOPPING'):
            if self.experiment_reservation and reason != 'switched':
                self.experiment_budget.finish(self.experiment_reservation); self.experiment_reservation = None
            return
        running = self.phase == 'RUNNING'; self.phase = 'STOPPING'
        if not running:
            self.latest = {'side': self.side, 'status': 'INTERRUPTED', 'completed': False,
                'reason': reason, 'recording': self.recording_path}
            if self.pair: self.save()
        if running:
            s.provider.scenarios.stop(reason=reason)
            outcome = s.provider.scenarios.collect_outcome()
            failed = failure_termination(reason)
            terminal = reason in ('destination_arrived','collision','timeout') or failed
            result = {'side': self.side, 'reason': reason, 'recording': self.recording_path,
                'failure_reason': (s.active_safety.last_fault or s.journey.get('reason')) if failed else None,
                'run': copy.deepcopy(s.provider.scenarios.run),
                'attempt_id': self.attempt['attempt_id'] if self.attempt else None,
                'initial_condition_audit': copy.deepcopy(self.pair.get('latest_initial_audit')),
                'completed': terminal, 'destination_arrived': reason == 'destination_arrived',
                'collision': outcome['metrics']['collision_count'] > 0,
                'status': 'ARRIVED' if reason == 'destination_arrived' else 'COLLISION' if reason == 'collision' else 'TIMEOUT' if reason == 'timeout' else 'INTERRUPTED' if not terminal else 'FAILURE',
                'metrics': {**self.metrics_v2, 'destination_arrived': reason == 'destination_arrived'},
                'outcome': outcome, 'final_safety': s.active_safety.snapshot()}
            if terminal: self.results[self.side] = result
            self.latest = result; self.save()
            if self.recording_path: (Path(self.recording_path)/'comparison-v2-result.json').write_text(json.dumps(result, indent=2), encoding='utf8')
            s._event(EventType.ControlChanged, comparison_v2_result=result)
        if self.attempt:
            self.attempt.update(phase='FINISHED' if running and terminal else 'INTERRUPTED',
                reason=reason, recording=self.recording_path)
            self.save(); self.attempt = None
        for light,state,frozen in self.original_lights:
            if light.is_alive: light.set_state(state); light.freeze(frozen)
        self.original_lights=[]; self.lights=[]
        if s._live(): s.stop_driving(reason)
        else:
            s._stop_navigation(reason); s.arbiter.safety.clear()
        if s.recorder: s._change_recording({'enabled': False})
        self.trace = None
        if self.original_safety is not None:
            if hasattr(s.active_safety,'close'): s.active_safety.close()
            s._clear_safety_command(); s.active_safety = self.original_safety
            self.original_safety = None; s.active_safety.reset()
        if self.experiment_reservation:
            self.experiment_budget.finish(self.experiment_reservation); self.experiment_reservation = None
        self.stop_requested = None; self._budget_at = -float('inf')
        self.phase = 'FINISHED'

    def snapshot(self):
        import time
        if self._budget_snapshot is None or time.monotonic()-self._budget_at >= 1:
            budget = self.experiment_budget.status()
            self._budget_snapshot = {k: budget[k] for k in ('charged_s','hard_cap_s')}
            self._budget_snapshot.update(remaining_s=max(0., budget.get('remaining_s', budget['hard_cap_s']-budget['charged_s'])),
                recommended_run_allowance_s=300. if self.validation_budget else 600.)
            self._budget_snapshot.update({k:budget[k] for k in ('scope','expires_at','ticket') if k in budget})
            self._budget_at = time.monotonic()
        def compact(result):
            fields=('side','reason','recording','completed','destination_arrived','collision','status','metrics','attempt_id','initial_condition_audit')
            corrected = {'status':'FAILURE','completed':True} if failure_termination(result.get('reason') or '') else {}
            return {**{k:result.get(k) for k in fields}, **corrected,
                'outcome_metrics': result.get('outcome',{}).get('metrics',{})}
        return {'version': 2, 'experimental': True, 'phase': 'QUEUED' if self.queued else self.phase,
            'side': self.side, 'pair_id': self.pair['pair_id'] if self.pair else None,
            'seed': self.pair['seed'] if self.pair else None, 'error': self.error,
            'results': {side:compact(r) for side,r in self.results.items()},
            'latest_attempt': compact(self.latest) if getattr(self,'latest',None) else None,
            'metrics': dict(self.metrics_v2),
            'budget': dict(self._budget_snapshot),
            'model_available': not self.validation_budget and (ROOT/'artifacts/learned_safety/predictive_v2/metadata.json').exists(),
            'acceptance': 'EXPERIMENTAL_PENDING_NATIVE_ACCEPTANCE'}
