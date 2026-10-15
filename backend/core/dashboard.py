"""Existing dashboard wire view derived exclusively from canonical observations."""
import math
from .contracts import to_dict


def dashboard_frame(frame, *, rich=True):
    vehicle, world = frame.vehicle, frame.world
    rotation = vehicle.transform.rotation_rad
    state = {'source': vehicle.provider, 'frame': frame.frame_id, 'timestamp': frame.timestamp_s,
             'actorId': vehicle.actor_id, 'positionWorldM': list(vehicle.transform.position_m),
             'coordinateFrame': vehicle.transform.coordinate_frame,
             'rotationDeg': {name: math.degrees(getattr(rotation, name)) for name in ('roll', 'pitch', 'yaw')},
             'velocityWorldMps': list(vehicle.linear_velocity_mps),
             'angularVelocityWorldRadps': list(vehicle.angular_velocity_radps),
             'accelerationWorldMps2': list(vehicle.acceleration_mps2),
             'speedMps': vehicle.longitudinal_speed_mps if vehicle.longitudinal_speed_mps is not None else vehicle.speed_mps,
             'speedMagnitudeMps': vehicle.speed_mps, 'accelerationMps2': vehicle.longitudinal_acceleration_mps2,
             'speedKmh': vehicle.speed_mps * 3.6,
             'steeringInput': vehicle.steering, 'throttle': vehicle.throttle, 'brake': vehicle.brake,
             'gear': 'R' if vehicle.reverse else 'N' if vehicle.gear == 0 else str(vehicle.gear),
             'gearIndex': vehicle.gear, 'reverse': vehicle.reverse, 'handbrake': vehicle.handbrake,
             'headingRad': rotation.yaw, 'engineRPM': None, 'fuelLevelL': None, 'damage': None}
    sensors = {sensor.sensor_id: {'source': sensor.provider, 'sensorId': sensor.sensor_id,
                                 'frame': sensor.frame_id, 'timestamp': sensor.timestamp_s,
                                 'sensorTimestamp': sensor.sensor_timestamp_s, 'actorId': sensor.actor_id,
                                 'mountTransform': to_dict(sensor.transform),
                                 'requestedRateHz': sensor.update_frequency_hz,
                                 'frameAvailable': sensor.asset is not None,
                                 'asset': to_dict(sensor.asset), 'matchesVehicleFrame': True}
               for sensor in frame.sensors}
    for sensor in frame.sensors:
        capture = sensor.metadata
        sensors[sensor.sensor_id].update(width=capture.get('width'), height=capture.get('height'),
            fovDeg=capture.get('fov_deg'), worldTransform=to_dict(sensor.transform),
            mountTransform=to_dict(capture.get('mount_transform', to_dict(sensor.transform))),
            sensorTickSeconds=capture.get('sensor_tick_s'))
        if rich:
            sensors[sensor.sensor_id].update(data=to_dict(sensor.data),units=to_dict(sensor.units),metadata=to_dict(capture))
    population = frame.population
    population_view = None if population is None else {
        'frame_id': population.frame_id,
        'actual': {'vehicles': population.traffic_vehicles, 'pedestrians': population.pedestrians,
                   'controllers': population.walker_controllers, 'walkers_active': population.walkers_active},
        'requested': {'vehicle_count': population.requested_traffic, 'pedestrian_count': population.requested_pedestrians},
        'traffic_manager_connected': population.traffic_manager_connected, 'npc_spawned': None, 'npc_failed': None,
        'walkers_failed': None, 'source': 'RECORDED_FRAME'}
    return {'vehicle': state, 'world': {'source': world.provider, 'frame': world.frame_id, 'timestamp': world.timestamp_s,
                                       'map': world.map_name, 'version': world.simulator_version, 'pythonApiVersion': world.api_version,
                                       'fixedDeltaSeconds': world.fixed_delta_seconds, 'synchronous': world.synchronous},
            'sensors': sensors, 'sensorRatesHz': {}, 'sensorErrors': {},
            'population': population_view,
            'canonical': to_dict(frame) if rich else None, 'frameComplete': frame.complete,
            'missingRequiredSensors': list(frame.missing_required_sensors)}
