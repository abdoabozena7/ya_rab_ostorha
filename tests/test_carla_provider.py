"""Offline SDK contract tests. These fixtures do not simulate vehicle physics."""
import copy
import math
import unittest
from types import SimpleNamespace as NS
from unittest.mock import MagicMock, patch

from backend.carla.connection import CarlaBlocker, CarlaConnection, ensure_runtime
from backend.carla.controls import native_control
from backend.carla.provider import CarlaProvider
from backend.carla.sensors import CarlaSensorManager
from backend.carla.telemetry import vehicle_state
from backend.carla.vehicle import EgoVehicle
from backend.carla.world import CarlaWorld


def vec(x=0, y=0, z=0):
    return NS(x=x, y=y, z=z)


def transform(location=None, rotation=None):
    return NS(location=location or vec(10, 20, 1), rotation=rotation or NS(pitch=0, yaw=90, roll=0),
              get_forward_vector=lambda: vec(0, 1, 0), get_up_vector=lambda: vec(0, 0, 1))


def fixture():
    world = MagicMock()
    settings = NS(synchronous_mode=False, fixed_delta_seconds=None, substepping=False,
                  max_substep_delta_time=.01, max_substeps=10)
    world.get_settings.side_effect = lambda: copy.copy(settings)
    world.apply_settings.side_effect = lambda value: settings.__dict__.update(value.__dict__)
    world.get_map.return_value.name = '/Game/Carla/Maps/Town10HD'
    world.get_map.return_value.get_spawn_points.return_value = [transform()]
    world.get_spectator.return_value.get_transform.return_value = transform()
    actor = MagicMock(id=144, type_id='vehicle.lincoln.mkz_2020', is_alive=True)
    actor.get_control.return_value = NS(throttle=.6, brake=0, steer=.2, reverse=False,
                                       gear=2, hand_brake=False)
    actor.destroy.return_value = True
    world.try_spawn_actor.return_value = actor
    observed = MagicMock()
    observed.get_transform.return_value = transform()
    observed.get_velocity.return_value = vec(3, -4, 0)
    observed.get_acceleration.return_value = vec(0, -6, 0)
    observed.get_angular_velocity.return_value = vec(0, 0, 180)
    snapshot = NS(frame=22, timestamp=NS(elapsed_seconds=1.1), find=lambda _: observed)
    world.get_snapshot.return_value = snapshot
    world.tick.return_value = 22
    world.get_blueprint_library.return_value.filter.return_value = [NS(id=actor.type_id)]
    return world, actor, snapshot, settings


class ConnectionTests(unittest.TestCase):
    def test_unsupported_python_is_rejected_before_import_or_connection(self):
        ensure_runtime((3, 12))
        for version in ((3, 7), (3, 13), (3, 14)):
            with self.subTest(version=version), self.assertRaises(CarlaBlocker):
                ensure_runtime(version)

    def test_version_match_and_reconnect(self):
        api = MagicMock()
        api.Client.return_value.get_client_version.return_value = '0.10.0'
        api.Client.return_value.get_server_version.return_value = '0.10.0'
        connection = CarlaConnection()
        with patch('backend.carla.connection.ensure_runtime'), patch('backend.carla.connection.importlib.import_module', return_value=api):
            connection.connect()
            self.assertTrue(connection.is_connected())
            connection.disconnect()
            self.assertFalse(connection.is_connected())
            connection.connect()
            self.assertEqual(api.Client.call_count, 2)

    def test_incompatible_api_fails_without_silent_fallback(self):
        api = MagicMock()
        api.Client.return_value.get_client_version.return_value = '0.9.15'
        api.Client.return_value.get_server_version.return_value = '0.10.0'
        with patch('backend.carla.connection.ensure_runtime'), patch('backend.carla.connection.importlib.import_module', return_value=api):
            connection = CarlaConnection()
            with self.assertRaisesRegex(CarlaBlocker, 'version mismatch'):
                connection.connect()
            self.assertFalse(connection.is_connected())

    def test_missing_api_and_connection_loss(self):
        with patch('backend.carla.connection.ensure_runtime'), patch('backend.carla.connection.importlib.import_module', side_effect=ImportError):
            with self.assertRaisesRegex(CarlaBlocker, 'shipped'):
                CarlaConnection().connect()
        connection = CarlaConnection()
        connection.client = MagicMock()
        connection.client.get_world.side_effect = RuntimeError('server stopped')
        self.assertFalse(connection.is_connected())


class ControlTelemetryTests(unittest.TestCase):
    def test_steering_sign_reverse_neutral_and_handbrake_map_to_native_api(self):
        api = NS(VehicleControl=lambda **values: NS(**values))
        left = native_control(api, throttle=.4, steering=1, gear=1)
        self.assertEqual(left.steer, -1)
        self.assertFalse(left.manual_gear_shift)
        reverse = native_control(api, gear=-1, parkingbrake=1)
        self.assertTrue(reverse.reverse)
        self.assertTrue(reverse.hand_brake)
        neutral = native_control(api, gear=0)
        self.assertTrue(neutral.manual_gear_shift)
        self.assertEqual(neutral.gear, 0)
        for field in ({'throttle': float('nan')}, {'steering': 2}, {'gear': 2}, {'brake': True}):
            with self.subTest(field=field), self.assertRaises(ValueError):
                native_control(api, **field)

    def test_native_snapshot_units_and_derived_longitudinal_speed(self):
        _, actor, snapshot, _ = fixture()
        state = vehicle_state(actor, snapshot)
        self.assertEqual(state['source'], 'carla')
        self.assertEqual(state['frame'], 22)
        self.assertEqual(state['speedMagnitudeMps'], 5)
        self.assertEqual(state['speedMps'], -4)
        self.assertEqual(state['accelerationMps2'], -6)
        self.assertAlmostEqual(state['angularVelocityWorldRadps'][2], math.pi)
        self.assertEqual(state['steeringInput'], .2)
        self.assertEqual(state['gear'], '2')
        for field in ('engineRPM', 'fuelLevelL', 'engineDamage', 'damage'):
            self.assertIsNone(state[field])

    def test_missing_actor_does_not_return_old_state(self):
        _, actor, snapshot, _ = fixture()
        snapshot.find = lambda _: None
        with self.assertRaisesRegex(RuntimeError, 'absent'):
            vehicle_state(actor, snapshot)


