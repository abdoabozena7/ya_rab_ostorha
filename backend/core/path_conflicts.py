"""Measured LiDAR surface motion near ego; no actor poses, IDs or routes.

360-degree samples are sparse/occluded, not a free-space certificate. Tracks
are short-lived connected surface clusters with ego speed/IMU compensation.
Only sustained lateral ingress into the forward swept path requests braking.
A closing rear return is diagnostic: forward braking cannot avoid that impact
and may worsen it. Steering remains unverified.
"""
import math
import numpy as np
from .surface_motion import surface_motion_evidence, register_material, MOTION_WINDOW_S

LATERAL_EVIDENCE_WINDOW_S = .5
MINIMUM_LATERAL_INGRESS_M = .1
LATERAL_SPEED_NOISE_MPS = .3
PATH_CONFLICT_POLICY = 'FORWARD_PHYSICAL_INGRESS_V4'


def surfaces(points, *, bounds=(-10.,30.,9.), geometry=None,ground_plane=None,split_large_frame=None):
    front=geometry.front_m if geometry else 2.5
    rear=geometry.rear_m if geometry else 2.5
    width=geometry.half_width_m if geometry else 1.15
    height=points[:,2] if ground_plane is None else points[:,2]-points[:,0]*ground_plane[0]-points[:,1]*ground_plane[1]-ground_plane[2]
    selected=points[(points[:,0]>bounds[0])&(points[:,0]<bounds[1])&(np.abs(points[:,1])<bounds[2])
                    &(height>.3)&(height<2.7)
                    &~((points[:,0]<=front)&(points[:,0]>=-rear)&(np.abs(points[:,1])<=width)),:2]
    cells={}
    keys=np.floor(selected/.9).astype(int).tolist()
    for key,point in zip(keys,selected):
        cells.setdefault(tuple(key),[]).append(point)
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
        chunks=[cloud]
        if np.max(high-low)>7:
            if split_large_frame is None:continue  # Legacy forward-only tracker.
            origin,rotation=split_large_frame
            # Preserve unresolved connected returns instead of making whole
            # parked rows disappear when two visible bodies merge. Odometry-
            # fixed tiles do not slide across the surface as ego advances.
            keys=np.floor((cloud@rotation.T+origin)/4.).astype(int)
            _,inverse=np.unique(keys,axis=0,return_inverse=True)
            chunks=[cloud[inverse==i] for i in range(int(inverse.max())+1)]
        # Stable sampling order prevents cell traversal changes from inventing
        # motion when the same stationary surface crosses voxel boundaries.
        for cloud in chunks:
            if len(cloud)<3:continue
            low=cloud.min(0);high=cloud.max(0)
            cloud=cloud[np.lexsort((cloud[:,1],cloud[:,0]))]
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

    def assess(self, points, observation, *, geometry=None,forward_path=None,ground_plane=None):
        if ground_plane is None:
            from .ground_geometry import measured_ground_plane
            from .motion_geometry import VehicleGeometry
            ground_plane,_=measured_ground_plane(points,geometry or VehicleGeometry())
        now=observation.timestamp_s;current=surfaces(points,geometry=geometry,ground_plane=ground_plane)
        dt=None if self.timestamp is None else now-self.timestamp
        from .ego_motion import signed_speed
        speed=signed_speed(observation.ego);yaw_rate=observation.ego.angular_velocity_radps[2]
        conflict=None;estimates=[];observations=[]
        if dt is not None and .025<=dt<=.15 and abs(yaw_rate)<.5:
            angle=yaw_rate*dt;co,si=math.cos(angle),math.sin(angle)
            rotation=np.asarray([[co,si],[-si,co]])
            distance=(speed+self.speed)*.5*dt
            ego_translation=distance*np.array([math.cos(angle*.5),math.sin(angle*.5)])
            available=set(range(len(self.previous)))
            for cluster in current:
                if abs(cluster['center'][1])<1.1 and cluster['center'][0]>=0:continue # forward supervisor
                pairs=[]
                for i in available:
                    old=self.previous[i]
                    predicted=rotation@(old['center']-ego_translation)
                    gap=np.linalg.norm(cluster['center']-predicted)
                    if gap<1.6 and np.linalg.norm(cluster['half']-old['half'])<1.5:pairs.append((gap,i,predicted))
                if not pairs:continue
                _,i,predicted=min(pairs,key=lambda p:p[0]);available.remove(i)
                old=self.previous[i]
                # Surface bounds shift as rays expose different parts of even a
                # stationary wall. Register measured returns instead of turning
                # bounding-box centroid jitter into invented lateral velocity.
                old_cloud=(old['cloud']-ego_translation)@rotation.T
                new_cloud=cluster['cloud']
                # Starting only at zero sticks to the interior of dense small
                # bodies (pedestrians/bikes). Compare prior-motion and measured
                # center seeds; the long baseline below still verifies motion.
                translation=register_material(new_cloud,old_cloud,
                    rotation@old.get('velocity',np.zeros(2))*dt,cluster['center']-predicted)
                measured=translation/dt
                if np.linalg.norm(measured)>12:continue
                velocity=.8*old.get('velocity',measured)+.2*measured
                cluster['velocity']=velocity;cluster['hits']=old.get('hits',0)+1
                # A few centimetres of changing ray coverage can produce an
                # inward instantaneous velocity even on a parallel parked car.
                # Require net registered lateral ingress over a bounded window,
                # preserving ego/IMU compensation for every displacement.
                motion=[(stamp,rotation@delta) for stamp,delta in old.get('motion',[])
                        if stamp>now-LATERAL_EVIDENCE_WINDOW_S]
                motion.append((now,translation));cluster['motion']=motion
                # Keep original measured clouds, not an integrated motion
                # estimate. Each is compensated into this frame using ego/IMU.
                # This independent baseline can reject cumulative ICP drift.
                history=[(stamp,(cloud-ego_translation)@rotation.T)
                         for stamp,cloud in old.get('surface_history',[(self.timestamp,old['cloud'])])
                         if stamp>=now-MOTION_WINDOW_S-1e-6]
                cluster['surface_history']=[*history,(now,cluster['cloud'])]
                side=math.copysign(1.,cluster['center'][1])
                edge=np.asarray([cluster['center'][0],cluster['center'][1]-side*cluster['half'][1]])
                edges=[(stamp,rotation@(point-ego_translation))
                       for stamp,point in old.get('edges',[]) if stamp>now-.75]
                edges.append((now,edge));cluster['edges']=edges
                if cluster['hits']<5:continue
                relative=velocity-np.asarray([speed,0.])
                # Use the same physical lateral corridor as forward sensing.
                # The old 1.8 m half-width converted adjacent-lane proximity
                # into immediate overlap before any actual ingress.
                half=cluster['half']+(geometry.half+np.array([.45,.2]) if geometry else np.asarray([2.95,1.35]))
                # Changing visible faces bias registration on parked bodies.
                # The physical inner edge must independently move into the lane.
                edge_speed=0.;edge_fit=0.
                if len(edges)>=6 and now-edges[0][0]>=.25:
                    times=np.asarray([t for t,_ in edges]);ys=np.asarray([p[1] for _,p in edges])
                    x=times-times.mean();y=ys-ys.mean();variance=float(y@y)
                    edge_speed=float(x@y/(x@x))
                    edge_fit=max(0.,1.-float(np.sum((y-edge_speed*x)**2))/variance) if variance>1e-8 else 0.
                edge_ingress=(side*edge_speed<-LATERAL_SPEED_NOISE_MPS and edge_fit>=.8)
                lateral_displacement=float(sum(delta[1] for _,delta in motion))
                inward=(cluster['center'][1]*velocity[1]<0 and
                        cluster['center'][1]*lateral_displacement<0 and
                        abs(lateral_displacement)>=MINIMUM_LATERAL_INGRESS_M and
                        abs(velocity[1])>LATERAL_SPEED_NOISE_MPS and edge_ingress)
                evidence={'state':'NOT_REQUIRED'}
                if inward:
                    baseline_stamp,baseline=history[0]
                    expected=sum((delta for stamp,delta in motion if stamp>baseline_stamp+1e-6),np.zeros(2))
                    evidence=surface_motion_evidence(cluster['cloud'],baseline,now-baseline_stamp,expected)
                measured_delta=evidence.get('displacement_m',[0.,0.])[1]
                measured_velocity=evidence.get('velocity_mps',[0.,0.])[1]
                verified=(evidence['state']=='MOVING' and side*measured_delta<-MINIMUM_LATERAL_INGRESS_M
                          and side*measured_velocity<-LATERAL_SPEED_NOISE_MPS
                          and np.linalg.norm(evidence['velocity_mps'])<=12.)
                # Forecast using the displacement that actually passed the
                # baseline test, not the biased accumulation it checked.
                forecast_velocity=np.asarray(evidence['velocity_mps']) if verified else velocity.copy()
                verified_relative=forecast_velocity-np.array([speed,0.])
                verified_relative[1]=math.copysign(min(abs(verified_relative[1]),abs(edge_speed)),verified_relative[1])
                time_to_conflict=overlap_time(cluster['center'],half,verified_relative,2.5)
                future_forward=None
                if geometry is not None:
                    from .motion_geometry import GRID,integrate,footprint_centers
                    from .prediction import occupied_overlap
                    path=np.asarray(forward_path) if forward_path is not None else integrate(speed,observation.ego.steering,geometry=geometry)
                    center=cluster['center']+GRID[:,None]*np.array([forecast_velocity[0],verified_relative[1]])
                    footprint=footprint_centers(path,geometry)
                    overlap=occupied_overlap(center,cluster['half'],footprint,geometry.half,np.full(31,.2))
                    indices=np.flatnonzero(overlap)
                    time_to_conflict=float(GRID[indices[0]]) if len(indices) else None
                    if len(indices):
                        i=indices[0];delta=center[i]-footprint[i,1:3]
                        future_forward=float(delta@np.array([np.cos(path[i,3]),np.sin(path[i,3])]))>0
                rear_approach=cluster['center'][0]<0 and relative[0]>.5
                # Test the relative longitudinal position at the predicted
                # overlap, not proximity or closing speed alone. A rear-only
                # catch-up/merge must not veto forward motion away from it.
                forward_overlap=(time_to_conflict is not None and
                    cluster['center'][0]+verified_relative[0]*time_to_conflict>0)
                if future_forward is not None:forward_overlap=future_forward
                actionable=inward and forward_overlap and verified
                relation=('FORWARD_CUT_IN' if actionable else
                          'STATIC_SURFACE' if evidence['state']=='STATIC_COMPATIBLE' else
                          'UNRESOLVED_SURFACE_MOTION' if inward and not verified else
                          'REAR_APPROACH' if rear_approach else
                          'BEHIND' if cluster['center'][0]<0 else
                          'PARALLEL_OR_LATERAL_NOISE' if abs(lateral_displacement)<MINIMUM_LATERAL_INGRESS_M else
                          'SEPARATING_OR_OUTSIDE_PATH')
                estimate={'source':'LIDAR_SURFACE_TRACK','center_m':cluster['center'].tolist(),
                          'motion_mps':velocity.tolist(),'relative_motion_mps':relative.tolist(),
                          'time_to_conflict_s':float(time_to_conflict) if time_to_conflict is not None else None,
                          'matched_frames':cluster['hits'],'relation':relation,
                          'lateral_displacement_m':lateral_displacement,
                          'surface_half_size_m':cluster['half'].tolist()}
                estimate['lateral_motion_above_noise']=bool(abs(velocity[1])>LATERAL_SPEED_NOISE_MPS)
                estimate.update(edge_lateral_speed_mps=edge_speed,edge_motion_fit=edge_fit,motion_evidence=evidence)
                if verified:estimate['forecast_motion_mps']=forecast_velocity.tolist()
                elif inward:estimate['time_to_conflict_s']=None
                observations.append(estimate)
                if actionable:
                    estimates.append(estimate)
                    if conflict is None or time_to_conflict<conflict['time_to_conflict_s']:conflict=estimate
        self.previous=current;self.timestamp=now;self.speed=speed;self.estimates=estimates
        return {'conflict':conflict,'tracked_surface_count':sum(c.get('hits',0)>=5 for c in current),
                'observations':observations,
                'coverage':'OBSERVED_LIDAR_SURFACES_ONLY; sparse/occluded side and rear directions remain UNKNOWN',
                'side_rear_free_space_verified':False}
