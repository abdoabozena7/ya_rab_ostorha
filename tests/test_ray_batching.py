"""Equal measured occupancy and coverage across memory-bounded ray batches."""
import unittest
import numpy as np
from backend.core.maneuver import ObservedSpace
from backend.core.motion_geometry import VehicleGeometry


class UnbatchedSpace(ObservedSpace):
    _observe = ObservedSpace._observe_reference
    def _mark_free_rays(self,xyz,delta,near,far,origin,count):
        fractions=near[:,None]+(far-near)[:,None]*np.linspace(0.,.999,count)[None,:]
        sample=origin[:2]+delta[:,None,:]*fractions[:,:,None]
        height=origin[2]+(xyz[:,2,None]-origin[2])*fractions
        height-=sample[:,:,0]*self.ground_plane[0]+sample[:,:,1]*self.ground_plane[1]+self.ground_plane[2]
        idx=self.indices(sample[(height>=.25)&(height<=1.5)])
        self.free[idx[:,0],idx[:,1]]=True


class RayBatchingTests(unittest.TestCase):
    def test_batched_rays_preserve_all_free_occupied_unknown_cells_and_coverage(self):
        rng=np.random.default_rng(1701);g=VehicleGeometry()
        cloud=rng.uniform([-75.,-40.,-.2],[75.,40.,2.5],(2500,3))
        ground=np.array([[x,y,.015*x]for x in np.arange(3.,40.,.4)for y in np.arange(-2.,2.,.25)])
        depth=np.vstack((cloud,ground));lidar=depth[::4]
        for scope in (6.,35.,75.):
            with self.subTest(scope=scope):
                args=dict(measured_surfaces=[(depth,np.array([1.6,0.,1.6]))],scope_m=scope,limit_m=85.)
                a=ObservedSpace(lidar,g,**args);b=UnbatchedSpace(lidar,g,**args)
                np.testing.assert_array_equal(a.free,b.free)
                np.testing.assert_array_equal(a.occupied,b.occupied)
                np.testing.assert_array_equal(a.measured_free,b.measured_free)
                path=np.column_stack((np.arange(80)*.1,np.arange(80)*.5,np.zeros((80,2))))
                self.assertEqual(a.continuous_coverage(path),b.continuous_coverage(path))
                self.assertEqual(a.certificate(path),b.certificate(path))
