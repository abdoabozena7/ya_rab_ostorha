"""Compiled evaluation of the original measured-ray samples, without fast math."""
import numpy as np
import math
from numba import njit


@njit(cache=True, nogil=True, fastmath=False)
def mark_free_rays(free, xyz, delta, near, far, origin, steps, plane, limit, resolution):
    maximum = free.shape[0] - 1
    for ray in range(len(xyz)):
        span = far[ray] - near[ray]
        for step in steps:
            fraction = near[ray] + span * step
            x = origin[0] + delta[ray, 0] * fraction
            y = origin[1] + delta[ray, 1] * fraction
            height = origin[2] + (xyz[ray, 2] - origin[2]) * fraction
            height -= x * plane[0] + y * plane[1] + plane[2]
            if .25 <= height <= 1.5:
                ix = min(maximum, max(0, int(np.rint((x + limit) / resolution))))
                iy = min(maximum, max(0, int(np.rint((y + limit) / resolution))))
                free[ix, iy] = True


_warmed = False


@njit(cache=True, nogil=True, fastmath=False)
def observe_surfaces(free, occupied, xyz, origin, plane, limit, resolution, scope, front, rear, half_width, steps):
    maximum = free.shape[0] - 1
    seen = set()
    for point in xyz:
        x, y, z = point
        radius = math.sqrt(x*x + y*y)
        height = z - x*plane[0] - y*plane[1] - plane[2]
        if not (.5 < radius < limit and -.2 < height < 2.5):
            continue
        if -rear <= x <= front and abs(y) <= half_width:
            continue
        ix = min(maximum, max(0, int(np.rint((x + limit) / resolution))))
        iy = min(maximum, max(0, int(np.rint((y + limit) / resolution))))
        key = (ix, iy, z > .25, int(math.floor(z/.2)))
        if key in seen:
            continue
        seen.add(key)
        if height > .12:
            occupied[ix, iy] = True
        if abs(height) <= .08:
            free[ix, iy] = True
        dx, dy = x-origin[0], y-origin[1]
        near, far = 0., 1.
        for axis in range(2):
            delta = dx if axis == 0 else dy
            low, high = -math.inf, math.inf
            if abs(delta) > 1e-8:
                low = (-scope-origin[axis])/delta
                high = (scope-origin[axis])/delta
            near = max(near, min(low, high))
            far = min(far, max(low, high))
        if far <= near:
            continue
        for step in steps:
            fraction = near + (far-near)*step
            sx, sy = origin[0] + dx*fraction, origin[1] + dy*fraction
            sh = origin[2] + (z-origin[2])*fraction
            sh -= sx*plane[0] + sy*plane[1] + plane[2]
            if .25 <= sh <= 1.5:
                ax = min(maximum, max(0, int(np.rint((sx+limit)/resolution))))
                ay = min(maximum, max(0, int(np.rint((sy+limit)/resolution))))
                free[ax, ay] = True


def warm_measured_rays():
    global _warmed
    if _warmed:
        return
    steps = np.linspace(0., .999, 2)
    steps.flags.writeable = False
    mark_free_rays(np.zeros((3, 3), np.bool_), np.empty((0, 3)), np.empty((0, 2)),
                   np.empty(0), np.empty(0), np.zeros(3), steps, np.zeros(3), 1., .5)
    observe_surfaces(np.zeros((3, 3), np.bool_), np.zeros((3, 3), np.bool_), np.empty((0, 3)),
                     np.zeros(3), np.zeros(3), 1., .5, 1., 1., 1., 1., steps)
    _warmed = True
