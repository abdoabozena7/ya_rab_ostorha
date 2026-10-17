"""Measured Doppler velocity constraints; no simulator actors or motion labels."""
import math
import numpy as np
from .active_safety import _mount
from .contracts import SensorKind
from .prediction import rotation


def measured_returns(observation,poses):
    if len(poses)<2:return None
    previous,current=poses[-2:];dt=current[0]-previous[0]
    if not 0<dt<=.15:return None
    origin=np.asarray(current[1:3]);prior_origin=np.asarray(previous[1:3])
    r=rotation(current[3]);prior_r=rotation(previous[3]);rows=[]
    for channel in observation.channels:
        if channel.kind!=SensorKind.RADAR:continue
        position,angles=_mount(channel)
        # These admitted experimental mounts are level; arbitrary pitch/roll
        # requires its own calibration rather than an incorrect 2-D transform.
        if abs(angles[0])+abs(angles[1])>1e-5:continue
        yaw=math.radians(angles[2]);mount_r=rotation(yaw)
        sensor_velocity=r.T@((origin+r@position[:2])-(prior_origin+prior_r@position[:2]))/dt
        detections=channel.data.get('detections',())
        if not detections:continue
        data=np.asarray([[d[k] for k in ('depth_m','azimuth_rad','altitude_rad','velocity_mps')] for d in detections],float)
        data=data[np.isfinite(data).all(axis=1)&(data[:,0]>0)]
        if not len(data):continue
        distance,az,alt,velocity=data.T
        direction=np.column_stack((np.cos(alt)*np.cos(az),np.cos(alt)*np.sin(az)))@mount_r.T
        xyz=np.column_stack((position[:2]+distance[:,None]*direction,position[2]+distance*np.sin(alt)))
        valid=(xyz[:,2]>.25)&(xyz[:,2]<2.5)&(np.abs(alt)<.2)
        # Same Doppler sign, finite pose velocity, bounds and return order.
        rows.append(np.column_stack((xyz,direction,velocity+direction@sensor_velocity))[valid])
    return np.concatenate(rows) if rows else np.empty((0,6))


def observable_velocity(directions,speeds,prior):
    """Correct only well-observed axes; retain the surface estimate elsewhere."""
    u,singular,axes=np.linalg.svd(directions,full_matrices=False)
    observable=singular>=max(1e-6,singular[0]/10.)
    axes=axes[observable]
    correction=(u[:,observable].T@(speeds-directions@prior))/singular[observable]
    return prior+axes.T@correction,axes


class RadarVelocityFusion:
    def __init__(self):self.previous={}

    def apply(self,prediction,observation,poses,tracker):
        returns=measured_returns(observation,list(poses))
        if returns is None or not len(returns):return 0
        tracks=[t for t in prediction['tracks'] if t.get('occlusion_s',0.)<1e-6]
        if not tracks:return 0
        centers=np.array([t['position_m'] for t in tracks]);half=np.array([t['half_size_m'] for t in tracks])
        association=np.all(np.abs(returns[:,None,:2]-centers[None,:,:])<=half[None,:,:]+.15,axis=2)
        unambiguous=association.sum(axis=1)==1
        r=rotation(prediction['odometry_yaw_rad']);origin=np.asarray(prediction['odometry_origin_m'])
        now=observation.timestamp_s;count=0
        for i,track in enumerate(tracks):
            points=returns[unambiguous&association[:,i]]
            if len(points)<4:continue
            directions=points[:,3:5];speeds=points[:,5]
            prior=np.asarray(track['velocity_mps'],float)
            velocity,axes=observable_velocity(directions,speeds,prior)
            residual=np.abs(directions@velocity-speeds)
            selected=residual<=max(.15,float(np.quantile(residual,.8)))
            if selected.sum()<4:continue
            velocity,axes=observable_velocity(directions[selected],speeds[selected],prior)
            residual=np.abs(directions[selected]@velocity-speeds[selected])
            if np.median(residual)>.2 or np.max(residual)>.5 or np.linalg.norm(velocity)>30.:continue
            world_velocity=r@velocity;old=self.previous.get(track['id'])
            native=tracker.tracks.get(int(track['id']))
            if native is None:continue
            acceleration=np.zeros(2);anchor=native.get('anchor',native['position']).copy();turn_rate=0.
            if old and 0<now-old['timestamp_s']<=.15:
                dt=now-old['timestamp_s']
                acceleration=np.clip((world_velocity-old['velocity'])/dt,-3.,2.)
                anchor=old['anchor']+(world_velocity+old['velocity'])*dt*.5
                if min(np.linalg.norm(world_velocity),np.linalg.norm(old['velocity']))>.5:
                    angle=math.atan2(world_velocity[1],world_velocity[0])-math.atan2(old['velocity'][1],old['velocity'][0])
                    angle=(angle+math.pi)%(2*math.pi)-math.pi
                    turn_rate=.8*old['turn_rate']+.2*float(np.clip(angle/dt,-.7,.7))
            # Doppler constrains motion, never the currently occupied bounds.
            native.update(velocity=world_velocity,acceleration=acceleration,anchor=anchor,turn_rate=turn_rate)
            if native['history']:native['history'][-1]=(now,*anchor,*world_velocity)
            track.update(velocity_mps=velocity.tolist(),acceleration_mps2=(r.T@acceleration).tolist(),
                motion_anchor_m=(r.T@(anchor-origin)).tolist(),turn_rate_radps=turn_rate,
                heading_rad=math.atan2(velocity[1],velocity[0]) if np.linalg.norm(velocity)>=.3 else None,
                velocity_source='MEASURED_SURROUND_DOPPLER_UNCALIBRATED' if len(axes)==2 else
                    'PARTIAL_DOPPLER_WITH_UNCALIBRATED_SURFACE_COMPONENT',
                doppler_evidence={'returns':int(selected.sum()),'maximum_residual_mps':float(np.max(residual)),
                    'source_frame':observation.frame_id,'observable_rank':len(axes),
                    'observable_axes_ego':axes.tolist(),
                    'unobserved_directions':'NONE' if len(axes)==2 else 'RETAINED_UNCALIBRATED_SURFACE_ESTIMATE'})
            track['history']=tracker.sample_history(native['history'],now)
            self.previous[track['id']]={'timestamp_s':now,'velocity':world_velocity,'anchor':anchor,'turn_rate':turn_rate}
            count+=1
        self.previous={k:v for k,v in self.previous.items() if now-v['timestamp_s']<=.3}
        return count
