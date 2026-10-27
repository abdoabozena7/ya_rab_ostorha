"""Ordinary RULE/standard-driver journeys, separate from research experiments.

All samples use canonical simulation time. Near misses are forward sensor
episodes (TTC < 1.5 s and measured range < 5 m), not collision probabilities.
"""
import copy
import json
import math
import uuid
from datetime import datetime, timezone
from pathlib import Path
from .driver_profiles import SENSOR_COMPARISON_PROTOCOL, SENSOR_COMPARISON_PROTOCOLS

MODES = ('ROBOSPHERE', 'NORMAL')
BENCHMARK_MODES = ('HYBRID', 'BASELINE')


def benchmark_terminal_supported(journey):
    return (journey.get('status')=='ARRIVED' or journey.get('status') in ('PAUSED','ERROR')
            and journey.get('reason') in ('collision','route_ended_before_destination'))


def validate_mode(mode):
    if mode not in MODES+BENCHMARK_MODES:
        raise ValueError('Choose ROBOSPHERE, NORMAL, HYBRID or BASELINE')
    return mode


def matching_setup(a, b, *, world_only=False):
    if not a or not b: return False
    if a.get('live_speed_changed') or b.get('live_speed_changed'): return False
    keys = ('map','blueprint','destination','speed_kmh','population','weather','actual_population')
    if a.get('runtime_rates') is not None or b.get('runtime_rates') is not None:
        keys += ('runtime_rates',)
    if a.get('render_configuration') is not None or b.get('render_configuration') is not None:
        keys += ('render_configuration',)
    if a.get('comparison_scenario') or b.get('comparison_scenario'):keys+=('perception_profile','comparison_scenario')
    if a.get('protocol') in SENSOR_COMPARISON_PROTOCOLS or b.get('protocol') in SENSOR_COMPARISON_PROTOCOLS:
        if a.get('protocol')!=b.get('protocol'):return False
        keys+=('vehicle_geometry','vehicle_physics','sensor_configuration')
    if world_only:keys=tuple(k for k in keys if k!='blueprint')
    if any(a.get(k) is None or b.get(k) is None for k in keys): return False
    try:
        poses = [setup['origin'][field] for setup in (a, b) for field in ('location', 'rotation')]
        if any(len(pose) != 3 or any(not math.isfinite(v) for v in pose) for pose in poses): return False
        return all(a[k] == b[k] for k in keys) and math.dist(a['origin']['location'], b['origin']['location']) <= .5 and all(
            abs((x-y+180)%360-180) <= 1 for x,y in zip(a['origin']['rotation'],b['origin']['rotation']))
    except (KeyError, TypeError, ValueError):
        return False


