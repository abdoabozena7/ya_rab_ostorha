"""YA RAB OSTORHA diagnostic teacher. Explicit experiment use only; no learning.

No world, scenario, route, reward or ground-truth objects enter this module.
The output still requires existing feasibility, safety and arbitration admission.
"""
from collections import deque
from dataclasses import dataclass, replace
from enum import Enum
import math
import statistics
import numpy as np
from ..core.contracts import ControlCommand, CommandSource, SensorKind, finite
from ..core.safety_policy import SensorObservation, ProposedSafetyAction
from .radar import foreground_return, validate_radar_calibration


@dataclass(frozen=True)
class TeacherConfig:
    version: str = 'YA_RAB_OSTORHA_TEACHER_V1'
    minimum_clearance_m: float = 3.
    reaction_time_s: float = .35
    assumed_deceleration_mps2: float = 5.
    additional_brake: float = 1.
    release_hysteresis_m: float = 2.
    stopped_speed_mps: float = .2
    lead_stationary_speed_mps: float = .5
    maximum_observation_age_s: float = .1

    def __post_init__(self):
        bounds={'minimum_clearance_m':(2.,6.),'reaction_time_s':(.1,1.),
            'assumed_deceleration_mps2':(2.,8.),'additional_brake':(.3,1.),
            'release_hysteresis_m':(.5,4.),'stopped_speed_mps':(.05,.3),
            'lead_stationary_speed_mps':(.1,1.),'maximum_observation_age_s':(.01,.15)}
        if not self.version:raise ValueError('Teacher version is required')
        for key,(lo,hi) in bounds.items():
            if not lo<=finite(getattr(self,key),key)<=hi:raise ValueError('Invalid teacher parameter: '+key)


class TeacherState(str, Enum):
    MONITORING='MONITORING'
    PROTECTIVE_BRAKING='PROTECTIVE_BRAKING'
    SAFE_RELEASE='SAFE_RELEASE'
    FINAL_APPROACH='FINAL_APPROACH'
    SAFE_STOP='SAFE_STOP'


@dataclass(frozen=True)
class TeacherDecision:
    decision: str
    state: str
    action: tuple[float,float,float]
    proposal: ProposedSafetyAction | None
    diagnostics: dict


