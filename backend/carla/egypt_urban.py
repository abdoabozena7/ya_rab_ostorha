"""Seeded physical urban events and scoring, isolated from the ego driver."""
import copy
import hashlib
import json
import math
import random
import time
from .dense_chaos import DenseChaos
from ..core.egypt_urban import SCENARIO_ID, PROTOCOL, EventLedger, configuration, event_realized


def xyz(location):
    return [float(location.x), float(location.y), float(location.z)]


def route_arcs(native):
    arcs = [0.]
    for (a, _), (b, _) in zip(native, native[1:]):
        arcs.append(arcs[-1] + a.transform.location.distance(b.transform.location))
    return arcs


def permitted_neighbour(wp, side):
    neighbour = getattr(wp, 'get_' + side + '_lane')()
    if neighbour is None or str(neighbour.lane_type) != 'Driving' or wp.is_junction or neighbour.is_junction:
        return None
    a, b = wp.transform.get_forward_vector(), neighbour.transform.get_forward_vector()
    permission = str(wp.lane_change)
    return neighbour if (neighbour.lane_width >= 2.8 and a.x * b.x + a.y * b.y > .9
                         and (side.title() in permission or 'Both' in permission)) else None


def validate_route(native):
    config = configuration()
    arcs = route_arcs(native)
    gaps = [b - a for a, b in zip(arcs, arcs[1:])]
    opportunities = []
    last = -100.
    for index, (wp, _) in enumerate(native):
        if arcs[index] < 65. or arcs[index] - last < 95. or arcs[-1] - arcs[index] < 75.:
            continue
        end = next((i for i in range(index, len(native)) if arcs[i] - arcs[index] >= 65.), None)
        if end is None:
            continue
        sides = [side for side in ('left', 'right')
                 if all(permitted_neighbour(native[i][0], side) is not None for i in range(index, end + 1))]
        if sides:
            opportunities.append({'progress_m': arcs[index], 'index': index, 'sides': sides})
            last = arcs[index]
    gates = {'length_600_to_800_m': config['route_minimum_m'] <= arcs[-1] <= config['route_maximum_m'],
             'connected_driving_lanes': bool(gaps) and max(gaps) <= 8.1
                 and all(str(w.lane_type) == 'Driving' for w, _ in native)
                 and native[0][0].transform.location.distance(native[-1][0].transform.location) >= 50.,
             'three_separated_passing_sections': len(opportunities) >= 3}
    return {'passed': all(gates.values()), 'gates': gates, 'length_m': arcs[-1],
            'maximum_segment_gap_m': max(gaps, default=0.), 'passing_sections': opportunities[:3]}


def prepare_route(provider, seed):
    p = provider
    tools = p.dashboard_tools
    if tools.map_name.rsplit('/', 1)[-1] != configuration()['map']:
        raise ValueError('Egypt urban chaos requires Town10HD_Opt')
    rng = random.Random(seed)
    indices = list(range(len(tools.spawns)))
    rng.shuffle(indices)
    failures = []
    for index in indices[:24]:
        origin = tools.spawns[index]
        waypoint = tools.map.get_waypoint(origin.location)
        visited = set()
        anchors = []
        travelled = 0.
        previous = waypoint.transform.location
        for _ in range(370):
            choices = sorted(waypoint.next(2.), key=lambda w: (w.road_id, w.section_id, w.lane_id, w.s))
            choices = [w for w in choices if (w.road_id, w.section_id, w.lane_id, round(w.s / 2.)) not in visited]
            if not choices:
                break
            waypoint = choices[rng.randrange(len(choices))]
            visited.add((waypoint.road_id, waypoint.section_id, waypoint.lane_id, round(waypoint.s / 2.)))
            travelled += previous.distance(waypoint.transform.location)
            previous = waypoint.transform.location
            if travelled >= (len(anchors) + 1) * 175.:
                anchors.append(xyz(previous))
            if travelled >= 710.:
                break
        if travelled < 650.:
            failures.append('Topology walk ended before 650 m')
            continue
        destination = {'map': tools.map_name, 'location': xyz(previous), 'via': anchors,
                       'name': 'Egypt mixed urban destination'}
        if anchors and math.dist(anchors[-1], destination['location']) < 10.:
            destination['via'] = anchors[:-1]
        route, native = tools.route_service.plan(origin.location, destination)
        validation = validate_route(native)
        if not validation['passed']:
            failures.append(validation['gates'])
            continue
        from .route_crowding import route_slots
        _, capacity = route_slots(native, origin.location, p.connection.api, maximum=60)
        if capacity['target_count'] < 60:
            failures.append('Route has fewer than 60 physical traffic spaces')
            continue
        p.ego.actor.set_target_velocity(p.connection.api.Vector3D())
        p.ego.actor.set_target_angular_velocity(p.connection.api.Vector3D())
        p.ego.actor.set_transform(origin)
        tools.route, tools.native_route = route, native
        p.population.set_route(route['points'])
        p.set_paused(False)
        return {'destination': destination, 'route_length_m': route['length_m'], 'route_validation': validation,
                'origin_index': index, 'planned_vehicle_capacity': capacity['target_count'],
                'scenario_id': SCENARIO_ID, 'scenario_version': 1, 'scenario_seed': seed,
                'selection_seed': seed, 'scene': 'DENSE_CHAOS', 'population_pending': True,
                'requested_route_vehicles': 60, 'requested_route_pedestrians': 100, 'speed_kmh': 60}
    raise ValueError('No connected 600--800 m Egypt route with maneuver space: ' + str(failures))


