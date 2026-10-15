import unittest
import numpy as np
from backend.core.measured_rows import unique_row_indices


class MeasuredRowTests(unittest.TestCase):
    def test_exact_indices_and_order_match_general_unique_with_repeated_negative_cells(self):
        rng=np.random.default_rng(665)
        for width in (2,3,4):
            rows=rng.integers(-40,40,(3000,width))
            rows=np.vstack((rows,rows[::3],rows[:20]))
            for dtype in (np.int32,np.int64):
                keys=rows.astype(dtype)
                np.testing.assert_array_equal(unique_row_indices(keys),np.unique(keys,axis=0,return_index=True)[1])

    def test_extreme_spans_fall_back_without_overflowing_or_merging_cells(self):
        for rows in (np.array([[-2**62,0],[2**62,0],[-2**62,0]],dtype=np.int64),
                     np.array([[2**63+2,4],[0,4],[2**63+2,4]],dtype=np.uint64)):
            np.testing.assert_array_equal(unique_row_indices(rows),np.unique(rows,axis=0,return_index=True)[1])
        self.assertEqual(unique_row_indices(np.empty((0,3),dtype=int)).size,0)


if __name__=='__main__':unittest.main()
