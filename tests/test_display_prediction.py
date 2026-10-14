import unittest
import numpy as np
from backend.core.display_prediction import local_modes


class DisplayPredictionTests(unittest.TestCase):
    def test_odometry_hypotheses_transform_and_advance_to_display_time(self):
        mode={'track_id':'1','points':[[0.,10.,20.],[1.,12.,20.],[3.,16.,20.]]}
        p={'odometry_origin_m':[10.,20.],'odometry_yaw_rad':np.pi/2,'timestamp_s':10.5}
        result=local_modes([mode],p,10.)[0]['points']
        np.testing.assert_allclose(result,[[0.,0.,-1.],[.5,0.,-2.],[2.5,0.,-6.]],atol=1e-8)

    def test_expired_and_invalid_hypotheses_are_not_displayed(self):
        p={'odometry_origin_m':[0.,0.],'odometry_yaw_rad':0.,'timestamp_s':14.}
        self.assertEqual(local_modes([{'points':[[0.,1.,1.],[3.,2.,2.]]}],p,10.),[])
        with self.assertRaises(ValueError):local_modes([{'points':[[0.,float('nan'),1.]]}],p)
