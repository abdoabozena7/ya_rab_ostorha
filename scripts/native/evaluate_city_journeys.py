"""Existing destination journeys and recording A/B probe through the native owner.

No new policy, sensor suite, graphics preset or tick owner. Journey metrics come
from native recordings; traffic/performance observations are sparsely sampled.
"""
import argparse
import json
import math
from pathlib import Path
import statistics
import time

from backend.core.replay import ReplayReader
from .evaluate_drive_experience import ObservationSession, traffic_sample, summarize_samples, write
from .stability_run import backend_pid, memory


def sample(session, tracking):
    state=session.state
    return {'frame':state['vehicle']['frame'],'timestamp_s':state['vehicle']['timestamp'],
            'actual':state['population']['actual'],'local':state['population'].get('local_counts',{}),
            'performance':state['performance'],'backend_step_ms':state['backendStepMs'],
            'frame_complete':state['frameComplete'],'sensor_errors':state['sensorErrors'],
            'traffic':traffic_sample(session,tracking),'journey':state['journey'],
            'route':state['route'],'safety':state['safetySystem'],'speed_kmh':state['vehicle']['speedKmh']}


def tracker(session):
    return {'map':session.world.get_map(),'positions':{},'distance':{},'vehicles':set(),'walkers':set(),
            'stopped':set(),'resumed':set(),'lanes':{},'lane_changes':[]}


def journey(session, destination, seed, speed, duration, folder, baseline):
    session.send('stop_driving')
    session.wait(lambda s:s['vehicle']['speedMagnitudeMps']<.15)
    session.action('population','reset')
    session.wait(lambda s:s['vehicle']['speedMagnitudeMps']<.15)
    session.action('settings',{'spawn_index':152})
    session.wait(lambda s:s['vehicle']['speedMagnitudeMps']<.15)
    config={**baseline,'seed':seed}
    if speed==12:config['speed_behavior']='SLOW'
    session.action('settings',{'population':config})
    target=session.world.get_map().get_spawn_points()[destination].location
    route=session.action('destination',{'location':[target.x,target.y,target.z],
                                       'name':f'Evaluation destination {destination}'})
    recording=session.action('recording',{'enabled':True})['path']
    initial_count=session.state['safetySystem']['intervention_count']
    session.send('start_journey',speed_kmh=speed)
    session.wait(lambda s:s['journey']['status'] in ('RUNNING','ERROR'))
    started=session.state['vehicle']['timestamp'];began=time.monotonic();last=-1e9
    observations=[];tracking=tracker(session);arrival=False;stop_reason='TIME_LIMIT';announced=-1
    with (folder/f'journey-{seed}-samples.jsonl').open('w',encoding='utf8') as log:
        while time.monotonic()-began<420:
            session.send('journey_heartbeat',session_id=session.state['sessionId'])
            state=session.state;elapsed=state['vehicle']['timestamp']-started
            arrival |= state['journey']['status']=='ARRIVED'
            if int(elapsed)//20>announced:
                announced=int(elapsed)//20
                print(json.dumps({'journey_seed':seed,'elapsed_s':elapsed,'state':state['journey'],
                                  'remaining_m':(state['route'] or {}).get('remaining_m'),
                                  'actual':state['population']['actual']}),flush=True)
            if state['vehicle']['timestamp']-last>=1.:
                last=state['vehicle']['timestamp'];row=sample(session,tracking);observations.append(row)
                log.write(json.dumps(row)+'\n');log.flush()
            if state['journey']['status'] not in ('RUNNING','STARTING'):
                stop_reason=state['journey'].get('reason') or state['journey']['status'];break
            if elapsed>=duration:break
        else:stop_reason='WALL_TIME_LIMIT'
    final_journey=dict(session.state['journey']);final_route=session.state['route']
    ended=session.state['vehicle']['timestamp']
    count=session.state['safetySystem']['intervention_count']-initial_count
    session.send('stop_driving')
    session.action('recording',{'enabled':False})
    # Native frame timestamps define the autonomous interval, excluding setup.
    distance=0.;previous=None;last_time=started;contacts=[];seen=set();gaps=[]
    for frame in ReplayReader(recording).frames():
        if frame.timestamp_s<started or frame.timestamp_s>ended:continue
        if previous:
            distance+=math.dist(previous.vehicle.transform.position_m,frame.vehicle.transform.position_m)
            gaps.append(frame.frame_id-previous.frame_id)
        previous=frame;last_time=frame.timestamp_s
        for collision in frame.collisions:
            key=(collision.frame_id,collision.other_actor_id)
            if key not in seen:
                seen.add(key);contacts.append({'frame':collision.frame_id,'timestamp':collision.timestamp_s,
                                               'other_actor_id':collision.other_actor_id,'impulse_ns':list(collision.impulse_ns)})
    # Event callbacks may arrive after their synchronous anchor frame.
    with (Path(recording)/'events/events.jsonl').open(encoding='utf8') as events:
        for line in events:
            event=json.loads(line)
            if event.get('event_type')!='CollisionDetected':continue
            collision=event.get('payload',{}).get('collision')
            if not collision or not started<=collision['timestamp_s']<=ended:continue
            key=(collision['frame_id'],collision['other_actor_id'])
            if key in seen:continue
            seen.add(key);contacts.append({'frame':collision['frame_id'],'timestamp':collision['timestamp_s'],
                                           'other_actor_id':collision['other_actor_id'],'impulse_ns':collision['impulse_ns']})
    episodes=0;last_contact={}
    for c in sorted(contacts,key=lambda x:x['timestamp']):
        actor=c['other_actor_id']
        if c['timestamp']-last_contact.get(actor,-float('inf'))>1.:episodes+=1
        last_contact[actor]=c['timestamp']
    elapsed=last_time-started
    row={'kind':'ORDINARY_DESTINATION_JOURNEY','seed':seed,'start_spawn':152,'destination_spawn':destination,
         'target_speed_kmh':speed,'recording':recording,'route_length_m':route['length_m'],
         'route_instructions':route['instructions'],'collision_count':episodes,'collision_callbacks':len(contacts),
         'destination_reached':arrival,'distance_m':distance,'average_speed_kmh':distance/elapsed*3.6 if elapsed>0 else None,
         'interventions':count,'duration_simulation_s':elapsed,'duration_wall_s':time.monotonic()-began,
         'stop_reason':stop_reason,'final_journey':final_journey,'final_route':final_route,'contacts':contacts,
         'max_recorded_frame_gap':max(gaps,default=0),'performance_and_behavior':summarize_samples(observations,tracking)}
    write(folder/f'journey-{seed}-summary.json',row)
    print(json.dumps({'finished_journey':{k:row[k] for k in ('seed','collision_count','destination_reached','distance_m','average_speed_kmh','interventions','stop_reason')}}),flush=True)
    return row


