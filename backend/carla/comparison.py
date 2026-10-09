"""Presentation comparison, advanced only by the existing simulation worker.

BasicAgent's vehicle/light checks are disabled in BOTH research arms. Normal
journeys construct a fresh BasicAgent with their original hazard settings.
"""
import copy
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import time

from .scenarios import demonstration, canonical_transform
from ..core.scenarios import ActorControlSegment
from ..core.contracts import to_dict
from ..core.control import ControlMode
from ..core.events import EventType
from ..core.timing import SensorSynchronizer

ROOT = Path(__file__).resolve().parents[2]
AGENT_OPTIONS = {'ignore_vehicles': True, 'ignore_traffic_lights': True,
                 'ignore_stop_signs': True}


def recipe(provider):
    spec = demonstration(provider, 'FRONT_OBSTACLE', 2589, 'TEST')
    api = provider.connection.api
    native_map = provider.world.world.get_map()
    actor = spec.other_actor_definitions[0]
    wp = native_map.get_waypoint(api.Location(*actor.transform.position_m))
    transform = wp.previous(3.)[0].transform
    transform.location.z += .3
    actor = replace(actor, transform=canonical_transform(transform),
        control_schedule=(ActorControlSegment(0., brake=1.),
                          ActorControlSegment(7., throttle=.45)))
    spec = replace(spec, scenario_id='presentation_front_obstacle_v1',
        other_actor_definitions=(actor,), timeout=14., failure_conditions={'max_collision_episodes': 1000000}, metadata={
            **spec.metadata, 'ego_control': 'BASIC_AGENT_RESEARCH_COMPARISON',
            'basic_agent_options': AGENT_OPTIONS, 'target_speed_kmh': 28,
            'hazard_release_s': 7., 'settling_ticks': 25})
    start = native_map.get_waypoint(native_map.get_spawn_points()[spec.ego_spawn].location)
    target = start.next(45.)[0].transform.location
    return spec, {'location': [target.x, target.y, target.z],
                  'name': 'Presentation comparison destination'}


def initial_signature(run, route, agent_options):
    # Absolute frame/time and native actor IDs differ between fresh runs.
    states = copy.deepcopy(run['initial_states'])
    actors = [{k: v for k, v in row.items() if k != 'actor_id'} for row in states['actors']]
    config = {'spec': run['spec'], 'map': run['map'], 'actors': actors,
        'weather': states['weather'], 'camera': run['camera'],
        'fixed_delta_seconds': run['fixed_delta_seconds'], 'route_points': route['points'],
        'destination': route['destination']['location'], 'basic_agent_options': agent_options,
        'target_speed_kmh': 28, 'settling_ticks': 25}
    return config, hashlib.sha256(json.dumps(config, sort_keys=True).encode()).hexdigest()


