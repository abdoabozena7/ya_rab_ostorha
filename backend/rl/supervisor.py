"""Training-only sensor projection and conservative intervention admission.

No CARLA/world/route/reward types enter this module. Radar cannot establish
side-space coverage, so this experiment never certifies a steering adjustment.
"""
from dataclasses import replace
import numpy as np
from gymnasium import spaces
from ..core.contracts import CommandSource, SensorKind
from ..core.safety_policy import (SensorObservation, ProposedSafetyAction,
                                 FeasibilityEvidence, admit_proposal)
from .radar import foreground_return

INTERVENTION_LOW = np.array([-1., 0., -1.], np.float32)
INTERVENTION_HIGH = np.ones(3, np.float32)
FEATURE_DIM = 47


def normalize_intervention(action):
    if isinstance(action, (list, tuple)) and any(isinstance(v, (bool, np.bool_)) for v in action):
        raise ValueError('Boolean intervention is invalid')
    a = np.asarray(action)
    if a.shape != (3,) or a.dtype.kind not in 'fiu' or not np.isfinite(a).all():
        raise ValueError('Intervention requires finite [gate, extra_brake, steering_delta]')
    return a.astype(np.float64), np.clip(a, INTERVENTION_LOW, INTERVENTION_HIGH)


def policy_features(observation, base_action):
    """Four onboard/radar histories (11 each), followed by proposed controls.

    The caller supplies only the audited lightweight arrays, never episode info.
    Absolute frame/time, seed, scenario parameters and actor geometry are omitted.
    """
    expected = {'ego', 'imu', 'previous_action', 'radar', 'radar_valid', 'history_valid', 'frame_time'}
    if set(observation) != expected:
        raise ValueError('Only the audited lightweight sensor projection is permitted')
    rows = []
    for i in range(4):
        valid = bool(observation['history_valid'][i])
        points = observation['radar'][i][observation['radar_valid'][i].astype(bool)]
        point = foreground_return(points)
        distance = float(point[0]) if point is not None else 50.
        velocity = float(point[3]) if point is not None else 0.
        ttc = min(10., distance / max(.1, -velocity)) if point is not None else 10.
        row = [observation['ego'][i, 0] / 15., observation['imu'][i, 0] / 10.,
               observation['ego'][i, 3] / 2., *observation['previous_action'][i],
               distance / 50., velocity / 20., ttc / 10., float(point is not None), float(valid)]
        rows.extend(row if valid else [0.] * 11)
    base = np.asarray(base_action, np.float32)
    if base.shape != (3,) or not np.isfinite(base).all():
        raise ValueError('Invalid proposed base controls')
    result = np.clip(np.asarray([*rows, *base], np.float32), -1., 1.)
    if result.shape != (FEATURE_DIM,) or not np.isfinite(result).all():
        raise ValueError('Invalid supervisor sensor projection')
    return result


class TrainingRadarFeasibilityValidator:
    """Implements the existing validator protocol for additional braking only.

    Physical checks are actuator constraints; hazard inspection covers the
    synchronized forward radar and onboard IMU. Side/rear safety is unverified.
    This limited experimental validator is not production maneuver validation.
    """
    def validate(self, history, base_command, proposal):
        observation = history[-1]
        if not isinstance(observation, SensorObservation):
            raise ValueError('Feasibility requires the sensor-only contract')
        kinds = {c.kind for c in observation.channels}
        fresh = all(c.frame_id == observation.frame_id and
                    abs(c.sensor_timestamp_s - observation.timestamp_s) <= 1e-6
                    for c in observation.channels)
        checked = fresh and {SensorKind.RADAR, SensorKind.IMU} <= kinds
        radar=next((c for c in observation.channels if c.kind==SensorKind.RADAR),None)
        imu=next((c for c in observation.channels if c.kind==SensorKind.IMU),None)
        # Inspect actual measured returns, including low returns. Validity is
        # not classification: a road return is not asserted to be a vehicle.
        if checked:
            detections=radar.data.get('detections')
            checked=(detections is not None and
                np.isfinite(np.asarray(imu.data.get('gyroscope_radps',[]),float)).all() and
                len(imu.data.get('gyroscope_radps',[]))==3 and
                all(np.isfinite([d['depth_m'],d['azimuth_rad'],d['altitude_rad'],d['velocity_mps']]).all()
                    and d['depth_m']>=0 and abs(d['azimuth_rad'])<=np.pi and abs(d['altitude_rad'])<=np.pi/2
                    for d in detections))
        c = proposal.command
        physical = (c.brake >= base_command.brake and c.throttle <= base_command.throttle
                    and c.gear == 1 and not c.reverse and not c.handbrake)
        return FeasibilityEvidence(observation.frame_id, observation.timestamp_s,
            physical, checked, False, False, False, .075, base_command.throttle,
            'EXPERIMENT1_FORWARD_RADAR_BRAKING_ONLY', 'SENSOR_DERIVED_AND_ONBOARD_LIMITS')


