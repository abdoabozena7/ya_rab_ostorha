"""Reusable scenario/curriculum contracts; no simulator or RL implementation."""
from collections.abc import Mapping
from dataclasses import dataclass, field
from enum import Enum
import hashlib
import json
from typing import Any, Protocol
from .contracts import Contract, Transform, validate_inputs, to_dict


class EnvironmentMode(str, Enum):
    LIVING_CITY = 'LIVING_CITY'
    TRAINING = 'TRAINING'


class ScenarioType(str, Enum):
    FRONT_OBSTACLE = 'FRONT_OBSTACLE'
    SUDDEN_BRAKING = 'SUDDEN_BRAKING'
    SIDE_CUT_IN = 'SIDE_CUT_IN'
    INTERSECTION_CONFLICT = 'INTERSECTION_CONFLICT'
    PEDESTRIAN_CROSSING = 'PEDESTRIAN_CROSSING'
    NARROW_GAP = 'NARROW_GAP'
    DENSE_CONGESTION = 'DENSE_CONGESTION'
    REAR_APPROACHING = 'REAR_APPROACHING'
    MULTI_HAZARD = 'MULTI_HAZARD'


class DatasetSplit(str, Enum):
    TRAIN = 'TRAIN'
    VALIDATION = 'VALIDATION'
    TEST = 'TEST'


# Explicit seed namespaces for the initial corpus. Additional corpora must
# supply a separate manifest rather than quietly reusing this evaluation set.
SEED_RANGES = {DatasetSplit.TRAIN:(0,999), DatasetSplit.VALIDATION:(1000,1999),
               DatasetSplit.TEST:(2000,2999)}


@dataclass(frozen=True)
class ActorControlSegment(Contract):
    start_s: float
    throttle: float = 0.
    brake: float = 0.
    steering: float = 0.

    def validate(self):
        validate_inputs(self.throttle,self.brake,self.steering)
        if self.start_s < 0 or self.throttle > 0 and self.brake > 0:
            raise ValueError('Control segment requires a nonnegative time and consistent pedals')


@dataclass(frozen=True)
class ScenarioActor(Contract):
    name: str
    blueprint: str
    transform: Transform
    initial_speed_mps: float = 0.
    control_schedule: tuple[ActorControlSegment, ...] = ()

    def validate(self):
        if not self.name or not self.blueprint.startswith('vehicle.') or not 0 <= self.initial_speed_mps <= 25:
            raise ValueError('Invalid scenario vehicle')
        if self.transform.coordinate_frame != 'left-handed-x-forward-y-right-z-up':
            raise ValueError('Scenario setup requires an explicit CARLA_WORLD pose')
        if any(b.start_s <= a.start_s for a,b in zip(self.control_schedule,self.control_schedule[1:])):
            raise ValueError('Actor schedule times must strictly increase')


@dataclass(frozen=True)
class ScenarioPedestrian(Contract):
    name: str
    blueprint: str
    transform: Transform
    destination: tuple[float,float,float]
    speed_mps: float
    start_s: float = 0.

    def validate(self):
        if not self.name or not self.blueprint.startswith('walker.pedestrian.') or not .5 <= self.speed_mps <= 2.5 or self.start_s < 0:
            raise ValueError('Invalid pedestrian definition')


@dataclass(frozen=True)
class ScenarioSpec(Contract):
    scenario_id: str
    scenario_type: ScenarioType
    random_seed: int
    map_id: str
    ego_spawn: int
    ego_initial_speed: float
    other_actor_definitions: tuple[ScenarioActor,...] = ()
    pedestrian_definitions: tuple[ScenarioPedestrian,...] = ()
    weather: Mapping[str,float] = field(default_factory=dict)
    traffic_density: Mapping[str,Any] = field(default_factory=dict)
    difficulty: int = 1
    success_conditions: Mapping[str,float] = field(default_factory=lambda: {'min_progress_m':10.,'max_collision_episodes':0.})
    failure_conditions: Mapping[str,float] = field(default_factory=lambda: {'max_collision_episodes':0.})
    timeout: float = 15.
    split: DatasetSplit = DatasetSplit.TRAIN
    metadata: Mapping[str,Any] = field(default_factory=dict)

    def validate(self):
        import re
        if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}',self.scenario_id) or not self.map_id:
            raise ValueError('Scenario identity/map required')
        lo,hi=SEED_RANGES[self.split]
        if not lo <= self.random_seed <= hi:
            raise ValueError(f'{self.split.value} seeds must be in the reserved range {lo}–{hi}')
        if self.ego_spawn < 0 or not 0 <= self.ego_initial_speed <= 15 or not 1 <= self.difficulty <= 6 or not 0 < self.timeout <= 600:
            raise ValueError('Invalid scenario spawn, speed, difficulty or timeout')
        if len({a.name for a in (*self.other_actor_definitions,*self.pedestrian_definitions)}) != len(self.other_actor_definitions)+len(self.pedestrian_definitions):
            raise ValueError('Scenario actor names must be unique')
        for conditions in (self.success_conditions,self.failure_conditions):
            if set(conditions)-{'min_progress_m','max_collision_episodes'} or any(v < 0 for v in conditions.values()):
                raise ValueError('Unknown or invalid outcome condition')
        if 'min_progress_m' not in self.success_conditions or self.success_conditions['min_progress_m'] <= 0:
            raise ValueError('Success requires positive progress; stationary survival is insufficient')

    @property
    def condition_id(self):
        data=to_dict(self)
        data.pop('metadata')
        return hashlib.sha256(json.dumps(data,sort_keys=True,separators=(',',':')).encode()).hexdigest()


class ScenarioLifecycle(Protocol):
    def load(self, spec: ScenarioSpec) -> None: ...
    def reset(self) -> None: ...
    def start(self) -> None: ...
    def step(self, frame) -> None: ...
    def stop(self) -> None: ...
    def collect_outcome(self) -> Mapping[str,Any]: ...
    def cleanup(self) -> None: ...


@dataclass(frozen=True)
class CurriculumCriteria(Contract):
    minimum_episodes: int
    maximum_collision_rate: float
    minimum_success_rate: float
    minimum_progress_fraction: float
    maximum_unsafe_interventions: int

    def validate(self):
        if self.minimum_episodes < 1 or self.maximum_unsafe_interventions < 0 or any(not 0 <= v <= 1 for v in
            (self.maximum_collision_rate,self.minimum_success_rate,self.minimum_progress_fraction)):
            raise ValueError('Invalid curriculum criteria')

    def passed(self, results):
        required={'episodes','collision_rate','success_rate','progress_fraction','unsafe_interventions'}
        if not required <= set(results): return False
        return (results['episodes']>=self.minimum_episodes and results['collision_rate']<=self.maximum_collision_rate
                and results['success_rate']>=self.minimum_success_rate and results['progress_fraction']>=self.minimum_progress_fraction
                and results['unsafe_interventions']<=self.maximum_unsafe_interventions)


@dataclass(frozen=True)
class CurriculumLevel(Contract):
    level: int
    name: str
    scenario_types: tuple[ScenarioType,...]
    entry_requirement: str
    progression: CurriculumCriteria
    criteria_status: str = 'PROPOSED_NOT_RESEARCH_VALIDATED'

    def validate(self):
        if not 1 <= self.level <= 6 or not self.name or not self.scenario_types or not self.entry_requirement:
            raise ValueError('Invalid curriculum level')
