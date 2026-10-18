import unittest
import numpy as np
from backend.core.ground_geometry import measured_ground_plane
from backend.core.motion_geometry import VehicleGeometry


class GroundGeometryTests(unittest.TestCase):
    def test_sloped_ground_is_robust_to_foreground_and_reproducible(self):
        rng=np.random.default_rng(318)
        forward=rng.uniform(3.,19.,400);lateral=rng.uniform(-1.,1.,400)
        height=.015*forward-.025*lateral-.12+rng.normal(0.,.002,400)
        cloud=np.column_stack((forward,lateral,height))
        cloud[:50,2]=rng.uniform(.35,.55,50)
        plane,support=measured_ground_plane(cloud,VehicleGeometry())
        np.testing.assert_allclose(plane,[.015,-.025,-.12],atol=.002)
        self.assertGreater(support,300)
        repeated,count=measured_ground_plane(cloud,VehicleGeometry())
        np.testing.assert_array_equal(repeated,plane);self.assertEqual(count,support)

    def test_collinear_returns_never_certify_ground(self):
        cloud=np.column_stack((np.linspace(3,19,40),np.zeros(40),np.zeros(40)))
        plane,support=measured_ground_plane(cloud,VehicleGeometry())
        self.assertEqual(support,0);np.testing.assert_array_equal(plane,[0.,0.,0.])
