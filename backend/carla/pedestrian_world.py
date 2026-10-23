"""Native construction of the pedestrian behavior suite (evaluator side only).

Walker scripts, triggers, native actor poses and future positions are never
ControlScene or controller inputs. Unsupported or invalid constructions raise
explicitly; no other location, geometry or behavior is substituted.
"""
import math
import numpy as np
from ..core.pedestrian_behaviors import (WalkerScript, identity, lateral_profile, project_polyline,
                                         validate_spec, verify_realization)


def straight_route(start, length_m, step=2.):
    """Deterministic straight-preferring native route used by the location probe."""
    path = [start]
    while len(path)*step < length_m:
        choices = path[-1].next(step)
        if not choices:raise RuntimeError('Route ends before the required journey length')
        heading = path[-1].transform.rotation.yaw
        choices.sort(key=lambda q: (abs((q.transform.rotation.yaw-heading+180) % 360-180), q.road_id, q.lane_id))
        path.append(choices[0])
    return path


def lateral_scan(world_map, api, waypoint, half_width=18., step=.25):
    t = waypoint.transform;right = t.get_right_vector();samples = []
    for i in range(int(-half_width/step), int(half_width/step)+1):
        y = i*step
        location = api.Location(t.location.x+right.x*y, t.location.y+right.y*y, t.location.z+.5)
        found = world_map.get_waypoint(location, project_to_road=False, lane_type=api.LaneType.Any)
        samples.append((y, str(found.lane_type) if found is not None else 'NONE'))
    return samples


