from types import SimpleNamespace as NS
from unittest import TestCase
import numpy as np
from backend.carla.onboard_geometry import geometry_for
from backend.core.path_conflicts import surfaces


class OnboardGeometryTests(TestCase):
    def actor(self,blueprint='vehicle.mercedes.coupe_2020',width=.9059):
        return NS(type_id=blueprint,bounding_box=NS(extent=NS(x=2.33,y=width),location=NS(x=0.,y=0.)),
            get_physics_control=lambda:NS(wheels=[NS(position=NS(x=x),max_steer_angle=70.) for x in (-140.,140.)]))

    def test_mirror_envelope_enlarges_both_clearance_footprint_and_self_surface_mask(self):
        g=geometry_for(self.actor());self.assertEqual(g.half_width_m,1.01)
        self.assertEqual(g.half[1],1.01)
        points=np.array([[.46,y,z] for y in (-.972,.972) for z in (1.03,1.07,1.10)])
        self.assertEqual(surfaces(points,geometry=g),[])
        outside=np.array([[.46,1.08,z] for z in (1.03,1.07,1.10)])
        self.assertTrue(surfaces(outside,geometry=g))

    def test_native_width_is_never_reduced_and_other_models_keep_their_dimensions(self):
        self.assertEqual(geometry_for(self.actor(width=1.2)).half_width_m,1.2)
        self.assertEqual(geometry_for(self.actor('vehicle.lincoln.mkz_2020',.918)).half_width_m,.918)
