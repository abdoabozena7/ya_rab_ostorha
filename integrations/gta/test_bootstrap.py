"""Candidate evidence, genuine ordered samples and runtime grant negative controls."""
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
import bootstrap as gate


class BootstrapTests(unittest.TestCase):
    def rows(self):
        return [{'stage':'FRAME','pid':123,'run_id':'test','frame':n,'game_ms':n*250} for n in (1,2,3)]

    def test_stale_pid(self):
        self.assertFalse(gate.samples_qualify(self.rows(),999,'test'))

    def test_stale_run(self):
        self.assertFalse(gate.samples_qualify(self.rows(),123,'another'))

    def test_frozen_frames(self):
        rows=self.rows(); rows[-1]['frame']=rows[-2]['frame']
        self.assertFalse(gate.samples_qualify(rows,123,'test'))

    def test_frozen_time(self):
        rows=self.rows(); rows[-1]['game_ms']=rows[-2]['game_ms']
        self.assertFalse(gate.samples_qualify(rows,123,'test'))

    def test_real_ordering_shape(self):
        self.assertTrue(gate.samples_qualify(self.rows(),123,'test'))
        self.assertFalse(gate.samples_qualify(self.rows()[:2],123,'test'))

    def test_support_list_excludes_changelog(self):
        text='Changelog: v3725.0/1013.20\nSupported enhanced game versions:\n1.0.1013.17/29/33/34, 1.0.1158.13\nNATIVE TRAINER'
        versions=gate.advertised_versions(text)
        self.assertIn('1.0.1013.29',versions); self.assertNotIn('1.0.1013.20',versions)

    def test_wrong_hash_refuses_candidate(self):
        with patch.object(gate,'digest',return_value='wrong'):
            with self.assertRaisesRegex(ValueError,'hash mismatch'):
                gate.inspect_candidate()

    def test_flagged_installation_stops_before_launch(self):
        observation={'ActiveProjectThreats':[{'ThreatName':'PUA:fixture'}]}
        with self.assertRaisesRegex(RuntimeError,'Windows protection flags'):
            gate.require_clean_security(observation)
        self.assertIsNone(gate.require_clean_security({'ActiveProjectThreats':[]}))

    def test_unfinished_reservation_remains_charged(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'ledger.json'; budget=gate.RuntimeBudget(path)
            budget.reserve('one'); resumed=gate.RuntimeBudget(path)
            self.assertEqual(resumed.state['charged_seconds'],600)
            for n in range(17):resumed.reserve(str(n))
            with self.assertRaisesRegex(ValueError,'Insufficient'):
                resumed.reserve('overflow')

    def test_no_duplicate_runtime_refund(self):
        with tempfile.TemporaryDirectory() as directory:
            budget=gate.RuntimeBudget(Path(directory)/'ledger.json')
            item=budget.reserve('one'); budget.finish(item,12.5)
            self.assertEqual(budget.state['charged_seconds'],12.5)
            with self.assertRaises(ValueError):budget.finish(item,0.)


if __name__=='__main__':unittest.main()
