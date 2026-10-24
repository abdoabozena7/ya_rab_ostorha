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
    def __init__(self, provider, *, reconstructable=False):
        self.provider = provider
        self.reconstructable=reconstructable
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
            if self.reconstructable:
                row.update(role=f'participant_{len(self.actors):03d}',
                    attributes={k:v for k,v in actor.attributes.items() if k in ('color','driver_id','is_invincible')})
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
                if self.reconstructable:
                    row.update(activity=entry.get('activity','WALKING'),crossing=entry.get('crossing',False),
                        wait_remaining_s=max(0.,(entry.get('wait_until') or 0.)-p.last_vehicle['timestamp']))
            self.actors.append(row)
        for light in p.world.world.get_actors().filter('traffic.traffic_light*'):
            self.lights.append({'id':light.id, 'opendrive_id':light.get_opendrive_id(), 'state':str(light.get_state()),
                                'green_s':light.get_green_time(), 'yellow_s':light.get_yellow_time(), 'red_s':light.get_red_time()})
        stress=getattr(p,'dense_chaos',None)
        if stress:stress.compile(self.actors)
        sensors = {key:{k:v for k,v in value.items() if k in ('blueprint','attributes','mountTransform','sensorTickSeconds','requestedRateHz')}
                   for key,value in p.sensor_manager.configurations.items()}
        self.condition = {'version':1, 'actors':self.actors, 'lights':self.lights, 'sensors':sensors,
                          'ego':{'blueprint':p.ego.actor.type_id,'pose':pose_data(p.ego.actor.get_transform())},
                          'camera_settings':dict(p.camera_settings),
                          'fixed_delta_s':p.fixed_delta, 'seed':pop.config['seed'],
                          'normalization':'Both arms start stationary; traffic is released on the first admitted control frame'}
        if self.reconstructable:
            tools=p.dashboard_tools
            from .dashboard_tools import WEATHER_PRESET_FIELDS
            weather=p.world.world.get_weather()
            self.condition.update(version=2,map=tools.map_name,route=tools.route['points'],
                destination=tools.route['destination'],population=dict(pop.config),
                weather={k:getattr(weather,k) for k in WEATHER_PRESET_FIELDS if hasattr(weather,k)},
                stress_plan=getattr(getattr(p,'dense_chaos',None),'plans',{}))
            if stress and callable(getattr(stress,'descriptor',None)):
                self.condition['comparison_scenario']=stress.descriptor()
            variants=getattr(p,'presentation_vehicle_variants',None)
            if variants:self.condition.update(version=3,vehicle_variants=dict(variants))
        identity={**self.condition,'actors':[{k:v for k,v in a.items() if k!='id'} for a in self.actors],
            'lights':[{k:v for k,v in light.items() if k!='id'} for light in self.lights]} if self.reconstructable else self.condition
        encoded = json.dumps(identity, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
        self.condition['id'] = hashlib.sha256(encoded).hexdigest()
        self.restore()
        return self.condition

    def rebuild(self):
        """Recreate stable roles at saved poses; native IDs are only bindings."""
        p=self.provider;pop=p.population;api=p.connection.api;world=p.world.world
        pop.benchmark_frozen=True;pop.benchmark_locked=True
        pop.clear_pedestrians();pop.clear_traffic()
        pop.config=dict(self.condition['population'])
        if self.condition.get('comparison_scenario', {}).get('id') == 'EGYPT_URBAN_CHAOS_V1':
            world.set_pedestrians_seed(pop.config['seed'])
        # Every road participant is retired before construction, including
        # survivors whose current positions might occupy a saved start.
        for row in self.actors:
            bp=world.get_blueprint_library().find(row['blueprint'])
            for key,value in row.get('attributes',{}).items():
                if bp.has_attribute(key):bp.set_attribute(key,value)
            if bp.has_attribute('role_name'):bp.set_attribute('role_name','ostorha_participant_'+row['role'])
            pose=row['pose'];native=api.Transform(api.Location(*pose['location']),api.Rotation(
                pitch=pose['rotation'][0],yaw=pose['rotation'][1],roll=pose['rotation'][2]))
            # Dense saved starts may contain touching native capsules (including
            # pedestrians beside a vehicle). Spawn in a staging volume, disable
            # physics, then restore the measured pose before the next native
            # tick. No driving camera or controls are released during rebuilding.
            admission=api.Transform(api.Location(pose['location'][0],pose['location'][1],pose['location'][2]+100.),native.rotation)
            actor=world.try_spawn_actor(bp,admission)
            if actor is None:raise ValueError('Saved start occupied for '+row['role'])
            row['id']=actor.id
            actor.set_simulate_physics(False)
            actor.set_transform(native)
            if row['blueprint'].startswith('vehicle.'):
                pop.vehicles.add(actor.id);pop.driver_profiles[actor.id]=dict(row['profile'])
            else:
                manual=row.get('control_owner')=='SCRIPTED_WALKER'
                try:controller=None if manual else world.spawn_actor(world.get_blueprint_library().find('controller.ai.walker'),api.Transform(),attach_to=actor)
                except Exception:
                    pop._destroy([actor.id]);raise
                pop.walkers[actor.id]={'controller_id':controller.id if controller else None,'speed':row['speed_mps'],'started':False,
                    'manual':manual,'scripted_crossing':manual,
                    'ready_at':None,'destination':None,'last_retarget':0.,'seen':False,'location':native.location,
                    'admitted_at_frame':pop.frame_id,'controller_seen':False,'activity':'IDLE','wait_until':None,'crossing':False}
        for row in self.lights:
            light=next((a for a in world.get_actors().filter('traffic.traffic_light*') if a.get_opendrive_id()==row['opendrive_id']),None)
            if light is None:raise ValueError('Saved traffic signal missing')
            row['id']=light.id
        stress=getattr(p,'dense_chaos',None)
        if stress:stress.bind(self.actors)

    def restore(self, *, rebuild=False):
        self.held_current=False
        p = self.provider; pop = p.population; api = p.connection.api
        if rebuild and self.reconstructable:
            # The stopped ego may occupy a participant's saved start after its
            # first drive. Retire that occupancy before rebuilding any role.
            p.ego.actor.set_simulate_physics(False)
            pose=self.condition['ego']['pose']
            p.ego.actor.set_transform(api.Transform(api.Location(*pose['location']),api.Rotation(
                pitch=pose['rotation'][0],yaw=pose['rotation'][1],roll=pose['rotation'][2])))
            self.rebuild()
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
                controller = p.world.world.get_actor(entry['controller_id']) if entry['controller_id'] is not None else None
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
        if self.reconstructable:
            weather=p.world.world.get_weather()
            if any(abs(getattr(weather,k)-v)>.001 for k,v in self.condition['weather'].items()):failures.append('weather changed')
            if pop_config := self.condition.get('population'):
                if p.population.config!=pop_config:failures.append('population settings changed')
        expected=self.condition['ego'];ego=p.ego.actor;actual=pose_data(ego.get_transform())
        variants=self.condition.get('vehicle_variants')
        expected_blueprint=variants.get(getattr(p,'presentation_vehicle_mode',None),expected['blueprint']) if variants else expected['blueprint']
        if ego.type_id!=expected_blueprint or math.dist(actual['location'],expected['pose']['location'])>.03:
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
            if self.reconstructable and any(actor.attributes.get(k)!=v for k,v in row['attributes'].items()):failures.append('participant attributes '+row['role'])
            if any(abs((x-y+180)%360-180) > .5 for x,y in zip(actual['rotation'],row['pose']['rotation'])):
                failures.append(f"actor rotation {row['id']}")
            if actor.get_velocity().length()>.03 or actor.get_angular_velocity().length()>.1:
                failures.append(f"actor initial velocity {row['id']}")
            if row['id'] in p.population.walkers:
                if row.get('control_owner')!='SCRIPTED_WALKER' and p.world.world.get_actor(p.population.walkers[row['id']]['controller_id']) is None:
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
                'matching_scope':'Initial actor poses, profiles, zero velocities, signals, sensors, clock and seed; reactive futures may diverge',
                'ego_blueprint':ego.type_id,'vehicle_variant':getattr(p,'presentation_vehicle_mode',None)}

    def release(self, *, strict=True):
        if not self.frozen: return
        p = self.provider; pop = p.population; api = p.connection.api
        p.ego.actor.set_simulate_physics(True)
        p.ego.actor.set_target_velocity(api.Vector3D());p.ego.actor.set_target_angular_velocity(api.Vector3D())
        for row in self.actors:
            try:self._release_actor(row,strict=strict)
            except RuntimeError as error:
                if strict:raise
                if not hasattr(self,'cleanup_failures'):self.cleanup_failures=[]
                self.cleanup_failures.append(f'Traffic actor {row["id"]}: {error}')
        for row in self.lights:
            try:
                light=p.world.world.get_actor(row['id'])
                if light is not None:light.freeze(False)
                elif strict:raise RuntimeError('Benchmark traffic light is missing')
            except RuntimeError:
                if strict:raise
        pop.benchmark_frozen = False; self.frozen = False
        self.held_current=False
        stress=getattr(p,'dense_chaos',None)
        if stress and strict:stress.start()

    def _release_actor(self,row,*,strict):
        from .urban import apply_driver
        p=self.provider;pop=p.population;api=p.connection.api
        if row:
            actor = p.world.world.get_actor(row['id'])
            if actor is None:
                if strict:raise RuntimeError('Cannot release a missing benchmark actor')
                return
            # CARLA disables CharacterMovement when physics is disabled.
            # Restore the movement mode of fresh, unpossessed walkers too.
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
                    return
                if entry.get('manual'):
                    actor.apply_control(api.WalkerControl(speed=0.));entry.update(started=True,ready_at=0.,scripted_owner=True)
                    return
                controller = p.world.world.get_actor(entry['controller_id'])
                if controller is None:
                    if strict:raise RuntimeError('Benchmark pedestrian controller is missing')
                    return
                if entry.get('scripted_crossing'):
                    controller.stop();actor.set_simulate_physics(False)
                    actor.apply_control(api.WalkerControl(speed=0.));entry['scripted_owner']=True
                else:
                    controller.start(); controller.set_max_speed(row['speed_mps'])
                entry.update(started=True, ready_at=0.)
                if self.reconstructable:
                    stamp=p.last_vehicle['timestamp']
                    entry.update(activity=row.get('activity','WALKING'),crossing=row.get('crossing',False),
                        last_retarget=stamp,wait_until=stamp+row['wait_remaining_s'] if row.get('wait_remaining_s') else None)
                if row['destination'] and not entry.get('scripted_crossing'):
                    target = api.Location(*row['destination']); controller.go_to_location(target); entry['destination'] = target
    def hold_current(self):
        """Stop owned traffic between recordings without teleporting it."""
        p=self.provider;pop=p.population
        stress=getattr(p,'dense_chaos',None)
        if stress:stress.running=False
        pop.benchmark_locked=True;pop.benchmark_frozen=True
        expected={row['id'] for row in self.actors};actual=set(pop.vehicles)|set(pop.walkers)
        failures=[] if expected==actual else ['Owned traffic changed during the recorded drive']
        # Freeze every remaining owned actor, including unexpected replacements,
        # before reporting a changed fixture. Never infer type from absent IDs.
        for actor_id in expected|actual:
            try:
                actor=p.world.world.get_actor(actor_id)
                if actor is None:
                    failures.append(f'Missing traffic actor {actor_id}');continue
                if actor.type_id.startswith('vehicle.'):actor.set_autopilot(False,pop.traffic_manager.port)
                else:
                    entry=pop.walkers.get(actor_id)
                    if entry:
                        controller=p.world.world.get_actor(entry['controller_id']) if entry['controller_id'] is not None else None
                        if entry.get('manual'):actor.apply_control(p.connection.api.WalkerControl(speed=0.))
                        if controller and entry['started']:controller.stop()
                        entry.update(started=False,ready_at=None)
                    else:failures.append(f'Missing pedestrian controller record {actor_id}')
                actor.set_simulate_physics(False)
            except RuntimeError as error:
                failures.append(f'Traffic actor {actor_id}: {error}')
        for row in self.lights:
            try:
                light=p.world.world.get_actor(row['id'])
                if light is not None:light.freeze(True)
                else:failures.append(f'Missing traffic light {row["id"]}')
            except RuntimeError as error:
                failures.append(f'Traffic light {row["id"]}: {error}')
        self.frozen=True;self.held_current=True
        return {'passed':not failures,'failures':failures}

    def close(self):
        # Teardown must continue when traffic changed; admission uses strict
        # release only after a successful matching-condition audit.
        try:
            try:self.release(strict=False)
            except RuntimeError:pass
        finally:
            for row in self.lights:
                try:
                    light=self.provider.world.world.get_actor(row['id'])
                    if light is not None:light.freeze(False)
                except RuntimeError:pass
            self.provider.population.benchmark_locked = False
            self.provider.population.benchmark_frozen = False
