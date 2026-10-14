"""Observe existing native Urban Chaos runs; never tick or change driving policy.

Seed variants exercise the same route/hazard recipe, not different scenario
families. Native recordings supply outcomes; sparse observer samples supply
performance and traffic behavior. Completion of the timed test is not arrival.
"""
import argparse
import json
import math
from pathlib import Path
import shutil
import statistics
import time

from .verify_urban_world import Session


class ObservationSession(Session):
    def wait(self, predicate, timeout=75):
        # The existing demo may hold publication while closing its bounded disk
        # writer. Keep the observer alive through that managed, stopped flush.
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            try:message=json.loads(self.socket.recv(timeout=min(5,deadline-time.monotonic())))
            except TimeoutError:continue
            if message['type']=='error':raise RuntimeError(message['error'])
            if message['type']!='snapshot':continue
            self.state=message
            if message.get('error'):raise RuntimeError(message['error'])
            if predicate(message):return message
        raise TimeoutError('Native observation condition timed out after managed-flush allowance')


def write(path, value):
    path.write_text(json.dumps(value, indent=2), encoding='utf8')


def traffic_sample(session, tracking):
    snapshot = session.world.get_snapshot()
    population = session.state['population']
    vehicle_ids = set(population['vehicle_ids'])
    walkers = set(population['walker_ids'])
    moving = stopped = 0
    for actor_id in vehicle_ids | walkers:
        actor = snapshot.find(actor_id)
        if actor is None:
            continue
        transform = actor.get_transform()
        location = transform.location
        position = (location.x, location.y, location.z)
        previous = tracking['positions'].get(actor_id)
        if previous:
            tracking['distance'][actor_id] = tracking['distance'].get(actor_id, 0.) + math.dist(previous, position)
        tracking['positions'][actor_id] = position
        if actor_id not in vehicle_ids:
            tracking['walkers'].add(actor_id)
            continue
        tracking['vehicles'].add(actor_id)
        velocity = actor.get_velocity()
        speed = math.hypot(velocity.x, velocity.y)
        moving += speed > 1.
        stopped += speed < .15
        if speed < .15:
            tracking['stopped'].add(actor_id)
        elif speed > 1. and actor_id in tracking['stopped']:
            tracking['resumed'].add(actor_id)
        waypoint = tracking['map'].get_waypoint(location)
        if not waypoint:
            continue
        lane = (waypoint.road_id, waypoint.lane_id, waypoint.is_junction)
        previous_lane = tracking['lanes'].get(actor_id)
        if previous_lane and not lane[2] and not previous_lane[2] and lane[0] == previous_lane[0] and lane[1] != previous_lane[1]:
            tracking['lane_changes'].append({'actor_id':actor_id, 'time_s':session.state['vehicle']['timestamp'],
                                            'from':previous_lane[:2], 'to':lane[:2]})
        tracking['lanes'][actor_id] = lane
    return {'moving_vehicles':moving, 'stopped_vehicles':stopped}


