"""Read one native ActorSnapshot, with its WorldSnapshot frame/time."""
import math


def vector(value):
    return [float(value.x), float(value.y), float(value.z)]


def rotation(value):
    return {'pitch': float(value.pitch), 'yaw': float(value.yaw), 'roll': float(value.roll)}


def vehicle_state(actor, snapshot):
    observed = snapshot.find(actor.id)
    if observed is None:
        raise RuntimeError('Ego actor absent from CARLA world snapshot')
    transform = observed.get_transform()
    forward = vector(transform.get_forward_vector())
    velocity = vector(observed.get_velocity())
    acceleration = vector(observed.get_acceleration())
    angular = vector(observed.get_angular_velocity())
    control = actor.get_control()
    return {'schemaVersion': 2, 'source': 'carla', 'actorId': actor.id, 'typeId': actor.type_id,
            'frame': snapshot.frame, 'timestamp': snapshot.timestamp.elapsed_seconds,
            'coordinateFrame': 'carla-world-left-handed-x-forward-y-right-z-up',
            'positionWorldM': vector(transform.location), 'rotationDeg': rotation(transform.rotation),
            'forwardWorld': forward, 'upWorld': vector(transform.get_up_vector()),
            'velocityWorldMps': velocity, 'speedMagnitudeMps': math.sqrt(sum(v*v for v in velocity)),
            'speedMps': sum(v*f for v, f in zip(velocity, forward)),
            'accelerationWorldMps2': acceleration,
            'accelerationMps2': sum(a*f for a, f in zip(acceleration, forward)),
            'accelerationSource': 'CARLA ActorSnapshot acceleration projected onto native forward vector',
            'angularVelocityWorldRadps': [math.radians(a) for a in angular],
            'headingRad': math.radians(transform.rotation.yaw), 'headingConvention': 'CARLA yaw from +X toward +Y',
            'steeringInput': float(control.steer), 'steeringConvention': 'positive right',
            'throttle': float(control.throttle), 'brake': float(control.brake),
            'gear': 'R' if control.reverse else 'N' if control.gear == 0 else str(control.gear),
            'gearIndex': int(control.gear), 'reverse': bool(control.reverse), 'handbrake': bool(control.hand_brake),
            'engineRPM': None, 'fuelLevelL': None, 'engineDamage': None, 'damage': None,
            'capabilities': {'mechanicalDamage': False, 'fuelSimulation': False,
                             'engineRPMMapped': False, 'perWheelTelemetryMapped': False}}
