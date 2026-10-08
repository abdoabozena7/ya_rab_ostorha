"""Live Gate 4 population lifecycle, normal behavior and performance evidence.

Commands enter through the production WebSocket; this process never ticks.
"""
import argparse
import json
import math
from pathlib import Path
import statistics
import time
import urllib.request
from websockets.sync.client import connect
from .stability_run import backend_pid, memory

ROOT = Path(__file__).resolve().parents[2]


def main():
    import carla
    from backend.carla.runtime import native_processes
    from backend.carla.population import DEFAULT_POPULATION
    parser = argparse.ArgumentParser()
    parser.add_argument('--duration', type=float, default=75, help='Steady wall seconds per matrix row')
    parser.add_argument('--output', default='output/native-validation/gate4-city')
    parser.add_argument('--lifecycle-only', action='store_true')
    args = parser.parse_args()
    client = carla.Client('localhost',2000); client.set_timeout(10)
    assert client.get_client_version() == client.get_server_version() == '0.9.16'
    world = client.get_world(); world.wait_for_tick(10)
    engine = next(p for p in native_processes() if 'Shipping' in p['ExecutablePath'])['ProcessId']
    backend = backend_pid(8000)
    proof = {'source':'LIVE_NATIVE','versions':[client.get_server_version(),client.get_client_version()],
             'map':world.get_map().name,'matrix':[],'checks':{},'errors':[]}
    root = Path(args.output); root.parent.mkdir(parents=True,exist_ok=True)
    sequence=0; state=None
    with connect('ws://127.0.0.1:8001',max_size=2**22) as socket:
        def wait(predicate, timeout=30):
            nonlocal state
            deadline=time.monotonic()+timeout
            while time.monotonic()<deadline:
                message=json.loads(socket.recv(timeout=10))
                if message['type']=='error': raise RuntimeError(message['error'])
                if message['type']!='snapshot': continue
                state=message
                if state.get('error'): raise RuntimeError(state['error'])
                if predicate(state): return state
            raise TimeoutError('Native condition timed out')

        def send(kind, **payload):
            nonlocal sequence
            sequence+=1
            socket.send(json.dumps({'type':kind,'sequence':sequence,**payload}))
            return sequence

        def action(kind, value):
            seq=send(kind,value=value)
            wait(lambda s:s.get('acknowledged')==seq)
            wait(lambda s:s.get('dashboardResult',{}).get('action')==kind and
                 s['dashboardResult'].get('status') in ('APPLIED','REJECTED'))
            result=state['dashboardResult']
            if result['status']!='APPLIED': raise RuntimeError(result['error'])
            # Observe actual counts/sensors from a subsequent native frame.
            frame=state['vehicle']['frame']
            wait(lambda s:s['connected'] and s['vehicle']['frame']>frame+4)
            return result['result']

        def inventory():
            actors=world.get_actors()
            return {'vehicles':[a.id for a in actors.filter('vehicle.*')],
                    'walkers':[a.id for a in actors.filter('walker.pedestrian.*')],
                    'controllers':[a.id for a in actors.filter('controller.ai.walker')],
                    'sensors':[a.id for a in actors.filter('sensor.*')]}

        def assert_inventory(traffic, walkers):
            wait(lambda s:s['population']['actual']['vehicles']==traffic and
                 s['population']['actual']['pedestrians']==walkers and
                 s['population']['actual']['controllers']==walkers)
            actual=inventory()
            assert len(actual['vehicles'])==traffic+1, actual
            assert len(actual['walkers'])==len(actual['controllers'])==walkers, actual
            assert len(actual['sensors'])==7, actual
            assert not state['sensorErrors'],state['sensorErrors']
            return actual

        wait(lambda s:s['connected'])
        seq=send('take_control');wait(lambda s:s.get('acknowledged')==seq)
        original_ego=state['vehicle']['actorId']
        original_sensors=inventory()['sensors']
        proof['configuration']={'fixed_delta_seconds':world.get_settings().fixed_delta_seconds,
                                'sensor_registry':state['sensorRegistry'],'gpu':state['performance']['gpu'],
                                'sensor_timeout_s':.5,'render_fps_available':False}
        if not args.lifecycle_only:
            for traffic,walkers in [(0,0),(10,10),(25,25),(50,25),(50,50)]:
                action('settings',{'population':{**DEFAULT_POPULATION,'vehicle_count':traffic,'pedestrian_count':walkers}})
                actual=assert_inventory(traffic,walkers)
                wait(lambda s:s['population']['actual']['walkers_active']==walkers)
                first=time.monotonic(); last_sample=-10.; rows=[]; positions={}; distances={}; max_gap=0.; received=first
                initial_sync=json.loads(json.dumps(state['synchronization']))
                while time.monotonic()-first < args.duration:
                    wait(lambda s:s['connected'])
                    now=time.monotonic();max_gap=max(max_gap,now-received);received=now
                    if now-last_sample < 1.: continue
                    last_sample=now
                    rows.append({'elapsed_s':now-first,'performance':state['performance'],
                                 'step_ms':state['backendStepMs'],'backend_memory':memory(backend),
                                 'carla_memory':memory(engine),'population':state['population'],
                                 'sync':state['synchronization']})
                    population=state['population']
                    for actor_id in population['vehicle_ids']+population['walker_ids']:
                        if actor_id==original_ego: continue
                        actor=world.get_actor(actor_id)
                        if actor is None: continue  # Native TM lifecycle can remove a blocked NPC between snapshots.
                        p=actor.get_location(); point=(p.x,p.y,p.z)
                        if actor_id in positions: distances[actor_id]=distances.get(actor_id,0.)+math.dist(point,positions[actor_id])
                        positions[actor_id]=point
                sync=state['synchronization']
                issue_delta={k:sync['issues'][k]-initial_sync['issues'][k] for k in sync['issues']}
                warm=rows[len(rows)//4:]
                rates={k:statistics.median(r['performance']['sensorWallRatesHz'][k] for r in warm)
                       for k in ('frontCamera','depth','radar','lidar','imu','gnss')}
                row={'requested':[traffic,walkers],'actual':[state['population']['actual']['vehicles'],state['population']['actual']['pedestrians']],
                     'actual_count_ranges':{k:[min(r['population']['actual'][k] for r in rows),max(r['population']['actual'][k] for r in rows)]
                                            for k in ('vehicles','pedestrians','controllers')},
                     'duration_wall_s':time.monotonic()-first,'tick_hz':statistics.median(r['performance']['nativeTickRateHz'] for r in warm),
                     'sensor_wall_hz':rates,'render_fps':None,'backend_step_ms_median':statistics.median(r['step_ms'] for r in warm),
                     'backend_step_ms_p95':sorted(r['step_ms'] for r in warm)[min(len(warm)-1,int(.95*len(warm)))],
                     'backend_private_mib_range':[min(r['backend_memory']['private_mib'] for r in warm),max(r['backend_memory']['private_mib'] for r in warm)],
                     'carla_private_mib_range':[min(r['carla_memory']['private_mib'] for r in warm),max(r['carla_memory']['private_mib'] for r in warm)],
                     'vram_mib_range':[min(r['performance']['gpu']['usedMiB'] for r in warm),max(r['performance']['gpu']['usedMiB'] for r in warm)],
                     'ws_max_gap_s':max_gap,'sync_issue_delta':issue_delta,
                     'sync_incomplete_delta':sync['incompleteFrames']-initial_sync['incompleteFrames'],
                     'moved_vehicles':sum(distances.get(i,0.)>2 for i in actual['vehicles'] if i!=original_ego),
                     'moved_walkers':sum(distances.get(i,0.)>2 for i in actual['walkers']),
                     'travelled_distance_m':distances,'sensor_errors':state['sensorErrors'],
                     'walkers_lost':state['population']['walkers_lost'],
                     'vehicles_removed_native':state['population']['vehicles_removed_native']}
                row['healthy']=not any(issue_delta.values()) and row['sync_incomplete_delta']==0 and not row['sensor_errors'] and max_gap<1.5
                proof['matrix'].append(row)
                root.with_suffix('.json').write_text(json.dumps(proof,indent=2),encoding='utf8')
                print(json.dumps({'matrix_row':row}),flush=True)
            baseline=proof['matrix'][0]['tick_hz']
            eligible=[r for r in proof['matrix'][1:] if r['healthy'] and r['tick_hz']>=baseline*.85]
            if not eligible: raise RuntimeError('No healthy populated performance row')
            # Prefer a measured moderate count, preserving headroom over maximum.
            balanced=next((r for r in eligible if r['requested']==[25,25]),eligible[0])
            profiles={name:{'population':{**DEFAULT_POPULATION,'vehicle_count':row['actual'][0],
                              'pedestrian_count':row['actual'][1]},'measured_tick_hz':row['tick_hz']}
                      for name,row in [('LIGHT',eligible[0]),('BALANCED',balanced),('DENSE',eligible[-1])]}
            profile_data={'source':'LIVE_NATIVE_MEASURED','map':proof['map'],'recommended_default':'BALANCED',
                          'baseline_tick_hz':baseline,'eligibility':'No new synchronization issues; >=85% baseline wall tick rate',
                          'conditions':proof['configuration'],
                          'profiles':profiles,'evidence':str(root.with_suffix('.json'))}
            (ROOT/'config'/'normal-city-profiles.json').write_text(json.dumps(profile_data,indent=2),encoding='utf8')
            proof['recommended_profiles']=profile_data
        # Exercise incremental reduction: retained actor IDs must remain owned/alive.
        action('settings',{'population':{**DEFAULT_POPULATION,'vehicle_count':10,'pedestrian_count':10}})
        before=assert_inventory(10,10)
        action('settings',{'population':{**DEFAULT_POPULATION,'vehicle_count':5,'pedestrian_count':5}})
        after=assert_inventory(5,5)
        assert set(after['vehicles']).issubset(before['vehicles']) and set(after['walkers']).issubset(before['walkers'])
        proof['checks']['incremental_reduction']=True
        action('population','respawn'); replacement=assert_inventory(5,5)
        assert set(replacement['walkers']).isdisjoint(after['walkers'])
        assert set(replacement['vehicles'])-{original_ego} != set(after['vehicles'])-{original_ego}
        proof['checks']['respawn']=True
        action('population','clear_traffic');assert_inventory(0,5)
        action('population','clear_pedestrians');assert_inventory(0,0)
        proof['checks']['clear_traffic_and_pedestrians']=True
        assert inventory()['sensors']==original_sensors and state['vehicle']['actorId']==original_ego
        proof['checks']['ego_sensors_unchanged']=True
        for speed,difference in [('SLOW',30.),('NORMAL',15.),('FAST',0.)]:
            action('settings',{'population':{**DEFAULT_POPULATION,'vehicle_count':10,'pedestrian_count':10,'speed_behavior':speed}})
            assert state['population']['desired_speed_difference_percent']==difference
        proof['checks']['speed_semantics']=True
        action('population','reset');assert_inventory(0,0)
        proof['checks']['reset_population']=True
        seq=send('stop_driving');wait(lambda s:s.get('acknowledged')==seq)
    proof['pass']=not proof['errors'] and all(proof['checks'].values()) and all(r['healthy'] for r in proof['matrix'])
    root.with_suffix('.json').write_text(json.dumps(proof,indent=2),encoding='utf8')
    print(json.dumps({'pass':proof['pass'],'checks':proof['checks']}))
    if not proof['pass']:raise SystemExit(1)


if __name__=='__main__': main()
