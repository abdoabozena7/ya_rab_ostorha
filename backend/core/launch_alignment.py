"""Launch steering alignment for the shared route controller (base driver only).

At near-standstill a small lane offset makes the route PID command a tight
arc (e.g. 0.38 m offset -> 0.247 steering). The independent safety layer then
correctly measures coverage along that arc, which can be a few metres, and
holds indefinitely. When the car is already aligned with its lane, launching
straight and correcting the offset once moving is the ordinary maneuver. This
changes only the proposed steering; every safety, coverage and freshness check
still applies to the resulting path.
"""
import math

LAUNCH_SPEED_MPS = 1.5
MAX_HEADING_ERROR_DEG = 8.
MAX_LATERAL_OFFSET_M = .8
LAUNCH_STEERING_LIMIT = .045


def launch_steering(steering, *, speed_mps, lateral_offset_m, heading_error_deg):
    """Return (steering, reason). Real turns and large offsets keep their steering."""
    if not all(math.isfinite(v) for v in (steering, speed_mps, lateral_offset_m, heading_error_deg)):
        return steering, None
    if (abs(speed_mps) < LAUNCH_SPEED_MPS and abs(heading_error_deg) <= MAX_HEADING_ERROR_DEG
            and abs(lateral_offset_m) <= MAX_LATERAL_OFFSET_M and abs(steering) > LAUNCH_STEERING_LIMIT):
        return math.copysign(LAUNCH_STEERING_LIMIT, steering), 'STRAIGHT_LAUNCH_ALIGNED_WITH_LANE'
    return steering, None


def lane_alignment(ego_transform, lane_transform):
    """Signed right offset and heading error of the ego relative to its lane centre."""
    dx = ego_transform.location.x-lane_transform.location.x;dy = ego_transform.location.y-lane_transform.location.y
    yaw = math.radians(lane_transform.rotation.yaw)
    offset = -dx*math.sin(yaw)+dy*math.cos(yaw)
    error = (ego_transform.rotation.yaw-lane_transform.rotation.yaw+180.) % 360.-180.
    return offset, error


PURSUIT_LOOKAHEAD_M = 6.
WHEELBASE_M = 2.9
MAX_STEER_DEG = 70.


def curvature_speed_limit(ego_xy, route_xy, *, lateral_acceleration_mps2=2.5, deceleration_mps2=2.5,
                          horizon_m=60., minimum_mps=2.):
    """Highest speed from which every curve within the horizon is reachable comfortably.

    For each planned point, v <= sqrt(a_lat*R + 2*a*d), with R from the
    circle through points two samples apart and d the distance along the plan.
    Returns None when the plan ahead is straight or too short.
    """
    points = [tuple(p[:2]) for p in route_xy]
    if len(points) < 5:return None
    distance = math.dist(ego_xy, points[0]);cumulative = [distance]
    for a, b in zip(points, points[1:]):
        distance += math.dist(a, b);cumulative.append(distance)
    best = math.inf
    for i in range(2, len(points)-2):
        if cumulative[i] > horizon_m:break
        a, b, c = points[i-2], points[i], points[i+2]
        ab, bc, ca = math.dist(a, b), math.dist(b, c), math.dist(c, a)
        area2 = abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))
        if min(ab, bc, ca) < .5 or area2 < 1e-6:continue
        curvature = 2.*area2/(ab*bc*ca)
        if curvature < 1e-3:continue
        best = min(best, math.sqrt(lateral_acceleration_mps2/curvature+2.*deceleration_mps2*cumulative[i]))
    return None if math.isinf(best) else max(minimum_mps, best)


def pursuit_steering(ego_xy, ego_yaw_deg, route_xy, *, lookahead_m=PURSUIT_LOOKAHEAD_M, wheelbase_m=WHEELBASE_M,
                     max_steer_deg=MAX_STEER_DEG, limit=.35):
    """Pure-pursuit steering toward the planned lane point ``lookahead_m`` ahead.

    Near standstill the route PID aims at a waypoint a few metres away and
    saturates in corners (0.35 -> ~6 m radius), so the commanded arc leaves
    the lane and the safety layer correctly measures almost no coverage along
    it. A longer lookahead follows the lane's own curvature instead.
    Returns None when no planned point exists far enough ahead.
    """
    yaw = math.radians(ego_yaw_deg)
    for x, y in route_xy:
        dx = x-ego_xy[0];dy = y-ego_xy[1]
        forward = dx*math.cos(yaw)+dy*math.sin(yaw)
        if forward <= 0. or math.hypot(dx, dy) < lookahead_m:continue
        lateral = -dx*math.sin(yaw)+dy*math.cos(yaw)
        distance = math.hypot(dx, dy);alpha = math.atan2(lateral, forward)
        delta = math.atan2(2.*wheelbase_m*math.sin(alpha), distance)
        return max(-limit, min(limit, math.degrees(delta)/max_steer_deg))
    return None