class JourneyComparison:
    def __init__(self, directory=None):
        self.directory = Path(directory or Path(__file__).resolve().parents[2]/'output/journey-comparisons')
        self.data = {'version': 1, 'pair_id': None, 'manifest': None, 'runs': {}}
        self.active = None
        self.previous = None
        self.contact_times = {}
        self.near = self.intervening = False
        self.control_latency_samples = []
        try:
            saved = json.loads((self.directory/'latest.json').read_text(encoding='utf-8'))
            if saved.get('version') in (1, 2, 3, 4, 5, 6, 7) and isinstance(saved.get('runs'), dict):
                self.data = saved
                for run in saved['runs'].values():
                    if run['status'] == 'RUNNING':
                        run.update(status='INTERRUPTED', reason='Backend restarted before run finished')
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def save(self):
        try:
            from .crossing_result import evaluate_pair
            assessment=evaluate_pair(self.data)
            if assessment:self.data['scenario_validation']=assessment
            self.directory.mkdir(parents=True, exist_ok=True)
            self.data.pop('storage_error', None)
            payload = json.dumps(self.data, ensure_ascii=False, allow_nan=False, indent=2)
            for name in (self.data['pair_id'], 'latest'):
                temporary = self.directory/(name+'.tmp')
                temporary.write_text(payload, encoding='utf-8')
                temporary.replace(self.directory/(name+'.json'))
        except OSError as error:
            # Reporting must never prevent a stop command from reaching CARLA.
            self.data['storage_error'] = str(error)

    def begin(self, mode, manifest, *, pair_id=None, recording=None):
        validate_mode(mode)
        if self.active: raise ValueError('A journey is already being measured')
        if pair_id is not None and pair_id != self.data['pair_id']:
            raise ValueError('Comparison changed; prepare its mode again')
        if pair_id is None:
            benchmark = mode in BENCHMARK_MODES
            self.data = {'version': 7 if manifest.get('protocol')=='EGYPT_COMPLETE_DRIVERS_V1' else 6 if manifest.get('protocol')==SENSOR_COMPARISON_PROTOCOL else 5 if manifest.get('guided') and manifest.get('vehicle_variants') else 4 if manifest.get('guided') else 3 if manifest.get('presentation_id') else 2 if benchmark else 1, 'pair_id': uuid.uuid4().hex,
                         'driver_modes':list(BENCHMARK_MODES if benchmark else MODES),
                         'manifest': copy.deepcopy(manifest), 'runs': {}}
            if manifest.get('guided'):self.data['order']=list(manifest['presentation_order'])
        elif mode not in self.data.get('driver_modes', MODES):
            raise ValueError('Legacy protection comparisons and the hybrid benchmark are separate protocols')
        if (self.data['manifest'].get('protocol') in SENSOR_COMPARISON_PROTOCOLS or manifest.get('protocol') in SENSOR_COMPARISON_PROTOCOLS) and self.data['manifest'].get('protocol') != manifest.get('protocol'):
            raise ValueError('Historical and sensor-reactive comparisons use different protocols')
        old = self.data['runs'].get(mode)
        if old:
            self.data.setdefault('previous_attempts', []).append(copy.deepcopy(old))
        run = {'id': uuid.uuid4().hex, 'mode': mode, 'status': 'RUNNING', 'reason': None, 'setup':copy.deepcopy(manifest),
               'driver_id': (manifest.get('driver_profile') or {}).get('id') or ('CARLA_BEHAVIOR_NORMAL' if mode == 'BASELINE' else 'ROBOSPHERE_HYBRID_V1' if mode == 'HYBRID' else mode),
               'driver_profile':copy.deepcopy(manifest.get('driver_profile')),
               'created_at_utc': datetime.now(timezone.utc).isoformat(), 'recording': recording,
               'duration_s': 0., 'distance_m': 0., 'route_completion_percent': 0.,
               'collisions': 0, 'contact_callbacks': 0, 'maximum_impulse_ns': 0., 'near_misses': 0,
               'safety_interventions': 0, 'high_risk_s': 0., 'sensor_coverage_percent': 0.,
               'safety_intervention_s': 0., 'harsh_braking_events': 0, 'destination_reached': False,
               'acceleration_samples': 0, 'intervention_samples': 0,
               'minimum_forward_range_m': None, 'mean_speed_kmh': 0.,
               'maximum_speed_kmh':0.,
               'samples': 0, 'observed_samples': 0, 'risk_timeline': [], 'events': []}
        if manifest.get('protocol') == 'EGYPT_COMPLETE_DRIVERS_V1':
            run.update(completed_maneuvers=[], waiting_reasons_s={}, sensor_age_samples=0,
                       maximum_sensor_sim_age_s=None, maximum_sensor_wall_age_s=None, simulation_wall_ratio=None,
                       missing_current_sensor_frames=0)
        self.data['runs'][mode] = self.active = run
        self.previous = None
        self.contact_times = {}
        self.near = self.intervening = False
        self.harsh = False
        self.driver_metric_frame = self.driver_metric_stamp = self.driver_metric_wall = self.driver_metric_start = None
        self.control_latency_samples = []
        self.save()
        return run

    def record_application(self, timing):
        if self.active is None or self.data.get('version') != 7:
            return
        sample = timing.get('sensor_to_application_check_ms')
        if (type(sample) not in (int, float) or not math.isfinite(sample) or sample < 0
                or timing.get('sensor_timing_verified') is not True):
            self.active['control_latency_unmeasured_frames'] = self.active.get('control_latency_unmeasured_frames', 0) + 1
            return
        frame = timing.get('frame_id')
        if self.control_latency_samples and frame == self.control_latency_samples[-1][0]:
            return
        self.control_latency_samples.append((frame, sample, timing.get('carla_control_call_ms'), timing.get('fresh_aligned')))

    def _finish_control_timing(self):
        if self.active is None or not self.control_latency_samples:
            return
        import numpy as np
        samples = [row[1] for row in self.control_latency_samples]
        calls = [row[2] for row in self.control_latency_samples if type(row[2]) in (int, float) and math.isfinite(row[2])]
        self.active['control_latency'] = {'clock': 'HOST_MONOTONIC', 'scope': 'SENSOR_RECEIPT_TO_APPLICATION_CHECK',
            'samples': len(samples), 'p95_ms': float(np.percentile(samples, 95)), 'p99_ms': float(np.percentile(samples, 99)),
            'maximum_ms': max(samples), 'deadline_exceeded_frames': sum(value > 250. for value in samples),
            'unmeasured_frames': self.active.get('control_latency_unmeasured_frames', 0),
            'unaligned_frames': sum(row[3] is not True for row in self.control_latency_samples),
            'carla_call_p95_ms': float(np.percentile(calls, 95)) if calls else None,
            'carla_call_p99_ms': float(np.percentile(calls, 99)) if calls else None}

    def collision(self, collision):
        run = self.active
        if self.data.get('version') == 7:
            candidates = [r for r in self.data['runs'].values() if
                          r.get('first_timestamp_s', math.inf) <= collision.timestamp_s <= r.get('last_timestamp_s', -math.inf) + .1]
            if candidates:
                run = max(candidates, key=lambda r: r['first_timestamp_s'])
        if run is None: return
        run['contact_callbacks'] = run.get('contact_callbacks', 0) + 1
        actor, stamp = collision.other_actor_id, collision.timestamp_s
        last = self.contact_times.get(actor, -math.inf)
        self.contact_times[actor] = stamp
        if stamp-last > 1.:
            run['collisions'] += 1
            run['events'].append({'title': 'Collision', 'timestamp_s': stamp, 'detail': f'Actor {actor}'})
        impulse = getattr(collision, 'impulse_magnitude_ns', None)
        if impulse is None: impulse = math.sqrt(sum(v*v for v in collision.impulse_ns))
        run['maximum_impulse_ns'] = max(run['maximum_impulse_ns'], impulse)
        if run is not self.active:
            run.setdefault('collision_events', []).append({'frame_id': collision.frame_id, 'timestamp_s': stamp,
                'actor_id': actor, 'type': getattr(collision, 'other_actor_type', None), 'late_callback': True})
            run.update(status='COLLISION', reason='collision', terminal_contact_recorded_late=True)
            self.save()
        return run

    def event(self, title, stamp, detail):
        self.active['events'].append({'title': title, 'timestamp_s': stamp, 'detail': str(detail)})
        self.active['events'] = self.active['events'][-60:]

    def sample_driver(self, frame, behavior, scene, *, wall_s, waiting_reason=None):
        run = self.active
        if not run or self.data.get('version') != 7 or frame is None or frame.frame_id == self.driver_metric_frame:
            return
        stamp = frame.timestamp_s
        dt = max(0., stamp - self.driver_metric_stamp) if self.driver_metric_stamp is not None else 0.
        self.driver_metric_frame, self.driver_metric_stamp = frame.frame_id, stamp
        if self.driver_metric_wall is None:
            self.driver_metric_wall, self.driver_metric_start = wall_s, stamp
        if wall_s > self.driver_metric_wall:
            run['simulation_wall_ratio'] = (stamp - self.driver_metric_start) / (wall_s - self.driver_metric_wall)
        if frame.vehicle.speed_mps < .15 and waiting_reason:
            waits = run['waiting_reasons_s']
            waits[waiting_reason] = waits.get(waiting_reason, 0.) + dt
        if behavior.get('driver_id') == run.get('driver_id'):
            run['completed_maneuvers'] = copy.deepcopy(behavior.get('completed_maneuvers', []))
        if scene is None or scene.observation.frame_id != frame.frame_id:
            run['missing_current_sensor_frames'] += 1
        if scene is not None and scene.observation.frame_id <= frame.frame_id:
            sim_age, wall_age = stamp - scene.observation.timestamp_s, wall_s - scene.received_wall_s
            if sim_age >= 0 and wall_age >= 0:
                run['sensor_age_samples'] += 1
                run['maximum_sensor_sim_age_s'] = max(sim_age, run['maximum_sensor_sim_age_s'] or 0.)
                run['maximum_sensor_wall_age_s'] = max(wall_age, run['maximum_sensor_wall_age_s'] or 0.)

    def sample(self, frame, route, safety):
        run = self.active
        if not run or self.previous and frame.frame_id <= self.previous.frame_id: return
        previous = self.previous
        self.previous = frame
        dt = max(0., frame.timestamp_s-previous.timestamp_s) if previous else 0.
        run['samples'] += 1
        if self.data.get('version') == 7:
            run.setdefault('first_timestamp_s', frame.timestamp_s)
            run['last_timestamp_s'] = frame.timestamp_s
        run['duration_s'] += dt
        if previous:
            run['distance_m'] += math.dist(frame.vehicle.transform.position_m, previous.vehicle.transform.position_m)
        run['mean_speed_kmh'] += (frame.vehicle.speed_mps*3.6-run['mean_speed_kmh'])/run['samples']
        run['maximum_speed_kmh']=max(run['maximum_speed_kmh'],frame.vehicle.speed_mps*3.6)
        length = run['setup'].get('route_length_m', 0.)
        if route and length > 0:
            run['route_completion_percent'] = max(run['route_completion_percent'], min(100., max(0., 100*(1-route.get('remaining_m', length)/length))))
        # No stale observer value is counted as a clear frame.
        measured_risk=safety.get('reactive_risk',safety.get('risk')) if self.data.get('version') in (6,7) else safety.get('risk')
        observed = frame.complete and safety.get('frame_id') == frame.frame_id and measured_risk not in (None, 'UNKNOWN', 'UNKNOWN_SPACE')
        run['observed_samples'] += int(observed)
        run['sensor_coverage_percent'] = 100*run['observed_samples']/run['samples']
        distance, ttc = safety.get('measured_range_m'), safety.get('ttc_s')
        high = observed and measured_risk in ('PATH_CONFLICT', 'FORWARD_COLLISION_RISK')
        if high: run['high_risk_s'] += dt
        if observed and isinstance(distance, (int, float)):
            run['minimum_forward_range_m'] = min(distance, run['minimum_forward_range_m'] if run['minimum_forward_range_m'] is not None else math.inf)
        near = observed and ttc is not None and distance is not None and 0 <= ttc < 1.5 and distance < 5
        if near and not self.near:
            run['near_misses'] += 1
            self.event('Forward near miss', frame.timestamp_s, f'TTC {ttc:.2f} s · range {distance:.2f} m')
        # Keep a one-second release gap between episodes, including unknown frames.
        if near: self.last_near = frame.timestamp_s
        self.near = bool(near or self.near and frame.timestamp_s-getattr(self, 'last_near', 0) < 1)
        observer_current = frame.complete and safety.get('frame_id') == frame.frame_id and isinstance(safety.get('active'), bool)
        run['intervention_samples'] += int(observer_current)
        active = bool(observer_current and (run['mode'] in ('ROBOSPHERE','HYBRID') or (run.get('driver_profile') or {}).get('sensor_obstacle_braking')) and safety['active'])
        if observer_current and self.intervening: run['safety_intervention_s'] += dt
        if active and not self.intervening:
            run['safety_interventions'] += 1
            self.event('Reactive sensor braking' if run['mode']=='NORMAL' else 'RULE intervention', frame.timestamp_s, safety.get('reason', ''))
        self.intervening = active
        # Measured deceleration, not requested brake pressure alone. Episode
        # release is one second; no control or protection thresholds are changed.
        acceleration = frame.vehicle.longitudinal_acceleration_mps2
        run['acceleration_samples'] += int(isinstance(acceleration, (int, float)) and math.isfinite(acceleration))
        harsh = isinstance(acceleration, (int, float)) and math.isfinite(acceleration) and acceleration <= -3.5 and frame.vehicle.speed_mps > 1 and frame.vehicle.brake > .2
        if harsh and not self.harsh:
            run['harsh_braking_events'] += 1
            self.event('Harsh braking', frame.timestamp_s, f'{acceleration:.2f} m/s²')
        if harsh: self.last_harsh = frame.timestamp_s
        self.harsh = bool(harsh or self.harsh and frame.timestamp_s-getattr(self, 'last_harsh', 0) < 1)
        if not run['risk_timeline'] or frame.timestamp_s-run['risk_timeline'][-1]['timestamp_s'] >= 1:
            run['risk_timeline'].append({'timestamp_s': frame.timestamp_s, 'elapsed_s': run['duration_s'],
                                         'risk': 'HIGH' if high else 'CLEAR' if observed else 'UNKNOWN'})
            run['risk_timeline'] = run['risk_timeline'][-900:]

    def finish(self, reason, status='INTERRUPTED'):
        if not self.active: return
        self._finish_control_timing()
        self.active.update(status='ARRIVED' if reason == 'destination_reached' else 'COLLISION' if reason == 'collision' else 'TIMEOUT' if reason=='egypt_route_timeout' else 'SHORTENED' if reason=='guided_shortened' else status, reason=reason)
        if self.active['status'] == 'ARRIVED':
            self.active['route_completion_percent'] = 100.
            self.active['destination_reached'] = True
        self.event('Run ended', self.previous.timestamp_s if self.previous else 0., reason)
        self.active = self.previous = None
        self.save()

    def snapshot(self, *, compact=False):
        data=self.data
        from .crossing_result import evaluate_pair
        assessment=evaluate_pair(data)
        if assessment:data={**data,'scenario_validation':assessment}
        if compact:
            def setup(value):
                return {k:v for k,v in (value or {}).items() if k!='initial_conditions'}
            def diagnostic(value):
                value=value or {}
                fault=value.get('runtime_fault') or value.get('safety_fault')
                return {'reason':value.get('reason'),'runtime_fault':{k:fault.get(k) for k in (
                    'stage','exception_type','message','evaluation_frame','timestamp_s','injected_validation_fault')}
                    if fault else None}
            data={**data,'manifest':setup(data.get('manifest')),
                'runs':{mode:{**{k:v for k,v in run.items() if k not in ('setup','stop_diagnostics')},
                    'setup':setup(run.get('setup')),'stop_diagnostics':diagnostic(run.get('stop_diagnostics'))}
                    for mode,run in data.get('runs',{}).items()}}
        result = copy.deepcopy(data)
        modes = result.get('driver_modes', MODES)
        result['conditions_match'] = matching_setup(*(result['runs'].get(m, {}).get('setup') for m in modes))
        if result.get('version') in (2, 3, 4, 5, 6, 7):
            audits = [result['runs'].get(m, {}).get('setup', {}).get('initial_condition_id') for m in modes]
            verified = all(result['runs'].get(m, {}).get('initial_condition_audit', {}).get('passed') is True for m in modes)
            result['conditions_match'] = result['conditions_match'] and bool(audits[0]) and audits[0] == audits[1] and verified
            if result.get('version')==5:
                result['world_start_match']=matching_setup(*(result['runs'].get(m,{}).get('setup') for m in modes),world_only=True) and bool(audits[0]) and audits[0]==audits[1] and verified
                result['vehicle_models_differ']=len({result['runs'].get(m,{}).get('setup',{}).get('blueprint') for m in modes})>1
                result['comparison_scope']='Same world start; different native vehicle models. Vehicle physics are a comparison variable.'
        return result
