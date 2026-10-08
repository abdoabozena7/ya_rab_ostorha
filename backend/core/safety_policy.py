"""Future sensor-only safety policy boundary. No learned policy is supplied.

Exact actor poses, bounding boxes, collision actor IDs, routes and future
trajectories remain in SimulationFrame/diagnostics; none enter this interface.
"""
from collections import deque
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Protocol
from .contracts import (AssetReference, Contract, ControlCommand, CommandSource,
                        SensorKind, SimulationFrame, validate_inputs)

REQUIRED_POLICY_CHANNELS=frozenset((SensorKind.RGB,SensorKind.DEPTH,SensorKind.LIDAR,SensorKind.RADAR,SensorKind.IMU))
ALLOWED_CHANNELS=REQUIRED_POLICY_CHANNELS | {SensorKind.GNSS}


@dataclass(frozen=True)
class PolicySensorChannel(Contract):
    sensor_id: str
    kind: SensorKind
    frame_id: int
    timestamp_s: float
    sensor_timestamp_s: float
    data: Mapping[str,Any] = field(default_factory=dict)
    units: Mapping[str,str] = field(default_factory=dict)
    asset: AssetReference | None = None
    calibration: Mapping[str,Any] = field(default_factory=dict)

    def validate(self):
        if self.kind not in ALLOWED_CHANNELS or not self.sensor_id or self.sensor_timestamp_s < 0:
            raise ValueError('Unsupported policy sensor channel')
        allowed={SensorKind.RGB:set(),SensorKind.DEPTH:set(),SensorKind.LIDAR:set(),
                 SensorKind.RADAR:{'detections'},SensorKind.IMU:{'accelerometer_mps2','gyroscope_radps','compass_rad'},
                 SensorKind.GNSS:{'latitude_deg','longitude_deg','altitude_m'}}[self.kind]
        unit_fields=allowed | {'depth_m','azimuth_rad','altitude_rad','velocity_mps','depth','x','y','z','intensity'}
        if set(self.data)-allowed or set(self.units)-unit_fields:
            raise ValueError('Unexpected data at the sensor-only policy boundary')
        if set(self.calibration)-{'mount_transform','width','height','fov_deg','encoding','dtype','shape','columns','coordinate_frame','sensor_tick_s'}:
            raise ValueError('Undeclared policy calibration field')
        if self.kind==SensorKind.RADAR and any(set(d)-{'depth_m','azimuth_rad','altitude_rad','velocity_mps'} for d in self.data.get('detections',())):
            raise ValueError('Radar contains undeclared privileged data')
        if self.kind in (SensorKind.RGB,SensorKind.DEPTH,SensorKind.LIDAR) and self.asset is None:
            raise ValueError('Image and point-cloud policy channels require real asset references')


@dataclass(frozen=True)
class EgoMeasurements(Contract):
    speed_mps: float
    angular_velocity_radps: tuple[float,float,float]
    angular_velocity_frame: str
    throttle: float
    brake: float
    steering: float
    gear: int
    reverse: bool
    handbrake: bool
    state_source: str = 'SIMULATED_ONBOARD_VEHICLE_STATE'

    def validate(self):
        validate_inputs(self.throttle,self.brake,self.steering)
        if self.speed_mps < 0 or not self.angular_velocity_frame or not self.state_source:
            raise ValueError('Invalid onboard state')


@dataclass(frozen=True)
class SensorObservation(Contract):
    frame_id: int
    timestamp_s: float
    ego: EgoMeasurements
    channels: tuple[PolicySensorChannel,...]
    provider: str

    def validate(self):
        if not self.provider or any(c.frame_id!=self.frame_id or abs(c.timestamp_s-self.timestamp_s)>1e-6 for c in self.channels):
            raise ValueError('Policy observations must use one synchronized frame')
        if not REQUIRED_POLICY_CHANNELS <= {c.kind for c in self.channels}:
            raise ValueError('Policy requires RGB, depth, LiDAR, radar and IMU')
        if len({c.sensor_id for c in self.channels})!=len(self.channels):
            raise ValueError('Duplicate policy sensor channel')


def sensor_observation(frame: SimulationFrame):
    if not frame.complete:raise ValueError('Incomplete synchronized frame cannot enter a policy')
    allowed_calibration={'mount_transform','width','height','fov_deg','encoding','dtype','shape','columns','coordinate_frame','sensor_tick_s'}
    sensors=tuple(PolicySensorChannel(s.sensor_id,s.kind,s.frame_id,s.timestamp_s,
        s.sensor_timestamp_s,s.data,s.units,s.asset,{k:v for k,v in s.metadata.items() if k in allowed_calibration})
        for s in frame.sensors if s.kind in ALLOWED_CHANNELS)
    imu=next((s for s in sensors if s.kind==SensorKind.IMU),None)
    if imu is None or 'gyroscope_radps' not in imu.data:raise ValueError('Native IMU gyroscope is unavailable')
    v=frame.vehicle
    # Use actual native IMU sensor readings; no exact world pose is exposed.
    ego=EgoMeasurements(v.speed_mps,tuple(imu.data['gyroscope_radps']),'IMU_SENSOR_LOCAL',
                        v.throttle,v.brake,v.steering,v.gear,v.reverse,v.handbrake)
    return SensorObservation(frame.frame_id,frame.timestamp_s,ego,sensors,frame.world.provider)