def recording_probe(session, folder):
    from backend.carla.runtime import native_processes
    backend=backend_pid(8000)
    engine=next(p for p in native_processes() if 'Shipping' in p['ExecutablePath'])['ProcessId']
    result={'scope':'Held ego, same live native city, 7 sensors; OFF / ON / OFF, 30 wall seconds each. Native traffic continues. Temporal population changes are reported. Not a matched seeded driving comparison.',
            'phases':[]}
    for name,enabled in [('OFF_1',False),('ON',True),('OFF_2',False)]:
        if enabled:recording=session.action('recording',{'enabled':True})['path']
        elif session.state['recording']:session.action('recording',{'enabled':False})
        began=time.monotonic();rows=[];last=-1e9;first_cpu={p:memory(pid) for p,pid in [('backend',backend),('carla',engine)]}
        first_frame=session.state['vehicle']['frame'];first_ts=session.state['vehicle']['timestamp']
        with (folder/f'profile-{name}.jsonl').open('w',encoding='utf8') as log:
            while time.monotonic()-began<30:
                session.wait(lambda s:True)
                if time.monotonic()-last<1:continue
                last=time.monotonic();state=session.state
                row={'performance':state['performance'],'backend_step_ms':state['backendStepMs'],
                     'actual':state['population']['actual'],'backend':memory(backend),'carla':memory(engine),
                     'frame':state['vehicle']['frame'],'timestamp_s':state['vehicle']['timestamp']}
                rows.append(row);log.write(json.dumps(row)+'\n');log.flush()
        wall=time.monotonic()-began;warm=rows[5:]
        phase={'name':name,'recording_enabled':enabled,'duration_wall_s':wall,
               'native_frames_per_wall_second':(session.state['vehicle']['frame']-first_frame)/wall,
               'simulation_seconds_per_wall_second':(session.state['vehicle']['timestamp']-first_ts)/wall,
               'tick_hz_median':statistics.median(r['performance']['nativeTickRateHz'] for r in warm),
               'backend_step_ms_median':statistics.median(r['backend_step_ms'] for r in warm),
               'pipeline_latency_ms_median':statistics.median(r['performance']['observationPipelineLatencyMs']['median'] for r in warm),
               'sensor_wall_rates_hz':{k:statistics.median(r['performance']['sensorWallRatesHz'][k] for r in warm) for k in ('frontCamera','depth','lidar','radar','imu','gnss')},
               'process_cpu_core_equivalents':{p:(rows[-1][p]['cpu_seconds']-first_cpu[p]['cpu_seconds'])/wall for p in first_cpu},
               'population_ranges':{k:[min(r['actual'][k] for r in rows),max(r['actual'][k] for r in rows)] for k in ('vehicles','pedestrians')},
               'vram_used_mib_range':[min(r['performance']['gpu']['usedMiB'] for r in warm),max(r['performance']['gpu']['usedMiB'] for r in warm)]}
        if enabled:
            session.action('recording',{'enabled':False});phase['recording']=recording
        result['phases'].append(phase);write(folder/'recording-profile.json',result)
        print(json.dumps({'profile':phase}),flush=True)
    return result


