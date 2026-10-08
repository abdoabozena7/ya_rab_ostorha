"""Gate 4 acceptance through production WS, with an independent read-only SDK.

Run after the population benchmark, never alongside another mutation owner.
"""
import json
import math
from pathlib import Path
import time
from websockets.sync.client import connect
from websockets.exceptions import ConnectionClosed


class NativeDashboard:
    def __init__(self, socket):
        self.socket, self.sequence, self.state = socket, 0, None

    def wait(self, predicate, timeout=60, allow_error=False):
        deadline = time.monotonic()+timeout
        while time.monotonic() < deadline:
            try:
                message = json.loads(self.socket.recv(timeout=min(10,timeout)))
            except ConnectionClosed:
                # A native reset retires the old Windows SDK process deliberately.
                while time.monotonic()<deadline:
                    try:
                        self.socket = connect('ws://localhost:8001',max_size=2**22)
                        break
                    except OSError: time.sleep(.5)
                else: raise TimeoutError('Native backend did not return after reset')
                continue
            if message['type'] == 'error':
                if allow_error: return message
                raise RuntimeError(message['error'])
            if message['type'] != 'snapshot': continue
            self.state = message
            if message.get('error') and not allow_error: raise RuntimeError(message['error'])
            if predicate(message): return message
        raise TimeoutError('Live dashboard condition timed out')

    def command(self, kind, **payload):
        self.sequence += 1
        self.socket.send(json.dumps({'type': kind, 'sequence': self.sequence, **payload}))
        self.wait(lambda s: s.get('acknowledged') == self.sequence)
        return self.state

    def action(self, kind, value=None):
        self.command(kind, value=value)
        self.wait(lambda s: (s.get('dashboardResult') or {}).get('action') == kind and
                  (s['dashboardResult']['status']=='REJECTED' or
                   s['dashboardResult']['status']=='APPLIED' and s['connected'] and s.get('vehicle')),
                  timeout=180 if kind=='world_reset' else 60)
        result = self.state['dashboardResult']
        if result['status'] != 'APPLIED': raise RuntimeError(result['error'])
        frame = self.state['vehicle']['frame']
        self.wait(lambda s: s['connected'] and s['vehicle']['frame'] > frame+8)
        return result['result']


