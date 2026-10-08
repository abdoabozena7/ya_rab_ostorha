"""Aggregate measured native episode outcomes; no fabricated policy results."""
import json
from pathlib import Path
from ..core.scenarios import DatasetSplit, SEED_RANGES

HELD_OUT_SEEDS={'TRAIN':[42,43,44],'VALIDATION':[1042,1043],'TEST':[2042,2043]}


def summarize(paths):
    rows=[json.loads((Path(p)/'outcome.json').read_text(encoding='utf8')) for p in paths]
    if not rows:raise ValueError('No measured episodes supplied')
    splits={r['split'] for r in rows};baselines={r['baseline_id'] for r in rows}
    if len(splits)!=1 or len(baselines)!=1:raise ValueError('Summaries require one split and one baseline')
    for r in rows:
        lo,hi=SEED_RANGES[DatasetSplit(r['split'])]
        if not lo<=r['seed']<=hi:raise ValueError('Episode seed violates held-out namespace')
    def minimum(key):
        values=[r['metrics'][key] for r in rows if r['metrics'][key] is not None]
        return min(values) if values else None
    def average(key):
        values=[r['metrics'][key] for r in rows if r['metrics'][key] is not None]
        return sum(values)/len(values) if values else None
    return {'episodes':len(rows),'split':next(iter(splits)),'baseline_id':next(iter(baselines)),
            'collision_frequency':sum(r['metrics']['collision_count']>0 for r in rows)/len(rows),
            'success_frequency':sum(r['outcome']=='SUCCESS' for r in rows)/len(rows),
            'collision_peak_impulse_ns':max(r['metrics']['collision_peak_impulse_ns'] for r in rows),
            'minimum_clearance_m':minimum('minimum_clearance_m'),'minimum_ttc_s':minimum('minimum_ttc_s'),
            'mean_forward_progress_m':average('forward_progress_m'),'mean_distance_traveled_m':average('distance_traveled_m'),
            'mean_speed_mps':average('average_speed_mps'),'mean_time_to_completion_s':average('time_to_completion_s'),
            'hard_braking_events':sum(r['metrics']['hard_braking_events'] for r in rows),
            'mean_steering_oscillation':average('steering_oscillation'),
            'mean_intervention_frequency':average('intervention_frequency'),'policy_active':False}
