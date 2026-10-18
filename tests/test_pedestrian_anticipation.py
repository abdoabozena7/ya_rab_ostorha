import copy
from dataclasses import replace
from types import SimpleNamespace as NS
from unittest import TestCase
from backend.core.pedestrian_anticipation import crossing_forecast
from backend.core.kinematic_prediction import kinematic_modes
from backend.core.motion_geometry import VehicleGeometry
from tests.test_normal_navigation import command


class PedestrianAnticipationTests(TestCase):
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
        self.assertEqual(result['source'],'PEDESTRIAN_POSSIBLE_START')
        self.assertEqual(result['certainty'],'POSSIBLE_CROSSING_NOT_KNOWN_INTENT')

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
