from dataclasses import replace
import unittest
import numpy as np
from backend.core.maneuver import ObservedSpace
from backend.core.motion_geometry import VehicleGeometry
from backend.core.control_scene import freeze_json
from backend.core.maneuver_candidates import CandidateGenerator
from backend.learning.rl.maneuver_observations import ManeuverObservationEncoder
from tests import test_control_scene


class SnapshotTests(unittest.TestCase):
    def test_manual_penalty_uses_applied_controls_instead_of_candidate_identity(self):
        from backend.learning.rl.maneuver_reward import driver_controls_changed
        desired={'throttle':.3,'brake':0.,'steering':.1,'gear':1,'reverse':False,'handbrake':False,
                 'source':'MANUAL','frame_id':5}
        applied={**desired,'source':'TRAINING','frame_id':6}
        self.assertFalse(driver_controls_changed(desired,applied))
        self.assertTrue(driver_controls_changed(desired,{**applied,'throttle':0.,'brake':1.}))

    def test_historical_motion_pass_cannot_qualify_changed_or_stale_control(self):
        from backend.learning.pilot_provenance import qualified_physical_report,control_hashes
        report={'ordinary_gate':True,'historical_ledgers_unchanged':True}
        self.assertFalse(qualified_physical_report(report))
        report['qualification']={'implementation_sha256':control_hashes(),'implementation_unchanged':True,
            'freshness_measurement':'AT_ACTION_REQUEST_FROM_ORIGINAL_SENSOR_RECEIPT','fresh_scene_fraction':.99}
        self.assertTrue(qualified_physical_report(report))
        report['qualification']['implementation_sha256']['backend/core/control_scene.py']='old build'
        self.assertFalse(qualified_physical_report(report))

    def test_motion_viability_is_distinct_from_full_acceptance(self):
        from backend.learning.pilot_provenance import qualified_motion_viability,qualified_physical_report,control_hashes
        report={'ordinary_gate':False,'historical_ledgers_unchanged':True,'qualification':{
            'implementation_sha256':control_hashes(),'implementation_unchanged':True,
            'freshness_measurement':'AT_ACTION_REQUEST_FROM_ORIGINAL_SENSOR_RECEIPT','fresh_scene_fraction':1.},
            'episodes':[{'outcome':'SUCCESS','scenario_validity':{'valid':True},'metrics':{
                'collisions':0,'native_distance_m':12.,'maximum_clear_path_stop_s':.6}}]}
        self.assertTrue(qualified_motion_viability(report));self.assertFalse(qualified_physical_report(report))
        report['episodes'][0]['metrics']['native_distance_m']=0.
        self.assertFalse(qualified_motion_viability(report))

    def test_exact_asymmetric_body_is_known_without_free_voxel_fringe(self):
        g=VehicleGeometry(front_m=2.278,rear_m=2.191,half_width_m=1.016)
        space=ObservedSpace(np.empty((0,3)),g)
        self.assertTrue(space.certificate(np.array([[0.,0.,0.,0.]]))['verified'])
        # A millimetre outside the measured body cannot inherit its known cell.
        self.assertFalse(space.certificate(np.array([[0.,0.,0.,0.],[.1,-.001,0.,0.]]))['verified'])
        self.assertFalse(space.certificate(np.array([[0.,0.,0.,0.],[.1,.001,0.,0.]]))['verified'])

    def test_condition_identity_preserves_schedules_and_ignores_allocated_ids(self):
        from backend.carla.pilot_world import condition_spec,identity
        from copy import deepcopy
        first={'scenario':'PEDESTRIAN_CROSSING','seed':10,'map':'Town10HD_Opt','spawn_index':54,
               'route':[[0,0,0],[20,0,0]],'native_route':[[0,0,0],[20,0,0]],
               'ego_initial':{'id':5,'position':[0,0,0]},'actors':[{'id':8,'position':[14,4,0]}],
               'events':[{'actor_id':8,'at_s':2.,'eligible':False,'realized':False,'start_position':None}],
               'population':{'requested':{'seed':10},'driver_profiles':{},
                             'walker_profiles':{'8':{'ready_at_s':102.,'wait_until_s':None}}}}
        second=deepcopy(first);second['ego_initial']['id']=105;second['actors'][0]['id']=108
        second['events'][0].update(actor_id=108,eligible=True,realized=True)
        second['population']['walker_profiles']={'108':{'ready_at_s':202.,'wait_until_s':None}}
        self.assertEqual(identity(condition_spec(first,100.)),identity(condition_spec(second,200.)))
        second['events'][0]['at_s']=3.
        self.assertNotEqual(identity(condition_spec(first,100.)),identity(condition_spec(second,200.)))

    def test_measured_sloping_ground_retains_a_real_low_curb(self):
        g=VehicleGeometry()
        ground=np.array([[x,y,.02*x+.03] for x in np.arange(-15.,15.,.25) for y in np.arange(-4.,4.,.25)])
        path=np.array([[0.,0.,0.,0.],[1.,2.,0.,0.]])
        space=ObservedSpace(ground,g)
        self.assertGreater(space.ground_support,100)
        self.assertTrue(space.certificate(path)['verified'])
        from backend.core.path_conflicts import surfaces
        self.assertEqual(surfaces(ground,geometry=g,ground_plane=space.ground_plane),[])
        curb=np.array([[4.,0.,.02*4.+.03+.17]])
        self.assertFalse(ObservedSpace(np.vstack((ground,curb)),g).certificate(path)['verified'])

    def test_actor_order_change_does_not_exchange_temporal_histories(self):
        measured,base,_=test_control_scene.ControlSceneTests().measured()
        road={'centerline':[[0.,0.],[50.,0.]],'junction_ahead':False,'lane_width_m':3.5}
        bundle=CandidateGenerator().build(measured,base,road,'MANUAL_PROTECTION',1.,wall_s=100.)
        def track(key,x):
            return {'id':key,'class':'UNKNOWN','position_m':[x,0.],'velocity_mps':[0.,0.],
                    'half_size_m':[1.,1.],'uncertainty_m':.2,'confirmed':True}
        encoder=ManeuverObservationEncoder()
        first=replace(measured,prediction=freeze_json({**measured.prediction,'tracks':[track(1,4.),track(2,5.)]}))
        encoder.append(first,bundle,base,road)
        next_scene,_,_=test_control_scene.ControlSceneTests().measured(frame=2)
        second=replace(next_scene,prediction=freeze_json({**next_scene.prediction,'tracks':[track(1,6.),track(2,3.)]}))
        observation=encoder.append(second,bundle,base,road)
        self.assertAlmostEqual(observation['history'][-2,8],5./50.)
        self.assertAlmostEqual(observation['history'][-1,8],3./50.)
        self.assertAlmostEqual(observation['history'][-2,20],4./50.)
        self.assertAlmostEqual(observation['history'][-1,20],6./50.)


if __name__=='__main__':unittest.main()
