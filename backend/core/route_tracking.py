"""Route-following path tracker shared by the evaluation base driver and its coverage probe.

The safety supervisor used to probe measured coverage along a constant-steering
arc taken from the route PID's instantaneous command. In tight turns that arc
is neither the route nor the path the car will drive: stopped at a corner the
PID or a long launch pursuit commanded 0.05-0.15 steering, so the arc ran
straight into the corner's curb or building, coverage was 0 m and the car held
indefinitely while its steering never changed.

This module computes one steering command by pure pursuit on the planned route
and predicts the path that the same tracker will drive by forward simulation
of a kinematic bicycle (rear-axle reference, onboard wheelbase and steering
limit). The base driver applies the first command; the supervisor probes the
predicted swept path. Map geometry only selects where the probe looks; every
pose along it still needs measured free, unoccupied space, and the probe is
recomputed from the measured pose on every frame.
"""
import math

TRACKER_ID = 'ROUTE_PURE_PURSUIT_V1'
MIN_LOOKAHEAD_M = 2.5
LOOKAHEAD_GAIN_S = .25
LOOKAHEAD_QUADRATIC_S2_PER_M = .035
MAX_LOOKAHEAD_M = 16.
BACK_EXTENSION_M = 12.
STEP_M = .25


def lookahead_m(speed_mps):
    """Short in slow tight turns (less corner cutting), growing with speed for stability.

    Offline kinematic checks on the failing Town01/Town02 corners kept the
    origin within 0.3 m of the route with 150-250 ms actuation lag and stayed
    stable up to 16.7 m/s with 350 ms lag.
    """
    v = max(0., float(speed_mps))
    return min(MAX_LOOKAHEAD_M, MIN_LOOKAHEAD_M+LOOKAHEAD_GAIN_S*v+LOOKAHEAD_QUADRATIC_S2_PER_M*v*v)


def dense_route(waypoints, step_m=.5, *, tolerance_m=1.5):
    """Planned route as lane geometry every ``step_m`` (onboard map, never another actor).

    The native planner samples its route every 4 m, which leaves only a few
    chords in a tight turn. Between consecutive route waypoints the lane is
    followed with ``next(step_m)`` toward the next waypoint; if that walk cannot
    reach it (for example a lane change) the straight chord is used instead.
    """
    def xy(w):return (w.transform.location.x, w.transform.location.y)
    points = []
    for a, b in zip(waypoints, waypoints[1:]):
        start, end = xy(a), xy(b);gap = math.dist(start, end);points.append(start)
        walk = [];current = a;best = gap
        for _ in range(int(gap/step_m*2)+8):
            following = current.next(step_m) if hasattr(current, 'next') else []
            if not following:break
            current = min(following, key=lambda w: math.dist(xy(w), end));distance = math.dist(xy(current), end)
            if distance < step_m*.75:best = distance;break
            if distance > best+step_m*2:break
            best = min(best, distance);walk.append(xy(current))
        if walk and best <= tolerance_m:points.extend(walk)
        else:
            count = max(1, int(math.ceil(gap/step_m)))
            points.extend((start[0]+(end[0]-start[0])*k/count, start[1]+(end[1]-start[1])*k/count) for k in range(1, count))
    if waypoints:points.append(xy(waypoints[-1]))
    return points


class RoutePolyline:
    """Planned route in world coordinates with arc length; extrapolates linearly at both ends."""
    def __init__(self, points):
        xy = []
        for point in points:
            x, y = float(point[0]), float(point[1])
            if not (math.isfinite(x) and math.isfinite(y)):raise ValueError('Invalid route point')
            if not xy or math.hypot(x-xy[-1][0], y-xy[-1][1]) > .05:xy.append((x, y))
        if len(xy) < 2:raise ValueError('Route tracking needs at least two distinct points')
        # Waypoints the native planner already passed are no longer queued. The
        # first segment's direction stands in for the lane just behind it.
        dx, dy = xy[1][0]-xy[0][0], xy[1][1]-xy[0][1];n = math.hypot(dx, dy)
        xy.insert(0, (xy[0][0]-BACK_EXTENSION_M*dx/n, xy[0][1]-BACK_EXTENSION_M*dy/n))
        self.x = [p[0] for p in xy];self.y = [p[1] for p in xy];self.s = [0.]
        for i in range(1, len(xy)):self.s.append(self.s[-1]+math.hypot(self.x[i]-self.x[i-1], self.y[i]-self.y[i-1]))
        self.planned_start_s = BACK_EXTENSION_M

    @property
    def length(self):return self.s[-1]

    def project(self, x, y, hint=None):
        """Arc length of the closest point; ``hint`` restricts the search near the previous segment."""
        last = len(self.x)-2
        lo, hi = (0, last) if hint is None else (max(0, hint-2), min(last, hint+6))
        best = (math.inf, 0., lo)
        for i in range(lo, hi+1):
            ax, ay = self.x[i], self.y[i];bx, by = self.x[i+1]-ax, self.y[i+1]-ay
            length2 = bx*bx+by*by
            f = 0. if length2 <= 0 else max(0., min(1., ((x-ax)*bx+(y-ay)*by)/length2))
            px, py = ax+f*bx, ay+f*by;d2 = (x-px)**2+(y-py)**2
            if d2 < best[0]:best = (d2, self.s[i]+f*(self.s[i+1]-self.s[i]), i)
        return best[1], best[2]

    def point_at(self, s):
        if s <= 0:i = 0
        elif s >= self.s[-1]:i = len(self.s)-2
        else:
            lo, hi = 0, len(self.s)-1
            while hi-lo > 1:
                mid = (lo+hi)//2
                if self.s[mid] <= s:lo = mid
                else:hi = mid
            i = lo
        span = self.s[i+1]-self.s[i];f = (s-self.s[i])/span if span > 0 else 0.
        return self.x[i]+f*(self.x[i+1]-self.x[i]), self.y[i]+f*(self.y[i+1]-self.y[i])


