"""LIVE verification through the real browser WebSocket/core control path.

Claims control of the existing backend. CARLA queries are read-only except
explicitly marked temporary collision fixtures. Never owns the world tick.
"""
import argparse
import io
import json
import math
from pathlib import Path
import time
import threading
import urllib.request
import carla
import numpy as np
from PIL import Image
from websockets.sync.client import connect

ROOT = Path(__file__).resolve().parents[2]


def http(path):
    with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/'+path, timeout=10) as response:
        return json.load(response)


def compare_image():
    with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/camera-raw.png') as response:
        raw=response.read(); frame=int(response.headers['X-Sensor-Frame'])
    with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/camera.jpg?frame_id='+str(frame)) as response:
        assert int(response.headers['X-Sensor-Frame'])==frame
        jpeg=response.read()
    a=np.array(Image.open(io.BytesIO(raw))).astype(float); b=np.array(Image.open(io.BytesIO(jpeg))).astype(float)
    return {'frame':frame,'mean_absolute_error_0_255':float(np.abs(a-b).mean()),
            'resolution':list(a.shape[:2]),'jpeg_quality':95},raw,jpeg


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--restart', choices=['Low','Epic'])
    parser.add_argument('--short', action='store_true')
    parser.add_argument('--output', type=Path, help='Preserve earlier validation artifacts by choosing a new evidence path')
    parser.add_argument('--collision', action='store_true', help='Temporary controlled static barrier; always cleaned up')
    args = parser.parse_args()
    proof = {'source':'LIVE_NATIVE', 'checks':{}, 'samples':[]}
    client = None
    if not args.restart:
        client = carla.Client('127.0.0.1',2000); client.set_timeout(10)
        assert client.get_client_version() == client.get_server_version() == '0.9.16'
        client.get_world().wait_for_tick(10)
        proof['version'] = client.get_server_version()
    with connect('ws://127.0.0.1:8001', origin='http://127.0.0.1:8000') as ws:
        state = None
        sequence = 0
        heartbeat = False
        last_heartbeat = 0

        def send(kind, **payload):
            nonlocal sequence
            sequence += 1
            ws.send(json.dumps({'type':kind,'sequence':sequence,
                    'frame_id':state['vehicle']['frame'] if state and state.get('vehicle') else None,
                    'timestamp_s':state['vehicle']['timestamp'] if state and state.get('vehicle') else None,**payload}))
            return sequence

        def wait(predicate, timeout=20):
            nonlocal state, last_heartbeat, ws
            deadline = time.monotonic()+timeout
            while time.monotonic()<deadline:
                if heartbeat and state and state.get('connected') and time.monotonic()-last_heartbeat>.08:
                    send('journey_heartbeat',session_id=state['sessionId']); last_heartbeat=time.monotonic()
                try:
                    data = json.loads(ws.recv(timeout=10))
                except Exception:
                    if not args.restart: raise
                    time.sleep(.5)
                    try: ws=connect('ws://127.0.0.1:8001',origin='http://127.0.0.1:8000')
                    except OSError: continue
                    data=json.loads(ws.recv(timeout=10))
                if data['type']=='error':
                    raise RuntimeError(data['error'])
                state = data
                if state.get('vehicle'):
                    v = state['vehicle']
                    proof['samples'].append({'frame':v['frame'],'time':v['timestamp'],'position':v['positionWorldM'],
                        'kmh':v['speedKmh'],'throttle':v['throttle'],'brake':v['brake'],'steer':v['steeringInput'],
                        'mode':state['mode'],'source':state['controlSource'],'journey':state.get('journey')})
                if predicate(state): return state
            raise TimeoutError('LIVE native predicate timed out: '+str(state.get('journey')))

        wait(lambda s:s['connected'])
        seq = send('take_control'); wait(lambda s:s.get('acknowledged')==seq)
        if args.restart:
            before = state['sessionId']
            seq = send('restart_graphics',value={'quality':args.restart,'resolution':'1280x720'})
            wait(lambda s:s.get('restartResult',{}).get('status') in ('APPLIED','ROLLED_BACK','FAILED'),180)
            proof['restart'] = state['restartResult']
            assert state['restartResult']['status']=='APPLIED', state['restartResult']
            assert state['sessionId']!=before and state['mode']=='PAUSED'
            client = carla.Client('127.0.0.1',2000); client.set_timeout(10)
            client.get_world().wait_for_tick(10)
            assert client.get_client_version()==client.get_server_version()=='0.9.16'
            proof['version']=client.get_server_version()
            assert len(client.get_world().get_actors().filter('vehicle.*'))==1
            assert len(client.get_world().get_actors().filter('sensor.*'))==7
            proof['checks']['restart_clean_one_ego_seven_sensors']=True
        else:
            seq = send('reset')
            actor_before = state['vehicle']['actorId']
            wait(lambda s:s['connected'] and s['vehicle']['actorId']!=actor_before and s.get('frameComplete'))
            spawn_frame = state['vehicle']['frame']
            seq = send('stop_driving'); wait(lambda s:s.get('acknowledged')==seq and
                s['mode']=='PAUSED' and s['vehicle']['frame']>spawn_frame+20 and s['vehicle']['speedKmh']<.5)
            world = client.get_world()
            ego = world.get_actor(state['vehicle']['actorId'])
            waypoint = world.get_map().get_waypoint(ego.get_location())
            target = waypoint.next(25)[0].transform.location
            seq = send('destination',value={'location':[target.x,target.y,target.z],'name':'Native straight validation'})
            wait(lambda s:s.get('acknowledged')==seq and s.get('dashboardResult',{}).get('action')=='destination'
                 and s['dashboardResult']['status']=='APPLIED')
            proof['checks']['selection_does_not_start_motion'] = state['mode']=='PAUSED' and state['vehicle']['speedKmh']<.5
            start = list(state['vehicle']['positionWorldM'])
            heartbeat = True
            send('start_journey',speed_kmh=15)
            wait(lambda s:s.get('journey',{}).get('status')=='RUNNING')
            wait(lambda s:s['vehicle']['speedKmh']>2)
            # Browser image requests do not block its WebSocket heartbeat.
            # Preserve that behavior while this synchronous verifier encodes PNG.
            image_done=threading.Event()
            def image_heartbeat():
                while not image_done.wait(.07):
                    send('journey_heartbeat',session_id=state['sessionId'])
            image_thread=threading.Thread(target=image_heartbeat,daemon=True)
            image_thread.start()
            try:proof['moving_image_comparison']=compare_image()[0]
            finally:image_done.set();image_thread.join(timeout=2)
            wait(lambda s:s.get('journey',{}).get('status')=='ARRIVED',35)
            proof['checks']['straight_arrival'] = math.dist(start,state['vehicle']['positionWorldM'])>15 and state['vehicle']['speedKmh']<.54
            heartbeat = False
            if not args.short:
                # Search actual native routes for a nearby route containing a turn.
                seq=send('reset'); before=state['vehicle']['actorId']
                wait(lambda s:s['connected'] and s['vehicle']['actorId']!=before and s.get('frameComplete'))
                catalog=http('catalog')
                here=state['vehicle']['positionWorldM']
                candidates=sorted(catalog['places'],key=lambda p:math.dist(here,p['location']))
                found=False
                for place in candidates:
                    if math.dist(here,place['location'])<35: continue
                    seq=send('destination',value=place['id'])
                    wait(lambda s:s.get('acknowledged')==seq and s.get('dashboardResult',{}).get('action')=='destination'
                         and s['dashboardResult']['status'] in ('APPLIED','REJECTED'))
                    route=state.get('route')
                    if route and route['length_m']<150 and any(i['action'] in ('LEFT','RIGHT') for i in route['instructions']):
                        found=True; break
                assert found, 'No nearby native turning route found'
                proof['turning_route']={'destination':route['destination'],'length_m':route['length_m'],'instructions':route['instructions']}
                heartbeat=True; send('start_journey',speed_kmh=15)
                wait(lambda s:s.get('journey',{}).get('status')=='RUNNING')
                wait(lambda s:s.get('journey',{}).get('status')=='ARRIVED',90)
                proof['checks']['turning_arrival']=state['vehicle']['speedKmh']<.54
                heartbeat=False
            # Real lease expiry: do not heartbeat; local controller cannot keep itself alive.
            target=world.get_map().get_waypoint(world.get_actor(state['vehicle']['actorId']).get_location()).next(40)[0].transform.location
            seq=send('destination',value={'location':[target.x,target.y,target.z],'name':'Native lease validation'})
            wait(lambda s:s.get('acknowledged')==seq and s.get('dashboardResult',{}).get('status')=='APPLIED')
            heartbeat=True; send('start_journey',speed_kmh=10)
            wait(lambda s:s['mode']=='AUTOMATIC' and s['vehicle']['speedKmh']>2)
            heartbeat=False
            wait(lambda s:s['mode']=='PAUSED' and s['journey']['reason']=='dashboard_heartbeat_timeout',5)
            proof['checks']['independent_dashboard_lease']=True
            heartbeat=True; send('start_journey',speed_kmh=10)
            wait(lambda s:s['mode']=='AUTOMATIC' and s['vehicle']['speedKmh']>2)
            heartbeat=False
            send('controls',controls={'throttle':0,'brake':1,'steering':.2,'parkingbrake':0,'gear':1})
            wait(lambda s:s['mode']=='MANUAL' and s['journey']['reason']=='manual_intervention')
            proof['checks']['manual_intervention']=True
            send('stop_driving'); wait(lambda s:s['mode']=='PAUSED' and s['vehicle']['speedKmh']<.5)
            retained_target=json.loads(json.dumps(state['route']['destination']))
            old_route_id=state['route']['id']
            heartbeat=True; send('start_journey',speed_kmh=10)
            wait(lambda s:s['mode']=='AUTOMATIC')
            proof['checks']['resume_keeps_exact_destination_replans_live_origin']=(
                state['route']['destination']==retained_target and state['route']['id']!=old_route_id and
                math.dist(state['route']['points'][0],state['vehicle']['positionWorldM'])<3)
            proof['resume']={'destination':retained_target,'new_route':state['route']['id'],
                             'origin_waypoint':state['route']['points'][0],
                             'ego_position':state['vehicle']['positionWorldM']}
            heartbeat=False; send('emergency_stop')
            wait(lambda s:s['mode']=='EMERGENCY_STOP')
            send('acknowledge_stop'); wait(lambda s:s['mode']=='PAUSED')
            proof['checks']['emergency_no_automatic_resume']=True
            if args.collision:
                before=state['vehicle']['actorId']; send('reset')
                wait(lambda s:s['connected'] and s['vehicle']['actorId']!=before and s.get('frameComplete'))
                spawn_frame=state['vehicle']['frame']
                send('stop_driving'); wait(lambda s:s['vehicle']['frame']>spawn_frame+20 and s['vehicle']['speedKmh']<.5)
                world=client.get_world(); ego=world.get_actor(state['vehicle']['actorId'])
                wp=world.get_map().get_waypoint(ego.get_location())
                goal=wp.next(25)[0].transform.location
                barrier_transform=wp.next(8)[0].transform
                barrier_transform.rotation.yaw+=90
                barrier_transform.location.z+=.5
                fixture=world.try_spawn_actor(world.get_blueprint_library().find('static.prop.streetbarrier'),barrier_transform)
                assert fixture is not None,'Controlled collision fixture could not spawn'
                try:
                    fixture.set_simulate_physics(False)
                    seq=send('destination',value={'location':[goal.x,goal.y,goal.z],'name':'Controlled collision validation'})
                    wait(lambda s:s.get('acknowledged')==seq and s.get('dashboardResult',{}).get('status')=='APPLIED')
                    heartbeat=True; send('start_journey',speed_kmh=8)
                    wait(lambda s:s['mode']=='AUTOMATIC')
                    wait(lambda s:s['mode']=='PAUSED' and s['journey']['reason']=='collision',20)
                    heartbeat=False
                    proof['checks']['native_collision_stops_journey']=any(
                        c['other_actor_id']==fixture.id for c in state['collisionEvents'])
                    proof['controlledCollision']=state['collisionEvents']
                finally:
                    heartbeat=False; fixture.destroy()
                    send('stop_driving'); wait(lambda s:s['vehicle']['speedKmh']<.5)
        proof['performance']=state.get('performance')
        proof['sensorRatesHz']=state['sensorRatesHz']
        proof['checks']['sensor_suite']=set(state['sensors'])=={'frontCamera','depth','radar','lidar','imu','gnss'} and not state['sensorErrors']
        rgb,depth=state['sensors']['frontCamera'],state['sensors']['depth']
        assert rgb['frame']==depth['frame']==state['vehicle']['frame']
        assert rgb['mountTransform']==depth['mountTransform']
        proof['checks']['exact_frame_rgb_depth_alignment']=True
        if not args.restart:
            proof['image_comparison'],raw,jpeg=compare_image()
            proof['image_comparison']['postprocess']=rgb['metadata']['attributes']['enable_postprocess_effects']
            prefix=args.output.with_suffix('') if args.output else ROOT/'output/native-validation/dashboard-v2'
            prefix.with_name(prefix.name+'-native.png').write_bytes(raw)
            prefix.with_name(prefix.name+'-delivered.jpg').write_bytes(jpeg)
        proof['pass']=all(proof['checks'].values())
    suffix=args.restart.lower() if args.restart else 'navigation-short' if args.short else 'navigation'
    path=args.output or ROOT/'output/native-validation'/('dashboard-v2-'+suffix+'.json')
    path.write_text(json.dumps(proof,ensure_ascii=False,indent=2),encoding='utf-8')
    assert proof['pass'],proof['checks']
    print(json.dumps({'pass':proof['pass'],'path':str(path),'checks':proof['checks']},ensure_ascii=False))


if __name__=='__main__':
    main()