def finish_prepare(p, seed, setup):
    pop = p.population
    config = {**pop.config, 'vehicle_count': 0, 'pedestrian_count': 100, 'seed': seed,
              'chaos_percent': 65, 'speed_behavior': 'NORMAL', 'driver_behavior': 'BUSY',
              'light_compliance_percent': 80, 'crossing_percent': 35,
              'placement': 'ROUTE', 'vehicle_mix': 'MIXED', 'fast_walk_percent': 20}
    pop.apply(config)
    pop.crowd_route(p.dashboard_tools.route, p.dashboard_tools.native_route,
                    {'route_id': p.dashboard_tools.route['id'], 'seed': seed, 'chaos_percent': 65, 'vehicle_count': 60})
    if len(pop.vehicles) != 60 or len(pop.walkers) != 100:
        raise ValueError(f'Egypt requested 60/100; native construction admitted {len(pop.vehicles)}/{len(pop.walkers)}')
    p.dense_chaos = EgyptUrbanChaos(p, seed, setup['route_validation'])
    return {**setup, 'population_pending': False, 'population': dict(pop.config)}


def rectangle(pose, bounds):
    yaw = math.radians(pose.rotation.yaw)
    offset = bounds.location
    center = (pose.location.x + offset.x * math.cos(yaw) - offset.y * math.sin(yaw),
              pose.location.y + offset.x * math.sin(yaw) + offset.y * math.cos(yaw))
    yaw += math.radians(bounds.rotation.yaw)
    return [(center[0] + x * math.cos(yaw) - y * math.sin(yaw),
             center[1] + x * math.sin(yaw) + y * math.cos(yaw))
            for x, y in ((-bounds.extent.x, -bounds.extent.y), (bounds.extent.x, -bounds.extent.y),
                         (bounds.extent.x, bounds.extent.y), (-bounds.extent.x, bounds.extent.y))]


def body_separation(a, b):
    def edges(poly):
        return list(zip(poly, poly[1:] + poly[:1]))
    for polygon in (a, b):
        for start, end in edges(polygon):
            axis = (start[1] - end[1], end[0] - start[0])
            projections = [[x * axis[0] + y * axis[1] for x, y in p] for p in (a, b)]
            if max(projections[0]) < min(projections[1]) or max(projections[1]) < min(projections[0]):
                break
        else:
            continue
        break
    else:
        return 0.
    values = []
    for vertices, other in ((a, b), (b, a)):
        for x, y in vertices:
            for start, end in edges(other):
                dx, dy = end[0] - start[0], end[1] - start[1]
                u = max(0., min(1., ((x - start[0]) * dx + (y - start[1]) * dy) / max(1e-12, dx * dx + dy * dy)))
                values.append(math.hypot(x - start[0] - u * dx, y - start[1] - u * dy))
    return min(values)


