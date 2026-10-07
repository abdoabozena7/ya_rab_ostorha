"""Versioned canonical contracts. SI units; simulation timestamps are seconds.

Steering is normalized [-1, 1], positive right, not a wheel angle. Positions and
vectors use the explicitly named coordinate frame; Euler rotations are radians.
Host watchdogs use separate monotonic seconds, never simulation timestamps.
"""
from collections.abc import Mapping
from dataclasses import dataclass, fields, is_dataclass
from enum import Enum
import math
from types import MappingProxyType, UnionType
from typing import Any, get_args, get_origin, get_type_hints, Union

SCHEMA_VERSION = 1
Vec3 = tuple[float, float, float]


def finite(value, name='value'):
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f'{name} must be a finite number')
    try:
        number = float(value)
    except (ValueError, OverflowError):
        raise ValueError(f'{name} must be a finite number') from None
    if not math.isfinite(number):
        raise ValueError(f'{name} must be a finite number')
    return number


def _check(value, annotation, name):
    origin, args = get_origin(annotation), get_args(annotation)
    if annotation is Any:
        freeze_json(value)
    elif origin in (Union, UnionType):
        for candidate in args:
            try:
                _check(value, candidate, name)
                return
            except ValueError:
                pass
        raise ValueError(f'{name} has an invalid type')
    elif origin is tuple:
        if not isinstance(value, tuple):
            raise ValueError(f'{name} must be a tuple')
        if args and args[-1] is Ellipsis:
            for item in value:
                _check(item, args[0], name)
        else:
            if len(value) != len(args):
                raise ValueError(f'{name} has an invalid vector length')
            for item, kind in zip(value, args):
                _check(item, kind, name)
    elif origin is Mapping:
        if not isinstance(value, Mapping):
            raise ValueError(f'{name} must be an object')
        for key, item in value.items():
            _check(key, args[0], name)
            _check(item, args[1], name)
    elif annotation is float:
        finite(value, name)
    elif annotation is int:
        if type(value) is not int:
            raise ValueError(f'{name} must be an integer')
    elif annotation is type(None):
        if value is not None:
            raise ValueError(f'{name} must be null')
    elif not isinstance(value, annotation) or annotation is bool and type(value) is not bool:
        raise ValueError(f'{name} must be {annotation.__name__}')


def freeze_json(value):
    if isinstance(value, Mapping):
        if any(not isinstance(key, str) for key in value):
            raise ValueError('JSON object keys must be strings')
        return MappingProxyType({key: freeze_json(item) for key, item in value.items()})
    if isinstance(value, (tuple, list)):
        return tuple(freeze_json(item) for item in value)
    if value is None or isinstance(value, (str, bool)):
        return value
    if isinstance(value, (int, float)):
        finite(value)
        return value
    raise ValueError('Payload must contain JSON data or asset references, not binary objects')


def to_dict(value):
    if isinstance(value, Enum):
        return value.value
    if is_dataclass(value):
        return {field.name: to_dict(getattr(value, field.name)) for field in fields(value)}
    if isinstance(value, Mapping):
        return {key: to_dict(item) for key, item in value.items()}
    if isinstance(value, (tuple, list)):
        return [to_dict(item) for item in value]
    return value


def _decode(annotation, value):
    origin, args = get_origin(annotation), get_args(annotation)
    if origin in (Union, UnionType):
        for candidate in args:
            try:
                decoded = _decode(candidate, value)
                _check(decoded, candidate, 'field')
                return decoded
            except (ValueError, TypeError):
                pass
        raise ValueError('Invalid union field')
    if origin is tuple:
        if not isinstance(value, (list, tuple)):
            raise ValueError('Expected an array')
        if args[-1] is Ellipsis:
            return tuple(_decode(args[0], item) for item in value)
        if len(args) != len(value):
            raise ValueError('Invalid vector length')
        return tuple(_decode(kind, item) for kind, item in zip(args, value))
    if origin is Mapping:
        if not isinstance(value, Mapping):
            raise ValueError('Expected an object')
        return {key: _decode(args[1], item) for key, item in value.items()}
    if isinstance(annotation, type) and issubclass(annotation, Enum):
        return annotation(value)
    if is_dataclass(annotation):
        return from_dict(annotation, value)
    _check(value, annotation, 'field')
    return value


def from_dict(cls, data):
    if not isinstance(data, Mapping):
        raise ValueError('Contract must be an object')
    hints = get_type_hints(cls)
    if set(data) - set(hints):
        raise ValueError(f'Unknown {cls.__name__} fields: {sorted(set(data)-set(hints))}')
    try:
        return cls(**{key: _decode(hints[key], value) for key, value in data.items()})
    except TypeError as error:
        raise ValueError(f'Invalid {cls.__name__}: {error}') from error


