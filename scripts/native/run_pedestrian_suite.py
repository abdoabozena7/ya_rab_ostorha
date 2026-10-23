"""Native pedestrian-suite harness for dataset collection and closed-loop evaluation.

The production route controller, ControlScene, safety supervisor, arbiter and
freshness gates run in-process with one tick owner. Evaluator truth (walker
poses, scripts) is written to the episode log beside — never into — control.
"""
import argparse
import gzip
import json
import math
import queue
from pathlib import Path
import subprocess
import sys
import threading
import time
import traceback
import uuid

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_OUT = ROOT/'output/pedestrian-suite'
TRACK_KEYS = ('id', 'class', 'confirmed', 'position_m', 'velocity_mps', 'acceleration_mps2', 'half_size_m', 'uncertainty_m',
              'occlusion_s', 'quality', 'motion_observations', 'observed_crossing_cleared', 'history')
SOURCE_FILES = ('backend/core/active_safety.py', 'backend/core/pedestrian_anticipation.py', 'backend/core/depth_people.py',
                'backend/core/path_entry_features.py', 'backend/core/path_entry_risk.py', 'backend/core/evidence_budget.py',
                'backend/core/pedestrian_behaviors.py', 'backend/carla/pedestrian_world.py', 'backend/core/closed_loop_evaluation.py',
                'backend/core/normal_navigation.py', 'config/path-entry-risk.json', 'config/ya_rab_ostorha_safety.json',
                'scripts/native/run_pedestrian_suite.py')


def source_hashes():
    import hashlib
    from backend.learning.pilot_provenance import control_hashes
    result = dict(control_hashes())
    for name in SOURCE_FILES:
        path = ROOT/name
        result[name] = hashlib.sha256(path.read_bytes()).hexdigest() if path.exists() else None
    return result


def _round(value, digits=3):
    if isinstance(value, float):return round(value, digits) if math.isfinite(value) else None
    if isinstance(value, (list, tuple)):return [_round(v, digits) for v in value]
    if isinstance(value, dict):return {k: _round(v, digits) for k, v in value.items()}
    return value


def compact_track(track):
    row = {k: track.get(k) for k in TRACK_KEYS if k in track}
    semantic = track.get('semantic_evidence') or {}
    evidence = track.get('measurement_evidence') or {}
    if semantic:row['semantic_evidence'] = {'confidence': semantic.get('confidence'), 'timestamp_s': semantic.get('timestamp_s'),
                                           'source_sensor': semantic.get('source_sensor')}
    row['measurement_evidence'] = {'source': evidence.get('source'), 'support_points': evidence.get('support_points'),
                                   'frame_id': evidence.get('frame_id')}
    return _round(row)


def plan_episodes(args, suite):
    from backend.core.pedestrian_behaviors import counterfactual_pair, ordinary_journey, sample_episode
    specs = []
    for index in parse_indices(args.indices):specs.append(sample_episode(suite, args.split, index))
    for index in parse_indices(args.counterfactual):specs.extend(counterfactual_pair(suite, args.split, index))
    for index in parse_indices(getattr(args, 'ordinary', '')):specs.append(ordinary_journey(suite, args.split, index))
    if args.behaviors:
        wanted = set(args.behaviors.split(','));specs = [s for s in specs if s['behavior'] in wanted]
    return specs


def parse_indices(text):
    if not text:return []
    result = []
    for part in text.split(','):
        if '-' in part:
            lo, hi = part.split('-');result.extend(range(int(lo), int(hi)+1))
        elif part:result.append(int(part))
    return result


class EpisodeWriter:
    """Background JSON/gzip writer so logging never delays the next native tick."""
    def __init__(self, path):
        self.queue = queue.Queue(maxsize=4000);self.path = path;self.rows = 0;self.error = None
        self.thread = threading.Thread(target=self._run, daemon=True);self.thread.start()

    def _run(self):
        try:
            with gzip.open(self.path, 'wt', encoding='utf8') as stream:
                while True:
                    row = self.queue.get()
                    if row is None:break
                    stream.write(json.dumps(row, allow_nan=False, separators=(',', ':'))+'\n');self.rows += 1
        except Exception as error:self.error = str(error)

    def put(self, row):self.queue.put(row)

    def close(self):
        self.queue.put(None);self.thread.join(timeout=60.)
        if self.error:raise RuntimeError('Episode log failed: '+self.error)


