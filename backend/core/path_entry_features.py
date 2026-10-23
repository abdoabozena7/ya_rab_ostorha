"""Sensor-only pedestrian path-entry features shared by runtime and offline training.

Inputs are a published ControlScene track (its own measured history in the
dead-reckoned odometry frame), measured ego speed, the commanded steering arc
and scene freshness. Native actor poses, scripts and future positions are never
accepted here; the offline dataset builder calls this same function.
"""
import math
import numpy as np

FEATURE_VERSION = 'PATH_ENTRY_FEATURES_V1'
STEPS = 10
STEP_S = .2
STEP_FEATURES = ('along_m', 'offset_m', 'outside_corridor_m', 'along_mps', 'toward_mps', 'speed_mps',
                 'toward_accel_mps2', 'observed')
STATIC_FEATURES = ('ego_speed_mps', 'corridor_curvature', 'quality', 'uncertainty_m', 'occlusion_s',
                   'observation_age_s', 'person_classified', 'measured_unknown', 'confirmed',
                   'observed_crossing_cleared', 'history_span_s', 'motion_observations',
                   'semantic_confidence', 'semantic_available', 'half_size_m')
INPUT_SIZE = len(STEP_FEATURES)+len(STATIC_FEATURES)
SCALES = np.array([50., 10., 10., 3., 3., 3., 5., 1.]+[20., .05, 1., 1., 1., .5, 1., 1., 1., 1., 2., 10., 1., 1., 1.], np.float32)
MAX_STEERING_ANGLE_RAD = math.radians(70.)


def steering_curvature(steering, *, wheelbase_m=2.9, max_steer_rad=MAX_STEERING_ANGLE_RAD):
    """Curvature of the commanded arc; RULE ignores |steering| < 0.05 likewise."""
    if steering is None or not math.isfinite(steering) or abs(steering) < .05:return 0.
    return math.tan(float(np.clip(steering, -1., 1.))*max_steer_rad)/wheelbase_m


def corridor_coordinates(points, curvature):
    """Arc length and right-positive offset of ego-frame points on the commanded arc."""
    p = np.atleast_2d(np.asarray(points, float))
    if abs(curvature) < 1e-4:return p[:, 0].copy(), p[:, 1].copy()
    radius = 1./curvature
    rel_y = radius-p[:, 1]
    r = np.hypot(p[:, 0], rel_y)
    offset = math.copysign(1., radius)*(abs(radius)-r)
    angle = np.arctan2(p[:, 0], math.copysign(1., radius)*rel_y)
    return abs(radius)*angle, offset


def _to_local(rows, origin, yaw):
    c, s = math.cos(yaw), math.sin(yaw)
    rotation = np.array([[c, -s], [s, c]])
    xy = (np.asarray(rows[:, 1:3], float)-np.asarray(origin, float)[None])@rotation
    v = np.asarray(rows[:, 3:5], float)@rotation
    return xy, v


def track_features(track, *, timestamp_s, odometry_origin_m, odometry_yaw_rad, ego_speed_mps, steering,
                   corridor_half_width_m, front_m=0., observation_age_s=0.):
    """Return the fixed sequence, static vector and observation mask for one track.

    Every value comes from the track's own published measurement history.
    Missing history steps are zero-filled with an explicit mask; missing
    semantic evidence sets ``semantic_available`` to zero.
    """
    position = np.asarray(track['position_m'], float)[:2];velocity = np.asarray(track.get('velocity_mps', (0., 0.)), float)[:2]
    if not np.isfinite(position).all() or not np.isfinite(velocity).all():raise ValueError('Track measurement is not finite')
    rows = np.asarray([r for r in track.get('history') or () if len(r) >= 5 and r[0] < timestamp_s-1e-6], float)
    times = np.r_[rows[:, 0], timestamp_s] if len(rows) else np.array([timestamp_s])
    if len(rows):
        xy, v = _to_local(rows, odometry_origin_m, odometry_yaw_rad)
        xy = np.vstack((xy, position));v = np.vstack((v, velocity))
    else:
        xy = position[None];v = velocity[None]
    order = np.argsort(times, kind='stable');times = times[order];xy = xy[order];v = v[order]
    grid = timestamp_s-STEP_S*np.arange(STEPS-1, -1, -1)
    observed = (grid >= times[0]-1e-6) & (grid <= times[-1]+1e-6)
    gx = np.interp(grid, times, xy[:, 0]);gy = np.interp(grid, times, xy[:, 1])
    gvx = np.interp(grid, times, v[:, 0]);gvy = np.interp(grid, times, v[:, 1])
    curvature = steering_curvature(steering)
    along, offset = corridor_coordinates(np.column_stack((gx, gy)), curvature)
    # Velocity components in the corridor frame (tangent of a near-straight arc).
    heading = along*curvature
    v_along = gvx*np.cos(heading)+gvy*np.sin(heading)
    v_offset = -gvx*np.sin(heading)+gvy*np.cos(heading)
    side = np.sign(offset)
    toward = -side*v_offset
    half = float(max(track.get('half_size_m') or (.3, .3)))
    outside = np.abs(offset)-corridor_half_width_m-half
    accel = np.r_[0., np.diff(toward)/STEP_S]
    accel[~(observed & np.r_[False, observed[:-1]])] = 0.
    sequence = np.column_stack((along-front_m, offset, outside, v_along, toward, np.hypot(gvx, gvy), accel,
                                observed.astype(float)))
    sequence[~observed, :-1] = 0.
    semantic = track.get('semantic_evidence') or {}
    classified = str(track.get('class', '')).lower() in ('person', 'pedestrian') and bool(semantic)
    static = np.array([abs(ego_speed_mps), curvature, float(track.get('quality', 0.) or 0.),
                       float(track.get('uncertainty_m', .5) or .5), float(track.get('occlusion_s', 0.) or 0.),
                       float(observation_age_s), float(classified), float(str(track.get('class', 'UNKNOWN')).upper() == 'UNKNOWN'),
                       float(bool(track.get('confirmed'))), float(bool(track.get('observed_crossing_cleared'))),
                       float(times[-1]-times[0]), float(min(track.get('motion_observations', 0) or 0, 20)),
                       float(semantic.get('confidence', 0.) or 0.), float(bool(semantic)), half])
    sequence = np.nan_to_num(sequence, nan=0., posinf=0., neginf=0.)
    static = np.nan_to_num(static, nan=0., posinf=0., neginf=0.)
    full = np.hstack((sequence, np.repeat(static[None], STEPS, axis=0)))
    return {'inputs': np.clip(full/SCALES[None], -3., 3.).astype(np.float32), 'observed': observed,
            'current': {'along_m': float(along[-1]-front_m), 'offset_m': float(offset[-1]),
                        'outside_corridor_m': float(outside[-1]), 'toward_mps': float(toward[-1]),
                        'speed_mps': float(np.hypot(gvx[-1], gvy[-1]))},
            'history_span_s': float(times[-1]-times[0]), 'version': FEATURE_VERSION}


def eligible_track(track, *, front_m=0., maximum_range_m=60., maximum_lateral_m=25.):
    """Pedestrian-sized, confirmed, forward tracks; broad merged surfaces are excluded."""
    position = track.get('position_m') or ()
    if len(position) < 2 or not track.get('confirmed'):return False
    if max(track.get('half_size_m') or (9., 9.)) > 1.5:return False
    return front_m < position[0] <= front_m+maximum_range_m and abs(position[1]) <= maximum_lateral_m