class Contract:
    def __post_init__(self):
        hints = get_type_hints(type(self))
        for field in fields(self):
            value = getattr(self, field.name)
            _check(value, hints[field.name], field.name)
            if isinstance(value, Mapping):
                object.__setattr__(self, field.name, freeze_json(value))
        if hasattr(self, 'frame_id') and self.frame_id is not None and self.frame_id < 0:
            raise ValueError('frame_id must be nonnegative')
        if hasattr(self, 'timestamp_s') and self.timestamp_s is not None and self.timestamp_s < 0:
            raise ValueError('timestamp_s must be nonnegative simulation seconds')
        for name in ('actor_id', 'ego_actor_id', 'other_actor_id'):
            value = getattr(self, name, None)
            if value is not None and value < 0:
                raise ValueError(f'{name} must be nonnegative')
        self.validate()

    def validate(self):
        pass


class CommandSource(str, Enum):
    MANUAL = 'MANUAL'
    ASSISTED = 'ASSISTED'
    AI = 'AI'
    SAFETY = 'SAFETY'
    SYSTEM = 'SYSTEM'


class SensorKind(str, Enum):
    RGB = 'RGB'
    DEPTH = 'DEPTH'
    RADAR = 'RADAR'
    LIDAR = 'LIDAR'
    IMU = 'IMU'
    GNSS = 'GNSS'
    COLLISION = 'COLLISION'
    SEMANTIC = 'SEMANTIC'
    INSTANCE = 'INSTANCE'
    LANE = 'LANE'


class DataOrigin(str, Enum):
    REAL_SIMULATION = 'REAL_SIMULATION'
    TEST_FIXTURE = 'TEST_FIXTURE'


@dataclass(frozen=True)
class RotationRad(Contract):
    roll: float
    pitch: float
    yaw: float


@dataclass(frozen=True)
class Transform(Contract):
    position_m: Vec3
    rotation_rad: RotationRad
    coordinate_frame: str

    def validate(self):
        if not self.coordinate_frame:
            raise ValueError('Coordinate frame must be explicit')


def validate_inputs(throttle, brake, steering):
    if not 0 <= throttle <= 1 or not 0 <= brake <= 1 or not -1 <= steering <= 1:
        raise ValueError('Pedals must be [0,1], steering [-1,1]')


@dataclass(frozen=True)
class VehicleState(Contract):
    frame_id: int
    timestamp_s: float
    transform: Transform
    linear_velocity_mps: Vec3
    angular_velocity_radps: Vec3
    acceleration_mps2: Vec3
    speed_mps: float
    steering: float
    throttle: float
    brake: float
    gear: int
    reverse: bool
    handbrake: bool
    provider: str
    actor_id: int | None = None
    longitudinal_speed_mps: float | None = None
    longitudinal_acceleration_mps2: float | None = None

    def validate(self):
        validate_inputs(self.throttle, self.brake, self.steering)
        if self.speed_mps < 0 or not self.provider:
            raise ValueError('Speed magnitude must be nonnegative; provider is required')


@dataclass(frozen=True)
class ControlCommand(Contract):
    frame_id: int
    timestamp_s: float
    throttle: float
    brake: float
    steering: float
    reverse: bool
    handbrake: bool
    source: CommandSource
    gear: int | None = None

    def validate(self):
        validate_inputs(self.throttle, self.brake, self.steering)


@dataclass(frozen=True)
class AssetReference(Contract):
    path: str
    media_type: str
    byte_count: int | None = None
    sha256: str | None = None

    def validate(self):
        # References are portable paths inside one run, never URLs/absolute paths.
        from pathlib import PurePosixPath, PureWindowsPath
        if not self.path or '\\' in self.path or ':' in self.path or '..' in PurePosixPath(self.path).parts or PureWindowsPath(self.path).is_absolute():
            raise ValueError('Asset reference must be a safe run-relative POSIX path')
        if PurePosixPath(self.path).is_absolute() or not self.media_type or self.byte_count is not None and self.byte_count < 0:
            raise ValueError('Invalid asset reference')


@dataclass(frozen=True)
class SensorFrame(Contract):
    sensor_id: str
    kind: SensorKind
    frame_id: int
    timestamp_s: float
    sensor_timestamp_s: float
    transform: Transform
    provider: str
    actor_id: int | None = None
    update_frequency_hz: float | None = None
    data: Mapping[str, Any] = None
    units: Mapping[str, str] = None
    asset: AssetReference | None = None

    def __post_init__(self):
        if self.data is None:
            object.__setattr__(self, 'data', {})
        if self.units is None:
            object.__setattr__(self, 'units', {})
        super().__post_init__()

    def validate(self):
        if not self.sensor_id or not self.provider or self.sensor_timestamp_s < 0:
            raise ValueError('Sensor ID/provider/timestamp are required')
        if self.update_frequency_hz is not None and self.update_frequency_hz <= 0:
            raise ValueError('Sensor rate must be positive Hz or null')
        if self.data and not self.units:
            raise ValueError('Sensor payload must declare its units')
        if self.kind in (SensorKind.RGB, SensorKind.DEPTH, SensorKind.LIDAR, SensorKind.SEMANTIC, SensorKind.INSTANCE) and self.data:
            raise ValueError('Images/point clouds require asset references, not inline payloads')


