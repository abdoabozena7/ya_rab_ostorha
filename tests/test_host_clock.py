import unittest
from unittest.mock import patch
from backend.core import host_clock
from backend.core.contracts import freeze_json


class HostClockTests(unittest.TestCase):
    def test_submillisecond_elapsed_time_does_not_wait_for_a_windows_tick(self):
        with patch.object(host_clock.time,'perf_counter',side_effect=[100.,100.0001]):
            before=host_clock.monotonic();after=host_clock.monotonic()
        self.assertAlmostEqual(after-before,.0001,places=9)

    def test_numeric_forecast_rows_remain_shared_immutable_and_finite(self):
        row=[0.,1.,2.];frozen=freeze_json([row,row])
        self.assertIs(frozen[0],frozen[1]);row[1]=99.
        self.assertEqual(frozen[0][1],1.)
        with self.assertRaises(TypeError):frozen[0][1]=9.
        for invalid in (float('nan'),float('inf')):
            with self.assertRaises(ValueError):freeze_json([0.,invalid,2.])