class WorldVehicleTests(unittest.TestCase):
    def test_synchronous_ticks_pause_and_restore_original_settings(self):
        world, _, _, settings = fixture()
        wrapped = CarlaWorld(world, .05)
        self.assertTrue(settings.synchronous_mode)
        self.assertEqual(wrapped.advance().frame, 22)
        wrapped.paused = True
        wrapped.advance()
        self.assertEqual(world.tick.call_count, 1)
        wrapped.restore()
        self.assertFalse(settings.synchronous_mode)
        self.assertIsNone(settings.fixed_delta_seconds)

    def test_conflicting_tick_owner_and_frame_are_rejected(self):
        world, _, snapshot, settings = fixture()
        settings.synchronous_mode = True
        with self.assertRaisesRegex(RuntimeError, 'tick owner'):
            CarlaWorld(world)
        settings.synchronous_mode = False
        wrapped = CarlaWorld(world)
        snapshot.frame = 23
        with self.assertRaisesRegex(RuntimeError, 'frame changed'):
            wrapped.advance()
        wrapped.restore()

    def test_spawn_collision_invalid_index_and_cleanup(self):
        world, actor, _, _ = fixture()
        ego = EgoVehicle(world)
        self.assertIs(ego.spawn(), actor)
        actor.set_autopilot.assert_called_once_with(False)
        ego.destroy()
        actor.destroy.assert_called_once()
        self.assertIsNone(ego.actor)
        with self.assertRaises(ValueError):
            EgoVehicle(world, spawn_index=9).spawn()
        world.try_spawn_actor.return_value = None
        with self.assertRaisesRegex(RuntimeError, 'occupied'):
            EgoVehicle(world).spawn()

    def test_provider_connect_catalog_control_and_cleanup(self):
        world, actor, _, settings = fixture()
        provider = CarlaProvider()
        provider.connection = MagicMock(api=NS(VehicleControl=lambda **v: NS(**v),
                                               Location=vec, Rotation=lambda **v: NS(**v), Transform=transform),
                                         server_version='0.10.0', api_version='0.10.0')
        provider.connection.connect.return_value = world
        provider.connection.client.get_available_maps.return_value = ['Town10HD']
        provider.connect()
        self.assertEqual(provider.catalog['maps'], ['Town10HD'])
        provider.set_controls(throttle=.6, steering=-1)
        self.assertEqual(actor.apply_control.call_args.args[0].steer, 1)
        self.assertEqual(provider.get_vehicle_state()['frame'], provider.get_world_state()['frame'])
        self.assertEqual(provider.get_sensor_state(), {})
        self.assertEqual(provider.get_camera_frame(), (None, None))
        provider.disconnect()
        actor.destroy.assert_called_once()
        self.assertFalse(settings.synchronous_mode)
        self.assertIsNone(provider.get_vehicle_state())

    def test_failed_spawn_restores_world_settings(self):
        world, _, _, settings = fixture()
        world.try_spawn_actor.return_value = None
        provider = CarlaProvider()
        provider.connection = MagicMock()
        provider.connection.connect.return_value = world
        with self.assertRaisesRegex(RuntimeError, 'occupied'):
            provider.connect()
        self.assertFalse(settings.synchronous_mode)


class SensorOwnershipTests(unittest.TestCase):
    def test_sensor_callback_keeps_native_frame_transform_and_rate(self):
        world, ego, _, _ = fixture()
        sensor = MagicMock(id=151, is_alive=True)
        sensor.destroy.return_value = True
        world.spawn_actor.return_value = sensor
        manager = CarlaSensorManager(world, ego)
        manager.spawn('imu', 'sensor.other.imu', transform(), {'sensor_tick': .05}, lambda data: {'compass': .7})
        callback = sensor.listen.call_args.args[0]
        callback(NS(frame=11, timestamp=.55, transform=transform()))
        callback(NS(frame=12, timestamp=.60, transform=transform()))
        data = manager.latest()['imu']
        self.assertEqual(data['source'], 'carla')
        self.assertEqual(data['frame'], 12)
        self.assertEqual(data['timestamp'], .6)
        self.assertEqual(data['actorId'], 151)
        self.assertAlmostEqual(manager.rates()['imu'], 20)
        self.assertEqual(data['mountTransform']['positionM'], [10., 20., 1.])
        manager.close()
        sensor.stop.assert_called_once()
        sensor.destroy.assert_called_once()
        callback(NS(frame=13, timestamp=.65, transform=transform()))
        self.assertEqual(manager.latest(), {})

    def test_destroy_is_attempted_even_when_sensor_stop_fails(self):
        world, ego, _, _ = fixture()
        sensor = MagicMock(id=155, is_alive=True)
        sensor.stop.side_effect = RuntimeError('stop failed')
        sensor.destroy.return_value = True
        world.spawn_actor.return_value = sensor
        manager = CarlaSensorManager(world, ego)
        manager.spawn('rgb', 'sensor.camera.rgb', transform(), {}, lambda _: {})
        manager.close()
        sensor.destroy.assert_called_once()
        self.assertIn('stop failed', manager.cleanup_errors)