def decide_intervention(observation, base_command, action, policy_id):
    proposed, bounded = normalize_intervention(action)
    result = {'proposed_intervention': proposed.tolist(), 'bounded_intervention': bounded.tolist(),
              'decision': 'NO_INTERVENTION', 'accepted': False, 'steering_adjustment_rejected': False,
              'policy_id': policy_id, 'reason': 'Gate requests no intervention'}
    if bounded[0] <= 0:
        return base_command, result
    requested_delta = float(bounded[2]) * .15
    # No side-space evidence exists in this profile. Reject that axis explicitly,
    # retaining an independently feasible braking proposal, rather than inventing it.
    result['steering_adjustment_rejected'] = abs(requested_delta) > .001
    brake = max(base_command.brake, float(bounded[1]))
    throttle = 0. if brake > 0 else base_command.throttle
    candidate = replace(base_command, source=CommandSource.SAFETY, brake=brake, throttle=throttle)
    if candidate.brake == base_command.brake and candidate.throttle == base_command.throttle:
        result['reason'] = 'No admitted control change; steering space is unverified'
        return base_command, result
    proposal = ProposedSafetyAction(candidate, policy_id, observation.frame_id,
                                   observation.timestamp_s, True, 'Additional braking proposal')
    evidence = TrainingRadarFeasibilityValidator().validate((observation,), base_command, proposal)
    admitted = admit_proposal(observation, base_command, proposal, evidence)
    result.update(accepted=admitted.accepted, reason=admitted.reason,
                  decision='BRAKING_INTERVENTION' if admitted.accepted else 'REJECTED',
                  feasibility={'physical_limits_verified': evidence.physical_limits_verified,
                               'surrounding_hazards_checked': evidence.surrounding_hazards_checked,
                               'left_space_verified': False, 'right_space_verified': False,
                               'validator_id': evidence.validator_id})
    return admitted.command if admitted.accepted else base_command, result


def rule_intervention(observation):
    """Explicit sensor-derived braking baseline; never a learned policy."""
    points = observation['radar'][-1][observation['radar_valid'][-1].astype(bool)]
    points = points[(np.abs(points[:, 1]) < .12) & (np.abs(points[:, 2]) < .15)]
    speed = float(observation['ego'][-1, 0])
    threshold = 2.5 + speed * .35 + speed * speed / (2 * 5.)
    hazard = len(points) and float(points[:, 0].min()) < max(6., threshold)
    return np.array([1., 1., 0.] if hazard else [-1., 0., 0.], np.float32)


import gymnasium as gym
from .env import YaRabOstorhaEnv


class SafetySupervisorEnv(gym.Env):
    metadata = {'render_modes': []}
    render_mode = None

    def __init__(self, *, split='TRAIN', parameters=None, policy_id='UNTRAINED_SAC', transport=None):
        self.native = YaRabOstorhaEnv(profile='lightweight', split=split, scenario='SUDDEN_BRAKING',
            parameters=parameters, max_steps=240, baseline_id='BASIC_AGENT_WITH_SUPERVISOR',
            supervisor=True, policy_id=policy_id, transport=transport)
        self.observation_space = spaces.Box(-1., 1., (FEATURE_DIM,), np.float32)
        self.action_space = spaces.Box(INTERVENTION_LOW, INTERVENTION_HIGH, dtype=np.float32)
        self.spec = self.native.spec
        self.raw_observation = None

    def reset(self, *, seed=None, options=None):
        super().reset(seed=seed)
        self.raw_observation, info = self.native.reset(seed=seed, options=options)
        return policy_features(self.raw_observation, info['base_proposed_action']), info

    def step(self, action):
        self.raw_observation, reward, terminated, truncated, info = self.native.step(action)
        base = info.get('next_base_proposed_action', info.get('base_proposed_action', [0., 0., 0.]))
        return policy_features(self.raw_observation, base), reward, terminated, truncated, info

    def close(self):
        self.native.close()