class ComparisonDemo:
    def __init__(self, service):
        self.service = service
        self.phase = 'IDLE'
        self.mode = None
        self.results = {}
        self.recording_path = None
        self.error = None
        self.spec = self.destination = None
        self.ready_frame = None
        self.prepared = False
        self.trace = None
        self.last_safety = None
        self.last_applied_brake = None

    @property
    def busy(self):
        return self.phase in ('RESETTING', 'RUNNING', 'STOPPING')

    def request(self, value):
        if not isinstance(value, dict) or set(value) != {'mode'} or value['mode'] not in ('WITHOUT', 'WITH', 'STOP'):
            raise ValueError('Choose WITHOUT, WITH or STOP comparison mode')
        s = self.service
        if not s.active_safety or not hasattr(s.provider, 'scenarios'):
            raise ValueError('Comparison requires the live CARLA sensor suite')
        if s.arbiter.machine.mode == ControlMode.EMERGENCY_STOP:
            raise ValueError('Acknowledge emergency stop before restarting the demo')
        # Latest click wins; queued resets cannot overlap or create extra runners.
        s.actions.clear()
        s.actions.append(('comparison', value['mode']))

    def _flush(self):
        s = self.service
        s._drain_collision_events()
        s._ingest_provider_sensors()
        for frame in s.synchronizer.drain(force=True):
            s._publish(frame)
            s._record(frame)

    def execute(self, mode):
        s = self.service
        p = s.provider
        self._flush()
        self.finish('switched' if mode != 'STOP' else 'operator_reset')
        s.stop_driving('comparison_reset')
        if s.recorder:
            s._change_recording({'enabled': False})
        p.scenarios.living_city()
        self.error = None
        self.ready_frame = None
        self.prepared = False
        self.recording_path = None
        s.reconfiguring = True
        try:
            if mode == 'STOP':
                p.reset_vehicle()
                self.phase = 'IDLE'
                self.mode = None
            else:
                if p.world.world.get_map().name.split('/')[-1] != 'Town10HD_Opt':
                    raise ValueError('Presentation demo requires the existing Town10HD_Opt map')
                if self.spec is None:
                    self.spec, self.destination = recipe(p)
                self.phase = 'RESETTING'
                self.mode = mode
                self.reset_began = time.monotonic()
                # Reuse the provider's actor/sensor lifecycle, with fixed demo settings.
                p.sensor_manager.close()
                if p.sensor_manager.cleanup_errors:
                    raise RuntimeError('; '.join(p.sensor_manager.cleanup_errors))
                p.blueprint = 'vehicle.lincoln.mkz_2020'
                p.fixed_delta = .05
                native = p.world.world.get_settings()
                native.fixed_delta_seconds = .05
                p.world.world.apply_settings(native)
                p.camera_settings.update(camera_view='front', camera_resolution='640x360',
                    camera_fov=90, camera_postprocess=False, camera_motion_blur=0, camera_bloom=0)
                p.set_paused(False)
                s.paused = False
                p.scenarios.load(self.spec)
            s.synchronizer = SensorSynchronizer(s.synchronizer.required, s.synchronizer.optional,
                timeout_s=s.synchronizer.timeout_s, now=s.now)
            s.camera_cache.clear()
            s.sensor_frame_cache.clear()
            s.collision_events.clear()
            s.policy_history.clear()
            s.arbiter.safety.clear()
            s._clear_safety_command()
            safety = s.active_safety
            safety.set_controller('RULE')
            safety.enabled = mode != 'WITHOUT'
            safety.interventions = 0
            safety.source_counts = {k: 0 for k in safety.source_counts}
            safety.last_fault = None
            safety.reset()
            p.active_safety_status = safety.snapshot()
            self.last_safety = safety.snapshot()
        except Exception as error:
            self.phase = 'ERROR'
            self.error = str(error)
            s.active_safety.enabled = True
            p.scenarios.living_city()
            raise
        finally:
            s.state_at = s.now()
            s.reconfiguring = False

    def before_control(self):
        if self.phase != 'RESETTING':
            return
        s, p = self.service, self.service.provider
        if time.monotonic() - self.reset_began > 30:
            raise ValueError('Comparison sensors/reset did not become ready within 30 seconds')
        if p.scenarios.phase != 'READY':
            return
        if not s.observation or s.observation.vehicle.actor_id != p.ego.actor.id:
            return
        if self.ready_frame is None:
            self.ready_frame = s.observation.frame_id
        if s.observation.frame_id - self.ready_frame < 25:
            return
        if not s.observation.complete or s.observation.vehicle.speed_mps > .15:
            return
        if not self.prepared:
            p.dashboard_action('destination', self.destination)
            route = p.start_navigation(28, demo_options=AGENT_OPTIONS)
            config, signature = initial_signature(p.scenarios.run, route, p.navigation_options)
            p.scenarios.run.update(comparison_mode=self.mode, comparison_configuration=config,
                comparison_initial_condition_id=signature, basic_agent_options=p.navigation_options,
                safety_policy_enabled=self.mode == 'WITH',
                comparison_group='YA_RAB_OSTORHA_RULE_BASED' if self.mode == 'WITH' else 'NO_YA_RAB_OSTORHA_BASELINE',
                route=copy.deepcopy(route))
            # Route construction and recorder files can exceed sensor freshness.
            # Do that work while stopped, then prime fresh native observations.
            self.recording_path = s._change_recording({'enabled': True})['path']
            self.trace = (Path(self.recording_path)/'telemetry/comparison-controls.jsonl').open('w', encoding='utf8')
            self.prepared_frame = p.last_vehicle['frame']
            self.prepared = True
            s._event(EventType.ControlChanged, comparison_mode=self.mode,
                comparison_configuration=config, comparison_initial_condition_id=signature)
            return
        if s.observation.frame_id < self.prepared_frame + 2 or s.now()-s.state_at > .1:
            return
        route = p.route_state()
        s.arbiter.safety.clear()
        s.arbiter.machine.transition(ControlMode.AUTOMATIC, connected=True, explicit=True)
        s.journey = {'status': 'RUNNING', 'reason': None, 'speed_kmh': 28, 'route_id': route['id']}
        s.navigation_heartbeat_at = s.now()
        p.active_safety_status = s.active_safety.snapshot()
        p.scenarios.start()
        self.phase = 'RUNNING'
        s._event(EventType.ControlChanged, comparison_started=self.mode)

    def record(self, frame):
        if self.phase not in ('RESETTING','RUNNING') or self.trace is None:
            return
        safety = self.service.active_safety.snapshot()
        self.last_safety = safety
        self.last_applied_brake = frame.vehicle.brake
        self.trace.write(json.dumps({'frame_id': frame.frame_id, 'timestamp_s': frame.timestamp_s,
            'comparison_phase': self.phase,
            'safety': safety, 'intervention_command': to_dict(self.service.safety_command),
            'applied_command': to_dict(frame.control), 'actual_vehicle_controls': {
                k: getattr(frame.vehicle, k) for k in ('throttle', 'brake', 'steering')},
            'complete': frame.complete})+'\n')
        self.trace.flush()

    def after_tick(self):
        if self.phase != 'RUNNING':
            return
        s, p = self.service, self.service.provider
        if p.scenarios.metrics.get('collision_count', 0):
            self.finish('collision')
        elif p.scenarios.phase == 'FINISHED':
            self.finish(p.scenarios.outcome['reason'])
        elif s.journey['status'] != 'RUNNING':
            self.finish(s.journey.get('reason') or 'interrupted')

    def finish(self, reason):
        s, p = self.service, self.service.provider
        if self.phase == 'RESETTING' and self.trace:
            self.trace.close()
            self.trace = None
            if s.recorder:
                s.reconfiguring = True
                try: s._change_recording({'enabled': False})
                finally:
                    s.state_at = s.now()
                    s.reconfiguring = False
        if self.phase == 'RUNNING':
            self.phase = 'STOPPING'
            p.scenarios.stop(reason=reason)
            outcome = p.scenarios.collect_outcome()
            outcome['reason'] = reason
            metrics = outcome['metrics']
            completed = reason == 'timeout'
            result = {'mode': self.mode, 'recording': self.recording_path,
                'run': copy.deepcopy(p.scenarios.run), 'outcome': outcome,
                'collision': metrics['collision_count'] > 0, 'completed': completed,
                'status': 'COLLISION' if metrics['collision_count'] else
                    'SAFE_PROGRESS' if completed and outcome['scenario_success'] else
                    'INCOMPLETE' if completed else 'INTERRUPTED',
                'final_safety': copy.deepcopy(self.last_safety)}
            s._event(EventType.ControlChanged, comparison_result=result)
            if self.trace:
                self.trace.close()
                self.trace = None
            if s.recorder:
                # End driving before waiting for disk flush. This is a managed
                # tick pause, like actor reset; no safety limits are relaxed.
                if s._live(): s.stop_driving(reason)
                else: s._stop_navigation(reason)
                s.reconfiguring = True
                try: s._change_recording({'enabled': False})
                finally:
                    s.state_at = s.now()
                    s.reconfiguring = False
            (Path(self.recording_path)/'comparison-result.json').write_text(json.dumps(result, indent=2), encoding='utf8')
            # Interrupted starts never replace an earlier full measured result.
            if completed or result['collision']:
                self.results[self.mode] = result
            self.latest = result
            directory = ROOT/'output/presentation-demo'
            directory.mkdir(parents=True, exist_ok=True)
        if self.busy:
            if s._live():
                s.stop_driving(reason)
            else:
                s._stop_navigation(reason)
                s.arbiter.safety.clear()
            self.phase = 'FINISHED'
        if s.active_safety:
            s._clear_safety_command()
            s.active_safety.enabled = True
            s.active_safety.set_controller('RULE')
        if hasattr(self, 'latest'):
            (ROOT/'output/presentation-demo/comparison.json').write_text(json.dumps(self.snapshot(), indent=2), encoding='utf8')

    def snapshot(self):
        p = self.service.provider
        environment = p.environment_state() or {}
        metrics = environment.get('metrics') or {}
        result = getattr(self, 'latest', None)
        # Compact live payload; full configs live beside the replay recordings.
        summaries = {mode: {k: value[k] for k in ('mode', 'recording', 'collision', 'completed', 'status', 'outcome')}
                     for mode, value in self.results.items()}
        signatures = [v['run']['comparison_initial_condition_id'] for v in self.results.values()]
        return {'phase': self.phase, 'mode': self.mode, 'error': self.error,
            'scenario_id': self.spec.scenario_id if self.spec else None, 'seed': 2589,
            'safety_enabled': self.mode == 'WITH' if self.mode else None,
            'active_controller': 'BasicAgent + RULE' if self.mode == 'WITH' else 'BasicAgent' if self.mode else None,
            'metrics': copy.deepcopy(metrics), 'recording': self.recording_path,
            'last_safety': copy.deepcopy(self.last_safety),
            'last_applied_brake': self.last_applied_brake,
            'latest_outcome': result['status'] if result and self.phase == 'FINISHED' else None,
            'results': summaries, 'initial_conditions_match': len(signatures) == 2 and signatures[0] == signatures[1],
            'basic_agent_vehicle_checks': 'DISABLED_IN_BOTH_RESEARCH_ARMS'}
