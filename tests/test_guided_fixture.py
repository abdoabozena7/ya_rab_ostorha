import copy
import math
import unittest
from types import SimpleNamespace as NS
from unittest.mock import Mock
from backend.carla.benchmark_fixture import BenchmarkFixture
from backend.carla.dense_chaos import DenseChaos


class Location:
    def __init__(self,x=0,y=0,z=0):self.x,self.y,self.z=x,y,z
    def distance(self,other):return math.dist((self.x,self.y,self.z),(other.x,other.y,other.z))


class GuidedFixtureTests(unittest.TestCase):
    def test_rebuild_binds_stable_roles_to_new_native_ids_and_restores_exact_poses(self):
        actors={};spawned=[]
        bp=NS(has_attribute=lambda _:True,set_attribute=Mock())
        def spawn(blueprint,transform):
            actor=NS(id=100+len(spawned),set_simulate_physics=Mock(),set_transform=Mock())
            actors[actor.id]=actor;spawned.append((actor,transform));return actor
        world=NS(get_blueprint_library=lambda:NS(find=lambda _:bp),try_spawn_actor=spawn,
            spawn_actor=lambda *a,**k:NS(id=199),get_actors=lambda:NS(filter=lambda _:[]))
        pop=NS(vehicles=set(),walkers={},driver_profiles={},frame_id=2,config={'seed':1},
            clear_pedestrians=Mock(),clear_traffic=Mock())
        api=NS(Location=Location,Rotation=lambda **k:NS(**k),Transform=lambda location=None,rotation=None:NS(location=location,rotation=rotation))
        fixture=BenchmarkFixture(NS(world=NS(world=world),population=pop,connection=NS(api=api)),reconstructable=True)
        fixture.actors=[{'id':1,'role':'vehicle_0','blueprint':'vehicle.test','attributes':{'color':'red'},
            'pose':{'location':[2.,3.,.01],'rotation':[0.,90.,0.]},'profile':{'ordinal':0}},
            {'id':2,'role':'walker_0','blueprint':'walker.test','attributes':{},
            'pose':{'location':[4.,5.,1.],'rotation':[0.,0.,0.]},'speed_mps':1.2}]
        fixture.condition={'id':'saved-description','population':{'seed':1},'actors':copy.deepcopy(fixture.actors)}
        fixture.rebuild()
        self.assertEqual([r['role'] for r in fixture.actors],['vehicle_0','walker_0'])
        self.assertEqual([r['id'] for r in fixture.actors],[100,101])
        self.assertEqual(pop.vehicles,{100});self.assertEqual(pop.walkers[101]['controller_id'],199)
        self.assertAlmostEqual(spawned[0][1].location.z,.41)
        restored=spawned[0][0].set_transform.call_args.args[0]
        self.assertEqual(restored.location.z,.01);self.assertEqual(restored.rotation.yaw,90.)
        self.assertEqual(fixture.condition['id'],'saved-description')

    def audit_provider(self,near=True):
        shift=0.
        origin=Location();pose=NS(location=origin,get_forward_vector=lambda:NS(x=1,y=0),get_right_vector=lambda:NS(x=0,y=1))
        ids=set(range(1,41));walkers={i:{} for i in range(41,91)}
        def make(frame,shift):
            rows={0:NS(get_transform=lambda:pose)}
            for i in ids|set(walkers):
                loc=Location(25+shift+i*.1 if near else 500+i,1.)
                rows[i]=NS(id=i,get_transform=lambda loc=loc:NS(location=loc),get_velocity=lambda:NS(x=1. if shift else 0.,y=0.))
            return NS(frame=frame,timestamp=NS(elapsed_seconds=frame*.05),find=rows.get)
        p=NS(ego=NS(actor=NS(id=0)),population=NS(vehicles=ids,walkers=walkers),world=NS(world=NS()))
        return p,make

    def test_dense_audit_requires_near_front_motion_not_global_totals(self):
        p,make=self.audit_provider();stress=DenseChaos(p,12)
        a=stress.audit(make(1,0));self.assertFalse(a['passed']);self.assertTrue(a['pending'])
        b=stress.audit(make(21,1));self.assertTrue(b['passed'])
        self.assertEqual(b['counts']['pedestrians']['moving_front_frustum'],50)
        stopped=stress.audit(make(42,1))
        self.assertEqual(stopped['counts']['vehicles']['moving_near'],0)
        p,make=self.audit_provider(near=False);stress=DenseChaos(p,12)
        stress.audit(make(1,0));c=stress.audit(make(200,1))
        self.assertEqual(c['counts']['vehicles']['total'],40);self.assertFalse(c['passed']);self.assertFalse(c['pending'])

    def test_dense_shortfall_is_reported_as_shortfall(self):
        p,make=self.audit_provider();p.population.vehicles=set(range(1,25));stress=DenseChaos(p,12)
        stress.audit(make(1,0));result=stress.audit(make(21,1))
        self.assertEqual(result['counts']['vehicles']['total'],24)
        self.assertEqual(result['requested']['vehicles'],40);self.assertFalse(result['passed'])

    def test_rebinding_native_ids_resets_motion_measurement_for_the_other_arm(self):
        p,make=self.audit_provider();stress=DenseChaos(p,12)
        stress.audit(make(1,0));self.assertTrue(stress.audit(make(21,1))['passed'])
        stress.bind([{'role':'vehicle_0','id':200}])
        self.assertEqual(stress.samples,{});self.assertEqual(stress.moved,set())
        self.assertIsNone(stress.latest_audit);self.assertIsNone(stress.audit_started)
        self.assertFalse(stress.audit(make(30,0))['motion_passed'])

    def test_later_density_recovery_does_not_erase_a_stress_failure(self):
        p,_=self.audit_provider();stress=DenseChaos(p,12);stress.running=True
        measured={'density_passed':False,'motion_passed':True,'motion_measurement_ready':True}
        stress.audit=lambda _:dict(measured)
        stress.after_tick(NS(timestamp=NS(elapsed_seconds=1.)))
        measured['density_passed']=True
        stress.after_tick(NS(timestamp=NS(elapsed_seconds=2.)))
        self.assertEqual(stress.latest_audit['series']['density_failures'],1)
        self.assertFalse(stress.latest_audit['sustained_passed'])