def npc_contacts_probe(session, folder):
    import carla
    session.send('stop_driving')
    contacts=[];sensors=[];population=[]
    ids=list(session.state['population']['vehicle_ids'])
    blueprint=session.world.get_blueprint_library().find('sensor.other.collision')
    try:
        for actor_id in ids:
            actor=session.world.get_actor(actor_id)
            if actor is None:continue
            sensor=session.world.spawn_actor(blueprint,carla.Transform(),attach_to=actor)
            sensor.listen(lambda event,actor_id=actor_id:contacts.append({
                'frame':event.frame,'timestamp_s':event.timestamp,'actor_id':actor_id,
                'other_actor_id':event.other_actor.id,'other_actor_type':event.other_actor.type_id,
                'impulse_ns':math.hypot(event.normal_impulse.x,event.normal_impulse.y,event.normal_impulse.z)}))
            sensors.append(sensor);session.probe_sensors.append(sensor)
        began=time.monotonic();started=session.state['vehicle']['timestamp'];last=-1e9
        while time.monotonic()-began<45:
            session.wait(lambda s:True)
            if time.monotonic()-last>=1:
                last=time.monotonic();population.append(session.state['population']['actual'])
        episodes=0;last_contact={};pairs={}
        for contact in sorted(contacts,key=lambda c:c['timestamp_s']):
            pair=tuple(sorted((contact['actor_id'],contact['other_actor_id'])))
            if contact['timestamp_s']-last_contact.get(pair,-float('inf'))>1:episodes+=1
            last_contact[pair]=contact['timestamp_s'];pairs[pair]=contact['other_actor_type']
        result={'scope':'45 wall seconds of the existing live city with held ego; temporary native collision sensors on currently admitted NPC vehicles. Newly recycled NPCs are not instrumented. Not an autonomous ego test or performance benchmark.',
                'duration_wall_s':time.monotonic()-began,'duration_simulation_s':session.state['vehicle']['timestamp']-started,
                'instrumented_vehicle_ids':ids,'probe_sensor_count':len(sensors),'raw_callbacks':len(contacts),
                'pair_contact_episodes':episodes,'unique_contact_pairs':len(pairs),
                'maximum_impulse_ns':max((c['impulse_ns'] for c in contacts),default=0.),
                'contacts':contacts,'population_ranges':{k:[min(r[k] for r in population),max(r[k] for r in population)] for k in ('vehicles','pedestrians')}}
    finally:
        cleanup=[]
        for sensor in sensors:
            try:
                if sensor.is_alive:sensor.stop();sensor.destroy()
                session.probe_sensors.remove(sensor)
            except RuntimeError as error:cleanup.append(str(error))
    result['cleanup_errors']=cleanup
    frame=session.state['vehicle']['frame']
    session.wait(lambda s:s['vehicle']['frame']>frame+2)
    result['inventory_after_cleanup']=session.inventory()
    write(folder/'npc-contact-probe.json',result)
    print(json.dumps({k:result[k] for k in ('probe_sensor_count','raw_callbacks','pair_contact_episodes','unique_contact_pairs','maximum_impulse_ns','cleanup_errors')}),flush=True)
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',default='output/native-validation/drive-experience-20261009')
    args=parser.parse_args();folder=Path(args.output);folder.mkdir(parents=True,exist_ok=True)
    preferences=Path('config/dashboard-preferences.json');saved_bytes=preferences.read_bytes()
    baseline=json.loads(saved_bytes)['population'];proof={'runs':[],'source':'LIVE_NATIVE_CARLA','controller':'BasicAgent + RULE'}
    with ObservationSession() as session:
        try:
            session.send('comparison',value={'mode':'STOP','seed':2589,'scenario':'URBAN_CHAOS'})
            session.wait(lambda s:s['comparisonDemo']['phase']=='IDLE',timeout=75)
            for destination,seed,speed in [(121,2621,20),(102,2622,12)]:
                proof['runs'].append(journey(session,destination,seed,speed,90,folder,baseline))
                write(folder/'journey-evaluation.json',proof)
            proof['recording_profile']=recording_probe(session,folder)
            proof['npc_contact_probe']=npc_contacts_probe(session,folder)
        except Exception as error:
            proof['error']=str(error);raise
        finally:
            session.send('stop_driving')
            session.wait(lambda s:s['vehicle']['speedMagnitudeMps']<.15)
            if session.state['recording']:session.action('recording',{'enabled':False})
            session.action('population','reset')
            session.action('settings',{'spawn_index':152,'population':baseline})
            session.action('clear_route')
            session.send('stop_driving')
            preferences.write_bytes(saved_bytes)
            proof['cleanup']={'mode':session.state['mode'],'recording':session.state['recording'],
                              'population':session.state['population']['actual'],'safety':session.state['safetySystem'],
                              'inventory':session.inventory(),'preferences_restored':preferences.read_bytes()==saved_bytes}
            write(folder/'journey-evaluation.json',proof)


if __name__=='__main__':main()
