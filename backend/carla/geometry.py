"""Privileged planar bounding-box clearance for diagnostics, never policy input.

Yaw-oriented rectangles approximate vehicle footprints; pitch/roll and detailed
meshes are excluded. Zero means overlapping footprints, not a collision event.
"""
import math


def footprint(transform, box):
    yaw=math.radians(transform.rotation.yaw)
    c,s=math.cos(yaw),math.sin(yaw)
    center=(transform.location.x+c*box.location.x-s*box.location.y,
            transform.location.y+s*box.location.x+c*box.location.y)
    yaw+=math.radians(box.rotation.yaw)
    c,s=math.cos(yaw),math.sin(yaw)
    return tuple((center[0]+c*x-s*y,center[1]+s*x+c*y) for x,y in
                 ((-box.extent.x,-box.extent.y),(box.extent.x,-box.extent.y),
                  (box.extent.x,box.extent.y),(-box.extent.x,box.extent.y)))


def rectangle_clearance(a,b):
    separated=False
    for poly in (a,b):
        for p,q in zip(poly,poly[1:]+poly[:1]):
            axis=(-(q[1]-p[1]),q[0]-p[0])
            left=[x*axis[0]+y*axis[1] for x,y in a]
            right=[x*axis[0]+y*axis[1] for x,y in b]
            if max(left)<min(right) or max(right)<min(left): separated=True
    if not separated:return 0.
    def distance(p,q,r):
        dx,dy=r[0]-q[0],r[1]-q[1]
        if dx*dx+dy*dy <= 1e-16: return math.hypot(p[0]-q[0],p[1]-q[1])
        t=max(0.,min(1.,((p[0]-q[0])*dx+(p[1]-q[1])*dy)/(dx*dx+dy*dy)))
        return math.hypot(p[0]-q[0]-t*dx,p[1]-q[1]-t*dy)
    return min(distance(p,q,r) for first,second in ((a,b),(b,a)) for p in first
               for q,r in zip(second,second[1:]+second[:1]))