@dataclass(frozen=True)
class CollisionEvent(Contract):
    frame_id: int
    timestamp_s: float
    ego_actor_id: int
    other_actor_id: int | None
    impulse_ns: Vec3
    coordinate_frame: str
    contact_position_m: Vec3 | None = None
    ego_transform: Transform | None = None


@dataclass(frozen=True)
class ActorState(Contract):
    frame_id: int
    timestamp_s: float
    actor_id: int
    class_name: str
    transform: Transform
    linear_velocity_mps: Vec3


@dataclass(frozen=True)
class WorldState(Contract):
    frame_id: int
    timestamp_s: float
    provider: str
    map_name: str | None = None
    simulator_version: str | None = None
    api_version: str | None = None
    fixed_delta_seconds: float | None = None
    synchronous: bool | None = None

    def validate(self):
        if not self.provider or self.fixed_delta_seconds is not None and self.fixed_delta_seconds <= 0:
            raise ValueError('Invalid world provider/timestep')


@dataclass(frozen=True)
class GroundTruthObject(Contract):
    actor: ActorState
    distance_m: float | None = None

    def validate(self):
        if self.distance_m is not None and self.distance_m < 0:
            raise ValueError('Ground truth distance must be nonnegative')


@dataclass(frozen=True)
class SimulatorGroundTruth(Contract):
    frame_id: int
    timestamp_s: float
    objects: tuple[GroundTruthObject, ...] = ()

    def validate(self):
        if any(item.actor.frame_id != self.frame_id or abs(item.actor.timestamp_s-self.timestamp_s) > 1e-6 for item in self.objects):
            raise ValueError('Ground truth actors must match its frame/time')


@dataclass(frozen=True)
class ModelPrediction(Contract):
    frame_id: int
    timestamp_s: float
    model_id: str
    track_id: str
    class_name: str
    confidence: float
    estimated_distance_m: float | None = None

    def validate(self):
        if not 0 <= self.confidence <= 1 or self.estimated_distance_m is not None and self.estimated_distance_m < 0:
            raise ValueError('Invalid model confidence/distance')


@dataclass(frozen=True)
class SimulationFrame(Contract):
    frame_id: int
    timestamp_s: float
    world: WorldState
    vehicle: VehicleState
    sensors: tuple[SensorFrame, ...] = ()
    control: ControlCommand | None = None
    collisions: tuple[CollisionEvent, ...] = ()
    actors: tuple[ActorState, ...] = ()
    ground_truth: SimulatorGroundTruth | None = None
    predictions: tuple[ModelPrediction, ...] = ()
    missing_required_sensors: tuple[str, ...] = ()
    missing_optional_sensors: tuple[str, ...] = ()

    def validate(self):
        parts = (self.world, self.vehicle, *self.sensors, *self.collisions, *self.actors, *self.predictions)
        if self.ground_truth is not None:
            parts += (self.ground_truth,)
        if any(part.frame_id != self.frame_id or abs(part.timestamp_s-self.timestamp_s) > 1e-6 for part in parts):
            raise ValueError('SimulationFrame cannot mix unrelated frame IDs/timestamps')
        if self.world.provider != self.vehicle.provider or any(sensor.provider != self.world.provider for sensor in self.sensors):
            raise ValueError('Provider provenance mismatch')
        if len({sensor.sensor_id for sensor in self.sensors}) != len(self.sensors):
            raise ValueError('Duplicate sensor in frame')
        if self.control and (self.control.frame_id > self.frame_id or self.control.timestamp_s > self.timestamp_s+1e-6):
            raise ValueError('Frame cannot contain a future control')
        if set(self.missing_required_sensors) & {sensor.sensor_id for sensor in self.sensors}:
            raise ValueError('Present required sensor marked missing')
        if set(self.missing_optional_sensors) & {sensor.sensor_id for sensor in self.sensors} or set(self.missing_required_sensors) & set(self.missing_optional_sensors):
            raise ValueError('Contradictory sensor completeness metadata')

    @property
    def complete(self):
        return not self.missing_required_sensors


@dataclass(frozen=True)
class ExperimentMetadata(Contract):
    run_id: str
    name: str
    provider: str
    data_origin: DataOrigin
    description: str = ''
    seed: int | None = None
    created_at_utc: str | None = None
    schema_version: int = SCHEMA_VERSION
    config: Mapping[str, Any] = None

    def __post_init__(self):
        if self.config is None:
            object.__setattr__(self, 'config', {})
        super().__post_init__()

    def validate(self):
        import re
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,100}', self.run_id) or not self.name or not self.provider or self.schema_version != SCHEMA_VERSION:
            raise ValueError('Invalid run identity/schema version')
        if self.data_origin == DataOrigin.REAL_SIMULATION and self.provider in ('test-fixture', 'mock', 'development-mock', 'replay'):
            raise ValueError('Test/mock/replay provenance cannot be marked as real simulation')
