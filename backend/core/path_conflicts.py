"""Measured LiDAR surface motion near ego; no actor poses, IDs or routes.

360-degree samples are sparse/occluded, not a free-space certificate. Tracks
are short-lived connected surface clusters with ego speed/IMU compensation.
Only credible swept overlap requests braking; steering remains unverified.
"""
import math
import numpy as np


def surfaces(points):
    selected=points[(points[:,0]>-10)&(points[:,0]<30)&(np.abs(points[:,1])<9)
                    &(points[:,2]>.3)&(points[:,2]<2.7)
                    &~((np.abs(points[:,0])<=2.5)&(np.abs(points[:,1])<=1.15)),:2]
    cells={}
    for point in selected:
        key=tuple(np.floor(point/.9).astype(int));cells.setdefault(key,[]).append(point)
    clusters=[]
    while cells:
        key=next(iter(cells));pending=[key];cloud=[]
        while pending:
            key=pending.pop()
            if key not in cells:continue
            cloud.extend(cells.pop(key))
            pending.extend((key[0]+x,key[1]+y) for x in (-1,0,1) for y in (-1,0,1) if x or y)
        if len(cloud)<3:continue
        cloud=np.asarray(cloud);low=cloud.min(0);high=cloud.max(0)
        if np.max(high-low)>7:continue  # walls/unresolved merged surfaces
        clusters.append({'center':(low+high)/2,'half':np.maximum((high-low)/2,.35),
                         'cloud':cloud[::max(1,len(cloud)//64)],'points':len(cloud)})
    return clusters


def overlap_time(center, half, velocity, horizon):
    lo=0.;hi=horizon
    for p,e,v in zip(center,half,velocity):
        if abs(v)<.05:
            if abs(p)>e:return None
        else:
            a,b=sorted(((-e-p)/v,(e-p)/v));lo=max(lo,a);hi=min(hi,b)
    return lo if 0<=lo<=hi else None


class LidarPathConflicts:
    def __init__(self):self.reset()

    def reset(self):self.previous=[];self.timestamp=None;self.speed=0.;self.estimates=[]

    def assess(self, points, observation):
        now=observation.timestamp_s;current=surfaces(points)
        dt=None if self.timestamp is None else now-self.timestamp
        speed=observation.ego.speed_mps;yaw_rate=observation.ego.angular_velocity_radps[2]
        conflict=None;estimates=[]
        if dt is not None and .025<=dt<=.15 and abs(yaw_rate)<.5:
            angle=yaw_rate*dt;co,si=math.cos(angle),math.sin(angle)
            rotation=np.asarray([[co,si],[-si,co]])
            available=set(range(len(self.previous)))
            for cluster in current:
                if abs(cluster['center'][1])<1.1 and cluster['center'][0]>=0:continue # forward supervisor
                pairs=[]
                for i in available:
                    old=self.previous[i]
                    predicted=rotation@(old['center']-np.asarray([(speed+self.speed)*.5*dt,0.]))
                    gap=np.linalg.norm(cluster['center']-predicted)
                    if gap<1.6 and np.linalg.norm(cluster['half']-old['half'])<1.5:pairs.append((gap,i,predicted))
                if not pairs:continue
                _,i,predicted=min(pairs,key=lambda p:p[0]);available.remove(i)
                old=self.previous[i]
                # Surface bounds shift as rays expose different parts of even a
                # stationary wall. Register measured returns instead of turning
                # bounding-box centroid jitter into invented lateral velocity.
                old_cloud=(rotation@(old['cloud']-np.asarray([(speed+self.speed)*.5*dt,0.])).T).T
                new_cloud=cluster['cloud'];translation=np.zeros(2)
                for _ in range(3):
                    difference=new_cloud[:,None,:]-(old_cloud+translation)[None,:,:]
                    distance2=np.sum(difference*difference,axis=2);nearest=np.argmin(distance2,axis=1)
                    residual=difference[np.arange(len(new_cloud)),nearest]
                    lengths=np.linalg.norm(residual,axis=1)
                    selected=residual[lengths<=max(.12,min(.65,float(np.quantile(lengths,.7))))]
                    if len(selected)<3:break
                    translation+=np.median(selected,axis=0)
                if len(selected)<3:continue
                measured=translation/dt
                if np.linalg.norm(measured)>12:continue
                velocity=.8*old.get('velocity',measured)+.2*measured
                cluster['velocity']=velocity;cluster['hits']=old.get('hits',0)+1
                if cluster['hits']<5:continue
                relative=velocity-np.asarray([speed,0.])
                # .45m margin covers sparse surface bounds; no mesh/GT input.
                half=cluster['half']+np.asarray([2.95,1.8])
                time_to_conflict=overlap_time(cluster['center'],half,relative,2.5)
                inward=cluster['center'][1]*velocity[1]<-.15
                rear_approach=cluster['center'][0]<0 and relative[0]>.5
                if time_to_conflict is not None and (inward or rear_approach):
                    estimate={'source':'LIDAR_SURFACE_TRACK','center_m':cluster['center'].tolist(),
                              'motion_mps':velocity.tolist(),'relative_motion_mps':relative.tolist(),
                              'time_to_conflict_s':time_to_conflict,'matched_frames':cluster['hits'],
                              'surface_half_size_m':cluster['half'].tolist()}
                    estimates.append(estimate)
                    if conflict is None or time_to_conflict<conflict['time_to_conflict_s']:conflict=estimate
        self.previous=current;self.timestamp=now;self.speed=speed;self.estimates=estimates
        return {'conflict':conflict,'tracked_surface_count':sum(c.get('hits',0)>=5 for c in current),
                'coverage':'OBSERVED_LIDAR_SURFACES_ONLY; sparse/occluded side and rear directions remain UNKNOWN',
                'side_rear_free_space_verified':False}
