"""Native onboard dimensions plus audited physical body envelopes.

The Mercedes native bounding box excludes the mirrors. Its own LiDAR returns at
x=0.457..0.477 m, y=+/-0.972 m, z=1.029..1.102 m were misread as nearby objects.
The 1.01 m half width includes that physical self surface with a 3.8 cm reserve.
This enlarges the entire collision/clearance footprint as well as its self mask;
it does not filter a wider region while retaining an artificially narrow car.
"""
import math
from ..core.motion_geometry import VehicleGeometry


def geometry_for(actor):
    box=actor.bounding_box;wheels=actor.get_physics_control().wheels
    width=box.extent.y+abs(box.location.y);source='NATIVE_ONBOARD_SPECIFICATIONS'
    if actor.type_id=='vehicle.mercedes.coupe_2020' and width<1.01:
        width=1.01;source='NATIVE_SPECIFICATIONS_WITH_AUDITED_MIRROR_ENVELOPE'
    return VehicleGeometry(box.extent.x+box.location.x,box.extent.x-box.location.x,width,
        (max(w.position.x for w in wheels)-min(w.position.x for w in wheels))/100.,
        math.radians(max(w.max_steer_angle for w in wheels)),source)
