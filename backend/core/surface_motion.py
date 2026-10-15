"""Test measured surface displacement against a stationary-world hypothesis.

Changing ray coverage can accumulate biased frame-to-frame ICP steps. A moving
object must also register over a longer baseline, in both directions. A fit to
stationary geometry is not evidence that the object will cross the road.
Unresolved motion never certifies free space or removes measured occupancy.
"""
import numpy as np
from .surface_registration import register_surfaces

MOTION_BASELINE_S = .25
MOTION_WINDOW_S = .5
STATIC_FIT_M = .08
MOVING_FIT_M = .15


def bidirectional_fit(distances):
    # Median nearest-neighbor error ignores a small body's leading/trailing
    # edges: most interior samples can align one ray spacing in the wrong
    # direction. Include those edges while tolerating a few outlier returns.
    return max(float(np.quantile(distances.min(axis),.9)) for axis in (0,1))


def register_material(current, previous, prior, center_displacement):
    candidates=register_surfaces([current,current],[previous,previous],
        [prior,center_displacement],[prior,center_displacement],enhanced=False)
    scores=[bidirectional_fit(np.linalg.norm(current[:,None]-(previous+delta)[None,:],axis=2))
            +.005*np.linalg.norm(delta-prior) for delta in candidates]
    return candidates[int(np.argmin(scores))]


def surface_motion_evidence(current, previous, elapsed_s, expected_displacement):
    evidence = {'state': 'UNRESOLVED', 'baseline_s': float(elapsed_s),
                'policy': 'BIDIRECTIONAL_REGISTERED_MOTION_V1'}
    if elapsed_s < MOTION_BASELINE_S-1e-6 or len(current) < 3 or len(previous) < 3:
        return evidence
    current = np.asarray(current); previous = np.asarray(previous)
    displacement = register_material(current,previous,np.asarray(expected_displacement),current.mean(0)-previous.mean(0))
    stationary = np.linalg.norm(current[:, None]-previous[None, :], axis=2)
    moving = np.linalg.norm(current[:, None]-(previous+displacement)[None, :], axis=2)
    # Both views must support the same material displacement. One-way ICP can
    # follow a newly revealed face along a stationary wall or parked vehicle.
    static_fit = bidirectional_fit(stationary)
    moving_fit = bidirectional_fit(moving)
    support = min(float(np.mean(moving.min(axis) <= MOVING_FIT_M)) for axis in (0, 1))
    improvement = (static_fit-moving_fit)/max(STATIC_FIT_M, static_fit)
    state = ('STATIC_COMPATIBLE' if static_fit <= STATIC_FIT_M else
             'MOVING' if moving_fit <= MOVING_FIT_M and support >= .65 and improvement >= .4 else
             'UNRESOLVED')
    evidence.update(state=state, displacement_m=displacement.tolist(),
                    velocity_mps=(displacement/elapsed_s).tolist(),
                    static_fit_m=static_fit, moving_fit_m=moving_fit,
                    matched_fraction=support, fit_improvement=improvement)
    return evidence