class EgyptUrbanChaos(DenseChaos):
    def __init__(self, provider, seed, route_validation):
        super().__init__(provider, seed)
        self.route_validation = copy.deepcopy(route_validation)
        self.arcs = route_arcs(provider.dashboard_tools.native_route)
        self.ledger = EventLedger({})
        self.handles = {}
        self.initial = {}
        self.minimum_body_separation_m = None
        self.started_wall = None

    def progress(self, position):
        route = self.provider.dashboard_tools.route['points']
        index = min(range(len(route)), key=lambda i: math.dist(position[:2], route[i][:2]))
        return self.arcs[index], index

    def crossing_pair(self, progress, used):
        p = self.provider
        index = min(range(len(self.arcs)), key=lambda i: abs(self.arcs[i] - progress))
        wp = p.dashboard_tools.native_route[index][0]
        origin = wp.transform.location
        forward, right = wp.transform.get_forward_vector(), wp.transform.get_right_vector()
        candidates = []
        for location, *_ in p.population.sidewalk_locations or []:
            dx, dy = location.x - origin.x, location.y - origin.y
            x, y = dx * forward.x + dy * forward.y, dx * right.x + dy * right.y
            if abs(x) <= 12. and 4. <= abs(y) <= 18. and all(math.dist(xyz(location), prior) > 2. for prior in used):
                candidates.append((location, x, y))
        pairs = [(a, b) for a in candidates for b in candidates if a[2] > 0 > b[2] and abs(a[1] - b[1]) < 4.]
        if not pairs:
            raise ValueError('Egypt bottleneck has no verified opposite native sidewalk endpoints')
        a, b = min(pairs, key=lambda pair: abs(pair[0][1]) + abs(pair[1][1]) + abs(pair[0][2] - 6.))
        return xyz(a[0]), xyz(b[0]), index

    def compile(self, rows):
        p = self.provider
        rng = random.Random(self.seed)
        vehicles = [r for r in rows if r['blueprint'].startswith('vehicle.') and r.get('profile', {}).get('category') in ('car', 'van')]
        people = [r for r in rows if r['blueprint'].startswith('walker.')]
        if len(vehicles) < 8 or len(people) < 4:
            raise ValueError('Egypt event construction needs eight cars/vans and four pedestrians')
        self.plans = {}
        used = set()
        def vehicle(kind, progress, name, *, adjacent=False, window=None):
            options = []
            for row in vehicles:
                if row['id'] in used:
                    continue
                arc, index = self.progress(row['pose']['location'])
                if window is not None and not window[0] <= arc <= window[1]:
                    continue
                wp = p.dashboard_tools.native_route[index][0]
                pose = row['pose']['location']
                gap = math.dist(pose[:2], xyz(wp.transform.location)[:2])
                if (gap > 2.5) != adjacent:
                    continue
                options.append((abs(arc - progress), row, arc, index))
            staged = not options or min(item[0] for item in options) > 65.
            if staged:
                row, arc, index = self._stage_vehicle(vehicles, used, rows, progress, adjacent, window)
            else:
                _, row, arc, index = min(options, key=lambda item: item[0])
            used.add(row['id'])
            row['role'] = name
            persona = rng.choice(('CAUTIOUS', 'ORDINARY', 'IMPATIENT', 'HESITANT'))
            self.plans[name] = {'kind': kind, 'persona': persona, 'progress_m': arc,
                                'staged_before_recording': staged,
                                'trigger_m': max(0., arc - 45.), 'expire_m': arc + 55.,
                                'hold_s': rng.uniform(16., 22.) if kind == 'DOUBLE_PARK' else rng.uniform(1.2, 2.4),
                                'speed_mps': rng.uniform(4., 7.), 'index': index,
                                'origin': list(row['pose']['location']), 'lane_width_m': p.dashboard_tools.native_route[index][0].lane_width,
                                'points': copy.deepcopy(row.get('profile', {}).get('route_points') or
                                    [xyz(w.transform.location) for w, _ in p.dashboard_tools.native_route[index:]])}
            return row
        sections = self.route_validation['passing_sections']
        for i, section in enumerate(sections):
            vehicle('DOUBLE_PARK', section['progress_m'] + 25., f'pass_obstacle_{i}',
                    window=(section['progress_m'] + 10., section['progress_m'] + 45.))
        vehicle('STOP_GO', 55., 'queue_lead')
        vehicle('CUT_IN', sections[0]['progress_m'] + 55., 'hesitant_merge', adjacent=True)
        vehicle('CHANGING_GAPS', sections[1]['progress_m'] + 35., 'gap_stream', adjacent=True)
        vehicle('DOUBLE_PARK', sections[0]['progress_m'] + 95., 'occlusion_vehicle', adjacent=True,
                window=(sections[0]['progress_m'] + 65., sections[0]['progress_m'] + 130.))
        overlap_progress = min(self.arcs[-1] - 80., sections[2]['progress_m'] + 45.)
        vehicle('STOP_GO', overlap_progress, 'overlap_brake')
        starts = []
        for i, (persona, progress) in enumerate((('OCCLUDED', self.plans['occlusion_vehicle']['progress_m'] + 25.),
                                                 ('HESITANT', self.arcs[-1] * .48),
                                                 ('RETREATING', self.arcs[-1] * .65),
                                                 ('STEADY', overlap_progress))):
            row = people[i]
            start, target, index = self.crossing_pair(progress, starts)
            starts.append(start)
            role = 'overlap_person' if i == 3 else 'pedestrian_' + persona.lower()
            row.update(role=role, pose={'location': start, 'rotation': [0., math.degrees(math.atan2(target[1] - start[1], target[0] - start[0])), 0.]},
                       destination=target, speed_mps=rng.uniform(1.2, 1.9), activity='WAITING', crossing=True, wait_remaining_s=0.)
            self._stage_walker(row)
            self.plans[role] = {'kind': 'PEDESTRIAN_CROSSING', 'persona': persona, 'progress_m': self.arcs[index],
                                'trigger_m': max(0., self.arcs[index] - (55. if persona == 'OCCLUDED' else 30.)),
                                'expire_m': self.arcs[index] + 40.,
                                'origin': start, 'target': target, 'speed_mps': row['speed_mps']}
        self.plans['overlapping_hazards'] = {'kind': 'OVERLAP', 'persona': 'COMBINED',
                                            'children': ['overlap_brake', 'overlap_person'],
                                            'trigger_m': min(self.plans[k]['trigger_m'] for k in ('overlap_brake', 'overlap_person')),
                                            'expire_m': overlap_progress + 80.}
        self.route_validation['gates']['native_sidewalk_crossings'] = True
        self.bind(rows)

    def _stage_vehicle(self, vehicles, used, rows, progress, adjacent, window):
        """Fill a missing event slot before capture, never during either drive."""
        p = self.provider
        api, world = p.connection.api, p.world.world
        available = [row for row in vehicles if row['id'] not in used]
        if self.running or not available:
            raise ValueError('No unused vehicle for pre-recording Egypt staging')
        actors = {row['id']: world.get_actor(row['id']) for row in rows}
        ego_pose = p.ego.actor.get_transform()
        native = p.dashboard_tools.native_route
        indices = sorted(range(len(native)), key=lambda index: (abs(self.arcs[index] - progress), index))
        for index in indices:
            arc = self.arcs[index]
            if abs(arc - progress) > 65. or window is not None and not window[0] <= arc <= window[1]:
                continue
            waypoint = native[index][0]
            if waypoint.is_junction:
                continue
            lanes = [(0, waypoint)] if not adjacent else [(offset, permitted_neighbour(waypoint, side))
                for offset, side in ((-1, 'left'), (1, 'right'))]
            for offset, lane in lanes:
                if lane is None or lane.is_junction or lane.lane_width < 2.8:
                    continue
                t = lane.transform
                pose = api.Transform(api.Location(t.location.x, t.location.y, t.location.z + .3), t.rotation)
                if pose.location.distance(ego_pose.location) < 24.:
                    continue
                for row in sorted(available, key=lambda row: (math.dist(row['pose']['location'], xyz(pose.location)), row['role'])):
                    actor = actors.get(row['id'])
                    if actor is None:
                        continue
                    body = rectangle(pose, actor.bounding_box)
                    occupied = [(p.ego.actor, ego_pose)]
                    for other in rows:
                        other_actor = actors.get(other['id'])
                        if other['id'] != row['id'] and other_actor is not None:
                            other_pose = other['pose']
                            occupied.append((other_actor, api.Transform(api.Location(*other_pose['location']),
                                api.Rotation(pitch=other_pose['rotation'][0], yaw=other_pose['rotation'][1], roll=other_pose['rotation'][2]))))
                    if any(body_separation(body, rectangle(other_pose, other.bounding_box)) < 1.
                           for other, other_pose in occupied):
                        continue
                    actor.set_autopilot(False, p.population.traffic_manager.port)
                    actor.set_simulate_physics(False)
                    actor.set_target_velocity(api.Vector3D())
                    actor.set_target_angular_velocity(api.Vector3D())
                    actor.set_transform(pose)
                    row['pose'] = {'location': xyz(pose.location),
                        'rotation': [pose.rotation.pitch, pose.rotation.yaw, pose.rotation.roll]}
                    from .route_crowding import driving_lanes
                    row['profile']['route_points'] = [xyz(driving_lanes(wp, api).get(offset, wp).transform.location)
                                                       for wp, _ in native[index:]]
                    return row, arc, index
        raise ValueError('No unoccupied physical pre-recording slot for Egypt event near ' + str(progress))

    def _stage_walker(self, row):
        p = self.provider
        api = p.connection.api
        p.population._remove_walker(row['id'])
        bp = p.world.world.get_blueprint_library().find(row['blueprint'])
        for key, value in row.get('attributes', {}).items():
            if bp.has_attribute(key):
                bp.set_attribute(key, value)
        if bp.has_attribute('is_invincible'):
            bp.set_attribute('is_invincible', 'false')
            row.setdefault('attributes', {})['is_invincible'] = 'false'
        if bp.has_attribute('role_name'):
            bp.set_attribute('role_name', 'ostorha_participant_' + row['role'])
        position = row['pose']['location']
        actor = p.world.world.spawn_actor(bp, api.Transform(api.Location(position[0], position[1], position[2] + 100.),
                                                           api.Rotation(yaw=row['pose']['rotation'][1])))
        actor.set_simulate_physics(False)
        row.update(id=actor.id, control_owner='SCRIPTED_WALKER')
        p.population.walkers[actor.id] = {'controller_id': None, 'manual': True, 'scripted_crossing': True,
                                          'speed': row['speed_mps'], 'started': False, 'seen': False, 'ready_at': 0.,
                                          'location': api.Location(*position), 'destination': None, 'last_retarget': 0.,
                                          'wait_until': None, 'crossing': False, 'activity': 'WAITING',
                                          'admitted_at_frame': p.population.frame_id}

    def bind(self, rows):
        super().bind(rows)
        self.ledger = EventLedger(self.plans)
        self.initial = {r['role']: copy.deepcopy(r['pose']) for r in rows}
        self.handles = {r['role']: self.provider.world.world.get_actor(r['id']) for r in rows}
        self.bounds = {role: actor.bounding_box for role, actor in self.handles.items() if actor is not None}
        self.minimum_body_separation_m = None
        self.started_wall = None
        self.motion_verified = False
        self.collision_measurement_failed = False

    def descriptor(self):
        definition = {'id': SCENARIO_ID, 'version': 1, 'protocol': PROTOCOL, 'seed': self.seed,
                      'route': self.provider.dashboard_tools.route['points'], 'events': self.plans}
        return {**definition, 'definition_sha256': hashlib.sha256(json.dumps(definition, sort_keys=True).encode()).hexdigest(),
                'route_validation': copy.deepcopy(self.route_validation),
                'requested_population': {'vehicles': 60, 'pedestrians': 100},
                'comparison_scope': 'COMPLETE_DRIVERS_MANEUVER_AND_PREDICTION_DIFFER'}

    def start(self):
        super().start()
        self.started_wall = time.monotonic()
        tm = self.provider.population.traffic_manager
        for role in self.plans:
            actor = self.handles.get(role)
            if actor is not None and actor.type_id.startswith('vehicle.'):
                actor.set_autopilot(False, tm.port)

    def _transition(self, key, phase, snapshot, **values):
        return self.ledger.transition(key, phase, snapshot.frame, snapshot.timestamp.elapsed_seconds, **values)

    def _gap(self, actor, snapshot, *, merge=False):
        pose = actor.get_transform()
        right, forward = pose.get_right_vector(), pose.get_forward_vector()
        for role, identity in self.bindings.items():
            other = snapshot.find(identity)
            if other is None or identity == actor.id:
                continue
            loc = other.get_transform().location
            dx, dy = loc.x - pose.location.x, loc.y - pose.location.y
            along, lateral = dx * forward.x + dy * forward.y, dx * right.x + dy * right.y
            if (-16. < along < 24. and abs(lateral) < (5. if merge else 2.8)):
                return False
        ego = snapshot.find(self.provider.ego.actor.id)
        if ego is not None and ego.get_transform().location.distance(pose.location) < (24. if merge else 10.):
            return False
        return True

    def _stream_gap(self, actor, snapshot):
        pose = actor.get_transform()
        forward, right = pose.get_forward_vector(), pose.get_right_vector()
        gaps = []
        for role, other in self.handles.items():
            if other is None or other.id == actor.id or not other.type_id.startswith('vehicle.'):
                continue
            state = snapshot.find(other.id)
            if state is None:
                continue
            other_pose = state.get_transform()
            direction = other_pose.get_forward_vector()
            if direction.x * forward.x + direction.y * forward.y < .9:
                continue
            dx, dy = other_pose.location.x - pose.location.x, other_pose.location.y - pose.location.y
            along, lateral = dx * forward.x + dy * forward.y, dx * right.x + dy * right.y
            if 0. < along <= 70. and abs(lateral) < 5.:
                gaps.append(max(0., along - actor.bounding_box.extent.x - self.bounds[role].extent.x))
        return min(gaps) if gaps else None

    def before_tick(self):
        if not self.running:
            return
        p = self.provider
        snapshot = p.world.world.get_snapshot()
        ego = snapshot.find(p.ego.actor.id)
        progress, _ = self.progress(xyz(ego.get_transform().location))
        for key, plan in self.plans.items():
            event = self.ledger.events[key]
            if event['status'] in ('COMPLETED', 'MISSED', 'EXPIRED', 'ACTOR_LOST'):
                continue
            if event['status'] == 'PENDING' and progress > plan['expire_m']:
                self._transition(key, 'MISSED', snapshot, reason='Ego passed activation window')
                continue
            if event['status'] == 'PENDING' and progress >= plan['trigger_m']:
                self._transition(key, 'REQUESTED', snapshot)
            if plan['kind'] == 'OVERLAP':
                self._overlap(key, plan, snapshot)
                continue
            actor = self.handles.get(key)
            if actor is None or snapshot.find(actor.id) is None:
                if event['status'] != 'PENDING':
                    self._transition(key, 'ACTOR_LOST', snapshot, reason='Physical participant absent')
                continue
            if plan['kind'] == 'PEDESTRIAN_CROSSING':
                self._walker(key, actor, plan, event, snapshot)
            else:
                self._vehicle(key, actor, plan, event, snapshot)

    def _vehicle(self, key, actor, plan, event, snapshot):
        p = self.provider
        api = p.connection.api
        now = snapshot.timestamp.elapsed_seconds
        if event['status'] == 'PENDING':
            actor.apply_control(api.VehicleControl(brake=1.))
            return
        measures = event['measurements']
        if event['status'] == 'REQUESTED':
            event.setdefault('began_s', now)
            event.setdefault('start_position', xyz(actor.get_location()))
            if plan['kind'] not in ('CUT_IN', 'CHANGING_GAPS'):
                self._transition(key, 'EXECUTING', snapshot)
        elapsed = now - event['began_s']
        moved = math.dist(event['start_position'][:2], xyz(actor.get_location())[:2])
        speed = actor.get_velocity().length()
        if plan['kind'] in ('CUT_IN', 'CHANGING_GAPS'):
            light = api.VehicleLightState
            target = p.dashboard_tools.native_route[plan['index']][0].transform.location
            right = actor.get_transform().get_right_vector()
            lateral_target = (target.x - actor.get_location().x) * right.x + (target.y - actor.get_location().y) * right.y
            side = event.setdefault('signal_side', 'left' if lateral_target < 0 else 'right')
            signal = light.LeftBlinker if side == 'left' else light.RightBlinker
            actor.set_light_state(signal)
            previous_light = event.get('light_sample_at', now)
            event['light_sample_at'] = now
            measures['signal_s'] = (measures.get('signal_s', 0.) + max(0., now - previous_light)
                                    if actor.get_light_state() & signal == signal else 0.)
            if measures['signal_s'] < .8 or elapsed < 1. or not event.get('merge_started') and not self._gap(actor, snapshot, merge=True):
                actor.apply_control(api.VehicleControl(brake=1.))
                event['wait_reason'] = 'WAITING_FOR_PHYSICAL_GAP'
                if elapsed > 30.:
                    self._transition(key, 'EXPIRED', snapshot, reason='No safe environment merge gap')
                return
            if not event.get('merge_started'):
                self._transition(key, 'EXECUTING', snapshot)
                event['merge_started'] = now
                index = plan['index']
                route = p.dashboard_tools.native_route
                points = [plan['origin']]
                points.extend(xyz(w.transform.location) for w, _ in route[index:] if
                              w.transform.location.distance(actor.get_location()) > 12.)
                event['path'] = points[:30]
            self.follow(actor, event['path'], plan['speed_mps'], key, tolerance=1.)
            arc, index = self.progress(xyz(actor.get_location()))
            wp = p.dashboard_tools.native_route[index][0]
            offset = actor.get_location().distance(wp.transform.location)
            start_offset = math.dist(plan['origin'][:2], xyz(p.dashboard_tools.native_route[plan['index']][0].transform.location)[:2])
            actual_gap = self._stream_gap(actor, snapshot)
            if actual_gap is not None:
                initial_gap = event.setdefault('initial_stream_gap_m', actual_gap)
                measures['gap_change_m'] = max(measures.get('gap_change_m', 0.), abs(actual_gap - initial_gap))
            measures.update(lateral_m=max(measures.get('lateral_m', 0.), start_offset - offset),
                            forward_m=max(measures.get('forward_m', 0.), arc - plan['progress_m']),
                            lane_entry_complete=offset + actor.bounding_box.extent.y <= wp.lane_width / 2. - .1)
        else:
            approach = 0. if plan['kind'] == 'DOUBLE_PARK' else 4.
            if approach:
                measures['approach_m'] = max(measures.get('approach_m', 0.), moved)
            if moved < approach and not event.get('stopped_at'):
                points = plan['points'][:30]
                self.follow(actor, points, plan['speed_mps'], key)
                return
            if event.get('stopped_at') is not None and speed > .2 and not event.get('departing'):
                event.pop('stopped_at')
                event.pop('stopped_position')
                measures['stopped_s'] = 0.
            if not event.get('stopped_at') and speed <= .2:
                event['stopped_at'] = now
                event['stopped_position'] = xyz(actor.get_location())
            stopped = now - event.get('stopped_at', now)
            if stopped < plan['hold_s']:
                actor.apply_control(api.VehicleControl(brake=1.))
                actor.set_light_state(api.VehicleLightState(
                    api.VehicleLightState.Brake | api.VehicleLightState.LeftBlinker | api.VehicleLightState.RightBlinker))
                measures['stopped_s'] = stopped if speed <= .2 else 0.
                return
            points = plan['points'][:50]
            event['departing'] = True
            self.follow(actor, points, plan['speed_mps'], key)
            measures['resumed_m'] = math.dist(event['stopped_position'][:2], xyz(actor.get_location())[:2])
        if event_realized(plan['kind'], measures, plan.get('persona')):
            self._transition(key, 'COMPLETED', snapshot)
            actor.set_light_state(api.VehicleLightState.NONE)
            actor.set_autopilot(True, p.population.traffic_manager.port)

    def _walker(self, key, actor, plan, event, snapshot):
        api = self.provider.connection.api
        now = snapshot.timestamp.elapsed_seconds
        if event['status'] == 'PENDING':
            actor.apply_control(api.WalkerControl(speed=0.))
            return
        if event['status'] == 'REQUESTED':
            self._transition(key, 'EXECUTING', snapshot)
            event['began_s'] = now
        measures = event['measurements']
        origin, destination = plan['origin'], plan['target']
        location = xyz(actor.get_location())
        crossed = math.dist(origin[:2], location[:2])
        target = destination
        pause = False
        persona = plan['persona']
        if crossed >= 3. and persona in ('HESITANT', 'RETREATING') and not event.get('intent_finished'):
            event.setdefault('hesitation_at', now)
            measures['hesitated_s'] = min(1., now - event['hesitation_at'])
            pause = measures['hesitated_s'] < .8
            if not pause and persona == 'RETREATING':
                event.setdefault('retreat_origin', location)
                target = origin
                measures['retreated_m'] = math.dist(event['retreat_origin'][:2], location[:2])
                if measures['retreated_m'] >= .8:
                    event['intent_finished'] = True
            elif not pause:
                event['intent_finished'] = True
        dx, dy = target[0] - location[0], target[1] - location[1]
        distance = math.hypot(dx, dy)
        reached = math.dist(destination[:2], location[:2]) <= .6
        actor.apply_control(api.WalkerControl(direction=api.Vector3D(dx / max(.01, distance), dy / max(.01, distance), 0.),
                                              speed=0. if pause or reached else plan['speed_mps']))
        road = self.provider.dashboard_tools.map.get_waypoint(actor.get_location(), project_to_road=False, lane_type=api.LaneType.Driving)
        measures.update(crossing_m=max(measures.get('crossing_m', 0.), crossed),
                        road_observed=measures.get('road_observed', False) or road is not None,
                        sidewalk_reached=reached and road is None)
        if persona == 'OCCLUDED' and crossed < 1.:
            ego = snapshot.find(self.provider.ego.actor.id).get_transform().location
            # Retain a native ray result, not an assumed occlusion from the plan.
            hits = self.provider.world.world.cast_ray(api.Location(ego.x, ego.y, ego.z + 1.6),
                                                       api.Location(location[0], location[1], location[2] + actor.bounding_box.location.z))
            measures['occluded_observed'] = measures.get('occluded_observed', False) or any(
                'Vehicle' in str(hit.label) or 'Car' in str(hit.label) or 'Truck' in str(hit.label) for hit in hits)
        if event_realized(plan['kind'], measures, persona):
            self._transition(key, 'COMPLETED', snapshot)

    def _overlap(self, key, plan, snapshot):
        event = self.ledger.events[key]
        if event['status'] == 'PENDING':
            return
        children = [self.ledger.events[k] for k in plan['children']]
        active = all(c['status'] in ('EXECUTING', 'COMPLETED') for c in children)
        if not active:
            return
        if event['status'] == 'REQUESTED':
            self._transition(key, 'EXECUTING', snapshot)
        intervals = []
        for child in children:
            begin = next(t['timestamp_s'] for t in child['transitions'] if t['phase'] == 'EXECUTING')
            end = next((t['timestamp_s'] for t in child['transitions'] if t['phase'] == 'COMPLETED'),
                       snapshot.timestamp.elapsed_seconds)
            intervals.append((begin, end))
        measurements = {'both_realized': all(c['realized'] for c in children),
                        'overlap_s': max(0., min(i[1] for i in intervals) - max(i[0] for i in intervals))}
        event['measurements'].update(measurements)
        if event_realized('OVERLAP', measurements):
            self._transition(key, 'COMPLETED', snapshot)

    def audit(self, snapshot=None):
        result = super().audit(snapshot)
        result['scenario_id'] = SCENARIO_ID
        for category, identities in (('vehicles', self.provider.population.vehicles), ('pedestrians', self.provider.population.walkers)):
            result['counts'][category]['moving_total'] = len(self.moved.intersection(identities))
        result['density_passed'] = result['counts']['vehicles']['total'] == 60 and result['counts']['pedestrians']['total'] == 100
        result['motion_passed'] = (result['counts']['vehicles']['moving_total'] > 0 and result['counts']['pedestrians']['moving_total'] > 0)
        result['passed'] = result['density_passed']
        result['pending'] = False
        return result

    def after_tick(self, snapshot):
        if not self.running:
            return
        super().after_tick(snapshot)
        if self.latest_audit and self.latest_audit['motion_passed']:
            self.motion_verified = True
        p = self.provider
        sensor = p.sensor_manager.actors.get('collision')
        self.collision_measurement_failed |= (sensor is None or not sensor.is_listening
                                               or 'collision' in p.sensor_manager.errors)
        ego = snapshot.find(p.ego.actor.id)
        own = rectangle(ego.get_transform(), p.ego.actor.bounding_box)
        for role, identity in self.bindings.items():
            other = snapshot.find(identity)
            if other is None:
                continue
            if ego.get_transform().location.distance(other.get_transform().location) > 35.:
                continue
            value = body_separation(own, rectangle(other.get_transform(), self.bounds[role]))
            self.minimum_body_separation_m = value if self.minimum_body_separation_m is None else min(value, self.minimum_body_separation_m)

    def run_evidence(self):
        return {'scenario_id': SCENARIO_ID, 'version': 1, 'seed': self.seed,
                'events': copy.deepcopy(self.ledger.events),
                'density_verified': self.audit_series['samples'] > 0 and self.audit_series['density_failures'] == 0,
                'motion_verified': self.motion_verified,
                'collision_measurement_healthy': not self.collision_measurement_failed and self.audit_series['samples'] > 0,
                'minimum_body_separation_m': self.minimum_body_separation_m,
                'separation_source': 'NATIVE_ORIENTED_BODY_BOUNDARIES_SCORING_ONLY',
                'physics_control': 'NATIVE_VEHICLE_AND_WALKER_CONTROLS_COLLISIONS_ENABLED',
                'audit': copy.deepcopy(self.latest_audit)}
