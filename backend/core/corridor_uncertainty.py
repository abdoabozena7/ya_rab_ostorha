"""Candidate-scoped uncertainty, including unconfirmed and temporarily lost tracks."""
import numpy as np
from .motion_geometry import GRID, footprint_centers, rectangle_clearances
from .prediction import MAX_TRACK_OCCLUSION_S


def uncertain_corridor_tracks(tracks, modes, path, geometry, *, retained_forecasts=False):
    ids = {m['track_id'] for m in modes}
    centers = footprint_centers(path, geometry)
    times = centers[:, 0]
    uncertain = []
    for tr in tracks:
        # Retained confirmed tracks already have explicit physical hypotheses
        # and age-grown uncertainty, checked independently by assess_conflicts.
        # A missed scan does not erase that evidence and replace it with a
        # different universal acceleration model at an arbitrary 100 ms cliff.
        # New tracks, missing forecasts and expired tracks keep this guard.
        age_limit=MAX_TRACK_OCCLUSION_S if retained_forecasts else .1
        if tr.get('confirmed') and tr.get('occlusion_s', 0) <= age_limit+1e-6 and tr['id'] in ids:
            continue
        position = np.asarray(tr['position_m'])
        velocity = np.asarray(tr.get('velocity_mps', [0., 0.]))
        predicted = position + times[:, None]*velocity
        # Bounded reachable acceleration around the measured velocity. This is
        # an uncertainty region, never a confident invented unseen trajectory.
        margin = float(tr.get('uncertainty_m', .5)) + .5*3.*times**2
        half = np.asarray(tr['half_size_m']) + geometry.half
        gap = np.abs(predicted-centers[:, 1:3])
        possible=np.all(gap<=half+margin[:,None],axis=1)
        # Acceleration is bounded in magnitude, not independently along both
        # axes. A square envelope admits an impossible sqrt(2)-faster diagonal
        # approach. Keep the box as a cheap broad phase, then use exact body
        # separation against the circular reachable radius at the same time.
        relevant=False
        if possible.any():
            distances=rectangle_clearances(predicted[possible],tr['half_size_m'],centers[possible],geometry.half)
            relevant=bool(np.any(distances<=margin[possible]))
        if relevant:
            uncertain.append(tr['id'])
    return uncertain
