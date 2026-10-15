"""Exact row deduplication for bounded integer sensor-cell coordinates."""
import math
import numpy as np


def unique_row_indices(keys):
    rows=np.asarray(keys)
    if rows.ndim!=2 or not np.issubdtype(rows.dtype,np.integer):
        raise ValueError('Measured cell keys must be an integer matrix')
    if not len(rows):return np.empty(0,dtype=np.intp)
    low=rows.min(axis=0);high=rows.max(axis=0)
    spans=tuple(int(b)-int(a)+1 for a,b in zip(low,high))
    # Scalar mixed-radix keys preserve the original lexicographic order and
    # first occurrence exactly. Extreme external inputs use NumPy's general
    # row comparison instead of overflowing the packed coordinate.
    if (not spans or math.prod(spans)>np.iinfo(np.intp).max
            or any(int(v)>np.iinfo(np.int64).max for v in high)):
        return np.unique(rows,axis=0,return_index=True)[1]
    shifted=rows.astype(np.int64)-low.astype(np.int64)
    packed=np.ravel_multi_index(tuple(shifted.T),spans)
    return np.unique(packed,return_index=True)[1]
