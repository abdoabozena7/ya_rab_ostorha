"""Execute verified adapter operations; mark unimplemented calibrations pending."""
import argparse
import importlib.util
import json

SENSOR_PLANS = {
    'collision': {'blueprint': 'sensor.other.collision', 'cases': ['barrier low/high speed', 'side', 'rear'], 'fields': ['frame', 'timestamp_s', 'other_actor_id', 'impulse_ns']},
    'rgb': {'blueprint': 'sensor.camera.rgb', 'checks': ['native image', 'mount transform', 'FOV', 'frame/timestamp alignment']},
    'depth': {'blueprint': 'sensor.camera.depth', 'distances_m': [5, 10, 20, 30], 'checks': ['surface-distance calibration', 'error_m']},
    'radar': {'blueprint': 'sensor.other.radar', 'cases': ['stationary', 'approaching', 'receding'], 'fields': ['depth_m', 'azimuth_rad', 'altitude_rad', 'velocity_mps']},
    'lidar': {'blueprint': 'sensor.lidar.ray_cast', 'fields': ['x_m', 'y_m', 'z_m', 'intensity'], 'checks': ['repeatable static targets', 'frame/timestamp']},
    'imu': {'blueprint': 'sensor.other.imu', 'cases': ['acceleration', 'hard braking', 'left/right turn'], 'fields': ['accelerometer_mps2', 'gyroscope_radps', 'compass_rad']},
    'gnss': {'blueprint': 'sensor.other.gnss', 'fields': ['latitude_deg', 'longitude_deg', 'altitude_m', 'world_transform']},
}


def main(check):
    parser = argparse.ArgumentParser(description=f'Native CARLA {check} validation; no mocks')
    parser.add_argument('--host', default='127.0.0.1')
    parser.add_argument('--port', type=int, default=2000)
    parser.add_argument('--spawn-index', type=int, default=0)
    args = parser.parse_args()
    if importlib.util.find_spec('carla') is None:
        print('CARLA NOT INSTALLED: the compatible native Python API is unavailable. No test passed.')
        return 2
    from backend.carla.connection import CarlaConnection, ensure_runtime
    try:
        ensure_runtime()
    except RuntimeError as error:
        print('CARLA NOT INSTALLED: no compatible API on this Python runtime. '+str(error))
        return 2
    connection = CarlaConnection(args.host, args.port)
    provider = None
    try:
        world = connection.connect()
        if check in SENSOR_PLANS:
            plan = SENSOR_PLANS[check]
            world.get_blueprint_library().find(plan['blueprint'])
            print('NATIVE VALIDATION PENDING: blueprint availability alone does not validate a sensor.')
            print(json.dumps({'check': check, 'plan': plan, 'status': 'NOT_RUN'}, indent=2))
            return 3  # Structural plans only; no fabricated sensor PASS.
        if check == 'connection':
            print(json.dumps({'status': 'PASS', 'check': check, 'version': connection.server_version,
                              'map': world.get_map().name, 'maps': connection.client.get_available_maps(),
                              'vehicles': [bp.id for bp in world.get_blueprint_library().filter('vehicle.*')]}, indent=2))
            return 0
        from backend.providers import create_provider
        from backend.core.contracts import ControlCommand, CommandSource
        before = {actor.id for actor in world.get_actors()}
        provider = create_provider('carla', host=args.host, port=args.port, spawn_index=args.spawn_index)
        provider.connect()
        observed = provider.get_simulation_frame()
        ego_id = observed.vehicle.actor_id
        if ego_id in before or world.get_actor(ego_id) is None:
            raise RuntimeError('Ego spawn ownership was not confirmed')
        if check == 'vehicle_control':
            def apply(throttle, brake, steering, ticks):
                for _ in range(ticks):
                    frame = provider.get_simulation_frame()
                    provider.apply_control(ControlCommand(frame.frame_id, frame.timestamp_s, throttle, brake, steering,
                                                          False, False, CommandSource.SYSTEM, 1))
                    provider.step()
                return provider.get_simulation_frame()
            driven = apply(.45, 0., 0., 40)
            if driven.vehicle.speed_mps <= observed.vehicle.speed_mps+.5:
                raise RuntimeError('Native acceleration was not observed')
            steered = apply(.25, 0., .3, 20)
            if abs(steered.vehicle.steering-.3) > .05:
                raise RuntimeError('Native applied steering does not match the requested input')
            stopped = apply(0., 1., 0., 40)
            if stopped.vehicle.speed_mps >= steered.vehicle.speed_mps:
                raise RuntimeError('Native braking was not observed')
        provider.close()
        if provider.cleanup_errors:
            raise RuntimeError('Cleanup unconfirmed: '+'; '.join(provider.cleanup_errors))
        if world.get_actor(ego_id) is not None:
            raise RuntimeError('Owned ego actor survived cleanup')
        if not before.issubset({actor.id for actor in world.get_actors()}):
            raise RuntimeError('Unrelated actor disappeared during the check')
        print(json.dumps({'status': 'PASS', 'check': check, 'ego_actor_id': ego_id,
                          'cleanup_confirmed': True, 'scope': 'native API checks only; visual driving and browser gate evidence remain required'}, indent=2))
        return 0
    except Exception as error:
        print('CARLA NATIVE VALIDATION FAILED: '+str(error))
        return 2
    finally:
        connection.disconnect()
        if provider and provider.world is not None:
            provider.close()
            if provider.cleanup_errors:
                raise RuntimeError('Native cleanup failed: '+'; '.join(provider.cleanup_errors))
