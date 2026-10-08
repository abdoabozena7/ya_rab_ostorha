"""Experimental sensor-derived top-K retention, independent of teacher strategy.

No actor identities, world transforms, task parameters or persistent fake tracks.
All output rows are actual current radar measurements; absence stays explicit.
"""
from dataclasses import replace
import numpy as np
from ..core.contracts import SensorKind
from ..core.safety_policy import SensorObservation
from .radar import RADAR_FEATURES, estimate_ground_plane, local_points, validate_radar_calibration

RETENTION_VERSION = 'RADAR_RETENTION_V1'
COLUMNS = ('depth_m', 'azimuth_rad', 'altitude_rad', 'velocity_mps')


def retention_indices(points, capacity=32):
    """Preserve a working nearest set; recover foreground when it was excluded.

    Existing V2 geometry/height thresholds are reused, not calibrated on TEST.
    Ground estimation uses the original nearest <=32 returns. If that set has
    a forward foreground candidate, preserve it exactly: changing its consensus
    voters can otherwise turn a vehicle surface into a false ground plane.
    When no forward candidate survives top-K, reserve half the slots for
    foreground. One foreground
    anchor per central/left/right bearing sector protects angular coverage; the
    remaining foreground quota is nearest-first. Preserve the existing plane's
    spanning support, then fill other slots with nearby ground/unknown returns.
    Final rows are range ordered.
    Capacity is a representational limit, not proof of complete hazard coverage.
    """
    points = np.asarray(points)
    if (points.ndim != 2 or points.shape[1] != 4 or points.dtype.kind not in 'fiu'
            or not np.isfinite(points).all() or np.any(points[:, 0] < 0)
            or np.any(np.abs(points[:, 1]) > np.pi) or np.any(np.abs(points[:, 2]) > np.pi/2)):
        raise ValueError('Retention requires finite measured N x 4 radar points')
    if type(capacity) is not int or not 12 <= capacity <= 32:
        raise ValueError('Retention capacity must be between 12 and 32')
    order = np.argsort(points[:, 0], kind='stable')
    if len(points) <= capacity:
        return order
    reference = points[order[:capacity]]
    plane = estimate_ground_plane(reference)
    x, y, z = local_points(points)
    if plane is not None:
        a, b = plane
        z = (z-a*x-b*y)/np.sqrt(1+a*a+b*b)
    foreground = (z > RADAR_FEATURES.minimum_height_m) & (np.abs(points[:, 2]) < RADAR_FEATURES.max_altitude_rad)
    bearing = points[:, 1]
    forward = np.abs(bearing) < RADAR_FEATURES.max_azimuth_rad
    if np.any(foreground[order[:capacity]] & forward[order[:capacity]]) or not foreground.any():
        return order[:capacity]
    sectors = (np.abs(bearing) < RADAR_FEATURES.max_azimuth_rad,
               bearing <= -RADAR_FEATURES.max_azimuth_rad,
               bearing >= RADAR_FEATURES.max_azimuth_rad)
    selected = []
    for sector in sectors:
        candidates = order[foreground[order] & sector[order]]
        if len(candidates):
            selected.append(int(candidates[0]))
    quota = capacity//2
    for i in order[foreground[order]]:
        if len(selected) >= quota:
            break
        if int(i) not in selected:
            selected.append(int(i))
    if plane is not None:
        # Retain six spanning inliers so recomputing V2 screening after top-K
        # does not lose its calibrated ground plane and turn road into foreground.
        a, b = plane
        rx, ry, rz = local_points(reference)
        support = order[:capacity][np.abs(rz-a*rx-b*ry) <= RADAR_FEATURES.plane_residual_m]
        support = support[np.argsort(x[support], kind='stable')]
        for i in support[np.linspace(0, len(support)-1, RADAR_FEATURES.min_plane_support, dtype=int)]:
            if int(i) not in selected:
                selected.append(int(i))
    for i in order:
        if len(selected) >= capacity:
            break
        if int(i) not in selected:
            selected.append(int(i))
    chosen = set(selected)
    return np.asarray([i for i in order if int(i) in chosen], dtype=np.int64)


def retain_detections(detections, capacity=32):
    points = np.array([[d[k] for k in COLUMNS] for d in detections], np.float32).reshape(-1, 4)
    return tuple(detections[int(i)] for i in retention_indices(points, capacity))


def retained_radar_observation(observation, capacity=32):
    """Input adapter for the byte-preserved Experiment 2B teacher.

    The teacher's existing local nearest-32 sort sees only the shared retained
    set. Other channels, ego state, calibration and timestamps remain unchanged.
    """
    if not isinstance(observation, SensorObservation):
        raise ValueError('Retention adapter requires the sensor-only contract')
    channels = []
    for channel in observation.channels:
        if channel.kind == SensorKind.RADAR:
            validate_radar_calibration(channel.calibration)
            channel = replace(channel, data={'detections': retain_detections(channel.data['detections'], capacity)})
        channels.append(channel)
    return replace(observation, channels=tuple(channels))
