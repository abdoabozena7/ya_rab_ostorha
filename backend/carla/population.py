"""Owned normal-city populations. Called only by the native simulation worker.

Traffic speed is a percentage below each road's speed limit, never an absolute
random speed. Native TM/walker controllers do not control the ego vehicle.
"""
import copy
import math
import random
from .urban import MIXTURES, WORLD_PROFILES, sample_driver, apply_driver

SPEED_DIFFERENCE = {'SLOW': 30., 'NORMAL': 15., 'FAST': 0.}
DEFAULT_POPULATION = {'vehicle_count': 0, 'pedestrian_count': 0,
                      'speed_behavior': 'NORMAL', 'seed': 42, 'fast_walk_percent': 10,
                      'driver_behavior': 'NORMAL', 'light_compliance_percent': 90,
                      'world_profile': 'TRAINING_DEVELOPMENT', 'crossing_percent': 5}


def validate_population(value):
    legacy = {'vehicle_count', 'pedestrian_count', 'speed_behavior', 'seed', 'fast_walk_percent'}
    if not isinstance(value, dict) or set(value)-set(DEFAULT_POPULATION) or not legacy <= set(value):
        raise ValueError('Population requires counts, speed behavior, seed and fast walk percent')
    value = {**DEFAULT_POPULATION, **value}
    for key, maximum in (('vehicle_count', 75), ('pedestrian_count', 50),
                         ('seed', 2147483647), ('fast_walk_percent', 20),
                         ('light_compliance_percent', 100), ('crossing_percent', 15)):
        if type(value[key]) is not int or not 0 <= value[key] <= maximum:
            raise ValueError(f'{key} must be an integer from 0 to {maximum}')
    if not isinstance(value['speed_behavior'], str) or value['speed_behavior'] not in SPEED_DIFFERENCE:
        raise ValueError('Traffic speed behavior must be SLOW, NORMAL or FAST')
    if not isinstance(value['driver_behavior'],str) or value['driver_behavior'] not in MIXTURES or not isinstance(value['world_profile'],str) or value['world_profile'] not in WORLD_PROFILES:
        raise ValueError('Unknown urban driver behavior or world profile')
    return dict(value)


def passenger_blueprints(library):
    """Native passenger cars, excluding bicycles, motorcycles, trucks and vans."""
    return sorted((bp for bp in library.filter('vehicle.*')
                   if bp.has_attribute('number_of_wheels') and
                   bp.get_attribute('number_of_wheels').as_int() == 4 and
                   bp.has_attribute('base_type') and
                   bp.get_attribute('base_type').as_str() == 'car' and 'police' not in bp.id), key=lambda bp: bp.id)


class TrafficManagerService:
    def __init__(self, client, port=8050):
        self.manager = client.get_trafficmanager(port)
        self.port = self.manager.get_port()
        self.connected = True
        self.manager.set_synchronous_mode(True)
        self.manager.set_hybrid_physics_mode(False)
        self.manager.set_global_distance_to_leading_vehicle(3.)

    def configure(self, speed_behavior, seed):
        self.manager.set_random_device_seed(seed)
        self.manager.global_percentage_speed_difference(SPEED_DIFFERENCE[speed_behavior])

    def normal_vehicle(self, actor):
        tm = self.manager
        tm.ignore_lights_percentage(actor, 0.)
        tm.ignore_signs_percentage(actor, 0.)
        tm.ignore_walkers_percentage(actor, 0.)
        tm.ignore_vehicles_percentage(actor, 0.)
        tm.auto_lane_change(actor, False)
        tm.update_vehicle_lights(actor, True)

    def close(self):
        self.manager.set_synchronous_mode(False)
        self.connected = False


