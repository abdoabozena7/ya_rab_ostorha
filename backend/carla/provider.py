"""CARLA is the rendered simulator. This provider sends controls and reads state."""
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
                 blueprint='vehicle.lincoln.mkz_2020', spawn_index=0, fixed_delta=.05, collision_sensor=False, sensor_suite=False):
        self.connection = CarlaConnection(host, port, version)
        self.map_name, self.blueprint, self.spawn_index = map_name, blueprint, spawn_index
        self.fixed_delta = fixed_delta
        self.collision_sensor = collision_sensor
        self.sensor_suite = sensor_suite
        self.camera_settings = {'camera_view': 'front', 'camera_resolution': '800x450', 'camera_fov': 90,
                                'camera_postprocess': False, 'camera_motion_blur': 0., 'camera_bloom': 0.}
        self.navigation = None
        self.scenarios = None
        self.strict_ego_spawn = False
        self.population = None
        self.inspector = None
        self.last_ground_truth = None
        self.dashboard_tools = None
        self.world = self.ego = self.sensor_manager = None
        self.gear = 1
        self.last_vehicle = self.last_world = None
        self.catalog = {}
        self.cleanup_errors = []
        self.controls = {'throttle': 0, 'brake': 1, 'steering': 0, 'parkingbrake': 0, 'gear': 1}

    def connect(self):
        if self.world is not None or self.ego is not None or self.cleanup_errors:
            raise RuntimeError('Disconnect the existing CARLA session first')
        try:
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
                           ('ostorha_ego', 'ostorha_npc', 'ostorha_walker', 'ostorha_sensor', 'ostorha_scenario')}
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
            self.spawn_ego_vehicle()
            self.population = WorldPopulationManager(self.connection.client, raw_world, self.connection.api, self.ego.actor.id)
            from .scenarios import NativeScenarioManager
            self.scenarios = NativeScenarioManager(self)
            self.set_controls(brake=1)
            self.step()
        except Exception:
            self.disconnect()
            raise
        return self

    def spawn_ego_vehicle(self):
        if self.ego is not None:
            raise RuntimeError('An ego vehicle is already owned by this session')
        self.ego = EgoVehicle(self.world.world, self.blueprint, self.spawn_index, strict_spawn=self.strict_ego_spawn)
        actor = self.ego.spawn()
        self.inspector = NearbyActorInspector(self.world.world, actor)
        self.sensor_manager = CarlaSensorManager(self.world.world, actor)
        if self.collision_sensor:
            self.sensor_manager.enable_collision(self.connection.api)
        if self.sensor_suite:
            self.sensor_manager.enable_suite(self.connection.api, self.fixed_delta, self.camera_settings)
        return actor.id

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
        if self.scenarios: self.scenarios.before_tick()
        if self.population and self.dashboard_tools:
            route = self.dashboard_tools.route
            self.population.set_route(route['points'] if route else [])
        snapshot = self.world.advance()
        if self.population: self.population.update(snapshot)
        self.last_vehicle = vehicle_state(self.ego.actor, snapshot)
        self.last_ground_truth = self.inspector.observe(snapshot) if self.inspector else None
        self.last_world = {**self.world.state(snapshot), 'version': self.connection.server_version,
                           'pythonApiVersion': self.connection.api_version}
        if self.scenarios: self.scenarios.after_tick(snapshot)
        self._follow_ego(snapshot.find(self.ego.actor.id).get_transform())
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
            population = self.population.get_population_state()
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
        if self.scenarios and self.scenarios.mode.value == 'TRAINING' and action in ('settings','population','scene'):
            raise ValueError('Return to Living city before changing the controlled scene or route')
        if action == 'settings': return self.dashboard_tools.apply(value)
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

    def population_state(self):
        return self.population.get_population_state() if self.population else None

    def environment_state(self):
        return self.scenarios.status() if self.scenarios else None

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
        if self.connection.host not in ('127.0.0.1', 'localhost'):
            raise ValueError('Native restart is available only for the local simulator')
        return validate_settings({'next_launch': value})['next_launch']

    def start_navigation(self, speed_kmh):
        self._ensure_dashboard_tools()
        if not self.dashboard_tools.route:
            raise ValueError('Choose a valid destination and show its route before starting')
        # Resume always plans from the real vehicle's current location.
        self.dashboard_tools.replan_route()
        from agents.navigation.basic_agent import BasicAgent
        delta = self.fixed_delta
        self.navigation = BasicAgent(self.ego.actor, target_speed=speed_kmh,
            opt_dict={'dt': delta, 'max_brake': 1.,
                      'lateral_control_dict': {'K_P': 1.95, 'K_I': .05, 'K_D': .2, 'dt': delta},
                      'longitudinal_control_dict': {'K_P': 1., 'K_I': .05, 'K_D': 0., 'dt': delta}},
            map_inst=self.dashboard_tools.map, grp_inst=self.dashboard_tools.route_service.planner)
        self.navigation.set_global_plan(self.dashboard_tools.native_route,
                                        stop_waypoint_creation=True, clean_queue=True)
        return self.route_state()

    def navigation_command(self, frame_id, timestamp_s, speed_kmh):
        from ..core.contracts import CommandSource
        if self.navigation is None:
            raise RuntimeError('No active native route controller')
        limit = self.ego.actor.get_speed_limit()
        self.navigation.set_target_speed(min(speed_kmh, limit) if limit > 0 else speed_kmh)
        value = self.navigation.run_step()
        # Canonical steering, like native telemetry, is right-positive. The
        # left-positive legacy dashboard adapter is used only in set_controls.
        # This command still goes through ControlSafetyLayer and CommandArbiter.
        return ControlCommand(frame_id, timestamp_s, float(value.throttle), float(value.brake),
                              float(value.steer), bool(value.reverse), bool(value.hand_brake),
                              CommandSource.NAVIGATION, -1 if value.reverse else 1)

    def navigation_done(self):
        return self.navigation is not None and self.navigation.done()

    def stop_navigation(self):
        self.navigation = None

    @property
    def required_sensors(self):
        return ('frontCamera', 'depth', 'radar', 'lidar', 'imu', 'gnss') if self.sensor_suite else ()

    def drain_sensor_frames(self):
        return self.sensor_manager.drain_frames() if self.sensor_manager else ()

    def get_sensor_asset(self, asset):
        return self.sensor_manager.asset_bytes(asset)

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
                'jpeg_quality':95,'launch':self.active_launch,'gpu':self.runtime.gpu,
                'navigation':'Explicit BasicAgent journeys via NAVIGATION safety arbitration; manual guidance available',
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