class ObservationHistory:
    def __init__(self,length=4,max_gap_s=.15):
        if type(length) is not int or not 1<=length<=16 or max_gap_s<=0:raise ValueError('Invalid history bounds')
        self.frames=deque(maxlen=length);self.max_gap_s=max_gap_s;self.status='WAITING'

    def clear(self):self.frames.clear();self.status='WAITING'

    def append(self,frame):
        try:observation=sensor_observation(frame)
        except ValueError:
            self.frames.clear();self.status='INCOMPLETE_OR_UNAVAILABLE';return None
        if self.frames:
            previous=self.frames[-1]
            if observation.frame_id<=previous.frame_id or observation.timestamp_s<=previous.timestamp_s:
                raise ValueError('Policy history must advance monotonically')
            if observation.timestamp_s-previous.timestamp_s>self.max_gap_s:self.frames.clear()
        self.frames.append(observation);self.status='READY'
        return observation

    def snapshot(self):return tuple(self.frames)


@dataclass(frozen=True)
class ProposedSafetyAction(Contract):
    command: ControlCommand
    policy_id: str
    observation_frame_id: int
    observation_timestamp_s: float
    intervention_required: bool
    reason: str

    def validate(self):
        if self.command.source!=CommandSource.SAFETY or not self.policy_id or not self.reason:
            raise ValueError('Policy proposal must identify a SAFETY command and reason')
        if self.command.frame_id!=self.observation_frame_id or self.command.timestamp_s!=self.observation_timestamp_s:
            raise ValueError('Safety proposal must reference its observation')


@dataclass(frozen=True)
class FeasibilityEvidence(Contract):
    frame_id: int
    timestamp_s: float
    physical_limits_verified: bool
    surrounding_hazards_checked: bool
    left_space_verified: bool
    right_space_verified: bool
    acceleration_path_verified: bool
    max_steering_delta: float
    max_throttle: float
    validator_id: str
    evidence_source: str

    def validate(self):
        if not 0<=self.max_steering_delta<=2 or not 0<=self.max_throttle<=1 or not self.validator_id or not self.evidence_source:
            raise ValueError('Invalid feasibility evidence')
        if self.evidence_source!='SENSOR_DERIVED_AND_ONBOARD_LIMITS':
            raise ValueError('Inference admission requires sensor-derived hazard evidence and onboard limits')


@dataclass(frozen=True)
class FeasibilityResult(Contract):
    accepted: bool
    reason: str
    command: ControlCommand | None

    def validate(self):
        if self.accepted!=(self.command is not None) or not self.reason:raise ValueError('Contradictory feasibility result')


def admit_proposal(observation,base_command,proposal,evidence=None):
    """Conservative integration admission, not a collision/physics oracle.

    A future real validator must construct current sensor-derived evidence.
    Absence of that validator rejects proposals, including braking proposals.
    Existing watchdog braking is separate and continues through its own path.
    """
    def reject(reason):return FeasibilityResult(False,reason,None)
    if not proposal.intervention_required:return reject('Policy requests no intervention')
    if (proposal.observation_frame_id,proposal.observation_timestamp_s)!=(observation.frame_id,observation.timestamp_s):
        return reject('Proposal does not match the current observation')
    if evidence is None:return reject('No feasibility validator evidence')
    if (evidence.frame_id,evidence.timestamp_s)!=(observation.frame_id,observation.timestamp_s):
        return reject('Stale feasibility evidence')
    if not evidence.physical_limits_verified or not evidence.surrounding_hazards_checked:
        return reject('Physical limits or surrounding hazards unverified')
    if not base_command.frame_id<=observation.frame_id or base_command.timestamp_s>observation.timestamp_s:
        return reject('Base command references a future frame')
    if observation.timestamp_s-base_command.timestamp_s>.35:return reject('Base command is stale')
    c=proposal.command
    if c.reverse!=base_command.reverse or c.gear!=base_command.gear or c.handbrake!=base_command.handbrake:
        return reject('Gear, reverse and handbrake changes require a separate validated contract')
    delta=c.steering-base_command.steering
    if abs(delta)>evidence.max_steering_delta:return reject('Steering exceeds verified physical limit')
    if delta<0 and not evidence.left_space_verified:return reject('Left-side space unverified')
    if delta>0 and not evidence.right_space_verified:return reject('Right-side space unverified')
    if c.throttle>evidence.max_throttle or c.throttle>base_command.throttle and not evidence.acceleration_path_verified:
        return reject('Acceleration path or throttle limit unverified')
    if c.brake>0 and c.throttle>0:return reject('Contradictory pedals')
    return FeasibilityResult(True,'Admitted for existing ControlSafetyLayer and CommandArbiter checks',c)


class BaseDriver(Protocol):
    def process_observation(self,observation:SensorObservation) -> ControlCommand: ...


class YaRabOstorhaSafetyPolicy(Protocol):
    def propose(self,history:tuple[SensorObservation,...],base_command:ControlCommand) -> ProposedSafetyAction | None: ...


class SafetyFeasibilityValidator(Protocol):
    def validate(self,history:tuple[SensorObservation,...],base_command:ControlCommand,
                 proposal:ProposedSafetyAction) -> FeasibilityEvidence: ...
