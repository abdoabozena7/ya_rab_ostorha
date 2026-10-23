"""CARLA is the rendered simulator. This provider sends controls and reads state."""
import copy
import math
import time
from .connection import CarlaConnection
from .controls import native_control
from .sensors import CarlaSensorManager
from .telemetry import vehicle_state
from .vehicle import EgoVehicle
from .world import CarlaWorld
from .target import VERSION
from .contracts import simulation_frame
from ..core.contracts import ControlCommand, PopulationState
from dataclasses import replace
from .population import WorldPopulationManager, passenger_blueprints
from .ground_truth import NearbyActorInspector
from .urban import WORLD_PROFILES


class CarlaProvider:
    name = 'carla'
    scenario_outcomes_enabled = True
    allow_navigation = True  # Explicit destination journeys; AI/assisted modes stay disabled.

    def __init__(self, host='127.0.0.1', port=2000, version=VERSION, map_name=None,
                 blueprint='vehicle.lincoln.mkz_2020', spawn_index=0, fixed_delta=.05, collision_sensor=False, sensor_suite=False, fresh_start=False,
                 traffic_manager_port=8050):
        self.connection = CarlaConnection(host, port, version)
        self.map_name, self.blueprint, self.spawn_index = map_name, blueprint, spawn_index
        self.fresh_start = fresh_start
        self.traffic_manager_port = traffic_manager_port
        self.fixed_delta = fixed_delta
        self.collision_sensor = collision_sensor
        self.sensor_suite = sensor_suite
        self.camera_settings = {'camera_view': 'front', 'camera_resolution': '640x360', 'camera_fov': 90,
                                'camera_postprocess': False, 'camera_motion_blur': 0., 'camera_bloom': 0.}
        self.navigation = None
        self.hybrid_driver = None
        self.hybrid_alternative = None
        self.hybrid_speed_policy = None
        self.benchmark_fixture = None
        self.benchmark_prepared = False
        self.scenarios = None
        self.strict_ego_spawn = False
        self.population = None
        self.inspector = None
        self.last_ground_truth = None
        self.local_population_counts = {}
        self.dashboard_tools = None
        self.world = self.ego = self.sensor_manager = None
        self.gear = 1
        self.last_vehicle = self.last_world = None
        self.catalog = {}
        self.cleanup_errors = []
        self.controls = {'throttle': 0, 'brake': 1, 'steering': 0, 'parkingbrake': 0, 'gear': 1}

    def create_comparison(self,service):
        from .comparison import ComparisonDemo
        return ComparisonDemo(service)

    def connect(self):
        if self.world is not None or self.ego is not None or self.cleanup_errors:
            raise RuntimeError('Disconnect the existing CARLA session first')
        try:
            import json
            from pathlib import Path
            from .dashboard_tools import validate_settings
            preferences_path=Path(__file__).resolve().parents[2]/'config/dashboard-preferences.json'
            preferences=json.loads(preferences_path.read_text(encoding='utf8')) if preferences_path.exists() and not self.fresh_start else {}
            saved_view=validate_settings(preferences.get('view',{}))
            self.camera_settings.update({k:v for k,v in saved_view.items() if k.startswith('camera_')})
            if 'simulation_hz' in saved_view:self.fixed_delta=1/saved_view['simulation_hz']
            from .runtime import get_runtime
            self.runtime = get_runtime()
            self.active_launch = self.runtime.active
            raw_world = self.connection.connect()
            if self.map_name:
                name = self.map_name.rsplit('/',1)[-1]
                if raw_world.get_map().name.rsplit('/',1)[-1] != name:
                    available = self.connection.client.get_available_maps()
                    match = next((m for m in available if m.rsplit('/',1)[-1] == name), self.map_name)
                    raw_world = self.connection.client.load_world(match)
            if raw_world.get_settings().synchronous_mode:
                raise RuntimeError('CARLA world already has synchronous ticking enabled; stop the other tick owner first')
            # A new SDK subscriber may initially have an empty actor cache.
            # Wait for a real snapshot before identifying this project's orphans.
            raw_world.wait_for_tick(self.connection.timeout)
            actors = raw_world.get_actors()
            project_ids = {a.id for a in actors if a.attributes.get('role_name') in
                           ('ostorha_ego', 'ostorha_npc', 'ostorha_walker', 'ostorha_sensor', 'ostorha_scenario') or
                           a.attributes.get('role_name','').startswith('ostorha_participant_')}
            children = [a for a in actors if a.type_id.startswith(('sensor.', 'controller.')) and
                        a.parent is not None and a.parent.id in project_ids]
            for actor in children:
                if actor.type_id == 'controller.ai.walker': actor.stop()
            owned = list({a.id:a for a in children + [a for a in actors if a.id in project_ids]}.values())
            if owned:
                replies = self.connection.client.apply_batch_sync([
                    self.connection.api.command.DestroyActor(actor.id) for actor in owned], False)
                errors = [reply.error for reply in replies if reply.error and 'not found' not in reply.error.lower()]
                if errors: raise RuntimeError('Previous project actor cleanup failed: '+'; '.join(errors))
            if project_ids:
                raw_world.wait_for_tick(self.connection.timeout)
                if any(a.id in {actor.id for actor in owned} for a in raw_world.get_actors()):
                    raise RuntimeError('Previous project ego cleanup is not confirmed')
            self.catalog = {'maps': self.connection.client.get_available_maps(),
                            'vehicles': [bp.id for bp in passenger_blueprints(raw_world.get_blueprint_library())]}
            self.world = CarlaWorld(raw_world, self.fixed_delta)
            clear_noon=getattr(getattr(self.connection.api,'WeatherParameters',None),'ClearNoon',None)
            if clear_noon is not None:raw_world.set_weather(clear_noon)
            if 'weather' in saved_view:
                weather=raw_world.get_weather()
                for key,value in saved_view['weather'].items():setattr(weather,key,value)
                raw_world.set_weather(weather)
            self.spawn_ego_vehicle()
            self.population = WorldPopulationManager(self.connection.client, raw_world, self.connection.api, self.ego.actor.id,
                traffic_manager_port=self.traffic_manager_port)
            from .scenarios import NativeScenarioManager
            self.scenarios = NativeScenarioManager(self)
            self.set_controls(brake=1)
            from .urban_chaos import CITY
            from .population import DEFAULT_POPULATION
            self.population.apply(DEFAULT_POPULATION if self.fresh_start else preferences.get('population',CITY))
            self.step()
        except Exception:
            self.disconnect()
            raise
        return self

    def spawn_ego_vehicle(self):
        if self.ego is not None:
            raise RuntimeError('An ego vehicle is already owned by this session')
        self.ego = EgoVehicle(self.world.world, self.blueprint, self.spawn_index, strict_spawn=self.strict_ego_spawn,
            traffic_manager_port=self.traffic_manager_port)
        actor = self.ego.spawn()
        from .onboard_geometry import geometry_for
        self.vehicle_geometry=geometry_for(actor)
        self.inspector = NearbyActorInspector(self.world.world, actor)
        self.sensor_manager = CarlaSensorManager(self.world.world, actor)
        if self.collision_sensor:
            self.sensor_manager.enable_collision(self.connection.api)
        if self.sensor_suite:
            self.sensor_manager.enable_suite(self.connection.api, self.fixed_delta, self.camera_settings)
        return actor.id

    def hold_prepared_presentation(self):
        from .benchmark_fixture import BenchmarkFixture
        self.presentation_vehicle_variants={'NORMAL':'vehicle.mercedes.coupe_2020',
            'ROBOSPHERE':'vehicle.mercedes.coupe_2020'}
        # Verify installed assets before discarding any live ego.
        library=self.world.world.get_blueprint_library()
        for blueprint in self.presentation_vehicle_variants.values():library.find(blueprint)
        self.benchmark_fixture=BenchmarkFixture(self,reconstructable=True)
        condition=self.benchmark_fixture.capture()
        self.benchmark_prepared=True
        return condition['id']

    def prepare_guided_vehicle(self):
        """Normalize the live app before capturing a matched comparison start."""
        if not self.sensor_suite:raise ValueError('The crossing comparison requires the native camera, depth and LiDAR sensor suite')
        target='vehicle.mercedes.coupe_2020'
        self.world.world.get_blueprint_library().find(target)
        self.camera_settings['_comparison_rig']=True
        self.camera_settings.update(camera_view='chase',camera_resolution='800x450',camera_fov=90,
            camera_postprocess=True,camera_motion_blur=0.,camera_bloom=0.)
        expected={'collision','frontCamera','drivingCamera','depth','radar','lidar','imu','gnss'}
        configuration=getattr(self.sensor_manager,'configurations',{})
        attributes=lambda name:configuration.get(name,{}).get('attributes',{})
        calibrated=(int(attributes('frontCamera').get('image_size_x',0))==1280
            and int(attributes('drivingCamera').get('image_size_x',0))==800
            and int(attributes('drivingCamera').get('image_size_y',0))==450
            and str(attributes('drivingCamera').get('enable_postprocess_effects','')).lower()=='true'
            and abs(float(attributes('drivingCamera').get('gamma',0))-2.2)<1e-3
            and self.sensor_manager.configurations.get('drivingCamera',{}).get('mountTransform',{}).get('positionM')==[-6.,0.,3.]
            and int(attributes('depth').get('image_size_x',0))==640
            and int(attributes('lidar').get('channels',0))==32
            and abs(float(attributes('lidar').get('lower_fov',0))+75)<1e-3
            and int(attributes('lidar').get('points_per_second',0))==128000)
        rebuild=self.ego.actor.type_id!=target or set(self.sensor_manager.actors)!=expected or not calibrated
        self.blueprint=target
        if rebuild:self.reset_vehicle()
        return rebuild

    def select_presentation_vehicle(self, mode):
        variants=getattr(self,'presentation_vehicle_variants',None)
        if not variants or mode not in variants:raise ValueError('Prepared vehicle choices unavailable')
        target=variants[mode];self.presentation_vehicle_mode=mode
        fixture=self.benchmark_fixture
        if not fixture or not fixture.frozen:raise ValueError('Hold the prepared world before switching cars')
        api=self.connection.api;pose=fixture.condition['ego']['pose']
        native=api.Transform(api.Location(*pose['location']),api.Rotation(
            pitch=pose['rotation'][0],yaw=pose['rotation'][1],roll=pose['rotation'][2]))
        self.destroy_ego_vehicle()
        self.blueprint=target
        # Spawn at the saved start, never at an unrelated free map spawn.
        self.ego=EgoVehicle(self.world.world,target,self.spawn_index,strict_spawn=True)
        bp=self.world.world.get_blueprint_library().find(target);bp.set_attribute('role_name','ostorha_ego')
        if bp.has_attribute('color'):bp.set_attribute('color','35,45,55')
        admission=api.Transform(api.Location(native.location.x,native.location.y,native.location.z+.4),native.rotation)
        actor=self.world.world.try_spawn_actor(bp,admission)
        if actor is None:raise ValueError('The prepared ego start is occupied')
        self.ego.actor=actor;actor.set_autopilot(False,self.traffic_manager_port);actor.set_simulate_physics(False);actor.set_transform(native)
        from .onboard_geometry import geometry_for
        self.vehicle_geometry=geometry_for(actor)
        self.inspector=NearbyActorInspector(self.world.world,actor)
        self.sensor_manager=CarlaSensorManager(self.world.world,actor)
        if self.collision_sensor:self.sensor_manager.enable_collision(api)
        if self.sensor_suite:self.sensor_manager.enable_suite(api,self.fixed_delta,self.camera_settings)
        self.population.ego_id=actor.id
        self.set_controls(brake=1)
        self.benchmark_prepared=True
        return True

    def destroy_ego_vehicle(self):
        self.stop_navigation()
        if self.sensor_manager:
            self.sensor_manager.close()
            self.cleanup_errors.extend(self.sensor_manager.cleanup_errors)
            self.sensor_manager = None
        if self.ego:
            self.ego.destroy()
            self.ego = None

    def set_controls(self, throttle=0, brake=0, steering=0, parkingbrake=0, gear=None):
        if self.ego is None or self.ego.actor is None:
            raise RuntimeError('CARLA ego vehicle is not available')
        selected = self.gear if gear is None else gear
        control = native_control(self.connection.api, throttle=throttle, brake=brake,
                                 steering=steering, parkingbrake=parkingbrake, gear=selected)
        self.ego.actor.apply_control(control)
        self.gear = selected
        self.controls = dict(throttle=throttle, brake=brake, steering=steering,
                             parkingbrake=parkingbrake, gear=selected)

    def _set_control_field(self, name, value):
        self.set_controls(**{**self.controls, name: value})

    def set_throttle(self, value):
        self._set_control_field('throttle', value)

    def set_brake(self, value):
        self._set_control_field('brake', value)

    def set_steering(self, value):
        self._set_control_field('steering', value)

    def set_reverse(self, reverse):
        self._set_control_field('gear', -1 if reverse else 1)

    def set_handbrake(self, enabled):
        self._set_control_field('parkingbrake', int(enabled))

    def step(self):
        began=time.perf_counter()
        if self.benchmark_fixture:self.benchmark_fixture.prepare_tick()
        stress=getattr(self,'dense_chaos',None)
        if stress:stress.before_tick()
        if self.scenarios: self.scenarios.before_tick()
        overlay=getattr(self,'measured_overlay',None)
        if overlay:
            from .scene_overlays import draw
            try:draw(self,overlay)
            except (RuntimeError,ValueError,TypeError) as error:self.overlay_error=str(error)
        if self.population and self.dashboard_tools:
            route = self.dashboard_tools.route
            self.population.set_route(route['points'] if route else [])
        before_population=time.perf_counter()
        if self.population:
            # NPC housekeeping consumes the last authoritative snapshot before
            # advancing physics. It must not age the next synchronized sensor
            # packet while the ego controller waits for publication. Commands
            # still affect the following native tick, under this same owner.
            self.population.update(self.world.world.get_snapshot())
        after_population=time.perf_counter()
        before_native=time.perf_counter()
        snapshot = self.world.advance()
        after_native=time.perf_counter()
        if stress:stress.after_tick(snapshot)
        self.last_actor_ids={a.id for a in snapshot} if self.scenarios and self.scenarios.urban else set()
        # Display counts use the worker's native snapshot. Dashboard requests
        # must not issue 71 actor queries while holding the control lock.
        if self.scenarios and self.scenarios.urban:
            ego_position = snapshot.find(self.ego.actor.id).get_transform().location
            plans = self.scenarios.spec.metadata['vehicle_plans']
            counts = {'vehicles_120m': 0, 'walkers_120m': 0}
            for name, actor_id in tuple(self.scenarios.actors.items()):
                actor_snapshot = snapshot.find(actor_id)
                if actor_snapshot and actor_snapshot.get_transform().location.distance(ego_position) <= 120:
                    counts['vehicles_120m' if name in plans else 'walkers_120m'] += 1
            self.local_population_counts = counts
        else:
            self.local_population_counts = {}
        before_telemetry=time.perf_counter()
        self.last_vehicle = vehicle_state(self.ego.actor, snapshot)
        self.last_ground_truth = self.inspector.observe(snapshot) if self.inspector else None
        self.last_world = {**self.world.state(snapshot), 'version': self.connection.server_version,
                           'pythonApiVersion': self.connection.api_version}
        if self.scenarios: self.scenarios.after_tick(snapshot)
        self._follow_ego(snapshot.find(self.ego.actor.id).get_transform())
        finished=time.perf_counter()
        self.step_timing_ms={'before_native':(before_native-began)*1000,
            'native_tick':(after_native-before_native)*1000,
            'scenario_audit':(before_telemetry-after_native)*1000,
            'population':(after_population-before_population)*1000,
            'telemetry_and_spectator':(finished-before_telemetry)*1000}
        return self.last_vehicle

    def _follow_ego(self, transform):
        api = self.connection.api
        forward = transform.get_forward_vector()
        location = api.Location(x=transform.location.x - forward.x*6,
                                y=transform.location.y - forward.y*6, z=transform.location.z+3)
        view = api.Transform(location, api.Rotation(pitch=-15, yaw=transform.rotation.yaw))
        self.world.world.get_spectator().set_transform(view)

    def get_vehicle_state(self):
        return self.last_vehicle

    def get_simulation_frame(self):
        if self.last_vehicle is None or self.last_world is None:
            raise RuntimeError('No native observation is available')
        frame = simulation_frame(self.last_vehicle, self.last_world)
        if self.population:
            population = self.population_state(compact=True)
            a, r = population['actual'], population['requested']
            frame = replace(frame, population=PopulationState(frame.frame_id, frame.timestamp_s,
                a['vehicles'], a['pedestrians'], a['controllers'], a['walkers_active'],
                r['vehicle_count'], r['pedestrian_count'], population['traffic_manager_connected'],
                r['speed_behavior'], population['desired_speed_difference_percent'], r['seed']))
        return replace(frame, ground_truth=self.last_ground_truth,
                       actors=tuple(item.actor for item in self.last_ground_truth.objects)) if self.last_ground_truth else frame

    def drain_collision_events(self):
        return self.sensor_manager.drain_collisions() if self.sensor_manager else ()

    def dashboard_catalog(self):
        self._ensure_dashboard_tools()
        return {'places': self.dashboard_tools.places(), 'roads': self.dashboard_tools.roads(),
                'settings': self.dashboard_tools.settings(), 'profiles': self.dashboard_tools.profiles(),
                'scenes': self.dashboard_tools.scenes(),
                'scenario_library': {'native_demonstrations':['FRONT_OBSTACLE','SUDDEN_BRAKING'],
                    'policy_status':'INTERFACE_PREPARED_NO_POLICY','seed_ranges':{'TRAIN':[0,999],'VALIDATION':[1000,1999],'TEST':[2000,2999]}},
                'urban_world_profiles': WORLD_PROFILES}

    def _ensure_dashboard_tools(self):
        if self.dashboard_tools is None:
            from .dashboard_tools import NativeDashboardTools
            self.dashboard_tools = NativeDashboardTools(self)

    def dashboard_action(self, action, value):
        self._ensure_dashboard_tools()
        if action == 'environment':
            if value != 'LIVING_CITY': raise ValueError('Load a scenario to enter the training environment')
            self.scenarios.living_city()
            return self.environment_state()
        if action == 'scenario':
            if not isinstance(value, dict) or value.get('operation') not in ('load','reset','start','stop','cleanup','collect_outcome'):
                raise ValueError('Unknown scenario operation')
            operation=value['operation']
            if operation == 'load':
                if 'spec' in value:self.scenarios.load(value['spec'])
                else:
                    from .scenarios import demonstration
                    self.scenarios.load(demonstration(self,value.get('scenario_type'),value.get('seed',42),
                                                      value.get('split','TRAIN'),value.get('difficulty',1)))
            elif operation == 'reset':self.scenarios.reset()
            elif operation == 'start':self.scenarios.start()
            elif operation == 'stop':self.scenarios.stop()
            elif operation == 'cleanup':self.scenarios.living_city()
            else:return self.scenarios.collect_outcome()
            return self.environment_state()
        if self.scenarios and self.scenarios.mode.value == 'TRAINING' and action in ('settings','population','scene','crowd_route'):
            raise ValueError('Return to Living city before changing the controlled scene or route')
        if action == 'settings': return self.dashboard_tools.apply(value)
        if action == 'crowd_route':
            route = self.dashboard_tools.route_state()
            self.population.crowd_route(route, self.dashboard_tools.native_route, value)
            return None  # Published after the next authoritative native frame.
        if action == 'destination': return self.dashboard_tools.set_destination(value)
        if action == 'save_place': return self.dashboard_tools.save_place(value)
        if action == 'favorite_place': return self.dashboard_tools.favorite_place(value)
        if action == 'clear_route':
            self.dashboard_tools.route = None
            self.dashboard_tools.native_route = []
            return {'active': False}
        if action == 'inspector':
            self.inspector.configure(value)
            return {'radius_m': self.inspector.radius}
        if action == 'population':
            if value not in ('clear_traffic', 'clear_pedestrians', 'reset', 'respawn'):
                raise ValueError('Unknown population operation')
            config = dict(self.population.config)
            if value == 'clear_traffic': self.population.clear_traffic()
            elif value == 'clear_pedestrians': self.population.clear_pedestrians()
            else:
                self.population.reset_population()
                if value == 'respawn': self.population.apply(config)
            return self.population.get_population_state()
        if action == 'scene':
            if value not in self.dashboard_tools.scenes(): raise ValueError('Unknown normal-city scene')
            self.population.reset_population()
            return self.dashboard_tools.apply(self.dashboard_tools.scenes()[value])
        raise ValueError('Unknown dashboard operation')

    def population_state(self,*,compact=False):
        state=(self.population.get_population_state(compact=True) if compact else
            self.population.get_population_state()) if self.population else None
        if state and self.scenarios and self.scenarios.urban:
            import copy
            state=copy.deepcopy(state)
            live=set(self.last_actor_ids)
            state['actual']={'vehicles':sum(i in live for n,i in self.scenarios.actors.items() if n in self.scenarios.spec.metadata['vehicle_plans']),
                'pedestrians':sum(i in live for n,i in self.scenarios.actors.items() if n not in self.scenarios.spec.metadata['vehicle_plans']),
                'controllers':sum(e['id'] in live for e in self.scenarios.urban.controllers.values()),
                'walkers_active':sum(e['started'] and self.scenarios.actors[n] in live for n,e in self.scenarios.urban.controllers.items())}
            state['requested'].update(vehicle_count=40,pedestrian_count=30,seed=self.scenarios.spec.random_seed,driver_behavior='UNREGULATED')
            state['experiment_actor_ids']=dict(self.scenarios.actors)
            state['actual_source']='Native admitted experiment actors; no recycling'
            state.update(npc_spawned=40,walkers_spawned=30,npc_failed=0,walkers_failed=0,
                walkers_lost=30-state['actual']['pedestrians'],vehicles_removed_native=40-state['actual']['vehicles'],
                vehicle_ids=[i for n,i in self.scenarios.actors.items() if n in self.scenarios.spec.metadata['vehicle_plans']],
                walker_ids=[i for n,i in self.scenarios.actors.items() if n not in self.scenarios.spec.metadata['vehicle_plans']],
                controller_ids=[e['id'] for e in self.scenarios.urban.controllers.values()],
                pedestrian_cross_factor=1.,walker_invincible=False,
                destinations='28 native navmesh walkers; 2 scripted native-physics crossings',
                behavior='UNREGULATED')
            state['local_counts']=dict(self.local_population_counts)
        return state

    def operator_population_state(self):
        return self.population_state(compact=True)

    def environment_state(self, compact=False):
        return self.scenarios.status(compact=compact) if self.scenarios else None

    def operator_environment_state(self):
        return self.environment_state(compact=True)

    def observe_scenario(self, frame):
        if self.scenarios:
            phase=self.scenarios.phase
            self.scenarios.step(frame)
            if phase=='RUNNING' and self.scenarios.phase=='FINISHED':
                return self.scenarios.collect_outcome()

    def observe_scenario_collision(self,collision):
        return self.scenarios.observe_collision(collision) if self.scenarios else None

    def ground_truth_debug(self):
        return self.inspector.latest if self.inspector else None

    def route_state(self):
        return self.dashboard_tools.route_state() if self.dashboard_tools else None

    def validate_graphics(self, value):
        from .dashboard_tools import validate_settings
        if isinstance(value,dict) and set(value)=={'preset'}:
            from ..graphics import PRESETS, launch
            if value['preset'] not in PRESETS:raise ValueError('Unknown graphics preset')
            value=launch(value['preset'])
        if self.connection.host not in ('127.0.0.1', 'localhost'):
            raise ValueError('Native restart is available only for the local simulator')
        return validate_settings({'next_launch': value})['next_launch']

    def journey_manifest(self, speed_kmh, *, benchmark=False):
        self._ensure_dashboard_tools()
        route = self.dashboard_tools.route
        if not route: raise ValueError('Choose a destination first')
        pose = self.ego.actor.get_transform()
        from .dashboard_tools import WEATHER_PRESET_FIELDS
        weather = self.world.world.get_weather()
        manifest = {'map':self.dashboard_tools.map_name, 'blueprint':self.ego.actor.type_id,
            'origin':{'location':[pose.location.x, pose.location.y, pose.location.z],
                      'rotation':[pose.rotation.pitch, pose.rotation.yaw, pose.rotation.roll]},
            'destination':copy.deepcopy(route['destination']), 'route_length_m':route['length_m'],
            'speed_kmh':speed_kmh,
            'speed_policy':'POSTED_ROAD_LIMIT',
            'population':copy.deepcopy(self.population.config),
            'actual_population':copy.deepcopy(self.population_state().get('actual')),
            'collision_measurement_available': 'collision' in self.sensor_manager.actors,
            'crowded':bool(self.population.route_crowding),
            'weather':{key:getattr(weather,key) for key in WEATHER_PRESET_FIELDS if hasattr(weather,key)},
            'setup_note':'Same origin, destination, weather, speed and seeded traffic settings. Live actor trajectories are not identical.'}
        from .comparison_vehicle import physical_configuration
        manifest.update(vehicle_geometry=copy.deepcopy(self.vehicle_geometry.__dict__),
            vehicle_physics=physical_configuration(self.ego.actor),
            sensor_configuration={key:{field:value for field,value in config.items()
                if field in ('blueprint','attributes','mountTransform','sensorTickSeconds','requestedRateHz')}
                for key,config in self.sensor_manager.configurations.items()})
        if benchmark:
            from .benchmark_fixture import BenchmarkFixture
            if not self.benchmark_prepared:
                if self.benchmark_fixture: self.benchmark_fixture.close()
                self.benchmark_fixture = BenchmarkFixture(self,reconstructable=getattr(self,'guided_presentation',False))
                self.benchmark_fixture.capture()
            self.benchmark_prepared = False
            manifest.update(protocol='HYBRID_NATIVE_BASELINE_V1', initial_condition_id=self.benchmark_fixture.condition['id'],
                destination_stop_policy='SHARED_2S_APPROACH_2_5M_SHORT_WITHIN_EXISTING_5M_ARRIVAL',
                initial_conditions=copy.deepcopy(self.benchmark_fixture.condition),
                actual_population={'vehicles':len(self.population.vehicles),'pedestrians':len(self.population.walkers),
                                   'controllers':sum(e.get('controller_id') is not None for e in self.population.walkers.values()),'walkers_active':0})
            if self.benchmark_fixture.condition.get('comparison_scenario'):
                manifest['comparison_scenario']=copy.deepcopy(self.benchmark_fixture.condition['comparison_scenario'])
            variants=getattr(self,'presentation_vehicle_variants',None)
            if variants:
                manifest.update(vehicle_variants=dict(variants),vehicle_geometry=copy.deepcopy(self.vehicle_geometry.__dict__),
                    comparison_scope='Same vehicle, sensors and world start; reactive sensors versus predictive RULE. Traffic can diverge.')
        return manifest

    def clear_presentation_context(self):
        """An explicit ordinary/research journey cannot inherit stress controls."""
        stress=getattr(self,'dense_chaos',None)
        if stress:stress.running=False
        self.dense_chaos=None
        self.guided_presentation=False
        self.presentation_vehicle_variants=None

    def prepare_journey_comparison(self, manifest, *, mode=None):
        self._ensure_dashboard_tools()
        if not manifest or manifest['map'] != self.dashboard_tools.map_name:
            raise ValueError('Start the saved CARLA map before preparing this comparison')
        if not manifest.get('vehicle_variants') and manifest['blueprint'] != self.ego.actor.type_id:
            raise ValueError('Select the saved vehicle before preparing this comparison')
        self.stop_navigation()
        self.set_controls(brake=1)
        if manifest.get('protocol') in ('HYBRID_NATIVE_BASELINE_V1', 'PRESENTATION_RULE_NORMAL_V1','GUIDED_RULE_NORMAL_V2','SENSOR_REACTIVE_PREDICTIVE_V1') and manifest.get('initial_condition_id'):
            if not self.benchmark_fixture or self.benchmark_fixture.condition['id'] != manifest['initial_condition_id']:
                raise ValueError('The live benchmark fixture expired; start a new pair')
            self.benchmark_fixture.restore(**({'rebuild':True} if manifest.get('guided') else {}))
            if manifest.get('vehicle_variants'):self.select_presentation_vehicle(mode)
            api, origin = self.connection.api, manifest['origin']
            self.ego.actor.set_target_velocity(api.Vector3D()); self.ego.actor.set_target_angular_velocity(api.Vector3D())
            self.ego.actor.set_transform(api.Transform(api.Location(*origin['location']),
                api.Rotation(pitch=origin['rotation'][0],yaw=origin['rotation'][1],roll=origin['rotation'][2])))
            weather = self.world.world.get_weather()
            for key,value in manifest['weather'].items(): setattr(weather,key,value)
            self.world.world.set_weather(weather)
            tools = self.dashboard_tools
            tools.route,tools.native_route = tools.route_service.plan(self.ego.actor.get_location(), copy.deepcopy(manifest['destination']))
            self.benchmark_prepared = True
            return
        self.population.reset_population()
        api, origin = self.connection.api, manifest['origin']
        self.ego.actor.set_target_velocity(api.Vector3D(0,0,0))
        self.ego.actor.set_target_angular_velocity(api.Vector3D(0,0,0))
        self.ego.actor.set_transform(api.Transform(api.Location(*origin['location']),
            api.Rotation(pitch=origin['rotation'][0],yaw=origin['rotation'][1],roll=origin['rotation'][2])))
        weather = self.world.world.get_weather()
        for key, value in manifest['weather'].items(): setattr(weather,key,value)
        self.world.world.set_weather(weather)
        tools = self.dashboard_tools
        tools.route, tools.native_route = tools.route_service.plan(self.ego.actor.get_location(), copy.deepcopy(manifest['destination']))
        self.population.apply({**manifest['population'], 'vehicle_count':0 if manifest['crowded'] else manifest['population']['vehicle_count']})
        if manifest['crowded']:
            self.population.crowd_route(tools.route, tools.native_route, {'route_id':tools.route['id'],
                'seed':manifest['population']['seed'], 'chaos_percent':manifest['population']['chaos_percent']})
        self.population.set_route(tools.route['points'])
        self.set_controls(brake=1)

    def prepare_presentation(self, seed, speed, **options):
        from .presentation import prepare
        return prepare(self, seed, speed, **options)

    def finish_presentation_setup(self,seed,setup):
        from .presentation import finish_prepare
        return finish_prepare(self,seed,setup)

    def presentation_population_audit(self):
        from .presentation import population_audit
        return population_audit(self)

    def start_navigation(self, speed_kmh, *, demo_options=None, driving_mode='ROBOSPHERE', presentation=False, evaluation=False):
        self._ensure_dashboard_tools()
        if not self.dashboard_tools.route:
            raise ValueError('Choose a valid destination and show its route before starting')
        # Resume always plans from the real vehicle's current location.
        self.dashboard_tools.replan_route()
        self.driving_mode = driving_mode
        self.presentation_mode = presentation
        # Harness evaluation shares the guided arms' route controller and
        # requested-target semantics; posted limits remain logged separately.
        self.evaluation_navigation = bool(evaluation) and not presentation
        self.evaluation_route_probe = None
        self.route_tracker_steering = None
        self._dense_route_key = None
        from ..learning.native_validation_budget import active_rule_ticket
        self.rule_validation_mode = driving_mode == 'ROBOSPHERE' and active_rule_ticket() is not None and not self.evaluation_navigation
        if driving_mode not in ('HYBRID','BASELINE') and not presentation and self.benchmark_fixture:
            self.benchmark_fixture.close(); self.benchmark_fixture = None
        self.hybrid_driver = None
        self.hybrid_alternative = None
        from .route_agent import route_agent_class
        BasicAgent = route_agent_class()
        delta = self.fixed_delta
        self.navigation_options = {'dt': delta, 'max_brake': 1.,
                      # One shared native route controller for both guided arms.
                      # Saturated low-speed steering made the Mercedes point at
                      # parked curb geometry while recovering from a stop.
                      **({'max_throttle':.9,'max_steering':.35} if (presentation and getattr(self,'guided_presentation',False)) or self.evaluation_navigation else {}),
                      'lateral_control_dict': {'K_P': 1.95, 'K_I': .05, 'K_D': .2, 'dt': delta},
                      'longitudinal_control_dict': {'K_P': 1., 'K_I': .05, 'K_D': 0., 'dt': delta},
                      **(demo_options or {})}
        if driving_mode in ('HYBRID', 'BASELINE') or presentation or self.rule_validation_mode or self.evaluation_navigation:
            from .hybrid_navigation import RoadSpeedPolicy, behavior_agent_class
            self.hybrid_speed_policy = RoadSpeedPolicy(self.dashboard_tools.map)
        if driving_mode == 'BASELINE':
            self.navigation = behavior_agent_class()(self.ego.actor, speed_policy=self.hybrid_speed_policy,
                requested_speed=speed_kmh, opt_dict=copy.deepcopy(self.navigation_options),
                map_inst=self.dashboard_tools.map, grp_inst=self.dashboard_tools.route_service.planner)
        else:
            self.navigation = BasicAgent(self.ego.actor, target_speed=speed_kmh,
                opt_dict=copy.deepcopy(self.navigation_options),
                map_inst=self.dashboard_tools.map, grp_inst=self.dashboard_tools.route_service.planner)
        self.navigation.set_global_plan(self.dashboard_tools.native_route,
                                        stop_waypoint_creation=True, clean_queue=True)
        self.navigation_planner=None
        self.navigation_recovery=None
        self.navigation_bypass=None
        if driving_mode == 'HYBRID':
            from ..core.hybrid_driver import HybridDriver
            from ..core.hybrid_config import admission
            config, ticket = admission(self.dashboard_tools.map_name, speed_kmh)
            self.navigation.ignore_vehicles(True)
            self.navigation.ignore_traffic_lights(False)
            self.navigation.ignore_stop_signs(False)
            self.hybrid_driver = HybridDriver(self.vehicle_geometry,
                deadline=ticket['expires_monotonic_s'] if ticket else float('inf'))
        elif driving_mode == 'BASELINE':
            self.navigation.ignore_vehicles(False)
            self.navigation.ignore_traffic_lights(False)
            self.navigation.ignore_stop_signs(False)
        elif driving_mode == 'NORMAL':
            # Native navigation owns route/signals; the shared sensor pipeline
            # owns Normal's reactive obstacle braking without actor queries.
            self.navigation.ignore_vehicles(True)
            self.navigation.ignore_traffic_lights(False)
            self.navigation.ignore_stop_signs(False)
        elif demo_options is None:
            import json
            from pathlib import Path
            from ..core.maneuver import ManeuverPlanner
            config=json.loads((Path(__file__).resolve().parents[2]/'config/motion-reliability.json').read_text())
            # Native target poses are not ordinary driver inputs. The existing
            # sensor RULE layer owns protected-mode forward obstacle protection.
            self.navigation.ignore_vehicles(True)
            gate_enabled=False;ticket=None
            # Controlled native tests may enable lateral motion only inside
            # a live, crash-charged reservation of the new experiment ledger.
            gate=Path(__file__).resolve().parents[2]/'output/motion-reliability/lateral-validation.json'
            if gate.exists():
                import sqlite3
                from contextlib import closing
                ticket=json.loads(gate.read_text())
                if time.monotonic()<ticket['expires_monotonic_s']:
                    with closing(sqlite3.connect(gate.parent/'budget.sqlite')) as db:
                        row=db.execute('SELECT phase,finished FROM phases WHERE id=?',(ticket['reservation_id'],)).fetchone()
                    gate_enabled=row==('validation',0)
            if (config['planner_enabled'] and config['longitudinal_native_acceptance']) or gate_enabled:
                self.navigation_planner=ManeuverPlanner(self.vehicle_geometry,lateral_accepted=config['lateral_native_acceptance'] or gate_enabled)
                if gate_enabled:self.navigation_planner.lateral_deadline=ticket['expires_monotonic_s']
            recovery_config=json.loads((Path(__file__).resolve().parents[2]/'config/congestion-recovery.json').read_text())
            from ..learning.recovery_budget import active_ticket
            recovery_ticket=active_ticket()
            recovery_test=recovery_ticket is not None
            if recovery_config['enabled'] and recovery_config['native_accepted'] or recovery_test:
                from ..core.congestion_recovery import CongestionRecovery
                self.navigation_recovery=CongestionRecovery(self.vehicle_geometry,
                    reverse_accepted=recovery_config['reverse_accepted'] or recovery_test,
                    lateral_accepted=recovery_config['lateral_accepted'] or recovery_test,
                    rule_exception_accepted=recovery_config['rule_exception_accepted'] or recovery_test)
                if recovery_test:
                    self.navigation_recovery.validation_deadline=recovery_ticket['expires_monotonic_s']
                    # Validate the new bounded overlay around the existing route
                    # follower, rather than enabling the rejected full planner.
                    self.navigation_planner=None
        if driving_mode=='ROBOSPHERE':
            from ..core.route_bypass import availability,RuleRouteBypass
            admission=availability(int(time.monotonic()))
            if admission['available'] and self.dashboard_tools.map_name.rsplit('/',1)[-1]=='Town10HD_Opt':
                self.navigation_bypass=RuleRouteBypass(self.vehicle_geometry,deadline=admission['deadline'],sides=admission['sides'])
        return self.route_state()

    def local_road_context(self,session_id):
        """Map rules and ego-local route only; never another native actor."""
        import math
        transform=self.ego.actor.get_transform();origin=transform.location
        f=transform.get_forward_vector();right=transform.get_right_vector()
        def local(loc):
            dx,dy=loc.x-origin.x,loc.y-origin.y
            return [dx*f.x+dy*f.y,dx*right.x+dy*right.y]
        plan=list(self.navigation.get_local_planner().get_plan())
        points=[local(w.transform.location) for w,_ in plan if w.transform.location.distance(origin)<60.]
        ahead=[p for p in points if p[0]>.5]
        if not ahead:ahead=[[50.,0.]]
        nearest=min(points,key=lambda p:math.hypot(*p)) if points else [0.,0.]
        centerline=[[0.,nearest[1]]]+ahead
        wp=self.dashboard_tools.map.get_waypoint(origin)
        junction=bool(wp.is_junction or any(w.is_junction and w.transform.location.distance(origin)<20. for w,_ in plan))
        permissions=str(wp.lane_change)
        result={'session_id':session_id,'centerline':centerline,'lane_width_m':float(wp.lane_width),
            'junction_ahead':junction,'left_allowed':False,'right_allowed':False,
            'traffic_stop':self.navigation_stop_reason if self.navigation_stop_reason and 'traffic light' in self.navigation_stop_reason.lower() else None}
        for side in ('left','right'):
            neighbour=getattr(wp,'get_'+side+'_lane')()
            if neighbour is None:continue
            direction=neighbour.transform.get_forward_vector()
            result[side+'_allowed']=bool(not junction and str(neighbour.lane_type)=='Driving' and
                direction.x*f.x+direction.y*f.y>.8 and (side.title() in permissions or 'Both' in permissions))
        return result

    def replan_after_recovery(self):
        self.dashboard_tools.replan_route()
        self.navigation.set_global_plan(self.dashboard_tools.native_route,
                                        stop_waypoint_creation=True,clean_queue=True)

    def hybrid_road_context(self, session_id):
        from .hybrid_navigation import road_context
        return road_context(self, session_id)

    def find_hybrid_alternative(self, scene):
        """Project a *measured* front blocker onto the map for detour search."""
        if self.hybrid_alternative is not None: return self.hybrid_alternative
        driver = self.hybrid_driver
        if not driver or not driver.last: return None
        blocker=driver.last.get('front_blocker')
        if not blocker or blocker['gap_m']>max(25.,scene.observation.ego.speed_mps*3.):return None
        stamp=scene.observation.timestamp_s
        if stamp-getattr(self,'hybrid_alternative_attempt_at',-float('inf'))<2.:return None
        pose = self.ego.actor.get_transform(); f = pose.get_forward_vector(); r = pose.get_right_vector()
        front = [t for t in scene.prediction['tracks'] if t.get('confirmed') and t['id']==blocker['track_id']
                 and math.hypot(*t['velocity_mps'])<.3]
        if not front: return None
        self.hybrid_alternative_attempt_at=stamp
        target = min(front, key=lambda t:t['position_m'][0])
        x,y = target['position_m']; location = self.connection.api.Location(
            x=pose.location.x+f.x*x+r.x*y, y=pose.location.y+f.y*x+r.y*y, z=pose.location.z)
        alternative = self.dashboard_tools.route_service.alternative(
            pose.location, self.dashboard_tools.route['destination'], location)
        if alternative is not None:
            import numpy as np
            from ..core.maneuver import spatial_route,stationary_route_blocker
            points=[]
            for point in alternative[0]['points']:
                dx,dy=point[0]-pose.location.x,point[1]-pose.location.y
                local=[dx*f.x+dy*f.y,dx*r.x+dy*r.y]
                if local[0]>.5:points.append(local)
                if math.hypot(dx,dy)>45.:break
            if points:
                path=spatial_route(0.,{'centerline':[[0.,0.]]+points},np.arange(0.,40.01,.5))
                if stationary_route_blocker(scene.prediction['tracks'],path,self.vehicle_geometry,max(25.,blocker['gap_m']+8.)) is not None:
                    alternative=None
            else:alternative=None
        self.hybrid_alternative=alternative
        return self.hybrid_alternative

    def apply_hybrid_alternative(self):
        if self.hybrid_alternative is None: return False
        self.dashboard_tools.route, self.dashboard_tools.native_route = self.hybrid_alternative
        self.navigation.set_global_plan(self.dashboard_tools.native_route, stop_waypoint_creation=True, clean_queue=True)
        self.hybrid_alternative = None
        return True

    def create_comparison_v2(self, service):
        from .comparison_v2 import ComparisonV2
        return ComparisonV2(service)

    def navigation_command(self, frame_id, timestamp_s, speed_kmh):
        from ..core.contracts import CommandSource
        if self.navigation is None:
            raise RuntimeError('No active native route controller')
        limit = self.ego.actor.get_speed_limit()
        evaluation = getattr(self,'evaluation_navigation',False)
        if getattr(self, 'driving_mode', None) in ('HYBRID','BASELINE') or getattr(self,'presentation_mode',False) or getattr(self,'rule_validation_mode',False) or evaluation:
            waypoint = self.dashboard_tools.map.get_waypoint(self.ego.actor.get_location())
            limit, self.hybrid_speed_limit_source = self.hybrid_speed_policy.limit(waypoint, limit)
        # This explicitly requested closed-simulator stress speed is shared by
        # both guided drivers. Research and legacy runs retain posted limits.
        self.navigation_posted_limit_kmh = limit
        if getattr(self,'presentation_mode',False) and getattr(self,'guided_presentation',False):
            limit = speed_kmh
            self.hybrid_speed_limit_source = 'GUIDED_STRESS_TARGET'
        elif evaluation:
            limit = speed_kmh
            self.hybrid_speed_limit_source = 'EVALUATION_REQUESTED_TARGET'
        self.navigation_speed_limit_mps = limit/3.6 if limit > 0 else speed_kmh/3.6
        requested=min(speed_kmh,limit) if limit>0 else speed_kmh
        bypass=getattr(self,'navigation_bypass',None)
        if bypass and bypass.motion_required:requested=min(requested,bypass.config['maneuver_speed_mps']*3.6)
        if getattr(self,'driving_mode',None) in ('HYBRID','BASELINE') or getattr(self,'presentation_mode',False) or getattr(self,'rule_validation_mode',False) or evaluation:
            from ..core.route_terminal import terminal_speed_mps
            route=self.route_state()
            if route and route.get('remaining_m') is not None:
                requested=min(requested,terminal_speed_mps(route['remaining_m'])*3.6)
        self.navigation_curvature_limit_mps=None
        if evaluation:
            # Route geometry restricts speed before tight curves; the requested
            # target remains the comparison request and is logged separately.
            from ..core.launch_alignment import curvature_speed_limit
            planner=self.navigation.get_local_planner() if hasattr(self.navigation,'get_local_planner') else None
            location=self.ego.actor.get_location()
            plan=[(wp.transform.location.x,wp.transform.location.y) for wp,_ in list(planner.get_plan())[:40]] if planner else []
            curve=curvature_speed_limit((location.x,location.y),plan)
            self.navigation_curvature_limit_mps=curve
            if curve is not None and curve*3.6<requested:
                requested=curve*3.6;self.hybrid_speed_limit_source='ROUTE_CURVATURE'
        self.navigation.set_target_speed(requested)
        self.navigation_target_mps=requested/3.6
        value = self.navigation.run_step()
        self.navigation_stop_reason = getattr(self.navigation,'stop_reason',None)
        steering = float(value.steer)
        self.launch_alignment = None
        self.evaluation_route_probe = None
        if evaluation:
            from ..core.launch_alignment import LAUNCH_SPEED_MPS, lane_alignment, launch_steering, pursuit_steering
            from ..core.route_tracking import track
            pose = self.ego.actor.get_transform()
            speed = self.last_vehicle['speedMps'] if self.last_vehicle and 'speedMps' in self.last_vehicle else self.ego.actor.get_velocity().length()
            planner = self.navigation.get_local_planner() if hasattr(self.navigation, 'get_local_planner') else None
            plan = [(wp.transform.location.x, wp.transform.location.y) for wp, _ in list(planner.get_plan())[:80]] if planner else []
            tracked = None
            route_window = self._evaluation_route_window(pose.location.x, pose.location.y)
            if route_window is not None and getattr(self, 'vehicle_geometry', None) is not None and getattr(self, 'route_tracker_enabled', True):
                try:
                    # One route-following tracker owns steering at every speed;
                    # the supervisor probes the path this tracker will drive.
                    tracked, path, info = track((pose.location.x, pose.location.y), math.radians(pose.rotation.yaw), route_window,
                        speed_mps=speed, target_speed_mps=self.navigation_target_mps, geometry=self.vehicle_geometry,
                        limit=float(self.navigation_options.get('max_steering', .35)),
                        previous_steering=getattr(self, 'route_tracker_steering', None), control_period_s=self.fixed_delta)
                except ValueError:
                    tracked = None
            if tracked is not None:
                import numpy as np
                steering, self.launch_alignment = tracked, 'ROUTE_TRACKER'
                self.evaluation_route_probe = {'frame_id': frame_id, 'timestamp_s': timestamp_s, 'steering': steering,
                                               'path_array': np.asarray(path, float), **info}
            elif abs(speed) < LAUNCH_SPEED_MPS:
                pursuit = pursuit_steering((pose.location.x, pose.location.y), pose.rotation.yaw, plan[:60])
                if pursuit is not None:
                    steering, self.launch_alignment = pursuit, 'LOW_SPEED_LANE_PURSUIT'
                else:
                    lane = self.dashboard_tools.map.get_waypoint(pose.location)
                    if lane is not None:
                        offset, error = lane_alignment(pose, lane.transform)
                        steering, self.launch_alignment = launch_steering(steering, speed_mps=speed, lateral_offset_m=offset, heading_error_deg=error)
            self.route_tracker_steering = steering
        # Canonical steering, like native telemetry, is right-positive. The
        # left-positive legacy dashboard adapter is used only in set_controls.
        # This command still goes through ControlSafetyLayer and CommandArbiter.
        return ControlCommand(frame_id, timestamp_s, float(value.throttle), float(value.brake),
                              steering, bool(value.reverse), bool(value.hand_brake),
                              CommandSource.NAVIGATION, -1 if value.reverse else 1)

    def navigation_done(self):
        return self.navigation is not None and self.navigation.done()

    def _evaluation_route_window(self, x, y, *, behind=24, ahead=140):
        """Dense planned-route points around the car (0.5 m lane geometry, cached per plan)."""
        import numpy as np
        native = getattr(self.dashboard_tools, 'native_route', None) or []
        key = (id(native), len(native))
        if getattr(self, '_dense_route_key', None) != key:
            from ..core.route_tracking import dense_route
            self._dense_route = np.asarray(dense_route([w for w, _ in native]), float) if len(native) >= 2 else None
            self._dense_route_key = key;self._dense_route_index = None
        route = getattr(self, '_dense_route', None)
        if route is None or len(route) < 2:return None
        previous = getattr(self, '_dense_route_index', None)
        lo, hi = (0, len(route)) if previous is None else (max(0, previous-10), min(len(route), previous+60))
        index = lo+int(np.argmin(np.hypot(route[lo:hi, 0]-x, route[lo:hi, 1]-y)))
        self._dense_route_index = index
        window = route[max(0, index-behind):index+ahead]
        return [tuple(p) for p in window] if len(window) >= 2 else None

    def stop_navigation(self):
        self.navigation = None
        self.evaluation_navigation = False
        self.evaluation_route_probe = None
        self.route_tracker_steering = None
        self.navigation_planner = None
        self.navigation_recovery = None
        self.navigation_bypass = None
        self.hybrid_driver = None
        self.hybrid_alternative = None

    @property
    def required_sensors(self):
        if not self.sensor_suite:return ()
        extras=tuple(n for n in ('rearDepth','leftDepth','rightDepth','frontLeftDepth','frontRightDepth','rearLeftDepth','rearRightDepth',
                                'frontLeftRadar','frontRightRadar','rearLeftRadar','rearRightRadar')
                     if self.sensor_manager and n in self.sensor_manager.actors)
        return ('frontCamera', 'depth', 'radar', 'lidar', 'imu', 'gnss')+extras

    def drain_sensor_frames(self):
        return self.sensor_manager.drain_frames() if self.sensor_manager else ()

    def get_sensor_asset(self, asset):
        return self.sensor_manager.asset_bytes(asset)

    def driving_camera(self, frame_id=None):
        from ..core.contracts import to_dict
        manager=self.sensor_manager
        if not manager:return None,None
        with manager.lock:
            frames=manager.driving_frames
            sensor=frames.get(frame_id) if frame_id is not None else next(reversed(frames.values()),None)
            if sensor is None:return None,None
            m=sensor.metadata
            view={'sensorId':'drivingCamera','source':'carla','frame':sensor.frame_id,'timestamp':sensor.timestamp_s,
                'width':m['width'],'height':m['height'],'fovDeg':m['fov_deg'],
                'worldTransform':to_dict(sensor.transform),'mountTransform':to_dict(m['mount_transform']),
                'contentType':sensor.asset.media_type,'frameAvailable':True}
            return manager.asset_bytes(sensor.asset),view

    def get_sensor_rates(self):
        return self.sensor_manager.rates() if self.sensor_manager else {}

    def get_sensor_wall_rates(self):
        return self.sensor_manager.wall_rates() if self.sensor_manager else {}

    def sensor_errors(self):
        return dict(self.sensor_manager.errors) if self.sensor_manager else {}

    def sensor_registry(self):
        return self.sensor_manager.registry() if self.sensor_manager else {}

    def apply_control(self, command: ControlCommand):
        if not isinstance(command, ControlCommand):
            raise ValueError('Expected canonical ControlCommand')
        gear = 0 if command.gear == 0 else -1 if command.reverse else 1
        self.set_controls(throttle=command.throttle, brake=command.brake,
                          steering=-command.steering, parkingbrake=int(command.handbrake), gear=gear)

    def apply_control_confirmed(self, command: ControlCommand):
        """Accepted safety/training acknowledgement using this provider's client.

        The ordinary call updates libcarla's sticky-control cache. Re-sending
        the identical accepted command in a synchronous batch acknowledges it
        before the worker's separate physics tick. The batch never ticks.
        """
        self.apply_control(command)
        native=native_control(self.connection.api,**self.controls)
        result=self.connection.client.apply_batch_sync(
            [self.connection.api.command.ApplyVehicleControl(self.ego.actor.id,native)],False)
        if len(result)!=1 or result[0].error:
            raise RuntimeError('Native control acknowledgement failed: '+str(result[0].error if result else 'empty response'))

    def get_world_state(self):
        return self.last_world

    def get_sensor_state(self):
        return self.sensor_manager.latest() if self.sensor_manager else {}

    def get_camera_frame(self):
        return None, None  # SimulationService serves RGB only after exact-frame synchronization.

    def is_connected(self):
        return self.world is not None and self.connection.is_connected()

    def reset_vehicle(self):
        if self.scenarios and self.scenarios.mode.value == 'TRAINING' and not self.scenarios.resetting:
            return self.scenarios.reset()
        if self.population: self.population.reset_population()
        self.destroy_ego_vehicle()
        if self.cleanup_errors:
            raise RuntimeError('CARLA cleanup failed: ' + '; '.join(self.cleanup_errors))
        self.gear = 1
        self.spawn_ego_vehicle()
        if self.population: self.population.ego_id = self.ego.actor.id
        self.set_controls(brake=1)
        if self.world.paused:
            self.world.paused = False
            try:
                self.step()  # Register the replacement actor in a native snapshot.
            finally:
                self.world.paused = True

    def set_paused(self, paused):
        if not isinstance(paused, bool):
            raise ValueError('paused must be boolean')
        self.set_controls(brake=1)
        if paused and not self.world.paused:
            self.world.advance()  # Apply released pedals before withholding ticks.
        self.world.paused = paused

    def load_world(self, map_name):
        self.disconnect()
        if self.cleanup_errors:
            raise RuntimeError('CARLA cleanup failed: ' + '; '.join(self.cleanup_errors))
        self.map_name = map_name
        return self.connect()

    def reset_world(self):
        name = self.world.world.get_map().name if self.world else self.map_name
        return self.load_world(name)

    def disconnect(self):
        self.cleanup_errors = []
        try:
            if self.benchmark_fixture:self.benchmark_fixture.close()
        except RuntimeError as error:
            self.cleanup_errors.append(str(error))
        finally:
            self.benchmark_fixture=None;self.benchmark_prepared=False
        try:
            if self.scenarios:
                self.scenarios.stop(reason='disconnect'); self.scenarios.cleanup()
        except RuntimeError as error:
            self.cleanup_errors.append(str(error))
        try:
            if self.population: self.population.close()
        except RuntimeError as error:
            self.cleanup_errors.append(str(error))
        try:
            self.destroy_ego_vehicle()
        except RuntimeError as error:
            self.cleanup_errors.append(str(error))
        try:
            if self.world:
                self.world.restore()
        except RuntimeError as error:
            self.cleanup_errors.append(str(error))
        finally:
            self.world = None
            self.population = self.inspector = self.last_ground_truth = None
            self.local_population_counts = {}
            self.dashboard_tools = None
            self.scenarios = None
            self.strict_ego_spawn = False
            self.last_vehicle = self.last_world = None
            self.connection.disconnect()

    close = disconnect

    def restart_configuration(self):
        from .dashboard_tools import WEATHER_PRESET_FIELDS
        weather = self.world.world.get_weather()
        return {'camera': dict(self.camera_settings), 'vehicle':self.blueprint,
                'spawn_index':self.spawn_index, 'fixed_delta':self.fixed_delta,
                'map':self.world.world.get_map().name,
                'weather':{key:getattr(weather,key) for key in WEATHER_PRESET_FIELDS if hasattr(weather,key)}}

    def recording_metadata(self):
        return {'native_version':self.connection.server_version,'python_api_version':self.connection.api_version,
                'map':self.world.world.get_map().name,'blueprint':self.ego.actor.type_id,
                'fixed_delta_seconds':self.fixed_delta,'camera':dict(self.camera_settings),
                'vehicle_geometry':self.vehicle_geometry.snapshot() if getattr(self,'vehicle_geometry',None) else None,
                'jpeg_quality':95,'launch':self.active_launch,'gpu':self.runtime.gpu,
                'navigation':'CARLA BehaviorAgent normal' if getattr(self,'driving_mode',None)=='BASELINE' else
                    'Sensor hybrid behavior with native route/signals follower' if getattr(self,'driving_mode',None)=='HYBRID' else
                    'Explicit BasicAgent journeys via NAVIGATION safety arbitration; manual guidance available',
                'driving_mode':getattr(self,'driving_mode',None),
                'storage_policy':'GUIDED_KEEP_TWO_RAW' if getattr(self,'presentation_mode',False) and
                    getattr(self,'guided_presentation',False) else 'KEEP_RAW',
                'driver_id':'CARLA_BEHAVIOR_NORMAL' if getattr(self,'driving_mode',None)=='BASELINE' else
                    'ROBOSPHERE_HYBRID_V1' if getattr(self,'driving_mode',None)=='HYBRID' else getattr(self,'driving_mode',None),
                'native_obstacle_handling':getattr(self,'driving_mode',None)=='BASELINE',
                'population': self.population_state(), 'environment':self.environment_state(),
                'traffic_active': bool(self.population and self.population.vehicles),
                'ya_rab_ostorha': {'status':getattr(self, 'active_safety_status', None),
                    'parameters':getattr(self, 'active_safety_configuration', None)}}

    def restart_status(self):
        ticket = getattr(self, 'restart_ticket', None)
        if not ticket:
            return None
        import json
        from pathlib import Path
        return json.loads(Path(ticket).read_text(encoding='utf-8'))['result']
