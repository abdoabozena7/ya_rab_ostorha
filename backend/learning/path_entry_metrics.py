"""Numpy metrics for calibrated binary path-entry risk (no external ML dependency)."""
import math
import numpy as np


def _valid(y, p):
    y = np.asarray(y);p = np.asarray(p, float)
    keep = (y == 0) | (y == 1)
    return y[keep].astype(int), p[keep]


def roc_auc(y, p):
    y, p = _valid(y, p)
    pos = int(y.sum());neg = len(y)-pos
    if not pos or not neg:return None
    order = np.argsort(p, kind='mergesort');ranks = np.empty(len(p));sorted_p = p[order]
    i = 0
    while i < len(p):
        j = i
        while j+1 < len(p) and sorted_p[j+1] == sorted_p[i]:j += 1
        ranks[order[i:j+1]] = (i+j)/2.+1.;i = j+1
    return float((ranks[y == 1].sum()-pos*(pos+1)/2.)/(pos*neg))


def average_precision(y, p):
    """Step-wise AUPRC: sum over positives of precision at each recall increment."""
    y, p = _valid(y, p)
    pos = int(y.sum())
    if not pos:return None
    order = np.argsort(-p, kind='mergesort');y = y[order];p = p[order]
    distinct = np.r_[np.flatnonzero(np.diff(p)), len(p)-1]
    tp = np.cumsum(y)[distinct];fp = (distinct+1)-tp
    precision = tp/(tp+fp);recall = tp/pos
    return float(np.sum(np.diff(np.r_[0., recall])*precision))


def brier(y, p):
    y, p = _valid(y, p)
    return float(np.mean((p-y)**2)) if len(y) else None


def calibration(y, p, bins=10):
    """Expected calibration error with equal-width bins and the reliability table."""
    y, p = _valid(y, p)
    if not len(y):return None, []
    edges = np.linspace(0., 1., bins+1);table = [];ece = 0.
    index = np.clip(np.digitize(p, edges[1:-1]), 0, bins-1)
    for b in range(bins):
        mask = index == b
        if not mask.any():continue
        confidence = float(p[mask].mean());observed = float(y[mask].mean())
        ece += mask.mean()*abs(confidence-observed)
        table.append({'bin': [float(edges[b]), float(edges[b+1])], 'count': int(mask.sum()),
                      'mean_probability': confidence, 'observed_frequency': observed})
    return float(ece), table


def threshold_metrics(y, p, threshold):
    y, p = _valid(y, p);predicted = p >= threshold
    tp = int(np.sum(predicted & (y == 1)));fp = int(np.sum(predicted & (y == 0)))
    fn = int(np.sum(~predicted & (y == 1)));tn = int(np.sum(~predicted & (y == 0)))
    precision = tp/(tp+fp) if tp+fp else None;recall = tp/(tp+fn) if tp+fn else None
    f1 = 2*precision*recall/(precision+recall) if precision and recall else 0. if precision is not None and recall is not None else None
    return {'threshold': float(threshold), 'tp': tp, 'fp': fp, 'fn': fn, 'tn': tn, 'precision': precision, 'recall': recall,
            'f1': f1, 'false_positive_rate': fp/(fp+tn) if fp+tn else None, 'false_negative_rate': fn/(fn+tp) if fn+tp else None}


def best_f1_threshold(y, p):
    y, p = _valid(y, p)
    candidates = np.unique(np.round(p, 4))
    if len(candidates) > 400:candidates = np.quantile(p, np.linspace(0., 1., 401))
    best = max(((threshold_metrics(y, p, t)['f1'] or 0., -t) for t in candidates), default=(0., -.5))
    return float(-best[1])


def event_metrics(meta, y, p, threshold, horizon_s):
    """Walker-level events: missed entries and false crossing alarms.

    An entry event is detected when any associated decision within the
    horizon before entry predicted at or above the threshold. A walker that
    never entered but received any such prediction is one false alarm.
    """
    groups = {}
    for m, label, score in zip(meta, y, p):
        if label not in (0, 1):continue
        key = (m['episode'], m['walker_id'])
        groups.setdefault(key, []).append((label, score))
    entered = detected = 0;non_entering = alarms = 0
    for rows in groups.values():
        labels = np.array([r[0] for r in rows]);scores = np.array([r[1] for r in rows])
        if labels.max() == 1:
            entered += 1;detected += bool(np.any(scores[labels == 1] >= threshold))
        else:
            non_entering += 1;alarms += bool(np.any(scores >= threshold))
    return {'horizon_s': horizon_s, 'entering_walkers': entered, 'missed_entries': entered-detected,
            'missed_entry_rate': (entered-detected)/entered if entered else None,
            'non_entering_walkers': non_entering, 'false_crossing_alarms': alarms,
            'false_alarm_rate': alarms/non_entering if non_entering else None}


def summary(y, p, *, threshold):
    ece, table = calibration(y, p)
    return {'n': int(np.sum(np.isin(y, (0, 1)))), 'positives': int(np.sum(np.asarray(y) == 1)), 'auroc': roc_auc(y, p),
            'auprc': average_precision(y, p), 'brier': brier(y, p), 'ece': ece, 'reliability': table,
            'at_threshold': threshold_metrics(y, p, threshold)}


def finite_or_none(value):
    return value if value is None or (isinstance(value, float) and math.isfinite(value)) or isinstance(value, int) else None
