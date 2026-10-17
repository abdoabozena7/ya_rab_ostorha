"""A forward-only certificate for stationary rear uncertainty growth.

This never removes occupancy or bypasses other tracks, measured-space or road
checks. Native acceptance is still required for the changed control revision.
"""
import numpy as np
from .motion_geometry import footprint_centers, rectangle_clearances


def forward_separation(track, modes, checked, geometry):
    path=np.asarray(checked,float)
    history=np.asarray(track.get('history',()),float)
    if (not track.get('confirmed') or track.get('occlusion_s',1.)>.1 or
        track.get('motion_observations',0)<5 or track.get('class','UNKNOWN').upper() in ('PERSON','PEDESTRIAN') or
        len(history)<2 or history.shape[1]<5 or history[-1,0]-history[-2,0]<.25 or
        np.max(np.linalg.norm(history[-2:,3:5],axis=1))>=.3 or
        np.linalg.norm(track['velocity_mps'])>=.3 or not modes or
        any(m['source']!='STATIONARY' for m in modes)):
        return None
    center=np.asarray(track['position_m'],float)
    if center[0]>=-geometry.rear_m or len(path)<2:return None
    # Strict forward travel; no lateral intent or turn toward either corner.
    if (path[-1,1]-path[0,1]<=1e-5 or np.any(np.diff(path[:,1])< -1e-7) or
        np.max(np.abs(path[:,2]))>.01 or np.max(np.abs(path[:,3]))>.002):return None
    footprint=footprint_centers(path,geometry)
    centers=np.tile(center,(len(path),1))
    half=np.asarray(track['half_size_m'])+float(track['uncertainty_m'])+.2
    clearance=rectangle_clearances(centers,half,footprint,geometry.half)
    if clearance.min()<=0. or np.any(np.diff(clearance)<-1e-7):return None
    separation=footprint[:,1]-center[0]
    if np.any(np.diff(separation)<-1e-7) or separation[-1]<=separation[0]+1e-5:return None
    return {'policy':'STATIONARY_REAR_FORWARD_SEPARATION_V1','track_id':track['id'],
        'minimum_padded_clearance_m':float(clearance.min()),'initial_clearance_m':float(clearance[0]),
        'final_clearance_m':float(clearance[-1]),'longitudinal_gain_m':float(separation[-1]-separation[0]),
        'checked_horizon_s':float(path[-1,0]),'original_uncertainty_m':float(track['uncertainty_m'])}
