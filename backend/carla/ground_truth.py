"""Debug native nearby actors, using the same snapshot as ego telemetry."""
import math
from ..core.contracts import ActorState, GroundTruthObject, RotationRad, SimulatorGroundTruth, Transform
from .contracts import CARLA_WORLD


class NearbyActorInspector:
    def __init__(self, world, ego):
        self.world, self.ego = world, ego
        self.radius = 50.
        self.actor_types = {}
        self.actor_bounds = {}
        self.refreshed_at = -float('inf')
        self.latest = {'radius_m': self.radius, 'actors': [], 'traffic_light': None}

    def configure(self, radius):
        if type(radius) not in (int, float) or not math.isfinite(radius) or not 10 <= radius <= 150:
            raise ValueError('Nearby actor radius must be 10–150 m')
        self.radius = float(radius)

    def observe(self, snapshot):
        timestamp = snapshot.timestamp.elapsed_seconds
        if timestamp-self.refreshed_at >= 1.:
            actors=[a for a in self.world.get_actors() if not a.type_id.startswith(('sensor.','controller.','spectator'))]
            self.actor_types={a.id:a.type_id for a in actors}
            self.actor_bounds={a.id:{'extent_m':[a.bounding_box.extent.x,a.bounding_box.extent.y,a.bounding_box.extent.z],
                'offset_m':[a.bounding_box.location.x,a.bounding_box.location.y,a.bounding_box.location.z]}
                for a in actors if hasattr(a,'bounding_box')}
            self.refreshed_at = timestamp
        ego = snapshot.find(self.ego.id)
        ego_transform = ego.get_transform()
        position = ego_transform.location
        inverse = ego_transform.get_inverse_matrix()
        objects, rows = [], []
        for actor_id, type_id in self.actor_types.items():
            if actor_id == self.ego.id: continue
            actor = snapshot.find(actor_id)
            if actor is None: continue
            native_transform = actor.get_transform()
            location = native_transform.location
            distance = location.distance(position)
            if distance > self.radius: continue
            velocity = actor.get_velocity(); rotation = native_transform.rotation
            state = ActorState(snapshot.frame, timestamp, actor_id, type_id,
                Transform((location.x, location.y, location.z),
                          RotationRad(*(math.radians(v) for v in (rotation.roll, rotation.pitch, rotation.yaw))), CARLA_WORLD),
                (velocity.x, velocity.y, velocity.z))
            category = 'VEHICLE' if type_id.startswith('vehicle.') else 'WALKER' if type_id.startswith('walker.') else 'TRAFFIC LIGHT' if 'traffic_light' in type_id else 'OTHER'
            relative = [sum(inverse[i][j]*v for j, v in enumerate((location.x, location.y, location.z, 1.))) for i in range(3)]
            objects.append(GroundTruthObject(state, distance))
            rows.append({'actor_id': actor_id, 'type': type_id, 'category': category,
                         'distance_m': distance, 'relative_position_m': relative,
                         'bounding_box':self.actor_bounds.get(actor_id),'yaw_deg':rotation.yaw,
                         'velocity_mps': [velocity.x, velocity.y, velocity.z]})
        paired = sorted(zip(objects, rows), key=lambda p: p[0].distance_m)[:256]
        objects = tuple(p[0] for p in paired); rows = [p[1] for p in paired]
        light = self.ego.get_traffic_light() if self.ego.is_at_traffic_light() else None
        relevant = {'relevant': light is not None}
        if light is not None:
            light_snapshot = snapshot.find(light.id)
            relevant.update(actor_id=light.id, state=str(light.get_state()),
                            distance_to_actor_origin_m=light_snapshot.get_transform().location.distance(position) if light_snapshot else None)
        self.latest = {'frame_id': snapshot.frame, 'timestamp_s': timestamp, 'radius_m': self.radius,
                       'source': 'SIMULATOR_GROUND_TRUTH', 'actors': rows, 'traffic_light': relevant}
        return SimulatorGroundTruth(snapshot.frame, timestamp, objects)
