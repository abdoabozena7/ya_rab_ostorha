import unittest
import numpy as np
from backend.core.display_prediction import local_modes,measured_control_view,DisplayPredictionService


class DisplayPredictionTests(unittest.TestCase):
    def test_ordinary_driving_keeps_measured_tracks_without_hypothetical_scoring(self):
        from unittest.mock import patch
        from backend.core.display_prediction import score_display_prediction
        tracks=[{'id':'1','class':'UNKNOWN','position_m':[8.,2.]}]
        measured=[{'track_id':'1','points':[[0.,8.,2.],[1.,8.,2.]]}]
        prediction={'tracks':tracks,'control_trajectories':measured,'trajectories':measured}
        with patch('backend.core.display_prediction.ego_paths',side_effect=AssertionError('Expensive scoring')):
            score_display_prediction(prediction,None,None,deferred=True)
        self.assertIs(prediction['tracks'],tracks)
        self.assertIs(prediction['trajectories'],measured)
        self.assertTrue(prediction['diagnostic_scoring_deferred'])
        self.assertEqual(prediction['object_assessments'],[])
        self.assertEqual(prediction['conflicts'],[])
        self.assertIsNone(prediction['conflict_point'])

    def test_odometry_hypotheses_transform_and_advance_to_display_time(self):
        mode={'track_id':'1','points':[[0.,10.,20.],[1.,12.,20.],[3.,16.,20.]]}
        p={'odometry_origin_m':[10.,20.],'odometry_yaw_rad':np.pi/2,'timestamp_s':10.5}
        result=local_modes([mode],p,10.)[0]['points']
        np.testing.assert_allclose(result,[[0.,0.,-1.],[.5,0.,-2.],[2.5,0.,-6.]],atol=1e-8)

    def test_expired_and_invalid_hypotheses_are_not_displayed(self):
        p={'odometry_origin_m':[0.,0.],'odometry_yaw_rad':0.,'timestamp_s':14.}
        self.assertEqual(local_modes([{'points':[[0.,1.,1.],[3.,2.,2.]]}],p,10.),[])
        with self.assertRaises(ValueError):local_modes([{'points':[[0.,float('nan'),1.]]}],p)

    def test_light_display_view_preserves_measurement_age_and_does_not_mutate_control_forecasts(self):
        from types import SimpleNamespace as NS
        from backend.core.contracts import freeze_json,to_dict
        prediction=freeze_json({'tracks':[{'id':'1','confirmed':True,'class':'UNKNOWN','position_m':[10.,2.],
            'half_size_m':[2.,1.],'velocity_mps':[0.,0.],'history':[[0.,10.,2.,0.,0.]]}],
            'control_trajectories':[{'track_id':'1','points':[[0.,10.,2.],[3.,10.,2.]]}]})
        scene=NS(session_id='s',observation=NS(frame_id=42,timestamp_s=2.),prediction=prediction)
        original=to_dict(prediction);reference={'frame':42}
        view=measured_control_view(scene,reference)
        self.assertEqual(view['timestamp_s'],2.);self.assertEqual(view['evaluation_frame'],42)
        self.assertTrue(view['display_observer_deferred']);self.assertEqual(view['trajectories'],[])
        observer=DisplayPredictionService.__new__(DisplayPredictionService)
        observer.latest=view;observer.error=None
        self.assertEqual(observer.snapshot()['status'],'RUNNING')
        view['tracks'][0]['position_m'][0]=99.;view['render_reference']['frame']=50
        self.assertEqual(to_dict(prediction),original);self.assertEqual(reference['frame'],42)
