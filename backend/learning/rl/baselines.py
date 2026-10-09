"""Diagnostic controllers, explicitly distinct from YA RAB OSTORHA."""
import numpy as np


def scripted_action(step):
    return np.array([0.,.4,0.],np.float32)


def conservative_action(observation):
    # Runtime sensor-only radar depth/velocity. No reward clearance or actor IDs.
    detections=observation['radar'][-1][observation['radar_valid'][-1].astype(bool)]
    forward=detections[(np.abs(detections[:,1])<.12)&(np.abs(detections[:,2])<.15)]
    speed=float(observation['ego'][-1,0])
    stopping=2.5+speed*.5+speed*speed/(2*5.)
    if len(forward) and float(forward[:,0].min())<max(10.,stopping):
        return np.array([0.,0.,1.],np.float32)
    return np.array([0.,.35 if speed<8. else 0.,0.],np.float32)