class WorldPopulationManager:
    def __init__(self, client, world, api, ego_id):
        self.client, self.world, self.api, self.ego_id = client, world, api, ego_id
        self.map = world.get_map()
        self.traffic_manager = TrafficManagerService(client)
        self.config = dict(DEFAULT_POPULATION)
        self.random = random.Random(self.config['seed'])
        self.vehicles = set()
        self.driver_profiles = {}
        self.driver_ordinal = 0
        self.route_points = []
        self.road_candidates = None
        self.last_recycle_at = -float('inf')
        self.recycled_vehicles = self.recycled_walkers = 0
        self.local_counts = {'vehicles_120m': 0, 'walkers_120m': 0}
        self.walkers = {}  # walker ID -> controller ID, speed and native schedule
        self.pending_vehicles = set()
        self.seen_vehicles = set()
        self.missing_vehicle_frames = {}
        self.vehicles_removed_native = 0
        self.last_replacement_at = -float('inf')
        self.last_walker_replacement_at = -float('inf')
        self.errors = []
        self.spawn_report = {'npc_spawned': 0, 'npc_failed': 0, 'walkers_spawned': 0, 'walkers_failed': 0}
        self.frame_id = None
        self.walkers_lost = 0
        self.sidewalk_locations = None
        self.actual = {'vehicles': 0, 'pedestrians': 0, 'controllers': 0, 'walkers_active': 0}
        self.world.set_pedestrians_cross_factor(self.config['crossing_percent']/100.)
        self.state_cache = self._build_population_state()

    def apply(self, value):
        config = validate_population(value)
        # Explicit application only: stored preferences never populate a session.
        if config['seed'] != self.config['seed'] or not self.vehicles and not self.walkers:
            self.random = random.Random(config['seed'])
            if not self.vehicles and not self.walkers:self.driver_ordinal = 0
        self.config = config
        self.world.set_pedestrians_seed(config['seed'])
        self.world.set_pedestrians_cross_factor(config['crossing_percent']/100.)
        self.traffic_manager.configure(config['speed_behavior'], config['seed'])
        self.pending_vehicles.update(self.vehicles)
        self.spawn_report = {'npc_spawned': 0, 'npc_failed': 0, 'walkers_spawned': 0, 'walkers_failed': 0}
        self.spawn_traffic(config['vehicle_count'])
        self.spawn_pedestrians(config['pedestrian_count'])
        return self.get_population_state()

    def _destroy(self, ids):
        ids = list(ids)
        if not ids: return
        replies = self.client.apply_batch_sync([self.api.command.DestroyActor(i) for i in ids], False)
        failures = [f'{i}: {reply.error}' for i, reply in zip(ids, replies)
                    if reply.error and 'not found' not in reply.error.lower()]
        if failures:
            self.errors.extend(failures)
            raise RuntimeError('Population actor cleanup failed: ' + '; '.join(failures))

    def spawn_traffic(self, count, replacement=False):
        if type(count) is not int or not 0 <= count <= 75:
            raise ValueError('Traffic count must be 0–75')
        self.config['vehicle_count'] = count
        remove = sorted(self.vehicles, reverse=True)[:max(0, len(self.vehicles)-count)]
        self._destroy(remove)
        self.vehicles.difference_update(remove); self.pending_vehicles.difference_update(remove)
        self.seen_vehicles.difference_update(remove)
        for actor_id in remove: self.missing_vehicle_frames.pop(actor_id, None)
        for actor_id in remove: getattr(self, 'driver_profiles', {}).pop(actor_id, None)
        needed = count-len(self.vehicles)
        if needed <= 0: return
        blueprints = passenger_blueprints(self.world.get_blueprint_library())
        if not blueprints: raise RuntimeError('No native passenger vehicle blueprints')
        spawns = self._local_road_spawns(replacement)
        # Batch only as many attempts as required; retry occupied native road points.
        attempted = 0
        while needed and attempted < len(spawns):
            batch = []
            for transform in spawns[attempted:attempted+needed]:
                bp = self.random.choice(blueprints)
                bp.set_attribute('role_name', 'ostorha_npc')
                for name in ('color', 'driver_id'):
                    if bp.has_attribute(name) and bp.get_attribute(name).recommended_values:
                        bp.set_attribute(name, self.random.choice(bp.get_attribute(name).recommended_values))
                batch.append(self.api.command.SpawnActor(bp, transform).then(
                    self.api.command.SetAutopilot(self.api.command.FutureActor, True, self.traffic_manager.port)))
            attempted += len(batch)
            for reply in self.client.apply_batch_sync(batch, False):
                if not reply.error:
                    self.vehicles.add(reply.actor_id); self.pending_vehicles.add(reply.actor_id)
                    self.driver_profiles[reply.actor_id] = {'ordinal': self.driver_ordinal}
                    self.driver_ordinal += 1
                    self.spawn_report['npc_spawned'] += 1; needed -= 1
        self.spawn_report['npc_failed'] = needed

    def clear_traffic(self):
        self.spawn_traffic(0)

    def spawn_pedestrians(self, count, _attempt=0, replacement=False):
        if type(count) is not int or not 0 <= count <= 50:
            raise ValueError('Pedestrian count must be 0–50')
        self.config['pedestrian_count'] = count
        for walker_id in sorted(self.walkers, reverse=True)[:max(0, len(self.walkers)-count)]:
            self._remove_walker(walker_id)
        needed = count-len(self.walkers)
        library = self.world.get_blueprint_library()
        blueprints = sorted(library.filter('walker.pedestrian.*'), key=lambda bp: bp.id)
        batch, speeds = [], []
        chosen_locations = []
        frusta=self._view_frusta() if replacement else ()
        existing_locations = [entry['location'] for entry in self.walkers.values() if entry.get('location') is not None]
        for _ in range(max(100, needed*10)) if needed else ():
            if len(batch) >= needed: break
            location = self._sidewalk_destination()
            if location is None: continue
            if replacement:
                ego = self.world.get_actor(self.ego_id)
                if ego is not None and location.distance(ego.get_location()) < 120.: continue
                if self._spawn_visible(location,frusta):continue
            if any(location.distance(previous) < 1.5 for previous in chosen_locations+existing_locations): continue
            chosen_locations.append(location)
            bp = self.random.choice(blueprints)
            if bp.has_attribute('is_invincible'): bp.set_attribute('is_invincible', 'true')
            if bp.has_attribute('role_name'): bp.set_attribute('role_name', 'ostorha_walker')
            recommended = bp.get_attribute('speed').recommended_values if bp.has_attribute('speed') else []
            normal = float(recommended[1]) if len(recommended) > 1 else 1.4
            fast = self.random.random()*100 < self.config['fast_walk_percent']
            speeds.append(min(1.9, max(.9, normal*self.random.uniform(1.05, 1.15) if fast else normal*self.random.uniform(.8, 1.05))))
            batch.append(self.api.command.SpawnActor(bp, self.api.Transform(location)))
        spawned = []
        for reply, speed, location in zip(self.client.apply_batch_sync(batch, False), speeds, chosen_locations):
            if not reply.error: spawned.append((reply.actor_id, speed, location))
        controller = library.find('controller.ai.walker')
        replies = self.client.apply_batch_sync([
            self.api.command.SpawnActor(controller, self.api.Transform(), walker_id)
            for walker_id, _, _ in spawned], False) if spawned else []
        for (walker_id, speed, location), reply in zip(spawned, replies):
            if reply.error:
                self._destroy([walker_id])
            else:
                self.walkers[walker_id] = {'controller_id': reply.actor_id, 'speed': speed, 'started': False,
                                          'ready_at': None, 'destination': None, 'last_retarget': 0., 'seen': False,
                                          'location': location}
                self.walkers[walker_id].update(activity='IDLE', wait_until=None, crossing=False)
                self.spawn_report['walkers_spawned'] += 1
        self.spawn_report['walkers_failed'] = count-len(self.walkers)
        if self.spawn_report['walkers_failed'] and _attempt < 2:
            self.spawn_pedestrians(count, _attempt+1, replacement)

    def _remove_walker(self, walker_id):
        entry = self.walkers[walker_id]
        controller = self.world.get_actor(entry['controller_id'])
        if controller is not None and controller.is_alive and entry['started']:
            try: controller.stop()
            except RuntimeError as error:
                if 'not found' not in str(error).lower(): raise
        self._destroy([entry['controller_id'], walker_id])
        del self.walkers[walker_id]

    def clear_pedestrians(self):
        for walker_id in list(self.walkers): self._remove_walker(walker_id)
        self.config['pedestrian_count'] = 0

    def _sidewalk_destination(self, origin=None):
        native_map = self.map
        sidewalk = native_map.get_waypoint(origin, lane_type=self.api.LaneType.Sidewalk) if origin else None
        # Stay on the same sidewalk segment. CARLA navmesh contains crossings;
        # cross_factor=0 alone does not constrain all arbitrary target pairs.
        if self.sidewalk_locations is None:
            self.sidewalk_locations = []
            for _ in range(1500):
                location = self.world.get_random_location_from_navigation()
                if location is None: continue
                candidate = native_map.get_waypoint(location, lane_type=self.api.LaneType.Sidewalk)
                if candidate is None or candidate.transform.location.distance(location) > 2.: continue
                if native_map.get_waypoint(location, project_to_road=False, lane_type=self.api.LaneType.Driving) is not None: continue
                driving = native_map.get_waypoint(location, lane_type=self.api.LaneType.Driving)
                if driving and driving.transform.location.distance(location) < driving.lane_width*.5+1.25: continue
                self.sidewalk_locations.append((location, candidate.road_id, candidate.lane_id))
        if origin is None:
            candidates = self.sidewalk_locations
            ego = self.world.get_actor(self.ego_id)
            if ego is not None:
                position = ego.get_location()
                candidates = [c for c in candidates if 25. <= c[0].distance(position) <= 180.]
                # Favor nearby busy streets without manufacturing destinations.
                candidates.sort(key=lambda c: c[0].distance(position))
                candidates = candidates[:max(60, self.config['pedestrian_count']*4)]
        else:
            candidates = [(location, road, lane) for location, road, lane in self.sidewalk_locations
                          if sidewalk is not None and (road, lane) == (sidewalk.road_id, sidewalk.lane_id)
                          and 5. <= origin.distance(location) <= 40.]
        return self.random.choice(candidates)[0] if candidates else None

    def _crossing_destination(self, origin):
        sidewalk = self.map.get_waypoint(origin, lane_type=self.api.LaneType.Sidewalk)
        if sidewalk is None: return None
        candidates = []
        for location, road, lane in self.sidewalk_locations:
            if not 7. <= origin.distance(location) <= 22.:continue
            # Sidewalk IDs can differ across one crossing in Town10. Require
            # a native driving lane at the midpoint, plus valid navmesh ends.
            midpoint=self.api.Location((origin.x+location.x)/2,(origin.y+location.y)/2,(origin.z+location.z)/2)
            driving=self.map.get_waypoint(midpoint,project_to_road=False,lane_type=self.api.LaneType.Driving)
            if driving is not None:candidates.append(location)
        return self.random.choice(candidates) if candidates else None

    def _local_road_spawns(self, replacement):
        if self.road_candidates is None:
            waypoints = self.map.generate_waypoints(12.)
            self.road_candidates = []
            for wp in waypoints:
                if wp.is_junction or wp.lane_width < 2.5: continue
                t = wp.transform
                # Initial spawn height only; driving actors never interpolate.
                t.location.z += .3
                self.road_candidates.append(t)
        ego = self.world.get_actor(self.ego_id)
        if ego is None: return []
        position = ego.get_location()
        minimum = 120. if replacement else 28.
        candidates = [t for t in self.road_candidates if minimum <= t.location.distance(position) <= 200.]
        if replacement:
            frusta=self._view_frusta()
            candidates=[t for t in candidates if not self._spawn_visible(t.location,frusta)]
        occupied = [a.get_location() for a in self.world.get_actors().filter('vehicle.*')]
        candidates = [t for t in candidates if all(t.location.distance(p) >= 9. for p in occupied)]
        self.random.shuffle(candidates)
        def score(t):
            distance = t.location.distance(position)
            route_gap = min((t.location.distance(p) for p in self.route_points), default=distance)
            return min(distance, route_gap+35.)
        candidates.sort(key=score)
        # Native points cover both legal driving directions. SpawnActor rejects
        # occupied volumes, retaining actual counts rather than claimed counts.
        return candidates

    def _view_frusta(self):
        """Conservative native RGB visibility, including rear/chase/top views."""
        frusta=[]
        for camera in self.world.get_actors().filter('sensor.camera.rgb'):
            transform=camera.get_transform();attributes=camera.attributes
            horizontal=math.tan(math.radians(float(attributes.get('fov',90))*.5))
            aspect=float(attributes.get('image_size_x',800))/float(attributes.get('image_size_y',450))
            frusta.append((transform.location,transform.get_forward_vector(),transform.get_right_vector(),
                           transform.get_up_vector(),horizontal,horizontal/aspect))
        return frusta

    @staticmethod
    def _spawn_visible(location,frusta):
        # Three-meter padding rejects objects intersecting a view edge. Native
        # occlusion is deliberately not assumed when choosing hidden spawns.
        for origin,forward,right,up,horizontal,vertical in frusta:
            delta=(location.x-origin.x,location.y-origin.y,location.z-origin.z)
            dot=lambda axis:sum(value*getattr(axis,key) for value,key in zip(delta,('x','y','z')))
            depth=dot(forward)
            if depth>-3. and abs(dot(right))<=max(depth,0.)*horizontal+3. and abs(dot(up))<=max(depth,0.)*vertical+3.:return True
        return False

    def set_route(self, points):
        self.route_points = [self.api.Location(*p) for p in (points or [])[::3]]

    def reset_population(self):
        self.clear_pedestrians(); self.clear_traffic()
        self.actual = dict(vehicles=0, pedestrians=0, controllers=0, walkers_active=0)

    def update(self, snapshot):
        """Register controllers after the sole worker has advanced the native frame."""
        timestamp = snapshot.timestamp.elapsed_seconds
        ego_snapshot = snapshot.find(self.ego_id) if hasattr(self, 'ego_id') else None
        ego_position = ego_snapshot.get_transform().location if ego_snapshot is not None else None
        if ego_position is not None and timestamp-self.last_recycle_at >= 10.:
            self.last_recycle_at = timestamp
            frusta=self._view_frusta()
            nearby=sum(snapshot.find(i) is not None and snapshot.find(i).get_transform().location.distance(ego_position)<=120.
                       for i in self.vehicles)
            # Circulating fleets can drift within the wider retirement radius.
            # Retire a bounded number of hidden distant actors under local
            # density pressure, then replenish through normal physical spawns.
            retirement_radius=180. if nearby<self.config['vehicle_count']*.6 else 300.
            # Beyond all camera ranges used by this project; bounded retirement
            # avoids a mass reset while ego traverses the map.
            distant = [i for i in sorted(self.vehicles) if snapshot.find(i) is not None
                       and snapshot.find(i).get_transform().location.distance(ego_position) > retirement_radius
                       and not self._spawn_visible(snapshot.find(i).get_transform().location,frusta)][:3]
            self._destroy(distant)
            for i in distant:
                self.vehicles.discard(i); self.pending_vehicles.discard(i); self.seen_vehicles.discard(i)
                self.driver_profiles.pop(i, None); self.missing_vehicle_frames.pop(i, None)
            self.recycled_vehicles += len(distant)
            for i, entry in list(self.walkers.items()):
                if snapshot.find(i) is not None and snapshot.find(i).get_transform().location.distance(ego_position) > 300. and not self._spawn_visible(snapshot.find(i).get_transform().location,frusta):
                    self._remove_walker(i); self.recycled_walkers += 1
                    break
        active = 0
        removed = []
        for actor_id in self.vehicles:
            if snapshot.find(actor_id) is not None:
                self.seen_vehicles.add(actor_id)
                self.missing_vehicle_frames.pop(actor_id, None)
            elif actor_id in self.seen_vehicles:
                missing = self.missing_vehicle_frames.get(actor_id, 0)+1
                self.missing_vehicle_frames[actor_id] = missing
                # get_actor()/is_alive can retain a stale SDK description. Two
                # consecutive authoritative snapshots confirm absence instead.
                if missing >= 2: removed.append(actor_id)
        for actor_id in removed:
            self._destroy([actor_id])
            self.vehicles.remove(actor_id); self.pending_vehicles.discard(actor_id); self.seen_vehicles.discard(actor_id)
            self.missing_vehicle_frames.pop(actor_id, None)
            getattr(self, 'driver_profiles', {}).pop(actor_id, None)
            self.vehicles_removed_native += 1
        # TM may destroy blocked vehicles. Replace only the missing owned NPCs,
        # outside the ego's immediate view, without resetting the world or fleet.
        if len(self.vehicles) < self.config['vehicle_count'] and timestamp-self.last_replacement_at >= 5.:
            self.last_replacement_at = timestamp
            self.spawn_traffic(self.config['vehicle_count'], replacement=True)
        for actor_id in list(self.pending_vehicles):
            actor = self.world.get_actor(actor_id)
            if actor is not None and actor.is_alive:
                entry = self.driver_profiles[actor_id]
                profile = sample_driver(self.config['seed'], entry['ordinal'], self.config['driver_behavior'],
                                        SPEED_DIFFERENCE[self.config['speed_behavior']], self.config['light_compliance_percent'])
                apply_driver(self.traffic_manager.manager, actor, profile)
                self.driver_profiles[actor_id] = {**profile, 'ordinal': entry['ordinal']}
                self.pending_vehicles.remove(actor_id)
        for walker_id, entry in list(self.walkers.items()):
            actor = snapshot.find(walker_id)
            controller = self.world.get_actor(entry['controller_id'])
            if actor is None:
                if entry['seen']:
                    entry['missing_frames'] = entry.get('missing_frames', 0)+1
                    if entry['missing_frames'] >= 2:
                        self._remove_walker(walker_id); self.walkers_lost += 1
                continue
            entry['seen'] = True
            entry['missing_frames'] = 0
            entry['location'] = actor.get_transform().location
            if entry.get('motion_location') is None or entry['location'].distance(entry['motion_location']) > .05:
                entry['motion_location'] = entry['location']
                entry['last_moved_at'] = timestamp
            if controller is None or not controller.is_alive: continue
            if entry['ready_at'] is None: entry['ready_at'] = timestamp+self.random.uniform(0., 2.)
            if timestamp < entry['ready_at']: continue
            if not entry['started']:
                controller.start(); controller.set_max_speed(entry['speed']); entry['started'] = True
            active += 1
            if entry.get('wait_until') is not None:
                if timestamp < entry['wait_until']: continue
                controller.set_max_speed(entry['speed']); entry['wait_until'] = None
                entry['destination'] = None
            destination = entry['destination']
            reached = destination is not None and actor.get_transform().location.distance(destination) < 2.
            # Retarget stationary walkers after 20 simulation seconds; never teleport.
            stationary = timestamp-entry['last_moved_at'] > 20. and timestamp-entry['last_retarget'] > 20.
            if destination is None or reached or stationary:
                if reached and self.random.random() < .35:
                    entry.update(activity='WAITING', wait_until=timestamp+self.random.uniform(2.,6.))
                    controller.set_max_speed(0.)
                    continue
                entry['activity'] = 'RESELECTING_DESTINATION'
                target = self._sidewalk_destination(actor.get_transform().location)
                crossing = self.random.random()*100 < self.config['crossing_percent']
                crossing_target = self._crossing_destination(entry['location']) if crossing else None
                if crossing_target is not None: target = crossing_target
                if target is not None:
                    controller.go_to_location(target); entry['destination'] = target; entry['last_retarget'] = timestamp
                    entry['activity'] = 'WALKING'
                    entry['crossing'] = crossing_target is not None
            if entry.get('crossing') and entry.get('wait_until') is None:
                on_road=self.map.get_waypoint(entry['location'],project_to_road=False,lane_type=self.api.LaneType.Driving)
                entry['activity']='CROSSING' if on_road is not None else 'WALKING'
        if len(self.walkers) < self.config['pedestrian_count'] and timestamp-self.last_walker_replacement_at >= 5.:
            self.last_walker_replacement_at = timestamp
            self.spawn_pedestrians(self.config['pedestrian_count'], replacement=True)
        self.frame_id = snapshot.frame
        if ego_position is not None:
            self.local_counts = {name:sum(snapshot.find(i) is not None and
                snapshot.find(i).get_transform().location.distance(ego_position) <= 120. for i in ids)
                for name,ids in [('vehicles_120m',self.vehicles),('walkers_120m',self.walkers)]}
        self.actual = {'vehicles': sum(snapshot.find(i) is not None for i in self.vehicles),
                       'pedestrians': sum(snapshot.find(i) is not None for i in self.walkers),
                       'controllers': sum(snapshot.find(e['controller_id']) is not None for e in self.walkers.values()),
                       'walkers_active': active}
        self.state_cache = self._build_population_state()

    def get_population_state(self):
        # Readers never iterate the ownership dictionaries during worker mutation.
        # Each cache publication describes one native snapshot, including its ID.
        return copy.deepcopy(self.state_cache)

    def _build_population_state(self):
        return {'frame_id': self.frame_id, 'requested': dict(self.config), 'actual': dict(self.actual),
                **self.spawn_report, 'traffic_manager_connected': self.traffic_manager.connected,
                'traffic_manager_port': self.traffic_manager.port,
                'desired_speed_difference_percent': SPEED_DIFFERENCE[self.config['speed_behavior']],
                'vehicle_ids': sorted(self.vehicles),
                'walker_ids': sorted(self.walkers),
                'controller_ids': sorted(e['controller_id'] for e in self.walkers.values()),
                'errors': list(self.errors), 'walkers_lost': self.walkers_lost,
                'vehicles_removed_native': self.vehicles_removed_native,
                'behavior': self.config['driver_behavior'],
                'driver_profiles': {str(i):dict(p) for i,p in getattr(self, 'driver_profiles', {}).items()},
                'local_counts': getattr(self, 'local_counts', {}),
                'recycled_vehicles': getattr(self, 'recycled_vehicles', 0),
                'recycled_walkers': getattr(self, 'recycled_walkers', 0),
                'activity_counts': {state:sum(e.get('activity','IDLE') == state for e in self.walkers.values())
                                    for state in ('WALKING','WAITING','CROSSING','IDLE','RESELECTING_DESTINATION')},
                'pedestrian_cross_factor': self.config['crossing_percent']/100., 'walker_invincible': True,
                'destinations': 'NATIVE_SIDEWALK_WITH_BOUNDED_OPTIONAL_CROSSINGS'}

    def close(self):
        try:
            self.reset_population()
        finally:
            self.traffic_manager.close()
