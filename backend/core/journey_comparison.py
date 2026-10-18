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

MODES = ('ROBOSPHERE', 'NORMAL')
BENCHMARK_MODES = ('HYBRID', 'BASELINE')


def benchmark_terminal_supported(journey):
    return (journey.get('status')=='ARRIVED' or journey.get('status') in ('PAUSED','ERROR')
            and journey.get('reason') in ('collision','route_ended_before_destination'))


def validate_mode(mode):
    if mode not in MODES+BENCHMARK_MODES:
        raise ValueError('Choose ROBOSPHERE, NORMAL, HYBRID or BASELINE')
    return mode


def matching_setup(a, b):
    if not a or not b: return False
    if a.get('live_speed_changed') or b.get('live_speed_changed'): return False
    keys = ('map','blueprint','destination','speed_kmh','population','weather','actual_population')
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
        try:
            saved = json.loads((self.directory/'latest.json').read_text(encoding='utf-8'))
            if saved.get('version') in (1, 2, 3, 4) and isinstance(saved.get('runs'), dict):
                self.data = saved
                for run in saved['runs'].values():
                    if run['status'] == 'RUNNING':
                        run.update(status='INTERRUPTED', reason='Backend restarted before run finished')
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def save(self):
        try:
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
            self.data = {'version': 4 if manifest.get('guided') else 3 if manifest.get('presentation_id') else 2 if benchmark else 1, 'pair_id': uuid.uuid4().hex,
                         'driver_modes':list(BENCHMARK_MODES if benchmark else MODES),
                         'manifest': copy.deepcopy(manifest), 'runs': {}}
            if manifest.get('guided'):self.data['order']=list(manifest['presentation_order'])
        elif mode not in self.data.get('driver_modes', MODES):
            raise ValueError('Legacy protection comparisons and the hybrid benchmark are separate protocols')
        old = self.data['runs'].get(mode)
        if old:
            self.data.setdefault('previous_attempts', []).append(copy.deepcopy(old))
        run = {'id': uuid.uuid4().hex, 'mode': mode, 'status': 'RUNNING', 'reason': None, 'setup':copy.deepcopy(manifest),
               'driver_id': 'CARLA_BEHAVIOR_NORMAL' if mode == 'BASELINE' else 'ROBOSPHERE_HYBRID_V1' if mode == 'HYBRID' else mode,
               'created_at_utc': datetime.now(timezone.utc).isoformat(), 'recording': recording,
               'duration_s': 0., 'distance_m': 0., 'route_completion_percent': 0.,
               'collisions': 0, 'maximum_impulse_ns': 0., 'near_misses': 0,
               'safety_interventions': 0, 'high_risk_s': 0., 'sensor_coverage_percent': 0.,
               'safety_intervention_s': 0., 'harsh_braking_events': 0, 'destination_reached': False,
               'acceleration_samples': 0, 'intervention_samples': 0,
               'minimum_forward_range_m': None, 'mean_speed_kmh': 0.,
               'maximum_speed_kmh':0.,
               'samples': 0, 'observed_samples': 0, 'risk_timeline': [], 'events': []}
        self.data['runs'][mode] = self.active = run
        self.previous = None
        self.contact_times = {}
        self.near = self.intervening = False
        self.harsh = False
        self.save()
        return run

    def collision(self, collision):
        if not self.active: return
        actor, stamp = collision.other_actor_id, collision.timestamp_s
        last = self.contact_times.get(actor, -math.inf)
        self.contact_times[actor] = stamp
        if stamp-last > 1.:
            self.active['collisions'] += 1
            self.event('Collision', stamp, f'Actor {actor}')
        impulse = getattr(collision, 'impulse_magnitude_ns', None)
        if impulse is None: impulse = math.sqrt(sum(v*v for v in collision.impulse_ns))
        self.active['maximum_impulse_ns'] = max(self.active['maximum_impulse_ns'], impulse)

    def event(self, title, stamp, detail):
        self.active['events'].append({'title': title, 'timestamp_s': stamp, 'detail': str(detail)})
        self.active['events'] = self.active['events'][-60:]

    def sample(self, frame, route, safety):
        run = self.active
        if not run or self.previous and frame.frame_id <= self.previous.frame_id: return
        previous = self.previous
        self.previous = frame
        dt = max(0., frame.timestamp_s-previous.timestamp_s) if previous else 0.
        run['samples'] += 1
        run['duration_s'] += dt
        if previous:
            run['distance_m'] += math.dist(frame.vehicle.transform.position_m, previous.vehicle.transform.position_m)
        run['mean_speed_kmh'] += (frame.vehicle.speed_mps*3.6-run['mean_speed_kmh'])/run['samples']
        run['maximum_speed_kmh']=max(run['maximum_speed_kmh'],frame.vehicle.speed_mps*3.6)
        length = run['setup'].get('route_length_m', 0.)
        if route and length > 0:
            run['route_completion_percent'] = max(run['route_completion_percent'], min(100., max(0., 100*(1-route.get('remaining_m', length)/length))))
        # No stale observer value is counted as a clear frame.
        observed = frame.complete and safety.get('frame_id') == frame.frame_id and safety.get('risk') not in (None, 'UNKNOWN', 'UNKNOWN_SPACE')
        run['observed_samples'] += int(observed)
        run['sensor_coverage_percent'] = 100*run['observed_samples']/run['samples']
        distance, ttc = safety.get('measured_range_m'), safety.get('ttc_s')
        high = observed and safety.get('risk') in ('PATH_CONFLICT', 'FORWARD_COLLISION_RISK')
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
        active = observer_current and run['mode'] in ('ROBOSPHERE','HYBRID') and safety['active']
        if observer_current and self.intervening: run['safety_intervention_s'] += dt
        if active and not self.intervening:
            run['safety_interventions'] += 1
            self.event('RULE intervention', frame.timestamp_s, safety.get('reason', ''))
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
        self.active.update(status='ARRIVED' if reason == 'destination_reached' else 'COLLISION' if reason == 'collision' else 'SHORTENED' if reason=='guided_shortened' else status, reason=reason)
        if self.active['status'] == 'ARRIVED':
            self.active['route_completion_percent'] = 100.
            self.active['destination_reached'] = True
        self.event('Run ended', self.previous.timestamp_s if self.previous else 0., reason)
        self.active = self.previous = None
        self.save()

    def snapshot(self, *, compact=False):
        data=self.data
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
        if result.get('version') in (2, 3, 4):
            audits = [result['runs'].get(m, {}).get('setup', {}).get('initial_condition_id') for m in modes]
            verified = all(result['runs'].get(m, {}).get('initial_condition_audit', {}).get('passed') is True for m in modes)
            result['conditions_match'] = result['conditions_match'] and bool(audits[0]) and audits[0] == audits[1] and verified
        return result
