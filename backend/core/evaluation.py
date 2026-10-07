"""Metrics from supplied observations. Unknown measurements remain null."""
from dataclasses import dataclass
import math
from .contracts import Contract, finite
from .events import EventType


def time_to_collision(distance_m, closing_velocity_mps):
    distance, closing = finite(distance_m), finite(closing_velocity_mps)
    if distance < 0:
        raise ValueError('Distance cannot be negative')
    if closing <= 0:
        return None  # Stationary or separating; no finite TTC in this model.
    result = distance/closing
    return result if math.isfinite(result) else None


def route_completion_percent(completed_distance_m, total_distance_m):
    completed, total = finite(completed_distance_m), finite(total_distance_m)
    if completed < 0 or total <= 0:
        raise ValueError('Route distances must be nonnegative with a positive total')
    return min(100., completed/total*100)


@dataclass(frozen=True)
class MetricResult(Contract):
    collision_count: int
    collision_impulse_total_ns: float
    minimum_object_distance_m: float | None
    minimum_ttc_s: float | None
    maximum_deceleration_mps2: float | None
    maximum_acceleration_mps2: float | None
    maximum_jerk_mps3: float | None
    average_speed_mps: float | None
    braking_distance_m: float | None
    manual_intervention_count: int
    emergency_stop_count: int
    route_completion_percent: float | None
    simulation_duration_s: float


def _norm(vector):
    return finite(math.hypot(*vector), 'vector magnitude')


def evaluate(frames, events=(), *, ttc_samples=(), route_progress=None):
    frames, events = list(frames), list(events)
    if any(b.frame_id <= a.frame_id or b.timestamp_s <= a.timestamp_s for a, b in zip(frames, frames[1:])):
        raise ValueError('Evaluation requires strictly increasing native frames/timestamps')
    collisions = [collision for frame in frames for collision in frame.collisions]
    distances = [obj.distance_m for frame in frames if frame.ground_truth for obj in frame.ground_truth.objects if obj.distance_m is not None]
    ttcs = [time_to_collision(distance, closing) for distance, closing in ttc_samples]
    ttcs = [value for value in ttcs if value is not None]
    accelerations = [frame.vehicle.longitudinal_acceleration_mps2 for frame in frames]
    observed_accelerations = [value for value in accelerations if value is not None]
    jerk = [abs(b-a)/(right.timestamp_s-left.timestamp_s)
            for left, right, a, b in zip(frames, frames[1:], accelerations, accelerations[1:])
            if a is not None and b is not None]
    duration = frames[-1].timestamp_s-frames[0].timestamp_s if frames else 0.
    # Trapezoidal time weighting, so sampling frequency does not bias average speed.
    distance = sum((a.vehicle.speed_mps+b.vehicle.speed_mps)/2*(b.timestamp_s-a.timestamp_s) for a, b in zip(frames, frames[1:]))
    braking_segments, braking_distance, active = [], 0., False
    for a, b in zip(frames, frames[1:]):
        if a.vehicle.brake > 0 and a.vehicle.speed_mps > .1:
            active = True
            braking_distance += _norm(tuple(y-x for x, y in zip(a.vehicle.transform.position_m, b.vehicle.transform.position_m)))
            if b.vehicle.speed_mps <= .1:
                braking_segments.append(braking_distance)
                braking_distance, active = 0., False
        elif active:
            braking_distance, active = 0., False  # Incomplete stopping episode is not a stopping distance.
    return MetricResult(
        len(collisions), sum(_norm(collision.impulse_ns) for collision in collisions),
        min(distances) if distances else None, min(ttcs) if ttcs else None,
        max((max(0., -value) for value in observed_accelerations), default=None),
        max((max(0., value) for value in observed_accelerations), default=None),
        max(jerk, default=None), distance/duration if duration > 0 else None,
        max(braking_segments, default=None),
        sum(event.event_type == EventType.ControlChanged and event.payload.get('manual_intervention') is True for event in events),
        sum(event.event_type == EventType.EmergencyStop for event in events),
        route_completion_percent(*route_progress) if route_progress is not None else None, duration)
