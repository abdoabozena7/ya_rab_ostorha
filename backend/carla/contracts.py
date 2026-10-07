"""Translate verified native packet units into canonical application contracts."""
import math
from ..core.contracts import RotationRad, Transform, VehicleState, WorldState, SimulationFrame

CARLA_WORLD = 'left-handed-x-forward-y-right-z-up'


def simulation_frame(vehicle, world):
    position = tuple(vehicle['positionWorldM'])
    rotation = vehicle['rotationDeg']
    transform = Transform(position, RotationRad(*(math.radians(rotation[key]) for key in ('roll', 'pitch', 'yaw'))), CARLA_WORLD)
    state = VehicleState(vehicle['frame'], vehicle['timestamp'], transform,
                         tuple(vehicle['velocityWorldMps']), tuple(vehicle['angularVelocityWorldRadps']),
                         tuple(vehicle['accelerationWorldMps2']), vehicle['speedMagnitudeMps'],
                         vehicle['steeringInput'], vehicle['throttle'], vehicle['brake'], vehicle['gearIndex'],
                         vehicle['reverse'], vehicle['handbrake'], 'carla', vehicle['actorId'],
                         vehicle['speedMps'], vehicle['accelerationMps2'])
    scene = WorldState(world['frame'], world['timestamp'], world['source'], world['map'],
                       world['version'], world['pythonApiVersion'], world['fixedDeltaSeconds'], world['synchronous'])
    return SimulationFrame(scene.frame_id, scene.timestamp_s, scene, state)
