"""Optimized reductions retain the existing registration decisions and evidence."""
from unittest import TestCase
from unittest.mock import patch
import numpy as np
from backend.core.surface_registration import register_surfaces


class RegistrationReductionTests(TestCase):
    def test_ragged_clouds_and_both_seed_policies_match_original_nanmedian(self):
        rng=np.random.default_rng(20261018)
        for enhanced in (False,True):
            for sizes in ((3,4,5),(12,23,48),(64,64,64)):
                current=[rng.normal(size=(n,2)) for n in sizes]
                previous=[p+rng.normal(0,.08,size=p.shape) for p in current]
                prior=rng.normal(0,.05,size=(len(sizes),2))
                centers=np.array([a.mean(axis=0)-b.mean(axis=0) for a,b in zip(current,previous)])
                original=lambda values,valid:np.nanmedian(np.where(valid,values,np.nan),axis=2)
                with patch('backend.core.surface_registration._masked_median',original):
                    expected=register_surfaces(current,previous,prior,centers,enhanced=enhanced)
                actual=register_surfaces(current,previous,prior,centers,enhanced=enhanced)
                np.testing.assert_allclose(actual,expected,rtol=0,atol=1e-12)