def collect_row(service, provider, world, elapsed, step_ms):
    from backend.core.contracts import to_dict
    from backend.core.path_entry_features import eligible_track
    observation = service.observation;v = observation.vehicle;scene = service.control_scene
    geometry = getattr(provider, 'vehicle_geometry', None);front = geometry.front_m if geometry else 0.
    row = {'frame': observation.frame_id, 'timestamp_s': observation.timestamp_s, 'elapsed_s': round(elapsed, 4),
           'ego': _round({'speed_mps': v.speed_mps, 'position_m': list(v.transform.position_m),
                          'yaw_rad': v.transform.rotation_rad.yaw, 'throttle': v.throttle, 'brake': v.brake,
                          'steering': v.steering, 'gear': v.gear, 'reverse': v.reverse}),
           'journey': {'status': service.journey.get('status'), 'reason': service.journey.get('reason')},
           'step_ms': round(step_ms, 2), 'backend_step_ms': _round(service.backend_step_ms),
           'control_timing_ms': _round(dict(service.control_timing_ms)) if getattr(service, 'control_timing_ms', None) else None,
           'provider_step_ms': _round(getattr(provider, 'step_timing_ms', None))}
    base = getattr(service, 'base_driver_command', None);selected = service.arbiter.last_selection
    row['base_command'] = _round({k: getattr(base, k) for k in ('frame_id', 'throttle', 'brake', 'steering', 'source')}) if base else None
    if row['base_command']:row['base_command']['source'] = str(base.source.value)
    row['applied_command'] = ({'frame_id': selected.frame_id, 'throttle': round(selected.throttle, 3), 'brake': round(selected.brake, 3),
                               'steering': round(selected.steering, 3), 'source': selected.source.value} if selected else None)
    row['speed'] = _round({'requested_kmh': service.journey.get('speed_kmh'),
        'navigation_target_mps': getattr(provider, 'navigation_target_mps', None),
        'posted_limit_kmh': getattr(provider, 'navigation_posted_limit_kmh', None),
        'curvature_limit_mps': getattr(provider, 'navigation_curvature_limit_mps', None),
        'limit_source': getattr(provider, 'hybrid_speed_limit_source', None),
        'launch_alignment': getattr(provider, 'launch_alignment', None),
        'navigation_stop_reason': getattr(provider, 'navigation_stop_reason', None)})
    status = dict(service.active_safety.status) if service.active_safety else {}
    keep = ('status', 'risk', 'reason', 'active', 'actual_generator', 'coverage_speed_limit_mps', 'cautious_roadside_speed_mps',
            'stopping_envelope_m', 'measured_range_m', 'observed_road_range_m', 'proposed_safety_brake', 'ttc_s',
            'prediction_speed_cap_mps', 'frame_id', 'decision_layer', 'evidence_decision')
    row['safety'] = _round({k: to_dict(status.get(k)) for k in keep if k in status})
    pedestrian = status.get('pedestrian_prediction') or {}
    if pedestrian:row['safety']['pedestrian_prediction'] = _round({k: pedestrian.get(k) for k in ('track_id', 'source', 'time_s', 'certainty')})
    if scene is not None:
        prediction = scene.prediction
        tracks = [compact_track(to_dict(t)) for t in prediction.get('tracks', ()) if eligible_track(t, front_m=front)]
        row['scene'] = {'frame_id': scene.observation.frame_id, 'timestamp_s': scene.observation.timestamp_s,
            'source': prediction.get('source'), 'motion_tracking_complete': prediction.get('motion_tracking_complete'),
            'odometry_origin_m': _round(list(prediction.get('odometry_origin_m') or ())),
            'odometry_yaw_rad': _round(prediction.get('odometry_yaw_rad')), 'tracks': tracks,
            'usable': scene.usable(observation.timestamp_s, service.now()),
            'wall_age_s': _round(service.now()-scene.received_wall_s), 'build_ms': _round(scene.build_ms),
            'timings_ms': _round(to_dict(scene.timings_ms))}
    perception = getattr(service, 'control_perception', None)
    latest = perception.latest(service.session_id) if perception else None
    if latest:row['perception'] = {'frame_id': latest.get('frame_id'), 'timestamp_s': latest.get('timestamp_s'),
                                   'detections': len(latest.get('detections') or ()), 'profile': (latest.get('detector_profile') or {}).get('id'),
                                   'detector_ms': _round(latest.get('detector_ms')), 'age_ms': _round(latest.get('age_ms'))}
    received = {s.sensor_id: s.metadata.get('received_monotonic_s') for s in observation.sensors if s.metadata.get('received_monotonic_s')}
    if received:
        first = min(received.values())
        row['sensors'] = {name: {'after_first_ms': round((stamp-first)*1000, 1),
                                 'decode_ms': _round(next((s.metadata.get('decode_duration_ms') for s in observation.sensors if s.sensor_id == name), None), 1)}
                          for name, stamp in received.items()}
    route = provider.route_state() or {}
    row['route'] = _round({k: route.get(k) for k in ('remaining_m', 'arrived', 'progress_m', 'length_m')})
    row['evaluator_truth'] = _round(world.truth())
    row['scripts'] = {role: s.phase for role, s in world.scripts.items()}
    return row