class PedestrianBehaviorWorld:
    def __init__(self, provider):
        self.p = provider;self.actors = [];self.walkers = {};self.scripts = {};self.errors = []
        self.started = None;self.samples = {};self.spec = None;self.manifest = None;self.extents = {}

    def close(self):
        for actor in reversed(self.actors):
            try:
                if actor.is_alive and not actor.destroy():self.errors.append(f'Actor cleanup failed: {actor.id}')
            except RuntimeError as error:self.errors.append(str(error))
        self.actors = [];self.walkers = {}
        errors, self.errors = self.errors, []
        if errors:raise RuntimeError('; '.join(errors))

    def setup(self, spec, *, reset=None):
        validate_spec(spec, allow_counterfactual=True, allow_ordinary=True)
        p = self.p;api = p.connection.api;world = p.world.world;native_map = world.get_map()
        town = native_map.name.split('/')[-1]
        if town != spec['location']['town']:
            raise ValueError(f"Scenario requires {spec['location']['town']}; native map is {town}. No map substitution")
        spawns = native_map.get_spawn_points();index = spec['location']['spawn_index']
        if type(index) is not int or not 0 <= index < len(spawns):raise ValueError('Invalid native spawn index')
        self.spec = spec;self.samples = {};self.scripts = {};self.walkers = {};self.started = None
        p.scenarios.living_city();p.population.reset_population()
        p.spawn_index = index;p.strict_ego_spawn = True;(reset or p.reset_vehicle)()
        start = native_map.get_waypoint(spawns[index].location, lane_type=api.LaneType.Driving)
        if start is None or start.is_junction:raise RuntimeError('Fixture spawn is not on a regular driving lane')
        path = straight_route(start, spec['route_length_m'])
        self.path = path
        self.route = np.array([[q.transform.location.x, q.transform.location.y] for q in path])
        self.route_points = [[q.transform.location.x, q.transform.location.y, q.transform.location.z] for q in path]
        geometry = p.vehicle_geometry
        self.corridor_half_width = float(geometry.half_width_m)+.25
        self.front_m = float(geometry.front_m)
        library = world.get_blueprint_library();walker_blueprints = sorted(library.filter('walker.pedestrian.*'), key=lambda b: b.id)
        placements = {}
        for plan in spec['pedestrians']:
            waypoint = path[min(len(path)-1, int(round(plan['along_m']/2.)))]
            if waypoint.is_junction:raise RuntimeError('Pedestrian placement falls inside a junction')
            profile = lateral_profile(lateral_scan(native_map, api, waypoint))
            sign = 1. if plan['side'] == 'RIGHT' else -1.
            near = abs(profile['right' if sign > 0 else 'left']['curb_m'])
            far = abs(profile['left' if sign > 0 else 'right']['curb_m'])
            width = profile['right' if sign > 0 else 'left']['sidewalk_width_m']
            if plan['curb_offset_m'] > width-.2:raise RuntimeError('Pedestrian start exceeds the measured sidewalk width')
            script = WalkerScript(plan, near_u=near, far_u=far)
            u = script.start_u;y = sign*u
            t = waypoint.transform;right = t.get_right_vector()
            location = api.Location(t.location.x+right.x*y, t.location.y+right.y*y, t.location.z+1.)
            facing = t.rotation.yaw+(-90. if sign > 0 else 90.)
            if plan['script'] == 'PARALLEL':facing = t.rotation.yaw+(0. if plan['direction'] > 0 else 180.)
            blueprint = walker_blueprints[plan['blueprint_index'] % len(walker_blueprints)]
            if blueprint.has_attribute('role_name'):blueprint.set_attribute('role_name', 'ostorha_participant_suite_'+plan['role'])
            if blueprint.has_attribute('is_invincible'):blueprint.set_attribute('is_invincible', 'false')
            # Static street furniture can occupy the nominal spot. Search a
            # bounded, deterministic set of sidewalk displacements and record
            # the actual one; the behavior and route segment never change.
            actor = None
            for shift in (0., .8, -.8, 1.6, -1.6, 2.4, -2.4):
                forward = t.get_forward_vector()
                location = api.Location(t.location.x+right.x*y+forward.x*shift, t.location.y+right.y*y+forward.y*shift, t.location.z+1.)
                actor = world.try_spawn_actor(blueprint, api.Transform(location, api.Rotation(yaw=facing)))
                if actor is not None:break
            if actor is None:raise RuntimeError(f"Invalid pedestrian spawn for {plan['role']}; no geometry substitution")
            self.actors.append(actor);self.walkers[plan['role']] = actor;self.scripts[plan['role']] = script
            placements[plan['role']] = {'near_curb_m': near, 'far_curb_m': far, 'side_sign': sign,
                'sidewalk_width_m': width, 'start_u_m': u, 'road_width_m': profile['road_width_m'],
                'blueprint': blueprint.id, 'location': [location.x, location.y, location.z], 'along_adjustment_m': shift}
        self.placements = placements
        if spec.get('occluder'):
            plan = spec['occluder'];waypoint = path[min(len(path)-1, int(round(plan['along_m']/2.)))]
            ped = next(v for v in placements.values() if v['side_sign'] > 0)
            u = ped['near_curb_m']-plan['curb_inset_m']
            blueprint = library.find(plan['blueprint'])
            half = None
            if blueprint.has_attribute('role_name'):blueprint.set_attribute('role_name', 'ostorha_participant_suite_occluder')
            t = waypoint.transform;right = t.get_right_vector();forward = t.get_forward_vector();actor = None
            for inset_extra in (0., .2, .4):
                for shift in (0., .5, -.5, 1., -1.):
                    lateral = u-inset_extra
                    location = api.Location(t.location.x+right.x*lateral+forward.x*shift,
                                            t.location.y+right.y*lateral+forward.y*shift, t.location.z+1.)
                    actor = world.try_spawn_actor(blueprint, api.Transform(location, t.rotation))
                    if actor is not None:break
                if actor is not None:break
            if actor is None:raise RuntimeError('Invalid parked occluder spawn; no geometry substitution')
            u = lateral
            self.actors.append(actor);actor.apply_control(api.VehicleControl(brake=1., hand_brake=True))
            half = actor.bounding_box.extent.y
            if u-half <= self.corridor_half_width+.3:
                raise RuntimeError('Parked occluder would intrude into the planned corridor')
            self.occluder = {'id': actor.id, 'blueprint': plan['blueprint'], 'u_m': u, 'half_width_m': half,
                             'along_m': plan['along_m']+shift, 'along_adjustment_m': shift, 'inset_adjustment_m': inset_extra,
                             'location': [location.x, location.y, location.z]}
        else:self.occluder = None
        self.manifest = {'version': 1, 'catalogue': spec['catalogue'], 'scenario_id': spec['scenario_id'],
            'split': spec['split'], 'seed': spec['seed'], 'behavior': spec['behavior'], 'map': town,
            'spawn_index': index, 'route': self.route_points, 'placements': placements, 'occluder': self.occluder,
            'corridor_half_width_m': self.corridor_half_width, 'ego_front_m': self.front_m,
            'full_native_physics': True, 'in_episode_teleport': False,
            'truth_policy': 'EVALUATOR_ONLY_NEVER_CONTROL_INPUT', 'spec': spec}
        return self.manifest

    def configure_route(self):
        p = self.p;actual = p.ego.actor.get_transform();intended = self.path[0].transform
        if math.dist((actual.location.x, actual.location.y), (intended.location.x, intended.location.y)) > 2.5:
            raise RuntimeError('Settled native ego pose differs from the requested fixture spawn')
        p.dashboard_tools.set_destination({'location': self.route_points[-1], 'name': 'Pedestrian suite destination'})
        route = p.route_state()
        expected = float(np.sum(np.linalg.norm(np.diff(self.route, axis=0), axis=1)))
        if route is None or route['length_m'] > expected+12.:
            raise RuntimeError('Native routing took an unintended detour; scenario invalid')
        self.manifest['native_route_length_m'] = route['length_m']
        # Signal phases restart here, a fixed number of ticks before the journey,
        # so every configuration and counterfactual arm meets the same phases.
        world = p.world.world
        if hasattr(world, 'reset_all_traffic_lights'):
            world.reset_all_traffic_lights();self.manifest['traffic_lights'] = 'RESET_AT_ROUTE_CONFIGURATION'
        else:self.manifest['traffic_lights'] = 'NOT_RESET_API_UNAVAILABLE'
        traffic = self.spec['traffic']
        if traffic['vehicles'] or traffic['pedestrians']:
            self.prepare_background(p.population, p.dashboard_tools.route['points'],
                                    p.world.world.get_snapshot().timestamp.elapsed_seconds)
            p.population.apply({**p.population.config, 'seed': self.spec['seed'], 'vehicle_count': traffic['vehicles'],
                                'pedestrian_count': traffic['pedestrians'], 'placement': 'EGO_SURROUNDING',
                                'vehicle_mix': 'MIXED'})
        return route

    @staticmethod
    def prepare_background(population, route_points, now_s):
        """Make background construction depend only on this episode's spec.

        The provider publishes the route to the population on the next tick, so
        without this the placement scoring used the previous episode's route
        (the first configuration of every scenario differed from the rest). The
        navmesh sidewalk cache is rebuilt after this episode's pedestrian seed,
        and housekeeping timers restart at construction rather than inheriting
        the previous episode's phase."""
        population.set_route(route_points)
        population.sidewalk_locations = None
        population.last_recycle_at = population.last_replacement_at = population.last_walker_replacement_at = float(now_s)

    def begin(self, timestamp_s):
        self.started = timestamp_s
        self.manifest['initial_truth'] = self.truth()
        self.manifest['ego_initial'] = self._ego_pose()
        self.manifest['condition_hash'] = identity({'spec': self.spec['scenario_id'], 'route': self.route_points,
            'placements': self.placements, 'occluder': self.occluder})

    def _ego_pose(self):
        t = self.p.ego.actor.get_transform()
        return {'position_m': [t.location.x, t.location.y, t.location.z], 'yaw_rad': math.radians(t.rotation.yaw)}

    def ego_route_front(self):
        t = self.p.ego.actor.get_transform()
        s, d = project_polyline([[t.location.x, t.location.y]], self.route)
        return float(s[0])+self.front_m, float(d[0])

    def before_tick(self, timestamp_s):
        """Command scripted walkers for the next native tick (construction schedule)."""
        if self.started is None:return
        api = self.p.connection.api;elapsed = timestamp_s-self.started
        front, _ = self.ego_route_front()
        for role, actor in self.walkers.items():
            script = self.scripts[role];plan = script.plan;placement = self.placements[role]
            location = actor.get_location()
            s, d = project_polyline([[location.x, location.y]], self.route)
            u = placement['side_sign']*float(d[0])
            along, toward, phase = script.command(elapsed, u, ego_distance_m=plan['along_m']-front)
            index = min(len(self.route)-2, max(0, int(np.searchsorted(np.r_[0., np.cumsum(np.linalg.norm(np.diff(self.route, axis=0), axis=1))], s[0])-1)))
            tangent = self.route[index+1]-self.route[index];tangent = tangent/np.linalg.norm(tangent)
            normal = np.array([-tangent[1], tangent[0]])
            velocity = tangent*along-placement['side_sign']*normal*toward
            speed = float(np.linalg.norm(velocity))
            if speed > 1e-6:
                direction = velocity/speed
                actor.apply_control(api.WalkerControl(direction=api.Vector3D(float(direction[0]), float(direction[1]), 0.), speed=speed))
            else:actor.apply_control(api.WalkerControl(speed=0.))
            v = actor.get_velocity()
            self.samples.setdefault(role, []).append((elapsed, float(s[0]), u, math.hypot(v.x, v.y), phase))

    def truth(self, snapshot=None):
        """Evaluator rows for every native walker and vehicle except the ego."""
        p = self.p;world = p.world.world;ego = p.ego.actor.id;roles = {a.id: r for r, a in self.walkers.items()}
        rows = [];actors = world.get_actors()
        for actor in list(actors.filter('vehicle.*'))+list(actors.filter('walker.pedestrian.*')):
            if actor.id == ego or not actor.is_alive:continue
            if actor.id not in self.extents:
                e = actor.bounding_box.extent;self.extents[actor.id] = [e.x, e.y]
            item = snapshot.find(actor.id) if snapshot is not None else None
            t = (item or actor).get_transform();v = (item or actor).get_velocity()
            rows.append({'id': actor.id, 'role': roles.get(actor.id, 'occluder' if self.occluder and actor.id == self.occluder['id'] else 'background'),
                         'kind': 'walker' if actor.type_id.startswith('walker.') else 'vehicle',
                         'position_m': [t.location.x, t.location.y, t.location.z], 'yaw_deg': t.rotation.yaw,
                         'velocity_mps': [v.x, v.y, v.z], 'half_size_m': self.extents[actor.id]})
        return rows

    def realization(self):
        result = {}
        for role, script in self.scripts.items():
            placement = self.placements[role];rows = [r[:4] for r in self.samples.get(role, [])]
            triggered = script.triggered_at
            if script.plan['script'] not in ('WAIT', 'PARALLEL') and triggered is None:
                result[role] = {'realized': False, 'reason': 'TRIGGER_NOT_REACHED', 'phases': script.history};continue
            check = verify_realization(script.plan, rows, near_u=placement['near_curb_m'], far_u=placement['far_curb_m'],
                corridor_half_width_m=self.corridor_half_width)
            result[role] = {**check, 'script': script.plan['script'], 'triggered_at_s': triggered, 'phases': script.history}
        return result
