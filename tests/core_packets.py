"""Deterministic packets only. No integrator, vehicle model, or sensor generator."""
from backend.core.contracts import (Transform, RotationRad, VehicleState, WorldState,
                                    SimulationFrame, SensorFrame, SensorKind, ControlCommand,
                                    CommandSource, ExperimentMetadata, DataOrigin)


TRANSFORM = Transform((0., 0., 0.), RotationRad(0., 0., 0.), 'test-coordinate-frame')


def packet(frame_id=1, timestamp_s=.05, *, speed=5., accel=0., x=0., brake=0., sensors=(), collisions=(), control=None):
    transform = Transform((x, 0., 0.), TRANSFORM.rotation_rad, TRANSFORM.coordinate_frame)
    vehicle = VehicleState(frame_id, timestamp_s, transform, (speed, 0., 0.), (0., 0., 0.), (accel, 0., 0.),
                           speed, 0., 0., brake, 1, False, False, 'test-fixture', 1, speed, accel)
    return SimulationFrame(frame_id, timestamp_s, WorldState(frame_id, timestamp_s, 'test-fixture'), vehicle,
                           sensors, control, collisions)


def sensor(sensor_id='imu', frame_id=1, timestamp_s=.05):
    return SensorFrame(sensor_id, SensorKind.IMU, frame_id, timestamp_s, timestamp_s,
                       TRANSFORM, 'test-fixture', data={'compass_rad': .7}, units={'compass_rad': 'rad'})


def command(source=CommandSource.MANUAL, frame_id=1, timestamp_s=.05, throttle=.4, brake=0.):
    return ControlCommand(frame_id, timestamp_s, throttle, brake, 0., False, False, source)


def metadata(run_id='run_test'):
    return ExperimentMetadata(run_id, 'Software test packets', 'test-fixture', DataOrigin.TEST_FIXTURE)