def reset_ego(service):
    """Mirror SimulationService's own reset action around a fixture ego respawn."""
    from backend.core.events import EventType
    from backend.core.timing import SensorSynchronizer
    service.policy_history.clear()
    if service.active_safety:service.active_safety.reset()
    service._clear_safety_command();service._drain_collision_events();service._ingest_provider_sensors()
    for pending in service.synchronizer.drain(force=True):
        service._publish(pending);service._record(pending)
    old = service.observation.vehicle.actor_id if service.observation else None
    service.provider.reset_vehicle()
    service.synchronizer = SensorSynchronizer(service._required_after_sensor_rebuild(), service.synchronizer.optional,
                                              timeout_s=service.synchronizer.timeout_s, now=service.now)
    service.camera_cache.clear();service.sensor_frame_cache.clear();service.collision_events.clear()
    service.control_scene = None;service.control_scene_builder = None
    service._event(EventType.VehicleDestroyed, actor_id=old)


def run_episode(service, provider, spec, configuration, folder, args):
    from backend.carla.pedestrian_world import PedestrianBehaviorWorld
    from backend.core.closed_loop_evaluation import CONFIGURATIONS, EvaluationAdmission
    from backend.core.contracts import to_dict
    directory = folder/spec['split']/configuration/spec['scenario_id'][:16]
    directory.mkdir(parents=True, exist_ok=True)
    world = PedestrianBehaviorWorld(provider);outcome = {'scenario_id': spec['scenario_id'], 'configuration': configuration,
        'behavior': spec['behavior'], 'split': spec['split'], 'location': spec['location'], 'outcome': None}
    writer = None;began_wall = time.monotonic();contacts = []
    try:
        manifest = world.setup(spec, reset=lambda: reset_ego(service))
        for _ in range(30):service.step_once()
        world.configure_route()
        for _ in range(10 if not spec['traffic']['vehicles'] else 60):service.step_once()
        if service.observation.vehicle.speed_mps > .15:raise RuntimeError('Ego did not settle before the journey')
        admission = EvaluationAdmission(configuration, float(spec['ego']['target_speed_kmh']),
                                        experimental_risk_model=bool(args.experimental_risk))
        collision_start = len(service.collision_events)
        service.start_journey(admission.requested_speed_kmh, driving_mode=CONFIGURATIONS[configuration]['driving_mode'],
                              evaluation=admission)
        service.journey_heartbeat(service.session_id);service.step_once()
        if service.journey.get('status') not in ('STARTING', 'RUNNING'):
            raise RuntimeError('Journey did not start: '+str(service.journey.get('reason')))
        start_t = service.observation.timestamp_s;world.begin(start_t)
        manifest.update(admission=admission.snapshot(), risk_model_status=to_dict(getattr(service.active_safety, 'risk_model_status', None)))
        (directory/'manifest.json').write_text(json.dumps(manifest, indent=1, default=str), encoding='utf8')
        writer = EpisodeWriter(directory/'episode.jsonl.gz')
        wall_limit = began_wall+args.episode_wall_s;moved = 0.;previous = list(service.observation.vehicle.transform.position_m)
        while True:
            elapsed = service.observation.timestamp_s-start_t
            world.before_tick(service.observation.timestamp_s)
            service.journey_heartbeat(service.session_id)
            tick = time.perf_counter();service.step_once();step_ms = (time.perf_counter()-tick)*1000
            elapsed = service.observation.timestamp_s-start_t
            position = list(service.observation.vehicle.transform.position_m)
            moved += math.dist(previous[:2], position[:2]);previous = position
            writer.put(collect_row(service, provider, world, elapsed, step_ms))
            for event in list(service.collision_events)[collision_start:]:
                contacts.append({'frame_id': event.frame_id, 'timestamp_s': event.timestamp_s, 'other_actor_id': event.other_actor_id,
                                 'other_actor_type': event.other_actor_type, 'elapsed_s': event.timestamp_s-start_t})
            collision_start = len(service.collision_events)
            status = service.journey.get('status')
            if contacts:outcome['outcome'] = 'COLLISION';break
            if status == 'ARRIVED':outcome['outcome'] = 'ARRIVED';break
            if status not in ('STARTING', 'RUNNING'):
                outcome['outcome'] = 'STOPPED_'+str(service.journey.get('reason') or status).upper();break
            if (args.end_after_passing and spec['pedestrians'] and
                    world.ego_route_front()[0] >= max(p['along_m'] for p in spec['pedestrians'])+10.):
                # Dataset collection only: never an arrival or a driving result.
                outcome['outcome'] = 'COLLECTION_END_PASSED_PEDESTRIANS';service.stop_driving('collection_passed_pedestrians');break
            if elapsed >= spec['time_limit_s']:
                outcome['outcome'] = 'TIMEOUT';service.stop_driving('evaluation_time_limit');break
            if time.monotonic() > wall_limit:
                outcome['outcome'] = 'WALL_LIMIT_ABORTED';service.stop_driving('evaluation_wall_limit');break
        outcome.update(simulated_s=round(elapsed, 3), distance_m=round(moved, 2), contacts=contacts,
                       journey=dict(service.journey), last_drive_stop=to_dict(service.last_drive_stop))
        for _ in range(4):service.step_once()
        outcome['realization'] = world.realization()
    except Exception as error:
        outcome.update(outcome=outcome['outcome'] or 'INVALID_CONSTRUCTION_OR_RUNTIME_FAILURE', error=str(error),
                       traceback=traceback.format_exc())
        try:
            if service.journey.get('status') in ('STARTING', 'RUNNING'):service.stop_driving('evaluation_failure')
        except Exception as stop_error:outcome['stop_error'] = str(stop_error)
    finally:
        if writer:
            try:writer.close();outcome['rows'] = writer.rows
            except RuntimeError as error:outcome['log_error'] = str(error)
        try:
            for _ in range(6):service.step_once()
        except Exception as error:outcome['settle_error'] = str(error)
        try:world.close()
        except RuntimeError as error:outcome['cleanup_error'] = str(error)
        outcome['wall_s'] = round(time.monotonic()-began_wall, 2)
        outcome['control_source_sha256'] = getattr(args, 'source_hashes', None)
        (directory/'outcome.json').write_text(json.dumps(outcome, indent=1, default=str), encoding='utf8')
    return outcome


