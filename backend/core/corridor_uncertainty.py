"""Candidate-scoped uncertainty, including unconfirmed and temporarily lost tracks."""
import numpy as np
from .motion_geometry import GRID, footprint_centers


def uncertain_corridor_tracks(tracks, modes, path, geometry):
    ids = {m['track_id'] for m in modes}
    centers = footprint_centers(path, geometry)
    times = centers[:, 0]
    uncertain = []
    for tr in tracks:
        if tr.get('confirmed') and tr.get('occlusion_s', 0) <= .1 and tr['id'] in ids:
            continue
        position = np.asarray(tr['position_m'])
        velocity = np.asarray(tr.get('velocity_mps', [0., 0.]))
        predicted = position + times[:, None]*velocity
        # Bounded reachable acceleration around the measured velocity. This is
        # an uncertainty region, never a confident invented unseen trajectory.
        margin = float(tr.get('uncertainty_m', .5)) + .5*3.*times**2
        half = np.asarray(tr['half_size_m']) + geometry.half
        gap = np.abs(predicted-centers[:, 1:3])
        relevant = np.any(np.all(gap <= half+margin[:, None], axis=1))
        if relevant:
            uncertain.append(tr['id'])
    return uncertain
