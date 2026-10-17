"""Matched initial conditions, isolated from the sensor-only control inputs.

Traffic remains reactive after release. Identity proves initial conditions,
not identical future trajectories or a causal count of prevented collisions.
"""
import hashlib
import json
import math


def pose_data(pose):
    return {'location': [pose.location.x, pose.location.y, pose.location.z],
            'rotation': [pose.rotation.pitch, pose.rotation.yaw, pose.rotation.roll]}


class BenchmarkFixture:
    def __init__(self, provider):
        self.provider = provider
        self.actors = []
        self.lights = []
        self.frozen = False
        self.condition = None

    def capture(self):
        p = self.provider; pop = p.population
        owned = set(pop.vehicles) | set(pop.walkers)
        foreign = [a.id for a in p.world.world.get_actors()
                   if a.type_id.startswith(('vehicle.', 'walker.')) and a.id not in owned | {p.ego.actor.id}]
        if foreign: raise ValueError('Unmanaged road actors invalidate the matched benchmark')
        for actor_id in sorted(owned):
            actor = p.world.world.get_actor(actor_id)
            if actor is None: raise ValueError('Population changed during benchmark capture')
            row = {'id': actor_id, 'blueprint': actor.type_id, 'pose': pose_data(actor.get_transform()),
                   'velocity_mps': [0., 0., 0.]}
            if actor_id in pop.vehicles:
                row['profile'] = dict(pop.driver_profiles[actor_id])
                points = row['profile'].get('route_points', [])
                if points:
                    origin = row['pose']['location']
                    nearest = min(range(len(points)), key=lambda i: math.dist(origin, points[i]))
                    row['profile']['route_points'] = points[nearest:]
            else:
                entry = pop.walkers[actor_id]
                destination = entry.get('destination')
                row.update(speed_mps=entry['speed'], destination=[destination.x, destination.y, destination.z] if destination else None)
            self.actors.append(row)
        for light in p.world.world.get_actors().filter('traffic.traffic_light*'):
            self.lights.append({'id':light.id, 'opendrive_id':light.get_opendrive_id(), 'state':str(light.get_state()),
                                'green_s':light.get_green_time(), 'yellow_s':light.get_yellow_time(), 'red_s':light.get_red_time()})
        sensors = {key:{k:v for k,v in value.items() if k in ('blueprint','attributes','mountTransform','sensorTickSeconds','requestedRateHz')}
                   for key,value in p.sensor_manager.configurations.items()}
        self.condition = {'version':1, 'actors':self.actors, 'lights':self.lights, 'sensors':sensors,
                          'ego':{'blueprint':p.ego.actor.type_id,'pose':pose_data(p.ego.actor.get_transform())},
                          'camera_settings':dict(p.camera_settings),
                          'fixed_delta_s':p.fixed_delta, 'seed':pop.config['seed'],
                          'normalization':'Both arms start stationary; traffic is released on the first admitted control frame'}
        encoded = json.dumps(self.condition, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
        self.condition['id'] = hashlib.sha256(encoded).hexdigest()
        self.restore()
        return self.condition

    def restore(self):
        self.held_current=False
        p = self.provider; pop = p.population; api = p.connection.api
        if set(pop.vehicles) | set(pop.walkers) != {r['id'] for r in self.actors}:
            raise ValueError('Benchmark actors changed; start a new pair instead of claiming matched conditions')
        pop.benchmark_frozen = True; pop.benchmark_locked = True; self.frozen = True
        pop.random.seed(pop.config['seed'])
        pop.traffic_manager.configure(pop.config['speed_behavior'], pop.config['seed'])
        p.ego.actor.set_simulate_physics(False)
        pose=self.condition['ego']['pose']
        p.ego.actor.set_transform(api.Transform(api.Location(*pose['location']),
            api.Rotation(pitch=pose['rotation'][0],yaw=pose['rotation'][1],roll=pose['rotation'][2])))
        reset_groups=set()
        for row in self.lights:
            light=p.world.world.get_actor(row['id'])
            if light is None:raise ValueError('Benchmark traffic light missing')
            group=tuple(sorted(member.id for member in light.get_group_traffic_lights()))
            if group not in reset_groups:
                light.reset_group();reset_groups.add(group)
        for row in self.actors:
            actor = p.world.world.get_actor(row['id'])
            if actor is None: raise ValueError('Benchmark actor missing')
            if row['id'] in pop.vehicles:
                actor.set_autopilot(False, pop.traffic_manager.port)
            else:
                entry = pop.walkers[row['id']]
                controller = p.world.world.get_actor(entry['controller_id'])
                if entry['started'] and controller: controller.stop()
                entry.update(started=False, destination=None, ready_at=None, wait_until=None)
            actor.set_simulate_physics(False)
            pose = row['pose']
            actor.set_transform(api.Transform(api.Location(*pose['location']),
                api.Rotation(pitch=pose['rotation'][0], yaw=pose['rotation'][1], roll=pose['rotation'][2])))
        for row in self.lights:
            light = p.world.world.get_actor(row['id'])
            if light is None: raise ValueError('Benchmark traffic light missing')
            light.set_green_time(row['green_s']); light.set_yellow_time(row['yellow_s']); light.set_red_time(row['red_s'])
            target = getattr(api.TrafficLightState, row['state'].split('.')[-1])
            light.set_state(api.TrafficLightState.Green if target == api.TrafficLightState.Red else api.TrafficLightState.Red)
            light.set_state(target); light.freeze(True)

    def prepare_tick(self):
        if not self.frozen or getattr(self,'held_current',False):return
        # Group reset and manual state RPCs can become visible on different
        # native ticks. Reassert the fixture before ticking; verification still
        # checks the subsequent measured state and refuses a mismatch.
        api=self.provider.connection.api
        for row in self.lights:
            light=self.provider.world.world.get_actor(row['id'])
            if light is None:raise ValueError('Benchmark traffic light missing')
            light.set_state(getattr(api.TrafficLightState,row['state'].split('.')[-1]));light.freeze(True)

    def verify(self):
        p = self.provider; failures = []; light_samples=[]
        sensors = {key:{k:v for k,v in value.items() if k in ('blueprint','attributes','mountTransform','sensorTickSeconds','requestedRateHz')}
                   for key,value in p.sensor_manager.configurations.items()}
        if sensors != self.condition['sensors'] or p.camera_settings != self.condition['camera_settings']:
            failures.append('sensor calibration or camera settings changed')
        if p.fixed_delta != self.condition['fixed_delta_s']: failures.append('simulation clock changed')
        expected=self.condition['ego'];ego=p.ego.actor;actual=pose_data(ego.get_transform())
        if ego.type_id!=expected['blueprint'] or math.dist(actual['location'],expected['pose']['location'])>.03:
            failures.append('ego initial pose')
        if any(abs((x-y+180)%360-180)>.5 for x,y in zip(actual['rotation'],expected['pose']['rotation'])):
            failures.append('ego initial rotation')
        if ego.get_velocity().length()>.03 or ego.get_angular_velocity().length()>.1:
            failures.append('ego initial velocity')
        for row in self.actors:
            actor = p.world.world.get_actor(row['id'])
            if actor is None: failures.append(f"missing actor {row['id']}"); continue
            actual = pose_data(actor.get_transform())
            if actor.type_id != row['blueprint'] or math.dist(actual['location'], row['pose']['location']) > .03:
                failures.append(f"actor pose {row['id']}")
            if any(abs((x-y+180)%360-180) > .5 for x,y in zip(actual['rotation'],row['pose']['rotation'])):
                failures.append(f"actor rotation {row['id']}")
            if actor.get_velocity().length()>.03 or actor.get_angular_velocity().length()>.1:
                failures.append(f"actor initial velocity {row['id']}")
            if row['id'] in p.population.walkers:
                if p.world.world.get_actor(p.population.walkers[row['id']]['controller_id']) is None:
                    failures.append(f"walker controller {row['id']}")
        for row in self.lights:
            light = p.world.world.get_actor(row['id'])
            light_samples.append({'id':row['id'],'expected_state':row['state'],
                'actual_state':str(light.get_state()) if light else None,
                'elapsed_s':light.get_elapsed_time() if light else None,
                'frozen':light.is_frozen() if light else None})
            if light is None or str(light.get_state()) != row['state'] or light.get_elapsed_time() > .06:
                failures.append(f"light phase {row['id']}")
            if light is not None and (light.get_green_time()!=row['green_s'] or
                    light.get_yellow_time()!=row['yellow_s'] or light.get_red_time()!=row['red_s']):
                failures.append(f"light durations {row['id']}")
        return {'passed':not failures, 'failures':failures, 'light_samples':light_samples, 'condition_id':self.condition['id'],
                'matching_scope':'Initial actor poses, profiles, zero velocities, signals, sensors, clock and seed; reactive futures may diverge'}

    def release(self, *, strict=True):
        if not self.frozen: return
        from .urban import apply_driver
        p = self.provider; pop = p.population; api = p.connection.api
        p.ego.actor.set_simulate_physics(True)
        p.ego.actor.set_target_velocity(api.Vector3D());p.ego.actor.set_target_angular_velocity(api.Vector3D())
        for row in self.actors:
            actor = p.world.world.get_actor(row['id'])
            if actor is None:
                if strict:raise RuntimeError('Cannot release a missing benchmark actor')
                continue
            actor.set_simulate_physics(True)
            if row['blueprint'].startswith('vehicle.'):
                actor.set_target_velocity(api.Vector3D()); actor.set_target_angular_velocity(api.Vector3D())
                actor.set_autopilot(True, pop.traffic_manager.port)
                apply_driver(pop.traffic_manager.manager, actor, row['profile'])
                points = row['profile'].get('route_points')
                if points: pop.traffic_manager.manager.set_path(actor, [api.Location(*v) for v in points], True)
            else:
                entry = pop.walkers.get(row['id'])
                if entry is None:
                    if strict:raise RuntimeError('Benchmark pedestrian registry changed')
                    continue
                controller = p.world.world.get_actor(entry['controller_id'])
                if controller is None:
                    if strict:raise RuntimeError('Benchmark pedestrian controller is missing')
                    continue
                controller.start(); controller.set_max_speed(row['speed_mps'])
                entry.update(started=True, ready_at=0.)
                if row['destination']:
                    target = api.Location(*row['destination']); controller.go_to_location(target); entry['destination'] = target
        for row in self.lights:
            light=p.world.world.get_actor(row['id'])
            if light is not None:light.freeze(False)
            elif strict:raise RuntimeError('Benchmark traffic light is missing')
        pop.benchmark_frozen = False; self.frozen = False
        self.held_current=False

    def hold_current(self):
        """Stop owned traffic between recordings without teleporting it."""
        p=self.provider;pop=p.population
        pop.benchmark_locked=True;pop.benchmark_frozen=True
        expected={row['id'] for row in self.actors};actual=set(pop.vehicles)|set(pop.walkers)
        failures=[] if expected==actual else ['Owned traffic changed during the recorded drive']
        # Freeze every remaining owned actor, including unexpected replacements,
        # before reporting a changed fixture. Never infer type from absent IDs.
        for actor_id in expected|actual:
            actor=p.world.world.get_actor(actor_id)
            if actor is None:
                failures.append(f'Missing traffic actor {actor_id}');continue
            if actor.type_id.startswith('vehicle.'):actor.set_autopilot(False,pop.traffic_manager.port)
            else:
                entry=pop.walkers.get(actor_id)
                if entry:
                    controller=p.world.world.get_actor(entry['controller_id'])
                    if controller and entry['started']:controller.stop()
                    entry.update(started=False,ready_at=None)
                else:failures.append(f'Missing pedestrian controller record {actor_id}')
            actor.set_simulate_physics(False)
        for row in self.lights:
            light=p.world.world.get_actor(row['id'])
            if light is not None:light.freeze(True)
        self.frozen=True;self.held_current=True
        return {'passed':not failures,'failures':failures}

    def close(self):
        # Teardown must continue when traffic changed; admission uses strict
        # release only after a successful matching-condition audit.
        try:self.release(strict=False)
        finally:
            for row in self.lights:
                light=self.provider.world.world.get_actor(row['id'])
                if light is not None:light.freeze(False)
            self.provider.population.benchmark_locked = False
            self.provider.population.benchmark_frozen = False
