"""Native dashboard operations: map destinations, manual guidance and settings."""
import json
import math
import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WEATHER_RANGES = {'cloudiness': (0, 100), 'precipitation': (0, 100),
                  'wetness': (0, 100), 'fog_density': (0, 100),
                  'sun_altitude_angle': (-90, 90), 'sun_azimuth_angle': (0, 360)}
CAMERA_VIEWS = {'front': (1.5, 0., 1.6, 0., 0.), 'hood': (2.3, 0., 1.1, 0., 0.),
                'chase': (-6., 0., 3., -15., 0.), 'rear': (-1.5, 0., 1.6, 0., 180.),
                'top': (0., 0., 15., -90., 0.)}


def validate_settings(data):
    if not isinstance(data, dict) or set(data)-{'weather', 'camera_view', 'camera_resolution',
            'camera_fov', 'camera_postprocess', 'camera_motion_blur', 'camera_bloom',
            'simulation_hz', 'vehicle', 'spawn_index', 'next_launch', 'traffic_plan'}:
        raise ValueError('Unknown CARLA setting')
    result = dict(data)
    if 'weather' in data:
        weather = data['weather']
        if not isinstance(weather, dict) or set(weather)-WEATHER_RANGES.keys():
            raise ValueError('Unknown weather field')
        for name, value in weather.items():
            if type(value) not in (int, float) or not math.isfinite(value) or not WEATHER_RANGES[name][0] <= value <= WEATHER_RANGES[name][1]:
                raise ValueError(f'Weather {name} outside its supported range')
    if 'camera_view' in data and (not isinstance(data['camera_view'],str) or data['camera_view'] not in CAMERA_VIEWS):
        raise ValueError('Unknown camera view')
    if 'camera_resolution' in data and data['camera_resolution'] not in ('640x360', '800x450'):
        raise ValueError('Supported camera resolutions: 640x360, 800x450')
    if 'camera_postprocess' in data and type(data['camera_postprocess']) is not bool:
        raise ValueError('Postprocessing must be boolean')
    for name, low, high in (('camera_fov', 60, 120), ('camera_motion_blur', 0, 1), ('camera_bloom', 0, 2)):
        if name in data and (type(data[name]) not in (int, float) or not math.isfinite(data[name]) or not low <= data[name] <= high):
            raise ValueError(f'{name} outside range')
    if 'simulation_hz' in data and (type(data['simulation_hz']) is not int or data['simulation_hz'] not in (10, 20)):
        raise ValueError('Development simulation rate must be 10 or 20 Hz')
    if 'vehicle' in data and (not isinstance(data['vehicle'], str) or not data['vehicle'].startswith('vehicle.')):
        raise ValueError('Invalid native vehicle blueprint')
    if 'spawn_index' in data and (type(data['spawn_index']) is not int or data['spawn_index'] < 0):
        raise ValueError('Spawn index must be a nonnegative integer')
    if 'next_launch' in data:
        launch = data['next_launch']
        if not isinstance(launch, dict) or set(launch) != {'quality', 'resolution'} or launch['quality'] not in ('Low', 'Epic') or launch['resolution'] not in ('1280x720', '1600x900', '1920x1080'):
            raise ValueError('Invalid next-launch graphics settings')
    if 'traffic_plan' in data:
        plan = data['traffic_plan']
        if not isinstance(plan, dict) or set(plan) != {'vehicle_count', 'speed_min_kmh', 'speed_max_kmh', 'seed'}:
            raise ValueError('Invalid prepared traffic settings')
        if any(type(plan[k]) is not int for k in plan):
            raise ValueError('Prepared traffic values must be integers')
        if not 0 <= plan['vehicle_count'] <= 100 or not 0 <= plan['speed_min_kmh'] <= plan['speed_max_kmh'] <= 120 or not 0 <= plan['seed'] <= 2147483647:
            raise ValueError('Prepared traffic values outside range')
    return result


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    temporary.replace(path)


