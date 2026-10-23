from unittest import TestCase
import numpy as np
from backend.learning.path_entry_metrics import (average_precision, best_f1_threshold, brier, calibration, event_metrics,
                                                 roc_auc, threshold_metrics)


class PathEntryMetricTests(TestCase):
    def test_ranking_metrics_match_hand_computed_values(self):
        y = np.array([0, 0, 1, 1]);p = np.array([.1, .4, .35, .8])
        self.assertAlmostEqual(roc_auc(y, p), .75)
        # Ranked: .8(+), .4(-), .35(+), .1(-): AP = 1*.5 + 2/3*.5.
        self.assertAlmostEqual(average_precision(y, p), .5+(2/3)*.5)
        self.assertAlmostEqual(roc_auc([0, 1, 1, 0], [.5, .5, .5, .5]), .5)
        self.assertIsNone(roc_auc([1, 1], [.2, .3]))
        self.assertAlmostEqual(brier([0, 1], [.2, .6]), (.04+.16)/2)

    def test_unlabeled_entries_are_excluded_not_counted_as_negatives(self):
        y = np.array([1, 0, -1, -1]);p = np.array([.9, .1, .95, .0])
        self.assertAlmostEqual(roc_auc(y, p), 1.)
        result = threshold_metrics(y, p, .5)
        self.assertEqual((result['tp'], result['fp'], result['fn'], result['tn']), (1, 0, 0, 1))

    def test_calibration_error_and_threshold_selection(self):
        rng = np.random.default_rng(3);p = rng.random(20000);y = (rng.random(20000) < p).astype(int)
        ece, table = calibration(y, p)
        self.assertLess(ece, .02);self.assertEqual(sum(row['count'] for row in table), 20000)
        overconfident, _ = calibration(y, np.clip(p*1.6-.3, 0, 1))
        self.assertGreater(overconfident, .08)
        threshold = best_f1_threshold(np.array([0, 0, 1, 1, 1]), np.array([.1, .3, .6, .7, .9]))
        self.assertTrue(.3 < threshold <= .6)

    def test_event_metrics_count_missed_entries_and_false_alarms(self):
        meta = [{'episode': 'e', 'walker_id': w} for w in (1, 1, 2, 2, 3)]
        y = np.array([0, 1, 0, 0, 1]);p = np.array([.2, .7, .9, .1, .2])
        result = event_metrics(meta, y, p, .5, 2)
        self.assertEqual((result['entering_walkers'], result['missed_entries']), (2, 1))
        self.assertEqual((result['non_entering_walkers'], result['false_crossing_alarms']), (1, 1))
