import copy
from dataclasses import replace
from types import SimpleNamespace as NS
from unittest import TestCase
import numpy as np
from backend.core.pedestrian_anticipation import crossing_forecast,cautious_roadside_approach,cautious_roadside_speed
from backend.core.kinematic_prediction import kinematic_modes
from backend.core.motion_geometry import VehicleGeometry
from tests.test_normal_navigation import command


class PedestrianAnticipationTests(TestCase):
    def test_cautious_speed_checks_all_crossing_modes_instead_of_a_fixed_walking_override(self):
        prediction,observation=self.case();track=prediction['tracks'][0];observation.ego.speed_mps=0.
        base=replace(command(.9),steering=0.);geometry=VehicleGeometry()
        conditions={'road_range':25.,'distance':35.,'envelope':3.,'hazard':False,'conflict':None}
        def prepare(position,velocity=(0.,0.)):
            track.update(position_m=position,velocity_mps=list(velocity),
                history=[[1.3,*position,0.,0.],[1.7,*position,0.,0.],[2.1,*position,0.,0.]])
            prediction['trajectories']=kinematic_modes([track])
            return crossing_forecast(prediction,observation,base,geometry,cap_mps=120/3.6)
        for position,expected in (([17.,-6.9],4.),([14.,6.1],4.),([7.3,3.25],4.),([6.45,3.75],3.)):
            forecast=prepare(position);self.assertIsNotNone(forecast)
            selected=cautious_roadside_speed(prediction,forecast,observation,base,geometry,**conditions)
            self.assertEqual(selected,expected)
            response=.35+selected/5.+.1
            self.assertIsNone(crossing_forecast(prediction,observation,base,geometry,cap_mps=selected,
                stationary_response=(track['id'],response)))
        forecast=prepare([14.,3.25],(0.,-.5))
        selected=cautious_roadside_speed(prediction,forecast,observation,base,geometry,**conditions)
        self.assertIsNotNone(selected)
        self.assertIsNone(crossing_forecast(prediction,observation,base,geometry,cap_mps=selected))
        forecast=prepare([14.,6.1]);conditions['hazard']=True
        self.assertIsNone(cautious_roadside_speed(prediction,forecast,observation,base,geometry,**conditions))

    def test_stationary_curbside_response_keeps_other_moving_crossings_and_immediate_intent(self):
        prediction,observation=self.case();observation.ego.speed_mps=0.
        track=prediction['tracks'][0];track.update(position_m=[6.45,3.75],
            history=[[1.3,6.45,3.75],[1.7,6.45,3.75],[2.1,6.45,3.75]])
        prediction['trajectories']=kinematic_modes([track]);base=replace(command(.9),steering=0.)
        geometry=VehicleGeometry();forecast=crossing_forecast(prediction,observation,base,geometry)
        conditions=dict(road_range=25.,distance=35.,envelope=3.,hazard=False,conflict=None)
        self.assertIsNotNone(cautious_roadside_speed(prediction,forecast,observation,base,geometry,**conditions))
        other=copy.deepcopy(track);other.update(id='actual-moving-crossing',position_m=[3.,-2.5],velocity_mps=[0.,1.])
        prediction['tracks'].append(other);prediction['trajectories']=kinematic_modes(prediction['tracks'])
        self.assertIsNone(cautious_roadside_speed(prediction,forecast,observation,base,geometry,**conditions))
        prediction['tracks']=[track];track.update(position_m=[3.,2.1],
            history=[[1.3,3.,2.1],[1.7,3.,2.1],[2.1,3.,2.1]])
        prediction['trajectories']=kinematic_modes([track])
        forecast=crossing_forecast(prediction,observation,base,geometry)
        self.assertIsNone(cautious_roadside_speed(prediction,forecast,observation,base,geometry,**conditions))

    def test_capped_progress_never_overrides_a_current_intersection_or_stale_forecast(self):
        prediction,observation=self.case();track=prediction['tracks'][0];observation.ego.speed_mps=0.
        base=replace(command(.9),steering=0.);geometry=VehicleGeometry()
        track.update(position_m=[3.,-1.],velocity_mps=[0.,1.],uncertainty_m=.4)
        prediction['trajectories']=kinematic_modes([track])
        forecast=crossing_forecast(prediction,observation,base,geometry)
        self.assertIsNotNone(forecast)
        conditions={'road_range':25.,'distance':None,'envelope':3.,'hazard':False,'conflict':None}
        self.assertIsNone(cautious_roadside_speed(prediction,forecast,observation,base,geometry,**conditions))
        track.update(position_m=[20.,3.],velocity_mps=[0.,-1.])
        prediction['trajectories']=kinematic_modes([track])
        forecast=crossing_forecast(prediction,observation,base,geometry)
        self.assertIsNotNone(cautious_roadside_speed(prediction,forecast,observation,base,geometry,**conditions))
        forecast['measurement_frame']-=1
        self.assertIsNone(cautious_roadside_speed(prediction,forecast,observation,base,geometry,**conditions))

    def test_current_moving_depth_body_survives_a_classification_gap_and_intermediate_launch_is_checked(self):
        from unittest.mock import patch
        prediction,observation=self.case();track=prediction['tracks'][0]
        observation.ego.speed_mps=0.
        track.update(**{'class':'UNKNOWN','position_m':[17.,-6.9],'velocity_mps':[0.,2.],
            'motion_observations':5,'measurement_evidence':{'session_id':'s','frame_id':42,'timestamp_s':2.1,
                'source':'CURRENT_DEPTH_BODY_CORE','support_points':20,'mad_m':.02,'motion_span_s':.25}})
        track.pop('semantic_evidence');prediction['trajectories']=kinematic_modes([track])
        base=replace(command(.9),steering=0.)
        self.assertIsNone(crossing_forecast(prediction,observation,base,VehicleGeometry()))
        def assess():return crossing_forecast(prediction,observation,base,VehicleGeometry(),allow_measured_unknown=True,cap_mps=120/3.6)
        result=assess();self.assertIsNotNone(result);self.assertEqual(result['object_class'],'UNKNOWN')
        self.assertEqual(result['source'],'CONSTANT_VELOCITY')
        self.assertIn(result['ego_acceleration_mps2'],(4.,6.))
        with patch('backend.core.pedestrian_anticipation.DRIVE_ACCELERATIONS',(2.,)):self.assertIsNone(assess())
        with patch('backend.core.pedestrian_anticipation.DRIVE_ACCELERATIONS',(8.,)):self.assertIsNone(assess())
        saved=copy.deepcopy(track)
        for changes in ({'motion_observations':1},{'velocity_mps':[0.,0.]},
                {'measurement_evidence':{**track['measurement_evidence'],'frame_id':41}},
                {'measurement_evidence':{**track['measurement_evidence'],'support_points':0}}):
            track.update(changes);prediction['trajectories']=kinematic_modes([track])
            self.assertIsNone(assess(),changes);track.clear();track.update(copy.deepcopy(saved))

    def test_cautious_progress_requires_stationary_outside_lane_evidence_and_clear_stopping_space(self):
        prediction,observation=self.case();track=prediction['tracks'][0]
        track.update(position_m=[7.3,3.25],history=[[1.3,7.3,3.25,0.,0.],[1.7,7.3,3.25,0.,0.],[2.1,7.3,3.25,0.,0.]])
        observation.ego.speed_mps=0.
        forecast={'track_id':track['id'],'source':'PEDESTRIAN_POSSIBLE_START'}
        parameters={'road_range':12.,'distance':35.,'envelope':3.,'hazard':False,'conflict':None}
        allowed=lambda p=parameters:cautious_roadside_approach(prediction,forecast,observation,VehicleGeometry(),**p)
        self.assertTrue(allowed())
        for changes in ({'road_range':4.},{'distance':4.},{'hazard':True},{'conflict':{'source':'MEASURED_MOTION'}}):
            self.assertFalse(allowed({**parameters,**changes}))
        original=copy.deepcopy(track)
        for change in ({'position_m':[7.3,1.]},{'velocity_mps':[0.,-.3]},{'occlusion_s':.2},
                {'history':[[1.8,7.3,3.25],[2.1,7.3,3.25]]}):
            track.update(change);self.assertFalse(allowed());track.clear();track.update(copy.deepcopy(original))
        observation.ego.speed_mps=2.;self.assertFalse(allowed())

    def test_sub_resolution_depth_jitter_does_not_turn_a_stationary_hypothesis_into_an_infinite_hold(self):
        prediction,observation=self.case();track=prediction['tracks'][0];observation.ego.speed_mps=0.
        track.update(position_m=[7.3,3.25],velocity_mps=[0.,.25],uncertainty_m=.3,
            history=[[1.3,7.5,3.25,0.,0.],[1.7,7.3,3.25,0.,0.],[2.1,7.3,3.25,0.,0.]])
        forecast={'track_id':track['id'],'source':'PEDESTRIAN_POSSIBLE_START'}
        def check():return cautious_roadside_approach(prediction,forecast,observation,VehicleGeometry(),
            road_range=12.,distance=35.,envelope=3.,hazard=False,conflict=None)
        self.assertTrue(check());track['velocity_mps']=[0.,-.3];self.assertFalse(check())

    def case(self):
        track={'id':'person-track','confirmed':True,'occlusion_s':0.,'class':'person',
            'position_m':[20.,3.],'velocity_mps':[0.,0.],'half_size_m':[.35,.35],'uncertainty_m':.1,
            'semantic_evidence':{'session_id':'s','confidence':.9,'source_sensor':'frontCamera','timestamp_s':2.,'depth_evidence':{'frame_id':40,'axial_m':18.5}},
            'measurement_evidence':{'session_id':'s','frame_id':42}}
        prediction={'session_id':'s','source':'CONTROL_SENSOR_PIPELINE','motion_tracking_complete':True,
            'evaluation_frame':42,'timestamp_s':2.1,'tracks':[track],'trajectories':kinematic_modes([track])}
        observation=NS(frame_id=42,timestamp_s=2.1,ego=NS(speed_mps=10.))
        return prediction,observation

    def test_waiting_person_is_anticipated_before_measured_lateral_motion(self):
        prediction,observation=self.case()
        result=crossing_forecast(prediction,observation,replace(command(.75),steering=0.),VehicleGeometry())
        self.assertIsNotNone(result)
        self.assertIn(result['source'],('PEDESTRIAN_POSSIBLE_START','PEDESTRIAN_POSSIBLE_RUN'))
        self.assertEqual(result['certainty'],'POSSIBLE_CROSSING_NOT_KNOWN_INTENT')

    def test_visible_waiting_person_can_start_a_bounded_run_before_entering_the_lane(self):
        prediction,observation=self.case();track=prediction['tracks'][0]
        track['position_m']=[20.,4.6];observation.ego.speed_mps=13.9
        prediction['trajectories']=kinematic_modes([track])
        result=crossing_forecast(prediction,observation,replace(command(.75),steering=0.),VehicleGeometry())
        self.assertIsNotNone(result);self.assertEqual(result['source'],'PEDESTRIAN_POSSIBLE_RUN')
        running=np.array(next(m['points'] for m in prediction['trajectories'] if m['source']=='PEDESTRIAN_POSSIBLE_RUN'))
        velocities=np.diff(running[:,2])/np.diff(running[:,0])
        self.assertLessEqual(np.max(abs(velocities)),3.5+1e-6)
        self.assertLessEqual(np.max(abs(np.diff(velocities)))/.1,6.+1e-6)
        prediction['trajectories']=[m for m in prediction['trajectories'] if m['source']!='PEDESTRIAN_POSSIBLE_RUN']
        self.assertIsNone(crossing_forecast(prediction,observation,replace(command(.75),steering=0.),VehicleGeometry()))

    def test_stale_future_foreign_unclassified_and_rear_tracks_do_not_invent_intent(self):
        for change in ({'class':'UNKNOWN'},{'confirmed':False},{'occlusion_s':.2},
                {'position_m':[-10.,3.]},{'half_size_m':[3.,2.]},
                {'semantic_evidence':{'session_id':'other'}},
                {'semantic_evidence':{'session_id':'s','confidence':.9,'source_sensor':'frontCamera','timestamp_s':1.}},
                {'semantic_evidence':{'session_id':'s','confidence':.9,'source_sensor':'frontCamera','timestamp_s':3.}}):
            prediction,observation=self.case();prediction['tracks'][0].update(change)
            self.assertIsNone(crossing_forecast(prediction,observation,command(.75),VehicleGeometry()),change)
        prediction,observation=self.case();prediction['evaluation_frame']=41
        self.assertIsNone(crossing_forecast(prediction,observation,replace(command(.75),steering=0.),VehicleGeometry()))

    def test_same_waiting_person_outside_the_reachable_corridor_does_not_force_a_stop(self):
        prediction,observation=self.case();track=prediction['tracks'][0];track['position_m']=[20.,12.]
        prediction['trajectories']=kinematic_modes([track])
        self.assertIsNone(crossing_forecast(prediction,observation,replace(command(.75),steering=0.),VehicleGeometry()))

    def test_observed_cleared_crossing_does_not_repeat_unknown_start_but_actual_return_still_brakes(self):
        prediction,observation=self.case();track=prediction['tracks'][0]
        track['observed_crossing_cleared']=True
        self.assertIsNone(crossing_forecast(prediction,observation,replace(command(.75),steering=0.),VehicleGeometry()))
        track.update(position_m=[12.,3.],velocity_mps=[0.,-2.])
        prediction['trajectories']=kinematic_modes([track])
        self.assertIsNotNone(crossing_forecast(prediction,observation,replace(command(.75),steering=0.),VehicleGeometry()))