def worker(args):
    import carla
    from backend.carla.provider import CarlaProvider
    from backend.carla.runtime import NativeRuntime
    from backend.computer_vision.service import ControlPerceptionCache, PerceptionService
    from backend.core.journey_comparison import JourneyComparison
    from backend.core.pedestrian_behaviors import load_suite
    from backend.core.service import SimulationService
    from backend.graphics import launch
    from backend.server import DashboardHTTPServer, Handler
    suite = load_suite();folder = Path(args.out);specs = [s for s in plan_episodes(args, suite) if s['location']['town'] == args.town]
    args.source_hashes = source_hashes()
    configurations = args.configurations.split(',')
    runtime = NativeRuntime()
    if not runtime.active:runtime.launch({**launch(args.render_profile), 'offscreen': True}, '127.0.0.1', 2000, carla)
    provider = service = http = perception = None;stop = threading.Event();results = []
    try:
        provider = CarlaProvider(map_name=args.town, blueprint='vehicle.mercedes.coupe_2020',
            spawn_index=specs[0]['location']['spawn_index'] if specs else 0, sensor_suite=True, collision_sensor=True,
            fresh_start=True, traffic_manager_port=8052)
        provider.camera_settings['_comparison_rig'] = True
        provider.connect();provider._ensure_dashboard_tools()
        service = SimulationService(provider, required_sensors=provider.required_sensors)
        service.journey_comparison = JourneyComparison(folder/'comparisons')
        service.pause_on_first_observation = True;service.start(threaded=False)
        def heartbeat():
            while not stop.wait(.1):service.navigation_transport_heartbeat(service.session_id)
        threading.Thread(target=heartbeat, daemon=True).start()
        http = DashboardHTTPServer(('127.0.0.1', args.http_port), Handler);http.simulation_service = service
        perception = PerceptionService(args.http_port);http.perception = perception
        service.control_perception = ControlPerceptionCache()
        threading.Thread(target=http.serve_forever, daemon=True).start()
        for _ in range(40):service.step_once()
        for spec in specs:
            for configuration in configurations:
                directory = folder/spec['split']/configuration/spec['scenario_id'][:16]
                if (directory/'outcome.json').exists():continue
                if (directory/'manifest.json').exists():
                    # A previous worker died natively inside this episode. Record
                    # it as a failed experiment; never retry it silently.
                    (directory/'outcome.json').write_text(json.dumps({'scenario_id': spec['scenario_id'], 'configuration': configuration,
                        'behavior': spec['behavior'], 'split': spec['split'], 'location': spec['location'],
                        'outcome': 'NATIVE_CRASH_DURING_EPISODE', 'source_sha256': args.source_hashes}, indent=1), encoding='utf8')
                    results.append({'scenario_id': spec['scenario_id'], 'configuration': configuration, 'outcome': 'NATIVE_CRASH_DURING_EPISODE'})
                    continue
                result = run_episode(service, provider, spec, configuration, folder, args)
                results.append({k: result.get(k) for k in ('scenario_id', 'configuration', 'behavior', 'outcome', 'simulated_s',
                                                          'distance_m', 'wall_s', 'error')})
                print(json.dumps(results[-1]), flush=True)
    except BaseException as error:
        results.append({'worker_error': str(error), 'traceback': traceback.format_exc()});print(json.dumps(results[-1]), flush=True)
    finally:
        stop.set()
        if http:http.shutdown();http.server_close()
        if perception:perception.close()
        if service:
            try:service.close()
            except BaseException as error:results.append({'close_error': str(error)})
        (folder/f'worker-{args.split}-{args.town}-{uuid.uuid4().hex[:8]}.json').write_text(json.dumps(results, indent=1), encoding='utf8')
    return 0 if not any('worker_error' in r for r in results) else 1