def pursuit_steering(rear_x, rear_y, yaw, line, s_projection, *, lookahead, wheelbase_m, max_steer_rad, limit):
    """Normalized right-positive steering toward the route point ``lookahead`` beyond the projection."""
    tx, ty = line.point_at(s_projection+lookahead)
    dx, dy = tx-rear_x, ty-rear_y;distance = math.hypot(dx, dy)
    if distance < 1e-3:return 0.
    c, s = math.cos(yaw), math.sin(yaw)
    alpha = math.atan2(-dx*s+dy*c, dx*c+dy*s)
    delta = math.atan2(2.*wheelbase_m*math.sin(alpha), distance)
    return max(-limit, min(limit, delta/max_steer_rad))


def rear_axle_offset_m(geometry):
    """Rear axle along the body x axis; axles are taken as centred on the measured box."""
    return geometry.center_offset-geometry.wheelbase_m/2.


def track(origin_xy, yaw_rad, route_xy, *, speed_mps, target_speed_mps, geometry, limit=.35,
          horizon_m=50., step_m=STEP_M, acceleration_mps2=2., previous_steering=None,
          steering_rate_per_s=2., control_period_s=.05, row_step_m=.5):
    """Return (steering, path, diagnostics).

    ``path`` rows are (distance travelled by the origin, x, y, yaw) in the
    vehicle frame of the current pose: metres, right-positive, as used by the
    safety supervisor. The first row is the current pose. Steering changes are
    rate-limited exactly as they will be applied (0.1 per 50 ms control tick,
    like the native route PID), so the first command and the predicted path
    describe the same motion.
    """
    line = RoutePolyline(route_xy)
    wheelbase = geometry.wheelbase_m;max_steer = geometry.max_steer_rad;rear = rear_axle_offset_m(geometry)
    ox0, oy0 = float(origin_xy[0]), float(origin_xy[1]);yaw0 = float(yaw_rad)
    if not all(math.isfinite(v) for v in (ox0, oy0, yaw0, speed_mps, target_speed_mps)):raise ValueError('Invalid tracker input')
    psi = yaw0;rx, ry = ox0+rear*math.cos(psi), oy0+rear*math.sin(psi)
    c0, s0 = math.cos(yaw0), math.sin(yaw0)
    v = max(0., float(speed_mps));target = max(v, float(target_speed_mps), .5)
    rows = [(0., 0., 0., 0.)];travelled = 0.;previous = (ox0, oy0);hint = None;first = None;steps = int(math.ceil(horizon_m/step_m))
    s_start, hint = line.project(rx, ry, hint)
    cross_track = None;applied = None if previous_steering is None else float(previous_steering);dt = control_period_s
    for _ in range(steps):
        s_projection, hint = line.project(rx, ry, hint)
        desired = pursuit_steering(rx, ry, psi, line, s_projection, lookahead=lookahead_m(v), wheelbase_m=wheelbase,
                                   max_steer_rad=max_steer, limit=limit)
        steering = desired if applied is None else max(applied-steering_rate_per_s*dt, min(applied+steering_rate_per_s*dt, desired))
        applied = steering
        if first is None:
            first = steering
            px, py = line.point_at(s_projection)
            cross_track = -(rx-px)*math.sin(psi)+(ry-py)*math.cos(psi)
        kappa = math.tan(steering*max_steer)/wheelbase
        if abs(kappa) < 1e-9:
            rx += step_m*math.cos(psi);ry += step_m*math.sin(psi)
        else:
            turn = kappa*step_m
            rx += (math.sin(psi+turn)-math.sin(psi))/kappa;ry += (math.cos(psi)-math.cos(psi+turn))/kappa;psi += turn
        v_next = min(target, math.sqrt(v*v+2.*acceleration_mps2*step_m))
        dt = step_m/max(.1, .5*(v+v_next));v = v_next
        ox, oy = rx-rear*math.cos(psi), ry-rear*math.sin(psi)
        travelled += math.hypot(ox-previous[0], oy-previous[1]);previous = (ox, oy)
        dx, dy = ox-ox0, oy-oy0
        done = s_projection >= line.length-1e-6
        if travelled-rows[-1][0] >= row_step_m-1e-9 or done or _ == steps-1:
            rows.append((travelled, dx*c0+dy*s0, -dx*s0+dy*c0, psi-yaw0))
        if done:break
    return first, rows, {'tracker': TRACKER_ID, 'lookahead_m': lookahead_m(speed_mps), 'rear_axle_x_m': rear,
                         'route_progress_m': s_start-line.planned_start_s, 'rear_axle_cross_track_m': cross_track,
                         'route_remaining_m': line.length-s_start}
