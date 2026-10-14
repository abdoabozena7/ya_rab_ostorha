"""Repeat the same existing destination journeys with full recording disabled.

Native snapshots supply a lightweight observer log. Distance is the observed
position polyline (snapshot gaps reported), not an invented complete recording.
"""
import argparse
import json
import math
from pathlib import Path
import time

from .evaluate_drive_experience import ObservationSession, summarize_samples, write
from .evaluate_city_journeys import sample, tracker


def run(session, seed, destination, speed, baseline, folder):
    session.send('stop_driving');session.wait(lambda s:s['vehicle']['speedMagnitudeMps']<.15)
    session.action('population','reset')
    session.action('settings',{'spawn_index':152})
    session.wait(lambda s:s['vehicle']['speedMagnitudeMps']<.15)
    config={**baseline,'seed':seed}
    if speed==12:config['speed_behavior']='SLOW'
    session.action('settings',{'population':config})
    target=session.world.get_map().get_spawn_points()[destination].location
    route=session.action('destination',{'location':[target.x,target.y,target.z],'name':f'Evaluation destination {destination}'})
    initial=session.state['safetySystem']['intervention_count']
    session.send('start_journey',speed_kmh=speed)
    session.wait(lambda s:s['journey']['status'] in ('RUNNING','ERROR'))
    started=session.state['vehicle']['timestamp'];began=time.monotonic()
    observations=[];trajectory=[];tracking=tracker(session);contacts={};last=-1e9;announced=-1
    stop='TIME_LIMIT';arrival=False
    with (folder/f'journey-unrecorded-{seed}-telemetry.jsonl').open('w',encoding='utf8') as log:
        while time.monotonic()-began<300:
            session.send('journey_heartbeat',session_id=session.state['sessionId'])
            state=session.state;vehicle=state['vehicle'];elapsed=vehicle['timestamp']-started
            arrival |= state['journey']['status']=='ARRIVED'
            if not trajectory or vehicle['frame']>trajectory[-1]['frame']:
                point={'frame':vehicle['frame'],'timestamp_s':vehicle['timestamp'],'position':vehicle['positionWorldM'],
                       'speed_kmh':vehicle['speedKmh'],'journey':state['journey'],'safety':state['safetySystem'],
                       'frame_complete':state['frameComplete']}
                trajectory.append(point);log.write(json.dumps(point)+'\n');log.flush()
            for c in state['collisionEvents']:
                if c['ego_actor_id']==vehicle['actorId'] and c['timestamp_s']>=started:
                    contacts[(c['frame_id'],c['other_actor_id'])]=c
            if vehicle['timestamp']-last>=1:
                last=vehicle['timestamp'];observations.append(sample(session,tracking))
            if int(elapsed)//20>announced:
                announced=int(elapsed)//20
                print(json.dumps({'unrecorded_seed':seed,'elapsed_s':elapsed,'journey':state['journey'],
                                  'remaining_m':state['route']['remaining_m'],'speed_kmh':vehicle['speedKmh'],
                                  'actual':state['population']['actual']}),flush=True)
            if state['journey']['status'] not in ('RUNNING','STARTING'):
                stop=state['journey'].get('reason') or state['journey']['status'];break
            if elapsed>=90:break
        else:stop='WALL_TIME_LIMIT'
    ended=session.state['vehicle']['timestamp'];final_journey=session.state['journey'];final_route=session.state['route']
    interventions=session.state['safetySystem']['intervention_count']-initial
    session.send('stop_driving');session.wait(lambda s:s['vehicle']['speedMagnitudeMps']<.15)
    distance=sum(math.dist(a['position'],b['position']) for a,b in zip(trajectory,trajectory[1:]))
    elapsed=ended-started;episodes=0;last_contact={}
    for c in sorted(contacts.values(),key=lambda c:c['timestamp_s']):
        actor=c['other_actor_id']
        if c['timestamp_s']-last_contact.get(actor,-float('inf'))>1:episodes+=1
        last_contact[actor]=c['timestamp_s']
    row={'kind':'UNRECORDED_DESTINATION_JOURNEY','seed':seed,'start_spawn':152,'destination_spawn':destination,
         'target_speed_kmh':speed,'recording':None,'route_length_m':route['length_m'],'route_instructions':route['instructions'],
         'collision_count':episodes,'collision_callbacks':len(contacts),'destination_reached':arrival,
         'distance_m':distance,'average_speed_kmh':distance/elapsed*3.6 if elapsed else None,'interventions':interventions,
         'duration_simulation_s':elapsed,'duration_wall_s':time.monotonic()-began,'stop_reason':stop,
         'final_journey':final_journey,'final_route':final_route,'contacts':list(contacts.values()),
         'observed_native_frames':len(trajectory),'maximum_observer_frame_gap':max((b['frame']-a['frame'] for a,b in zip(trajectory,trajectory[1:])),default=0),
         'distance_measurement':'Native snapshot position polyline; unobserved curved segments may underestimate distance. No complete RGB/depth/lidar recording.',
         'performance_and_behavior':summarize_samples(observations,tracking)}
    write(folder/f'journey-unrecorded-{seed}-summary.json',row)
    print(json.dumps({'finished_unrecorded':{k:row[k] for k in ('seed','collision_count','destination_reached','distance_m','average_speed_kmh','interventions','stop_reason')}}),flush=True)
    return row


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',default='output/native-validation/drive-experience-20261009')
    args=parser.parse_args();folder=Path(args.output);folder.mkdir(parents=True,exist_ok=True)
    preferences=Path('config/dashboard-preferences.json');saved=preferences.read_bytes();baseline=json.loads(saved)['population']
    proof={'source':'LIVE_NATIVE_CARLA','controller':'BasicAgent + RULE','recording':False,'runs':[]}
    with ObservationSession() as session:
        try:
            for seed,destination,speed in [(2621,121,20),(2622,102,12)]:
                proof['runs'].append(run(session,seed,destination,speed,baseline,folder))
                write(folder/'journey-unrecorded-evaluation.json',proof)
        except Exception as error:proof['error']=str(error);raise
        finally:
            session.send('stop_driving');session.wait(lambda s:s['vehicle']['speedMagnitudeMps']<.15)
            session.action('population','reset')
            session.action('settings',{'spawn_index':152,'population':baseline})
            session.action('clear_route');session.send('stop_driving')
            preferences.write_bytes(saved)
            proof['cleanup']={'mode':session.state['mode'],'recording':session.state['recording'],
                              'inventory':session.inventory(),'population':session.state['population']['actual'],
                              'safety':session.state['safetySystem'],'preferences_restored':preferences.read_bytes()==saved}
            write(folder/'journey-unrecorded-evaluation.json',proof)


if __name__=='__main__':main()