def prepare_engine(render_profile):
    """Before each worker: a live engine in asynchronous mode without stale project actors."""
    probe = ('import carla,json; c=carla.Client("127.0.0.1",2000);c.set_timeout(15);w=c.get_world();s=w.get_settings()\n'
             'if s.synchronous_mode:\n s.synchronous_mode=False;s.fixed_delta_seconds=None;w.apply_settings(s)\n'
             'stale=[a.id for a in w.get_actors() if a.attributes.get("role_name","").startswith("ostorha_") or a.type_id=="controller.ai.walker"]\n'
             'c.apply_batch_sync([carla.command.DestroyActor(i) for i in stale],False)\n'
             'print("ENGINE_READY "+json.dumps({"stale_destroyed":len(stale)}))')
    for attempt in range(3):
        try:
            result = subprocess.run([sys.executable, '-c', probe], capture_output=True, text=True, timeout=60, cwd=ROOT)
            if 'ENGINE_READY' in result.stdout:return True
        except subprocess.TimeoutExpired:pass
        import carla
        from backend.carla.runtime import NativeRuntime
        from backend.graphics import launch
        runtime = NativeRuntime()
        try:runtime.stop()
        except RuntimeError:pass
        time.sleep(10.+10.*attempt)
        try:runtime.launch({**launch(render_profile), 'offscreen': True}, '127.0.0.1', 2000, carla)
        except RuntimeError as error:print(json.dumps({'engine_launch_error': str(error), 'attempt': attempt}), flush=True)
    try:
        if 'ENGINE_READY' in subprocess.run([sys.executable, '-c', probe], capture_output=True, text=True, timeout=60, cwd=ROOT).stdout:return True
    except subprocess.TimeoutExpired:pass
    raise RuntimeError('CARLA engine could not be prepared for the next worker')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--split', choices=('TRAIN', 'VALIDATION', 'TEST'), required=True)
    parser.add_argument('--indices', default='')
    parser.add_argument('--counterfactual', default='')
    parser.add_argument('--ordinary', default='')
    parser.add_argument('--behaviors', default='')
    parser.add_argument('--configurations', default='B_PHYSICAL_PREDICTIVE')
    parser.add_argument('--experimental-risk', action='store_true')
    parser.add_argument('--out', default=None)
    parser.add_argument('--render-profile', default='LOW')
    parser.add_argument('--episode-wall-s', type=float, default=420.)
    parser.add_argument('--http-port', type=int, default=8013)
    parser.add_argument('--worker', action='store_true')
    parser.add_argument('--town', default=None)
    parser.add_argument('--stop-carla', action='store_true')
    parser.add_argument('--end-after-passing', action='store_true')
    args = parser.parse_args()
    if args.worker:return worker(args)
    from backend.core.pedestrian_behaviors import load_suite
    suite = load_suite();specs = plan_episodes(args, suite)
    folder = Path(args.out) if args.out else DEFAULT_OUT/('run-'+time.strftime('%Y%m%d-%H%M%S'))
    folder.mkdir(parents=True, exist_ok=True)
    towns = sorted({s['location']['town'] for s in specs})
    (folder/f'plan-{args.split}-{uuid.uuid4().hex[:8]}.json').write_text(json.dumps({'source': 'LIVE_NATIVE_CARLA', 'args': vars(args),
        'episodes': [{'scenario_id': s['scenario_id'], 'behavior': s['behavior'], 'location': s['location'],
                      'counterfactual': s['counterfactual']} for s in specs], 'source_sha256': source_hashes()}, indent=1), encoding='utf8')
    print(json.dumps({'folder': str(folder), 'episodes': len(specs), 'towns': towns}), flush=True)
    code = 0
    configurations = args.configurations.split(',')
    for town in towns:
        town_specs = [s for s in specs if s['location']['town'] == town]
        for attempt in range(4):
            remaining = [1 for s in town_specs for c in configurations
                         if not (folder/s['split']/c/s['scenario_id'][:16]/'outcome.json').exists()]
            if not remaining:break
            prepare_engine(args.render_profile)
            command = [sys.executable, '-m', 'scripts.native.run_pedestrian_suite', '--worker', '--town', town, '--split', args.split,
                       '--indices', args.indices, '--counterfactual', args.counterfactual, '--ordinary', args.ordinary,
                       '--behaviors', args.behaviors,
                       '--configurations', args.configurations, '--out', str(folder), '--render-profile', args.render_profile,
                       '--episode-wall-s', str(args.episode_wall_s), '--http-port', str(args.http_port)]
            if args.experimental_risk:command.append('--experimental-risk')
            if args.end_after_passing:command.append('--end-after-passing')
            with (folder/f'worker-{args.split}-{town}.log').open('a', encoding='utf8') as log:
                returncode = subprocess.run(command, cwd=ROOT, stdout=log, stderr=subprocess.STDOUT).returncode
            print(json.dumps({'town': town, 'attempt': attempt, 'returncode': returncode, 'remaining_before': len(remaining)}), flush=True)
            if returncode == 0:break
        remaining = [1 for s in town_specs for c in configurations
                     if not (folder/s['split']/c/s['scenario_id'][:16]/'outcome.json').exists()]
        code |= int(bool(remaining))
    if args.stop_carla:
        from backend.carla.runtime import NativeRuntime
        NativeRuntime().stop()
    return code


if __name__ == '__main__':sys.exit(main())
