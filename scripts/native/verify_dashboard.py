"""Validate dashboard operations against an already running native backend.

This claims the dashboard controller, changes conservative settings, then
disconnects/reconnects one ego. It never ticks CARLA or creates traffic.
"""
import json
import time
import urllib.request
from pathlib import Path

import carla
from websockets.sync.client import connect


def http(path):
    with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/'+path, timeout=5) as response:
        return json.load(response)


def main():
    client = carla.Client('127.0.0.1', 2000); client.set_timeout(10)
    assert client.get_client_version() == client.get_server_version() == '0.9.16'
    proof = {'source': 'LIVE_NATIVE', 'version': client.get_server_version(), 'checks': []}
    sequence = 0
    with connect('ws://127.0.0.1:8001', origin='http://127.0.0.1:8000') as socket:
        def wait(predicate, timeout=20):
            deadline = time.monotonic()+timeout
            while time.monotonic() < deadline:
                data = json.loads(socket.recv(timeout=5))
                if data['type'] == 'error': raise RuntimeError(data['error'])
                if predicate(data): return data
            raise TimeoutError('Native dashboard operation did not complete')

        def send(kind, value=None):
            nonlocal sequence
            sequence += 1
            socket.send(json.dumps({'type':kind, 'sequence':sequence, 'value':value}))
            return sequence

        def settings(value):
            before_frame = http('state')['world']['frame']
            seq = send('settings', value)
            state = wait(lambda s: s.get('acknowledged', 0) == seq and
                         s.get('dashboardResult', {}).get('status') in ('APPLIED','REJECTED'))
            assert state['dashboardResult']['status'] == 'APPLIED', state['dashboardResult']
            return wait(lambda s: s['connected'] and s.get('frameComplete') and
                        s['world']['frame'] > before_frame+5 and
                        ('simulation_hz' not in value or abs(s['world']['fixedDeltaSeconds']-1/value['simulation_hz'])<1e-6) and
                        all(s.get('sensorRatesHz', {}).get(n) is not None
                            and abs(s['sensorRatesHz'][n]-1/s['world']['fixedDeltaSeconds'])<.01
                            for n in ('frontCamera','depth','radar','lidar','imu','gnss')))

        state = json.loads(socket.recv(timeout=5))
        if not state.get('connected'):
            send('reconnect')
            state = wait(lambda s:s['connected'])
        state = wait(lambda s:s['connected'] and s['vehicle']['speedMagnitudeMps']<.15)
        send('start_driving'); wait(lambda s:s['connected'] and s['controller'] and s['mode']=='MANUAL')
        original = http('catalog')['settings']
        actors_before = {k:v['actorId'] for k,v in state['sensorRegistry'].items()}
        for view in ('chase','rear','top','hood','front'):
            state = settings({'camera_view':view})
            assert {k:v['actorId'] for k,v in state['sensorRegistry'].items()} == actors_before
            assert state['sensors']['frontCamera']['mountTransform'] == state['sensors']['depth']['mountTransform']
            proof['checks'].append({'camera_view':view, 'frame':state['world']['frame'],
                'mount':state['sensors']['frontCamera']['mountTransform'], 'actor_ids_unchanged':True})
        for hz in (10,20):
            state = settings({'simulation_hz':hz})
            assert abs(state['world']['fixedDeltaSeconds']-1/hz)<1e-6
            assert all(abs(v-hz)<.01 for v in state['sensorRatesHz'].values() if v is not None)
            proof['checks'].append({'simulation_hz':hz,'frame':state['world']['frame'],'rates':state['sensorRatesHz']})
        state = settings({'camera_resolution':'800x450','camera_fov':100})
        rgb = state['sensors']['frontCamera']
        assert (rgb['width'],rgb['height'],rgb['fovDeg']) == (800,450,100)
        proof['checks'].append({'camera_dimensions':[rgb['width'],rgb['height']], 'fov':rgb['fovDeg']})
        settings({'camera_resolution':original['camera_resolution'],'camera_fov':original['camera_fov']})
        for vehicle in ('vehicle.tesla.model3',original['vehicle']):
            old_id = state['vehicle']['actorId']
            state = settings({'vehicle':vehicle,'spawn_index':original['spawn_index']})
            actor = client.get_world().get_actor(state['vehicle']['actorId'])
            assert actor.type_id == vehicle and actor.id != old_id
            proof['checks'].append({'vehicle':vehicle,'actor_id':actor.id,'sensors':len(state['sensorRegistry'])})
        # A second reconnect of a live session must be safe and leave driving paused.
        seq = send('reconnect')
        wait(lambda s:s.get('acknowledged')==seq and s['connected'] and s['mode']=='PAUSED')
        send('start_driving'); wait(lambda s:s['connected'] and s['controller'] and s['mode']=='MANUAL')
        owned = [state['vehicle']['actorId']]+[v['actorId'] for v in state['sensorRegistry'].values()]
        send('disconnect'); wait(lambda s:not s['connected'] and s['connectionState']=='DISCONNECTED')
        world = client.get_world()
        # SDK episode caches and actor descriptions update asynchronously. Wait
        # for native snapshots to confirm destruction rather than one cached read.
        for _ in range(30):
            native = world.wait_for_tick(10)
            remaining = [a.id for a in world.get_actors() if a.id in owned]
            if not remaining and all(native.find(i) is None for i in owned): break
        assert not world.get_settings().synchronous_mode
        assert not remaining and all(native.find(i) is None for i in owned), remaining
        proof['cleanup'] = {'destroyed_ids':owned,'synchronous_restored':False}
        send('reconnect')
        state = wait(lambda s:s['connected'] and s.get('frameComplete'))
        world = client.get_world(); world.wait_for_tick(10)
        vehicles = list(world.get_actors().filter('vehicle.*')); sensors = list(world.get_actors().filter('sensor.*'))
        assert len(vehicles)==1 and len(sensors)==7
        assert state['world']['version']==state['world']['pythonApiVersion']=='0.9.16'
        proof['reconnect'] = {'frame':state['world']['frame'],'ego_id':state['vehicle']['actorId'],
            'vehicles':len(vehicles),'sensors':len(sensors),'connected':True}
        proof['population'] = state.get('population')
        assert not state['population']['actual']['vehicles'] and not state['population']['actual']['pedestrians']
        proof['traffic_active'] = False
    proof['status'] = 'PASS'
    path = Path('output/native-validation/dashboard-operations.json')
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_text(json.dumps(proof,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(proof,ensure_ascii=False,indent=2))


if __name__ == '__main__':
    main()