def main():
    import carla
    from backend.carla.population import DEFAULT_POPULATION
    client = carla.Client('localhost', 2000); client.set_timeout(20)
    assert client.get_client_version() == client.get_server_version() == '0.9.16'
    world = client.get_world(); world.wait_for_tick(10)
    proof = {'source': 'LIVE_NATIVE', 'checks': {}, 'settings': [], 'errors': []}
    root = Path('output/native-validation/gate4-settings.json')
    def inventory():
        world.wait_for_tick(10)
        actors = world.get_actors()
        return {k: [a.id for a in actors.filter(p)] for k,p in
                [('vehicle','vehicle.*'), ('walker','walker.*'), ('controller','controller.*'), ('sensor','sensor.*')]}
    with connect('ws://localhost:8001', max_size=2**22) as socket:
        d = NativeDashboard(socket)
        d.wait(lambda s: s['connected']); d.command('take_control'); d.command('stop_driving')
        # Native blueprint selection, population cleanup and seven reattached sensors.
        d.action('settings', {'population': {**DEFAULT_POPULATION, 'vehicle_count':10,'pedestrian_count':10}})
        old = inventory()
        result = d.action('settings', {'vehicle':'vehicle.toyota.prius','spawn_index':0})
        current = inventory()
        assert len(current['vehicle']) == 1 and len(current['sensor']) == 7
        assert not current['walker'] and not current['controller']
        assert not set(sum(old.values(), [])).intersection(sum(current.values(), []))
        ego = world.get_actor(d.state['vehicle']['actorId'])
        assert ego.type_id == 'vehicle.toyota.prius'
        assert ego.get_location().distance(world.get_map().get_spawn_points()[result['actual_spawn_index']].location) < 2
        proof['checks']['vehicle_spawn_and_cleanup'] = True
        proof['settings'].append(result)
        frame = d.state['vehicle']['frame']
        d.wait(lambda s:s['vehicle']['speedKmh'] < .3 and s['vehicle']['frame'] > frame+30)
        d.action('settings', {'vehicle':'vehicle.lincoln.mkz_2020','spawn_index':152})
        frame = d.state['vehicle']['frame']
        d.wait(lambda s:s['vehicle']['speedKmh'] < .3 and s['vehicle']['frame'] > frame+30)
        # Five views reuse the same RGB/depth actors, with aligned native mounts.
        ids = inventory()['sensor']
        mounts = []
        for view in ('front','hood','chase','rear','top','front'):
            d.action('settings', {'camera_view':view})
            assert inventory()['sensor'] == ids
            cameras = world.get_actors(ids).filter('sensor.camera.*')
            rgb = next(a for a in cameras if a.type_id=='sensor.camera.rgb')
            depth = next(a for a in cameras if a.type_id=='sensor.camera.depth')
            assert rgb.get_transform().location.distance(depth.get_transform().location) < .01
            assert abs(rgb.get_transform().rotation.yaw-depth.get_transform().rotation.yaw) < .01
            assert not d.state['sensorErrors']
            mounts.append({'view':view,'rgb_actor':rgb.id,'depth_actor':depth.id})
        proof['checks']['five_camera_views_no_leaks'] = True; proof['camera_views'] = mounts
        for preset in ('ClearNoon','CloudyNoon','HardRainNoon'):
            result = d.action('settings', {'weather_preset':preset})
            actual = world.get_weather(); expected = getattr(carla.WeatherParameters,preset)
            assert all(abs(getattr(actual,k)-getattr(expected,k)) < .01 for k in result['weather'])
            assert result['weather_preset'] == preset
            proof['settings'].append({'weather':preset,'actual':result['weather']})
        proof['checks']['native_weather'] = True
        for hz in (10,20):
            before = inventory()['sensor']
            d.action('settings', {'simulation_hz':hz})
            assert abs(world.get_settings().fixed_delta_seconds-1/hz)<1e-6
            assert len(inventory()['sensor'])==7 and set(before).isdisjoint(inventory()['sensor'])
            assert not d.state['sensorErrors']
            proof['settings'].append({'simulation_hz':hz,'native_fixed_delta':world.get_settings().fixed_delta_seconds,
                                      'sensor_rates':d.state['sensorRatesHz']})
        proof['checks']['fixed_delta_and_sensor_recreation'] = True
        d.action('settings', {'weather_preset':'ClearNoon'})
        # Route originates at the native ego and is guidance only.
        route = d.action('destination', 'road-point-20')
        origin = world.get_actor(d.state['vehicle']['actorId']).get_location()
        assert math.dist((origin.x,origin.y,origin.z),route['points'][0]) < 5
        assert route['source']=='CARLA_ROAD_GRAPH' and route['mode']=='MANUAL_GUIDANCE'
        assert len(route['points']) > 2 and route['length_m'] > 10
        assert d.state['vehicle']['throttle']==0
        d.sequence += 1
        socket.send(json.dumps({'type':'start_journey','sequence':d.sequence,'speed_kmh':20}))
        rejected = d.wait(lambda s:False,allow_error=True)
        assert rejected['type']=='error' and 'Gate 4' in rejected['error']
        proof['checks']['autonomous_ego_rejected_live'] = True
        saved = d.action('save_place', 'Gate 4 native test')
        assert saved['map']==world.get_map().name and len(saved['world_transform']['rotation_deg'])==3
        d.action('favorite_place', saved['id'])
        point = world.get_map().get_spawn_points()[30].location
        map_route = d.action('destination', {'map':world.get_map().name,'location':[point.x,point.y,point.z],'name':'Native map test'})
        assert map_route['source']=='CARLA_ROAD_GRAPH'
        d.action('clear_route'); assert d.state['route'] is None
        proof['checks']['native_manual_routes_saved_transform'] = True
        proof['routes'] = [route,map_route]; proof['saved_place'] = saved
        d.action('inspector', 100)
        actors = d.state['nearbyActors']
        assert actors['source']=='SIMULATOR_GROUND_TRUTH' and actors['radius_m']==100
        assert all(a['distance_m']<=100 and a['category'] in ('VEHICLE','WALKER','TRAFFIC LIGHT','OTHER') for a in actors['actors'])
        proof['checks']['native_actor_inspector'] = True
        for scene,counts,preset in [('A',(10,10),'ClearNoon'),('B',(25,25),'CloudyNoon'),('C',(50,50),'HardRainNoon')]:
            d.action('scene',scene)
            d.wait(lambda s:(s['population']['actual']['vehicles'],s['population']['actual']['pedestrians'])==counts)
            assert len(inventory()['sensor'])==7 and not d.state['sensorErrors']
            proof['settings'].append({'scene':scene,'population':d.state['population'],'weather':preset})
        proof['checks']['repeatable_normal_scenes'] = True
        proof['final_inventory'] = inventory()
        d.command('stop_driving')
    proof['pass'] = all(proof['checks'].values())
    root.write_text(json.dumps(proof,indent=2),encoding='utf8')
    print(json.dumps({'pass':proof['pass'],'checks':proof['checks']}))


if __name__ == '__main__': main()
