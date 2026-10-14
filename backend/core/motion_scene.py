"""Advance a fresh asynchronous sensor scene using onboard odometry only."""
import math
import numpy as np
from .kinematic_prediction import kinematic_modes


def advance_scene(scene,observation):
    old,points,prediction=scene[:3]
    dt=observation.timestamp_s-old.timestamp_s
    if not 0<=dt<=.1+1e-6:raise ValueError('Motion scene exceeds simulation freshness limit')
    yaw=(old.ego.angular_velocity_radps[2]+observation.ego.angular_velocity_radps[2])*.5*dt
    co,si=math.cos(yaw),math.sin(yaw);r=np.array([[co,si],[-si,co]])
    from .ego_motion import signed_speed
    distance=(signed_speed(old.ego)+signed_speed(observation.ego))*.5*dt
    translation=np.array([distance*math.cos(yaw/2),distance*math.sin(yaw/2)])
    tracks=[]
    for tr in prediction['tracks']:
        v=np.asarray(tr['velocity_mps']);position=r@(np.asarray(tr['position_m'])+v*dt-translation)
        half=np.abs(r)@np.asarray(tr['half_size_m']);velocity=r@v
        tracks.append({**tr,'position_m':position.tolist(),'velocity_mps':(r@v).tolist(),
            'half_size_m':half.tolist(),
            'heading_rad':math.atan2(velocity[1],velocity[0]) if np.linalg.norm(velocity)>=.3 else None,
            'occlusion_s':tr.get('occlusion_s',0.)+dt,
            'acceleration_mps2':(r@np.asarray(tr['acceleration_mps2'])).tolist(),
            'uncertainty_m':tr['uncertainty_m']+.1*dt})
    transformed=np.asarray(points).copy();transformed[:,:2]=(transformed[:,:2]-translation)@r.T
    current={**prediction,'timestamp_s':observation.timestamp_s,'evaluation_frame':observation.frame_id,
        'tracks':tracks,'control_trajectories':kinematic_modes(tracks)}
    if len(scene)>3:
        class CurrentSpace:
            def certificate(self,path):
                source=np.asarray(path).copy();source[:,1:3]=source[:,1:3]@r+translation;source[:,3]+=yaw
                return scene[3].certificate(source)
        current['_observed_space']=CurrentSpace()
    return transformed,current