def summarize_samples(samples, tracking):
    warm = samples[len(samples)//4:] or samples
    def median(values):
        return statistics.median(values) if values else None
    return {
        'sample_count':len(samples),
        'native_tick_hz_median':median([r['performance']['nativeTickRateHz'] for r in warm]),
        'backend_step_ms_median':median([r['backend_step_ms'] for r in warm if r['backend_step_ms'] is not None]),
        'pipeline_latency_ms_median':median([r['performance']['observationPipelineLatencyMs']['median'] for r in warm]),
        'vram_used_mib_range':[min(r['performance']['gpu']['usedMiB'] for r in warm), max(r['performance']['gpu']['usedMiB'] for r in warm)],
        'population_ranges':{k:[min(r['actual'][k] for r in samples),max(r['actual'][k] for r in samples)]
                             for k in ('vehicles','pedestrians','controllers')},
        'local_population_ranges':{k:[min(r['local'].get(k,0) for r in samples),max(r['local'].get(k,0) for r in samples)]
                                  for k in ('vehicles_120m','walkers_120m')},
        'moved_vehicles':sum(tracking['distance'].get(i,0)>2 for i in tracking['vehicles']),
        'moved_walkers':sum(tracking['distance'].get(i,0)>2 for i in tracking['walkers']),
        'stopped_then_moved_vehicles':len(tracking['resumed']),
        'observed_same_road_nonjunction_lane_changes':tracking['lane_changes'],
        'stopped_vehicle_count_range':[min(r['traffic']['stopped_vehicles'] for r in samples),max(r['traffic']['stopped_vehicles'] for r in samples)],
        'sensor_errors':sorted({e for r in samples for e in r['sensor_errors']}),
        'incomplete_observer_samples':sum(not r['frame_complete'] for r in samples),
        'render_fps':None,
    }


def run_urban(session, seed, folder):
    began = time.monotonic()
    session.send('comparison', value={'mode':'WITH','seed':seed,'scenario':'URBAN_CHAOS'})
    session.wait(lambda s:s['comparisonDemo']['seed']==seed and s['comparisonDemo']['phase'] in ('RESETTING','RUNNING','ERROR'))
    tracking = {'map':session.world.get_map(),'positions':{},'distance':{},'vehicles':set(),'walkers':set(),
                'stopped':set(),'resumed':set(),'lanes':{},'lane_changes':[]}
    samples = []
    arrival = False
    sampled = -1e9
    announced = -1
    with (folder/f'urban-{seed}-samples.jsonl').open('w',encoding='utf8') as log:
        while time.monotonic()-began < 420:
            session.send('journey_heartbeat',session_id=session.state['sessionId'])
            state = session.state
            demo = state['comparisonDemo']
            if demo['phase']=='ERROR':
                raise RuntimeError(demo['error'])
            arrival |= state['journey']['status']=='ARRIVED' or bool((state.get('route') or {}).get('arrived'))
            if demo['phase']=='FINISHED':
                full = json.loads((Path(demo['recording'])/'comparison-result.json').read_text(encoding='utf8'))
                metrics = full['outcome']['metrics']
                row = {'kind':'URBAN_CHAOS_SEED_VARIANT','seed':seed,'recording':demo['recording'],
                       'test_interval_completed':full['completed'],'stop_reason':full['outcome']['reason'],
                       'collision_count':metrics['collision_count'],'destination_reached':arrival,
                       'distance_m':metrics['distance_traveled_m'],
                       'average_speed_kmh':metrics['average_speed_mps']*3.6,
                       'interventions':full['final_safety']['intervention_count'],
                       'duration_simulation_s':metrics['elapsed_simulation_s'],
                       'duration_wall_s':time.monotonic()-began,
                       'progress_m':metrics['progress_m'],'route_completion':metrics['route_completion'],
                       'minimum_clearance_m':metrics['minimum_clearance_m'],
                       'collision_callback_count':metrics['collision_callback_count'],
                       'status':full['status'],'hazard_observations':full['run'].get('hazard_observations',{}),
                       'performance_and_behavior':summarize_samples(samples,tracking),
                       'final_journey':state['journey']}
                write(folder/f'urban-{seed}-summary.json',row)
                print(json.dumps({'finished':{k:row[k] for k in ('seed','collision_count','destination_reached','distance_m','average_speed_kmh','interventions','duration_wall_s')},
                                  'performance':row['performance_and_behavior']['native_tick_hz_median'],
                                  'population':row['performance_and_behavior']['population_ranges']}),flush=True)
                return row
            if demo['phase']!='RUNNING':
                continue
            timestamp = state['vehicle']['timestamp']
            elapsed = demo['metrics'].get('elapsed_simulation_s',0)
            if int(elapsed)//15 > announced:
                announced = int(elapsed)//15
                print(json.dumps({'running_seed':seed,'elapsed_simulation_s':elapsed,
                                  'collisions':demo['metrics'].get('collision_count'),
                                  'progress_m':demo['metrics'].get('progress_m'),
                                  'actual_population':state['population']['actual']}),flush=True)
            if timestamp-sampled < 1.:
                continue
            sampled = timestamp
            row = {'frame':state['vehicle']['frame'],'timestamp_s':timestamp,'elapsed_s':elapsed,
                   'position':state['vehicle']['positionWorldM'],'speed_kmh':state['vehicle']['speedKmh'],
                   'journey':state['journey'],'route':state['route'],'safety':state['safetySystem'],
                   'actual':state['population']['actual'],'local':state['population'].get('local_counts',{}),
                   'performance':state['performance'],'backend_step_ms':state['backendStepMs'],
                   'frame_complete':state['frameComplete'],'sensor_errors':state['sensorErrors'],
                   'traffic':traffic_sample(session,tracking)}
            samples.append(row)
            log.write(json.dumps(row)+'\n');log.flush()
    raise TimeoutError('Existing native comparison exceeded 420 wall seconds')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--seeds',default='2601,2602,2603,2604,2605,2606,2607,2608,2609,2610')
    parser.add_argument('--output',default='output/native-validation/drive-experience-20261009')
    args = parser.parse_args()
    folder = Path(args.output);folder.mkdir(parents=True,exist_ok=True)
    archive = folder/'prior-presentation-summary';archive.mkdir(exist_ok=True)
    for source in Path('output/presentation-demo').glob('*.json'):
        if not (archive/source.name).exists():shutil.copy2(source,archive/source.name)
    proof = {'source':'LIVE_NATIVE_CARLA','controller':'BasicAgent + RULE','runs':[],
             'scope':'Ten seeds of the existing 60s Urban Chaos recipe on one fixed route, with native recording enabled. Not ten scenario families or a real-road safety rate.'}
    previous_path=folder/'evaluation.json'
    if previous_path.exists():
        previous=json.loads(previous_path.read_text(encoding='utf8'))
        if previous.get('error'):
            write(folder/'initial-admission-failure.json',previous)
        proof['prior_attempt_error']=previous.get('error')
        proof['runs']=previous.get('runs',[])
    completed_seeds={r['seed'] for r in proof['runs']}
    with ObservationSession() as session:
        proof['versions']=[session.client.get_server_version(),session.client.get_client_version()]
        proof['map']=session.world.get_map().name
        proof['before']={'population':session.state['population'],'performance':session.state['performance'],
                         'journey':session.state['journey'],'sensor_registry':session.state['sensorRegistry']}
        write(folder/'evaluation.json',proof)
        try:
            for seed in map(int,args.seeds.split(',')):
                if seed in completed_seeds:continue
                try:
                    proof['runs'].append(run_urban(session,seed,folder))
                except RuntimeError as error:
                    demo=session.state['comparisonDemo']
                    if demo['phase']!='ERROR':raise
                    row={'kind':'URBAN_CHAOS_SEED_VARIANT','seed':seed,'status':'ADMISSION_FAILED',
                         'error':str(error),'collision_count':None,'destination_reached':None,
                         'distance_m':None,'average_speed_kmh':None,'interventions':None}
                    proof['runs'].append(row)
                    write(folder/f'urban-{seed}-summary.json',row)
                    print(json.dumps(row),flush=True)
                    session.send('comparison',value={'mode':'STOP','seed':2589,'scenario':'URBAN_CHAOS'})
                    session.wait(lambda s:s['comparisonDemo']['phase']=='IDLE',timeout=75)
                write(folder/'evaluation.json',proof)
        except Exception as error:
            proof['error']=str(error)
            write(folder/'evaluation.json',proof)
            raise
        finally:
            # Return through the existing demo reset: native city, held ego, RULE.
            session.send('comparison',value={'mode':'STOP','seed':2589,'scenario':'URBAN_CHAOS'})
            session.wait(lambda s:s['comparisonDemo']['phase']=='IDLE',timeout=75)
            session.send('stop_driving')
            proof['cleanup']={'mode':session.state['mode'],'journey':session.state['journey'],
                              'recording':session.state['recording'],'inventory':session.inventory(),
                              'safety':session.state['safetySystem'],'population':session.state['population']['actual']}
            write(folder/'evaluation.json',proof)


if __name__=='__main__':main()
