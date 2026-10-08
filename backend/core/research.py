"""Unweighted reward and matched evaluation contracts. Unknowns remain null."""
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Protocol
from .contracts import Contract, SimulationFrame, SimulatorGroundTruth
from .scenarios import DatasetSplit


@dataclass(frozen=True)
class RewardComponents(Contract):
    collision_penalty: float | None = None
    collision_severity_penalty: float | None = None
    near_miss_penalty: float | None = None
    progress_reward: float | None = None
    time_cost: float | None = None
    control_smoothness_penalty: float | None = None
    unnecessary_intervention_penalty: float | None = None
    route_completion_reward: float | None = None


class RewardEvaluator(Protocol):
    def components(self,frame:SimulationFrame,training_ground_truth:SimulatorGroundTruth,
                   context:Mapping[str,Any]) -> RewardComponents: ...


@dataclass(frozen=True)
class ResearchMetrics(Contract):
    collision_rate: float | None = None
    collision_count: int | None = None
    collision_callback_count: int | None = None
    collision_severity_impulse_ns: float | None = None
    near_miss_rate: float | None = None
    minimum_clearance_m: float | None = None
    minimum_ttc_s: float | None = None
    route_completion: float | None = None
    distance_traveled_m: float | None = None
    average_speed_mps: float | None = None
    elapsed_simulation_s: float | None = None
    emergency_braking_frequency: float | None = None
    steering_intervention_frequency: float | None = None
    progress_under_congestion_m: float | None = None
    safety_intervention_count: int | None = None
    unsafe_intervention_count: int | None = None
    scenario_success_rate: float | None = None
    physically_unavoidable: bool | None = None
    avoidability_evidence_id: str | None = None

    def validate(self):
        if self.physically_unavoidable is not None and not self.avoidability_evidence_id:
            raise ValueError('Avoidability classification requires reviewed physical evidence')
        for name in self.__dataclass_fields__:
            value=getattr(self,name)
            if isinstance(value,(int,float)) and not isinstance(value,bool) and value<0:
                raise ValueError('Research metrics cannot be negative')
        for name in ('collision_rate','near_miss_rate','route_completion','scenario_success_rate'):
            value=getattr(self,name)
            if value is not None and value>1:raise ValueError('Rates/fractions must be [0,1]')


@dataclass(frozen=True)
class ComparisonRun(Contract):
    run_id: str
    scenario_condition_id: str
    actual_initial_condition_id: str
    split: DatasetSplit
    base_driver_protocol_id: str
    base_driver_context: str
    safety_policy_enabled: bool
    safety_policy_id: str | None
    metrics: ResearchMetrics

    def validate(self):
        if not all((self.run_id,self.scenario_condition_id,self.actual_initial_condition_id,self.base_driver_protocol_id)):
            raise ValueError('Comparison identities required')
        if self.base_driver_context not in ('MANUAL_SCRIPTED_TRACE','AUTONOMOUS_BASE_DRIVER'):
            raise ValueError('Comparison needs a reproducible driver protocol')
        if self.safety_policy_enabled!=bool(self.safety_policy_id):
            raise ValueError('Enabled comparisons require a real identified policy')


def matched_pair(baseline,enabled):
    if baseline.safety_policy_enabled or not enabled.safety_policy_enabled:
        raise ValueError('Pair requires a no-policy baseline and identified enabled policy')
    for name in ('scenario_condition_id','actual_initial_condition_id','split','base_driver_protocol_id','base_driver_context'):
        if getattr(baseline,name)!=getattr(enabled,name):raise ValueError('Unmatched comparison: '+name)
    if baseline.split==DatasetSplit.TRAIN:raise ValueError('Generalization evaluation requires validation or test scenarios')
    return {'baseline_run_id':baseline.run_id,'enabled_run_id':enabled.run_id,
            'matched_conditions':True,'split':baseline.split.value}
