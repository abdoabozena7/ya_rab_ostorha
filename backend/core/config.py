"""Strict JSON experiment configuration, without speculative simulator options."""
from dataclasses import dataclass, field
import json
from pathlib import Path
from typing import Mapping
from .contracts import Contract, SensorKind, Transform, from_dict, to_dict


@dataclass(frozen=True)
class ExperimentSection(Contract):
    name: str
    description: str = ''
    seed: int | None = None

    def validate(self):
        if not self.name.strip():
            raise ValueError('Experiment name is required')


@dataclass(frozen=True)
class SimulationSection(Contract):
    fixed_delta_seconds: float = .05
    connection_timeout_s: float = 10.
    sensor_timeout_s: float = .25
    required_sensors: tuple[str, ...] = ()
    optional_sensors: tuple[str, ...] = ()

    def validate(self):
        if min(self.fixed_delta_seconds, self.connection_timeout_s, self.sensor_timeout_s) <= 0:
            raise ValueError('Timing values must be positive seconds')
        if set(self.required_sensors) & set(self.optional_sensors):
            raise ValueError('Required/optional sensors overlap')


@dataclass(frozen=True)
class VehicleSection(Contract):
    blueprint: str | None = None
    spawn_point: int | None = None

    def validate(self):
        if self.spawn_point is not None and self.spawn_point < 0:
            raise ValueError('Spawn index must be nonnegative')


@dataclass(frozen=True)
class SensorConfig(Contract):
    kind: SensorKind
    enabled: bool = False
    transform: Transform | None = None
    update_frequency_hz: float | None = None

    def validate(self):
        if self.update_frequency_hz is not None and self.update_frequency_hz <= 0:
            raise ValueError('Sensor frequency must be positive Hz')


@dataclass(frozen=True)
class RecordingSection(Contract):
    enabled: bool = False
    output_directory: str = 'runs'

    def validate(self):
        if not self.output_directory:
            raise ValueError('Recording output directory required')


@dataclass(frozen=True)
class ExperimentConfig(Contract):
    experiment: ExperimentSection
    simulation: SimulationSection = field(default_factory=SimulationSection)
    vehicle: VehicleSection = field(default_factory=VehicleSection)
    sensors: Mapping[str, SensorConfig] = field(default_factory=dict)
    recording: RecordingSection = field(default_factory=RecordingSection)

    def __post_init__(self):
        # Typed sensor configs are immutable contracts, not generic JSON payloads.
        from types import MappingProxyType
        sensors = self.sensors
        object.__setattr__(self, 'sensors', {})
        super().__post_init__()
        if not isinstance(sensors, Mapping) or any(not isinstance(key, str) or not key or not isinstance(value, SensorConfig) for key, value in sensors.items()):
            raise ValueError('Invalid sensor configuration')
        object.__setattr__(self, 'sensors', MappingProxyType(dict(sensors)))
        if set(self.simulation.required_sensors+self.simulation.optional_sensors)-set(sensors):
            raise ValueError('Synchronization references an unconfigured sensor')
        if any(not sensors[name].enabled for name in self.simulation.required_sensors):
            raise ValueError('A required sensor cannot be disabled')


def load_config(path):
    return from_dict(ExperimentConfig, json.loads(Path(path).read_text(encoding='utf-8-sig')))
