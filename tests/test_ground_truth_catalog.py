import math
from types import SimpleNamespace
import unittest
from unittest.mock import Mock
from backend.carla.ground_truth import NearbyActorInspector


def actor_sample(actor_id,position):
    location=SimpleNamespace(x=position,y=0.,z=0.)
    location.distance=lambda other:math.dist((location.x,location.y,location.z),(other.x,other.y,other.z))
    transform=SimpleNamespace(location=location,rotation=SimpleNamespace(roll=0.,pitch=0.,yaw=0.),
        get_inverse_matrix=lambda:[[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]])
    return SimpleNamespace(id=actor_id,get_transform=lambda:transform,
        get_velocity=lambda:SimpleNamespace(x=0.,y=0.,z=0.))


class Snapshot:
    def __init__(self,frame,samples):
        self.frame=frame;self.timestamp=SimpleNamespace(elapsed_seconds=frame*.05)
        self.samples={sample.id:sample for sample in samples}
    def __iter__(self):return iter(self.samples.values())
    def find(self,actor_id):return self.samples.get(actor_id)


class GroundTruthCatalogTests(unittest.TestCase):
    def test_stable_membership_reuses_metadata_but_preserves_current_snapshot_poses(self):
        ego=Mock(id=1);ego.is_at_traffic_light.return_value=False
        actor=SimpleNamespace(id=2,type_id='vehicle.test')
        world=Mock();world.get_actors.return_value=[actor]
        inspector=NearbyActorInspector(world,ego)
        first=inspector.observe(Snapshot(1,[actor_sample(1,0),actor_sample(2,10)]))
        later=inspector.observe(Snapshot(100,[actor_sample(1,0),actor_sample(2,20)]))
        world.get_actors.assert_called_once()
        self.assertEqual(first.objects[0].actor.transform.position_m[0],10.)
        self.assertEqual(later.objects[0].actor.transform.position_m[0],20.)
        self.assertEqual(later.frame_id,100)
        world.get_actors.return_value=[]
        removed=inspector.observe(Snapshot(101,[actor_sample(1,0)]))
        self.assertEqual(world.get_actors.call_count,2)
        self.assertFalse(removed.objects)
