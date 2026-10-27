"""Numerical equivalence to the scalar sensor-registration algorithm."""
import unittest
import numpy as np
from backend.core.surface_registration import register_surfaces, register_surfaces_reference


def scalar_reference(cloud,old,prior,center,enhanced):
    candidates=[]
    for seed in ([prior,center] if enhanced else [prior]):
        trial=seed.copy();count=0
        for _ in range(3 if enhanced else 2):
            delta=cloud[:,None,:]-(old+trial)[None,:,:]
            nearest=np.argmin(np.sum(delta**2,axis=2),axis=1)
            residual=delta[np.arange(len(cloud)),nearest];norm=np.linalg.norm(residual,axis=1)
            cutoff=max(.12,min(.65,float(np.quantile(norm,.7)))) if enhanced and len(norm)>=6 else .65
            inliers=residual[norm<=cutoff]
            if len(inliers)<3:break
            count=len(inliers);trial+=np.median(inliers,axis=0)
        if count>=3:
            distance=np.linalg.norm(cloud[:,None,:]-(old+trial)[None,:,:],axis=2).min(axis=1)
            candidates.append((np.median(distance)+.01*np.linalg.norm(trial-prior),trial))
    return min(candidates,key=lambda row:row[0])[1] if candidates else prior


class SurfaceRegistrationTests(unittest.TestCase):
    def test_history_sampling_preserves_values_and_rejects_ragged_records(self):
        from collections import deque
        from backend.core.prediction import MotionTracker
        values=np.arange(500,dtype=float).reshape(100,5)
        values[:,0]=np.arange(100)*.05
        now=float(values[-1,0])
        times=now-np.arange(8,-1,-1)*.5
        times=times[(times>=values[0,0])&(times<=values[-1,0])]
        expected=np.column_stack((times,*[np.interp(times,values[:,0],values[:,i]) for i in range(1,5)])).tolist()
        for history in (values.tolist(),deque(map(tuple,values),maxlen=100)):
            self.assertEqual(MotionTracker.sample_history(history,now),expected)
        with self.assertRaises(ValueError):
            MotionTracker.sample_history([(0.,1.,2.,3.),(.05,1.,2.,3.,4.,5.)],.05)

    def test_compiled_registration_is_exact_for_ties_and_ragged_measured_clouds(self):
        rng=np.random.default_rng(2707)
        for enhanced in (False,True):
            for sizes in ((1,2,3,4,5,6),(12,24,48),(64,64,64)):
                previous=[np.round(rng.normal(size=(n,2)),2) for n in sizes]
                current=[p+rng.normal(0,.2,p.shape) for p in previous]
                prior=rng.normal(0,.1,(len(sizes),2));centers=rng.normal(0,.2,(len(sizes),2))
                expected=register_surfaces_reference(current,previous,prior,centers,enhanced=enhanced)
                actual=register_surfaces(current,previous,prior,centers,enhanced=enhanced)
                np.testing.assert_array_equal(actual,expected)

    def test_compiled_registration_rejects_malformed_measured_inputs(self):
        for current,previous,prior,centers in (
                ([np.ones((3,3))],[np.ones((3,2))],[[0.,0.]],[[0.,0.]]),
                ([np.empty((0,2))],[np.ones((3,2))],[[0.,0.]],[[0.,0.]]),
                ([np.full((3,2),np.nan)],[np.ones((3,2))],[[0.,0.]],[[0.,0.]]),
                ([np.ones((3,2))],[],[[0.,0.]],[[0.,0.]])):
            with self.assertRaises(ValueError):
                register_surfaces(current,previous,prior,centers,enhanced=True)

    def test_batch_preserves_scalar_results_for_changed_visibility_fast_motion_and_padding(self):
        rng=np.random.default_rng(442)
        previous=[rng.normal(size=(int(rng.integers(4,25)),2)) for _ in range(40)]
        displacement=rng.uniform(-1.4,1.4,(40,2));prior=rng.uniform(-.1,.1,(40,2))
        current=[old[rng.permutation(len(old))[:max(3,len(old)-3)]]+shift+rng.normal(0,.01,(max(3,len(old)-3),2))
                 for old,shift in zip(previous,displacement)]
        for enhanced in (False,True):
            expected=np.array([scalar_reference(c,p,v,d,enhanced) for c,p,v,d in zip(current,previous,prior,displacement)])
            actual=register_surfaces(current,previous,prior,displacement,enhanced=enhanced)
            np.testing.assert_allclose(actual,expected,atol=1e-10)

    def test_no_inlier_keeps_the_prior_and_empty_batch_is_supported(self):
        old=np.array([[0.,0.],[.1,0.],[0.,.1]])
        result=register_surfaces([old+20.],[old],[[.1,0.]],[[0.,0.]],enhanced=True)
        np.testing.assert_allclose(result,[[.1,0.]])
        self.assertEqual(register_surfaces([],[],[],[],enhanced=True).shape,(0,2))


if __name__=='__main__':unittest.main()