class YaRabOstorhaSafetyTeacher:
    """Additional braking supervisor, not a replacement base driver.

    Worst-case stationary-target envelope: margin + v*tau + v²/(2*a).
    Full stop before release provides hysteresis. A distant stop can release
    even when the lead is stationary, enabling useful approach progress.
    Near-object stops are held until measured clearance opens beyond hysteresis.
    There is no task odometer, goal distance, trigger timing or fixed dwell.
    The radar motion estimate only names approach states; it is not ground truth.
    """
    def __init__(self,config=None):
        self.config=config or TeacherConfig();self.reset()

    def reset(self):
        self.state=TeacherState.MONITORING;self.previous=None
        self.motion=deque(maxlen=3)

    def propose(self,observation,base_command,*,as_of_timestamp_s=None):
        if not isinstance(observation,SensorObservation) or not isinstance(base_command,ControlCommand):
            raise ValueError('Teacher requires SensorObservation and proposed ControlCommand')
        c=self.config
        now=observation.timestamp_s if as_of_timestamp_s is None else finite(as_of_timestamp_s)
        age=now-observation.timestamp_s
        if not 0<=age<=c.maximum_observation_age_s:raise ValueError('Teacher observation age is invalid')
        if (base_command.frame_id!=observation.frame_id or
                abs(base_command.timestamp_s-observation.timestamp_s)>1e-6):
            raise ValueError('Teacher base command must reference the current observation')
        if self.previous is not None and (observation.frame_id<=self.previous[0] or
                observation.timestamp_s<=self.previous[1]):raise ValueError('Teacher observation did not advance')
        if any(ch.frame_id!=observation.frame_id or
               abs(ch.sensor_timestamp_s-observation.timestamp_s)>1e-6 for ch in observation.channels):
            raise ValueError('Teacher sensors are stale or unsynchronized')
        if observation.ego.reverse or observation.ego.handbrake or base_command.reverse or base_command.gear!=1:
            raise ValueError('Teacher supports forward driving only')
        channels={ch.kind:ch for ch in observation.channels}
        radar=channels[SensorKind.RADAR]
        validate_radar_calibration(radar.calibration)
        detections=sorted(radar.data['detections'],key=lambda d:d['depth_m'])[:32]
        points=np.array([[d[k] for k in ('depth_m','azimuth_rad','altitude_rad','velocity_mps')]
                         for d in detections],np.float32).reshape(-1,4)
        point=foreground_return(points)
        speed=observation.ego.speed_mps
        envelope=c.minimum_clearance_m+speed*c.reaction_time_s+speed**2/(2*c.assumed_deceleration_mps2)
        release_range=c.minimum_clearance_m+c.release_hysteresis_m
        previous_state=self.state
        if self.previous is not None and observation.timestamp_s-self.previous[1]>.15:
            self.motion.clear();self.state=TeacherState.PROTECTIVE_BRAKING
        self.previous=(observation.frame_id,observation.timestamp_s)
        distance=closing=target_motion=None
        if point is not None:
            distance=float(point[0]);closing=-float(point[3])
            # Forward straight-lane approximation; angular sensor motion and
            # return switching make this an uncertain motion estimate.
            self.motion.append(speed*math.cos(float(point[1]))*math.cos(float(point[2]))+float(point[3]))
            target_motion=statistics.median(self.motion)
        else:self.motion.clear()
        braking=self.state in (TeacherState.PROTECTIVE_BRAKING,TeacherState.FINAL_APPROACH,TeacherState.SAFE_STOP)
        reason='Observed range exceeds stationary-target stopping envelope'
        decision='NO_INTERVENTION'
        if point is None:
            self.state=TeacherState.PROTECTIVE_BRAKING;decision='BRAKE_INTERVENTION'
            reason='No valid foreground return; absence is not free space'
        elif braking:
            if speed<=c.stopped_speed_mps and distance>release_range:
                self.state=TeacherState.SAFE_RELEASE;decision='RELEASE_TO_BASE_DRIVER'
                reason='Stopped ego with measured clearance beyond release hysteresis'
            else:
                self.state=(TeacherState.SAFE_STOP if speed<=c.stopped_speed_mps and distance<=release_range else
                    TeacherState.FINAL_APPROACH if target_motion<=c.lead_stationary_speed_mps else TeacherState.PROTECTIVE_BRAKING)
                decision='BRAKE_INTERVENTION';reason='Complete protective stop; hold near obstacle'
        elif distance<=envelope and (closing>.1 or base_command.throttle>0 or distance<=c.minimum_clearance_m):
            self.state=(TeacherState.FINAL_APPROACH if target_motion<=c.lead_stationary_speed_mps else TeacherState.PROTECTIVE_BRAKING)
            decision='BRAKE_INTERVENTION';reason='Measured range is inside stationary-target stopping envelope'
        else:self.state=TeacherState.MONITORING
        proposal=None;action=(-1.,0.,0.)
        if decision=='BRAKE_INTERVENTION':
            command=replace(base_command,source=CommandSource.SAFETY,throttle=0.,brake=max(base_command.brake,c.additional_brake))
            proposal=ProposedSafetyAction(command,c.version,observation.frame_id,observation.timestamp_s,True,reason)
            action=(1.,c.additional_brake,0.)
        return TeacherDecision(decision,self.state.value,action,proposal,
            {'previous_state':previous_state.value,'reason':reason,'frame_id':observation.frame_id,
             'timestamp_s':observation.timestamp_s,'observation_age_s':age,'ego_speed_mps':speed,
             'foreground_valid':point is not None,'forward_range_m':distance,'closing_velocity_mps':closing,
             'target_motion_estimate_mps':target_motion,'stopping_envelope_m':envelope,
             'release_range_m':release_range,'steering_available':False})