class NativeDashboardTools:
    def __init__(self, provider):
        self.provider = provider
        self.map = provider.world.world.get_map()
        self.map_name = self.map.name
        self.spawns = self.map.get_spawn_points()
        self.route = None
        self.native_route = []
        self.road_geometry = None
        self.planner = None
        self.settings_path = ROOT / 'config' / 'dashboard-preferences.json'
        self.places_path = ROOT / 'config' / ('places-' + self.map_name.split('/')[-1] + '.json')
        self.preferences = json.loads(self.settings_path.read_text(encoding='utf-8')) if self.settings_path.exists() else {}
        self.saved_places = json.loads(self.places_path.read_text(encoding='utf-8')) if self.places_path.exists() else []
        # Project labels for native road anchors, not fabricated real-world POIs.
        locations = [t.location for t in self.spawns]
        cx = sum(p.x for p in locations)/len(locations); cy = sum(p.y for p in locations)/len(locations)
        selections = [('وسط الخريطة', min(range(len(locations)), key=lambda i: (locations[i].x-cx)**2+(locations[i].y-cy)**2)),
                      ('شمال الخريطة', min(range(len(locations)), key=lambda i: locations[i].y)),
                      ('جنوب الخريطة', max(range(len(locations)), key=lambda i: locations[i].y)),
                      ('شرق الخريطة', max(range(len(locations)), key=lambda i: locations[i].x)),
                      ('غرب الخريطة', min(range(len(locations)), key=lambda i: locations[i].x)),
                      ('بداية الاختبار', min(152, len(locations)-1))]
        self.presets = [self.place(f'anchor-{index}', name, self.spawns[index].location, index) for name, index in selections]
        for i, transform in enumerate(self.spawns):
            point = transform.location
            sector = ('شمال' if point.y < cy else 'جنوب') + (' شرق' if point.x >= cx else ' غرب')
            place = self.place(f'road-point-{i}', '', point, i)
            place.update(name=f'{sector} · طريق {place["road_id"]} · نقطة {i+1}', sector=sector)
            self.presets.append(place)

    def place(self, place_id, name, location, spawn_index=None):
        waypoint = self.map.get_waypoint(location)
        return {'id': place_id, 'name': name, 'map': self.map_name,
                'location': [location.x, location.y, location.z], 'spawn_index': spawn_index,
                'road_id': waypoint.road_id, 'lane_id': waypoint.lane_id, 'source': 'CARLA_WORLD'}

    def places(self):
        favorites=set(self.preferences.get('favorite_places',{}).get(self.map_name,[]))
        return [{**p,'favorite':p['id'] in favorites} for p in self.presets+self.saved_places]

    def favorite_place(self, place_id):
        if not isinstance(place_id,str) or not any(p['id']==place_id for p in self.places()):
            raise ValueError('Favorite must refer to a place on the current native map')
        favorites=self.preferences.setdefault('favorite_places',{}).setdefault(self.map_name,[])
        if place_id in favorites: favorites.remove(place_id)
        else: favorites.append(place_id)
        write_json(self.settings_path,self.preferences)
        return {'id':place_id,'favorite':place_id in favorites}

    def roads(self):
        if self.road_geometry is None:
            segments = []
            for waypoint in self.map.generate_waypoints(4.):
                if waypoint.lane_type != self.provider.connection.api.LaneType.Driving:
                    continue
                a = waypoint.transform.location
                for following in waypoint.next(4.):
                    b = following.transform.location
                    segments.append([[a.x, a.y], [b.x, b.y]])
            flat = [point for line in segments for point in line]
            self.road_geometry = {'segments': segments, 'bounds': [
                min(p[0] for p in flat), min(p[1] for p in flat),
                max(p[0] for p in flat), max(p[1] for p in flat)],
                'source': 'CARLA_ROAD_GRAPH', 'sample_m': 4}
        return self.road_geometry

    def save_place(self, name):
        if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60:
            raise ValueError('Place name must contain 1-60 characters')
        name = name.strip()
        if len(self.saved_places) >= 30 and not any(p['name'] == name for p in self.saved_places):
            raise ValueError('Maximum 30 saved places per map')
        point = self.provider.ego.actor.get_location()
        place = self.place('saved-'+uuid.uuid4().hex[:12], name, point)
        self.saved_places = [p for p in self.saved_places if p['name'] != name]+[place]
        write_json(self.places_path, self.saved_places)
        return place

    def set_destination(self, place_id):
        # A rejected new selection must never leave an older driveable plan armed.
        self.route = None
        self.native_route = None
        if isinstance(place_id, dict):
            location = place_id.get('location')
            if not isinstance(location, list) or len(location) != 3 or any(
                    type(v) not in (int, float) or not math.isfinite(v) for v in location):
                raise ValueError('Destination must have three finite CARLA coordinates')
            native = self.provider.connection.api.Location(*location)
            waypoint = self.map.get_waypoint(native, project_to_road=True,
                                             lane_type=self.provider.connection.api.LaneType.Driving)
            point = waypoint.transform.location if waypoint else None
            if point is None or math.hypot(point.x-native.x, point.y-native.y) > 10:
                raise ValueError('اختار نقطة أقرب لطريق؛ أقصى مسافة مسموحة 10 أمتار')
            name = place_id.get('name', f'وجهة على طريق {waypoint.road_id}')
            if not isinstance(name, str) or not 1 <= len(name.strip()) <= 60:
                raise ValueError('Invalid destination name')
            target = self.place('map-'+uuid.uuid4().hex[:10], name.strip(), point)
        else:
            target = next((p for p in self.places() if p['id'] == place_id), None)
        if target is None:
            raise ValueError('Choose a saved or native map destination')
        if self.planner is None:
            # Official packaged deterministic road graph; no driving agent is instantiated.
            api_path = Path('C:/CARLA/CARLA_0.9.16/PythonAPI/carla')
            if str(api_path) not in sys.path:
                sys.path.insert(0, str(api_path))
            from agents.navigation.global_route_planner import GlobalRoutePlanner
            # Load controller dependencies while the route is being prepared,
            # before a driving lease is armed. This never instantiates an agent.
            from agents.navigation.basic_agent import BasicAgent
            self.planner = GlobalRoutePlanner(self.map, 4.)
        points = self.planner.trace_route(self.provider.ego.actor.get_location(),
                                         self.provider.connection.api.Location(*target['location']))
        if not points:
            raise ValueError('No drivable route to this destination')
        # GRP terminates within 2*sampling_resolution, which is 8 m here.
        # Retain the exact native destination waypoint so arrival is not early.
        from agents.navigation.local_planner import RoadOption
        final_waypoint = self.map.get_waypoint(self.provider.connection.api.Location(*target['location']))
        final_location = final_waypoint.transform.location
        last_location = points[-1][0].transform.location
        gap = last_location.distance(final_location)
        if gap > 8.1:
            raise ValueError('Native route does not reach the selected road waypoint')
        if gap > .5:
            points.append((final_waypoint, RoadOption.LANEFOLLOW))
        self.native_route = points
        polyline = [[wp.transform.location.x, wp.transform.location.y, wp.transform.location.z] for wp, _ in points]
        length = sum(math.dist(a, b) for a, b in zip(polyline, polyline[1:]))
        self.route = {'id': uuid.uuid4().hex, 'destination': target, 'points': polyline, 'length_m': length,
                      'source': 'CARLA_ROAD_GRAPH', 'mode': 'ROUTE_GUIDANCE',
                      'instructions': [{'location': polyline[i], 'action': option.name, 'point_index': i}
                                       for i, (_, option) in enumerate(points) if option.name != 'LANEFOLLOW'
                                       and (i == 0 or points[i-1][1] != option)]}
        return self.route

    def route_state(self):
        if self.route is None:
            return None
        position = self.provider.last_vehicle['positionWorldM'] if self.provider.last_vehicle else [0,0,0]
        nearest = min(range(len(self.route['points'])), key=lambda i: math.dist(position, self.route['points'][i]))
        remaining = math.dist(position, self.route['points'][nearest])+sum(math.dist(a,b) for a,b in zip(self.route['points'][nearest:], self.route['points'][nearest+1:]))
        upcoming = next((step for step in self.route['instructions'] if step['point_index'] >= nearest), None)
        return {**self.route, 'remaining_m': remaining, 'next_instruction': upcoming,
                'arrived': math.dist(position, self.route['destination']['location']) <= 5}

    def settings(self):
        p = self.provider
        native_weather = p.world.world.get_weather()
        return {'map': self.map_name, 'vehicle': p.ego.actor.type_id, 'spawn_index': p.spawn_index,
                'vehicles': p.catalog['vehicles'], 'maps': p.catalog['maps'],
                'simulation_hz': round(1/p.fixed_delta), **p.camera_settings,
                'weather': {key: getattr(native_weather, key) for key in WEATHER_RANGES},
                'next_launch': self.preferences.get('next_launch', {'quality':'Low', 'resolution':'1280x720'}),
                'traffic_plan': self.preferences.get('traffic_plan', {'vehicle_count':0,'speed_min_kmh':20,'speed_max_kmh':40,'seed':42}),
                'traffic_active': False, 'graphics_apply': 'RESTART_REQUIRED',
                'active_launch': getattr(p, 'active_launch', None),
                'camera_effects': {'supported': ['camera_postprocess','camera_motion_blur','camera_bloom'],
                                   'note': 'جودة Low قد تعطل مؤثرات الصورة مهما كانت القيم المحفوظة'}}

    def apply(self, settings):
        p = self.provider
        data = validate_settings(settings)
        if 'vehicle' in data and data['vehicle'] not in p.catalog['vehicles']:
            raise ValueError('Vehicle blueprint absent from native catalog')
        if 'spawn_index' in data and data['spawn_index'] >= len(self.spawns):
            raise ValueError('Spawn index absent from current map')
        recreates = any(k in data for k in ('camera_resolution','camera_fov','camera_postprocess',
                                           'camera_motion_blur','camera_bloom','simulation_hz','vehicle','spawn_index'))
        if recreates and p.last_vehicle and p.last_vehicle['speedMagnitudeMps'] > .15:
            raise ValueError('Stop the vehicle before changing camera, timing or vehicle settings')
        if recreates:
            # Stop acquisition before changing the native world step. Keeping old-rate
            # GPU cameras/LiDAR active while applying settings can stall the renderer.
            p.sensor_manager.close()
            if p.sensor_manager.cleanup_errors:
                raise RuntimeError('; '.join(p.sensor_manager.cleanup_errors))
            p.sensor_manager = None
            p.world.world.tick()
        if 'weather' in data:
            weather = p.world.world.get_weather()
            for key, value in data['weather'].items(): setattr(weather, key, value)
            p.world.world.set_weather(weather)
        for key in ('next_launch','traffic_plan'):
            if key in data: self.preferences[key] = data[key]
        if any(k in data for k in ('next_launch','traffic_plan')):
            write_json(self.settings_path, self.preferences)
        if 'simulation_hz' in data:
            p.fixed_delta = 1/data['simulation_hz']
            native = p.world.world.get_settings(); native.fixed_delta_seconds = p.fixed_delta
            p.world.world.apply_settings(native)
        p.camera_settings.update({k:v for k,v in data.items() if k.startswith('camera_')})
        if 'camera_view' in data and not recreates:
            p.sensor_manager.change_camera_view(p.connection.api, data['camera_view'])
        if any(k in data for k in ('vehicle','spawn_index')):
            p.blueprint = data.get('vehicle', p.blueprint); p.spawn_index = data.get('spawn_index', p.spawn_index)
            p.reset_vehicle()
        elif recreates:
            from .sensors import CarlaSensorManager
            p.sensor_manager = CarlaSensorManager(p.world.world, p.ego.actor)
            p.sensor_manager.enable_suite(p.connection.api, p.fixed_delta, p.camera_settings)
        return self.settings()
