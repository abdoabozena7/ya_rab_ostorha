"""CARLA is the rendered simulator. This provider sends controls and reads state."""
from .connection import CarlaConnection
from .controls import native_control
from .sensors import CarlaSensorManager
from .telemetry import vehicle_state
from .vehicle import EgoVehicle
from .world import CarlaWorld
from .target import VERSION
from .contracts import simulation_frame
from ..core.contracts import ControlCommand


class CarlaProvider:
    name = 'carla'

    def __init__(self, host='127.0.0.1', port=2000, version=VERSION, map_name=None,
                 blueprint='vehicle.lincoln.mkz_2020', spawn_index=0, fixed_delta=.05, collision_sensor=False, sensor_suite=False):
        self.connection = CarlaConnection(host, port, version)
        self.map_name, self.blueprint, self.spawn_index = map_name, blueprint, spawn_index
        self.fixed_delta = fixed_delta
        self.collision_sensor = collision_sensor
        self.sensor_suite = sensor_suite
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
            raw_world = self.connection.connect()
            if self.map_name:
                raw_world = self.connection.client.load_world(self.map_name)
            self.catalog = {'maps': self.connection.client.get_available_maps(),
                            'vehicles': [bp.id for bp in raw_world.get_blueprint_library().filter('vehicle.*')]}
            self.world = CarlaWorld(raw_world, self.fixed_delta)
            self.spawn_ego_vehicle()
            self.set_controls(brake=1)
            self.step()
        except Exception:
            self.disconnect()
            raise
        return self

    def spawn_ego_vehicle(self):
        if self.ego is not None:
            raise RuntimeError('An ego vehicle is already owned by this session')
        self.ego = EgoVehicle(self.world.world, self.blueprint, self.spawn_index)
        actor = self.ego.spawn()
        self.sensor_manager = CarlaSensorManager(self.world.world, actor)
        if self.collision_sensor:
            self.sensor_manager.enable_collision(self.connection.api)
        if self.sensor_suite:
            self.sensor_manager.enable_suite(self.connection.api, self.fixed_delta)
        return actor.id

    def destroy_ego_vehicle(self):
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
        snapshot = self.world.advance()
        self.last_vehicle = vehicle_state(self.ego.actor, snapshot)
        self.last_world = {**self.world.state(snapshot), 'version': self.connection.server_version,
                           'pythonApiVersion': self.connection.api_version}
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
        return simulation_frame(self.last_vehicle, self.last_world)

    def drain_collision_events(self):
        return self.sensor_manager.drain_collisions() if self.sensor_manager else ()

    @property
    def required_sensors(self):
        return ('frontCamera', 'depth', 'radar', 'lidar', 'imu', 'gnss') if self.sensor_suite else ()

    def drain_sensor_frames(self):
        return self.sensor_manager.drain_frames() if self.sensor_manager else ()

    def get_sensor_asset(self, asset):
        return self.sensor_manager.asset_bytes(asset)

    def get_sensor_rates(self):
        return self.sensor_manager.rates() if self.sensor_manager else {}

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

    def get_world_state(self):
        return self.last_world

    def get_sensor_state(self):
        return self.sensor_manager.latest() if self.sensor_manager else {}

    def get_camera_frame(self):
        return None, None  # SimulationService serves RGB only after exact-frame synchronization.

    def is_connected(self):
        return self.world is not None and self.connection.is_connected()

    def reset_vehicle(self):
        self.destroy_ego_vehicle()
        if self.cleanup_errors:
            raise RuntimeError('CARLA cleanup failed: ' + '; '.join(self.cleanup_errors))
        self.gear = 1
        self.spawn_ego_vehicle()
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
            self.last_vehicle = self.last_world = None
            self.connection.disconnect()

    close = disconnect
