"""Measured-motion prediction in an odometry frame; never accepts native actors.

All modes remain distinct. Occupancy is compared at equal times, including a
launch intent while stopped. The frame origin is integrated from speed and IMU.
"""
from collections import deque
import math
import time
import numpy as np
from .path_conflicts import surfaces
from .motion_geometry import VehicleGeometry, integrate, footprint_centers
from .kinematic_prediction import kinematic_modes

GRID = np.round(np.arange(31) * .1, 6)
MAX_TRACK_OCCLUSION_S=.3


def rotation(yaw):
    c, s = math.cos(yaw), math.sin(yaw)
    return np.array([[c, -s], [s, c]])


def ego_paths(speed, steering, throttle, half=(2.5, 1.15), geometry=None):
    paths = []
    for name, acceleration in [('CONTINUE', 0.), ('BRAKE', -5.)] + ([('LAUNCH', 2.)] if throttle > .01 else []):
        if geometry is not None:
            paths.append({'intent':name,'points':footprint_centers(integrate(speed,steering,acceleration,geometry),geometry),'half':geometry.half})
            continue
        velocity=np.maximum(0.,speed+acceleration*GRID)
        distance=(velocity[:-1]+velocity[1:])*.05
        arc=np.r_[0.,np.cumsum(distance)]
        yaw=arc*math.tan(float(steering)*.6)/2.8
        mid=(yaw[:-1]+yaw[1:])*.5
        xy=np.vstack((np.zeros(2),np.cumsum(distance[:,None]*np.column_stack((np.cos(mid),np.sin(mid))),axis=0)))
        paths.append({'intent': name, 'points': np.column_stack((GRID,xy,yaw)), 'half': np.asarray(half)})
    return paths


def occupied_overlap(centers, half, ego, ego_half, uncertainty, *, padding=.2):
    """Vectorized rectangle SAT (object axis-aligned conservative measured bounds)."""
    delta = centers-ego[:, 1:3]; co = np.cos(ego[:, 3]); si = np.sin(ego[:, 3])
    oh = np.broadcast_to(np.asarray(half),(len(ego),2)) + np.asarray(uncertainty)[:, None] + padding
    return ((np.abs(delta[:, 0]) <= oh[:, 0]+ego_half[0]*np.abs(co)+ego_half[1]*np.abs(si)) &
            (np.abs(delta[:, 1]) <= oh[:, 1]+ego_half[0]*np.abs(si)+ego_half[1]*np.abs(co)) &
            (np.abs(delta[:, 0]*co+delta[:, 1]*si) <= ego_half[0]+oh[:, 0]*np.abs(co)+oh[:, 1]*np.abs(si)) &
            (np.abs(-delta[:, 0]*si+delta[:, 1]*co) <= ego_half[1]+oh[:, 0]*np.abs(si)+oh[:, 1]*np.abs(co)))


class MotionTracker:
    def __init__(self, *, enhanced=False, geometry=None):
        self.enhanced=enhanced;self.geometry=geometry
        self.tracks = {}; self.next_id = 1; self.timestamp = None
        self.origin = np.zeros(2); self.yaw = 0.; self.speed = 0.
        self.surface_history = deque(maxlen=3)

    def update(self, points, observation):
        now = observation.timestamp_s
        dt = 0. if self.timestamp is None else now-self.timestamp
        if dt < 0 or dt > .75:
            self.__init__(enhanced=self.enhanced,geometry=self.geometry); dt = 0.
        yaw_rate = float(observation.ego.angular_velocity_radps[2])
        angle = yaw_rate*dt
        from .ego_motion import signed_speed
        longitudinal=signed_speed(observation.ego)
        self.origin += rotation(self.yaw+angle*.5) @ np.array([(self.speed+longitudinal)*dt*.5, 0.])
        self.yaw += angle; self.speed = longitudinal; self.timestamp = now
        plane=None
        if self.enhanced:
            from .ground_geometry import measured_ground_plane
            plane,_=measured_ground_plane(points,self.geometry or VehicleGeometry())
        r = rotation(self.yaw)
        front=max(45.,min(90.,abs(longitudinal)*.35+longitudinal**2/10.+10.))
        clusters = surfaces(np.asarray(points),bounds=(-40.,front,15.) if self.enhanced else (-10.,30.,9.),
                            geometry=self.geometry,ground_plane=plane,
                            split_large_frame=(self.origin,r) if self.enhanced else None)
        available = set(self.tracks)
        spatial_frames=[]
        if self.enhanced:
            spatial_frames=[keys for stamp,keys in self.surface_history if 0<now-stamp<=.16+1e-6]
        current_surface_keys=set()
        # Global nearest association with one-to-one assignment, dimension gate.
        measurements = [(c, self.origin+r@c['center']) for c in clusters]
        pairs = []
        old_keys = list(self.tracks)
        if measurements and old_keys:
            ages = np.array([now-self.tracks[k]['last_seen'] for k in old_keys])
            predicted = np.array([self.tracks[k]['position']+self.tracks[k]['velocity']*age for k,age in zip(old_keys,ages)])
            gaps = np.linalg.norm(np.array([pos for _,pos in measurements])[:,None,:]-predicted[None,:,:],axis=2)
            sizes = np.linalg.norm(np.array([c['half'] for c,_ in measurements])[:,None,:]-np.array([self.tracks[k]['half'] for k in old_keys])[None,:,:],axis=2)
            for j,i in zip(*np.where((gaps < 1.+np.minimum(1.5,ages*8)) & (sizes < 1.5))):
                pairs.append((float(gaps[j,i]),old_keys[i],int(j)))
        assigned = {}; used = set()
        for _, key, j in sorted(pairs):
            if key in available and j not in used:
                assigned[j] = key; available.remove(key); used.add(j)
        clouds=[c['cloud'][::max(1,math.ceil(len(c['cloud'])/24))]@r.T+self.origin for c,_ in measurements]
        registered={}
        if assigned:
            from .surface_registration import register_surfaces
            indices=sorted(assigned);old=[self.tracks[assigned[j]] for j in indices]
            prior=[t['velocity']*(now-t['last_seen']) for t in old]
            centers=[measurements[j][1]-t.get('surface_center',t['position']) for j,t in zip(indices,old)]
            registered=dict(zip(indices,register_surfaces([clouds[j] for j in indices],
                [t['cloud'] for t in old],prior,centers,enhanced=self.enhanced)))
        for j, (c, pos) in enumerate(measurements):
            key = assigned.get(j)
            cloud = clouds[j]
            spatial_support=1
            if self.enhanced:
                # Object IDs can split as a parked body's visible faces change.
                # Count repeated *occupied measurements* in the odometry frame,
                # without carrying free space or pretending an ID has history.
                keys=np.rint(cloud/.2).astype(int)
                current_surface_keys.update(map(tuple,keys.tolist()))
                for previous_keys in spatial_frames:
                    supported=sum(any((int(x)+dx,int(y)+dy) in previous_keys
                        for dx in (-1,0,1) for dy in (-1,0,1)) for x,y in keys)
                    if len(keys) and supported/len(keys)>=.8:spatial_support+=1
            if key is None:
                key = self.next_id; self.next_id += 1
                tr = {'id': key, 'position': pos, 'half': c['half'], 'velocity': np.zeros(2),
                      'anchor': pos.copy(),
                      'acceleration': np.zeros(2), 'hits': 0, 'history': deque(maxlen=100),
                      'class': 'UNKNOWN', 'quality': 0., 'last_seen': now, 'cloud': cloud}
                self.tracks[key] = tr
            else:
                tr = self.tracks[key]; elapsed = now-tr['last_seen']
                translation=registered[j]
                measured = translation/max(.025, elapsed)
                if self.enhanced:
                    # Carry a registered material anchor through changing visible
                    # faces. Box-centroid changes are not object displacement.
                    # Material registration estimates motion. Current measured
                    # box half sizes must stay around their measured center;
                    # using the old anchor invented occupied space in the lane.
                    tr['anchor']=tr.get('anchor',tr['position'])+translation
                    if np.linalg.norm(measured)<.25: measured=np.zeros(2)
                if np.linalg.norm(measured) <= 18:
                    old = tr['velocity'].copy()
                    filtered = .65*old+.35*measured
                    if self.enhanced and tr.get('confirmed', False):
                        # A new visible face is not an instantaneous multi-m/s
                        # change in the established velocity of the same body.
                        # Initial velocity estimation remains unconstrained;
                        # established tracks obey a bounded physical change.
                        change = filtered-old
                        magnitude = np.linalg.norm(change)
                        limit = 6.*elapsed
                        if magnitude > limit: filtered = old+change*limit/max(1e-9,magnitude)
                    tr['velocity'] = filtered
                    change=(tr['velocity']-old)/max(.025, elapsed)
                    tr['acceleration'] = (.8*tr['acceleration']+.2*np.clip(change,-3.,2.)) if self.enhanced else np.clip(change,-5.,5.)
                    old_angle=math.atan2(old[1],old[0]);new_angle=math.atan2(tr['velocity'][1],tr['velocity'][0])
                    turn=(new_angle-old_angle+math.pi)%(2*math.pi)-math.pi
                    tr['turn_rate']=.8*tr.get('turn_rate',0.)+.2*np.clip(turn/max(.025,elapsed),-.7,.7) if min(np.linalg.norm(old),np.linalg.norm(tr['velocity']))>.5 else 0.
                tr['hits'] = tr['hits'] if elapsed <= (.251 if self.enhanced else .151) else 0
            surface_center=self.origin+r@c['center']
            tr.update(position=pos, surface_center=surface_center,half=c['half'], last_seen=now, cloud=cloud, hits=tr['hits']+1,support_points=c['points'])
            tr['spatially_supported_frames']=spatial_support
            tr['quality'] = min(1., tr['hits']/3.)*min(1., c['points']/6.)
            tr['history'].append((now, *(tr.get('anchor',pos) if self.enhanced else pos), *tr['velocity']))
        for key in list(available):
            if now-self.tracks[key]['last_seen'] > MAX_TRACK_OCCLUSION_S+1e-6: del self.tracks[key]
            else: self.tracks[key]['hits'] = 0  # reacquisition requires consecutive evidence
        result = []
        if self.enhanced:self.surface_history.append((now,current_surface_keys))
        for tr in self.tracks.values():
            age = now-tr['last_seen']
            if tr['hits'] >= 3 or tr.get('spatially_supported_frames',0)>=3: tr['confirmed'] = True
            local = r.T@(tr['position']+tr['velocity']*age-self.origin)
            result.append({'id': str(tr['id']), 'position_m': local.tolist(),
                'motion_anchor_m': (r.T@(tr.get('anchor',tr['position'])-self.origin)).tolist(),
                'half_size_m': tr['half'].tolist(), 'velocity_mps': (r.T@tr['velocity']).tolist(),
                'acceleration_mps2': (r.T@tr['acceleration']).tolist(),
                'class': tr['class'], 'confirmed': tr.get('confirmed', False),
                'motion_observations':tr['hits'],'turn_rate_radps':float(tr.get('turn_rate',0.)),
                'support_points':tr.get('support_points'),
                'spatially_supported_frames':tr.get('spatially_supported_frames',0),
                'heading_rad':float(math.atan2(tr['velocity'][1],tr['velocity'][0])-self.yaw) if np.linalg.norm(tr['velocity'])>=.3 else None,
                'gaze_direction':'UNKNOWN',
                'consecutive_observations': tr['hits'], 'occlusion_s': age,
                'uncertainty_m': .15+age*2., 'quality': tr['quality']*max(0., 1-age/.4),
                'history': self.sample_history(tr['history'], now),
                'fixed_position_m': (tr['position']+tr['velocity']*age).tolist()})
        return result

    @staticmethod
    def sample_history(history, now):
        h=np.asarray(history); times=now-np.arange(8,-1,-1)*.5
        times=times[(times>=h[0,0]) & (times<=h[-1,0])]
        return np.column_stack((times,*[np.interp(times,h[:,0],h[:,i]) for i in range(1,5)])).tolist()


def geometric_modes(tracks):
    result = []
    for tr in tracks:
        p = np.asarray(tr['position_m']); v = np.asarray(tr['velocity_mps'])
        result.append({'track_id': tr['id'], 'source': 'CONSTANT_VELOCITY', 'mode': 0,
            'probability': 1., 'points': np.column_stack((GRID, p+GRID[:, None]*v)).tolist()})
    return result


def intended_conflict(conflicts, speed, throttle):
    # All intents remain auditable; a stationary hold must not veto a safe
    # forward launch away from a measured rear object.
    intent = 'LAUNCH' if speed < .2 and throttle > .01 else 'CONTINUE'
    return next((c for c in conflicts if c['ego_intent'] == intent
        and not c.get('separating_rear_overlap') and not c.get('braking_worsens_rear_conflict')), None)


def assess_conflicts(tracks, modes, paths, *, grid=GRID):
    grid=np.asarray(grid,float)
    conflicts = []; indexed = {t['id']: t for t in tracks if t['confirmed']}
    accepted = [m for m in modes if m['track_id'] in indexed]
    if not accepted: return conflicts
    centers = []
    for mode in accepted:
        points = np.asarray(mode['points'])
        centers.append(np.column_stack([np.interp(grid,points[:,0],points[:,i]) for i in (1,2)]))
    centers=np.asarray(centers); ego=np.array([p['points'] for p in paths]); eh=np.array([p['half'] for p in paths])[None,:,None,:]
    half=np.array([indexed[m['track_id']]['half_size_m'] for m in accepted])[:,None,None,:]
    uncertainty=np.array([indexed[m['track_id']]['uncertainty_m'] for m in accepted])[:,None,None,None]
    oh=half+uncertainty+.12*grid[None,None,:,None]+.2
    delta=centers[:,None,:,:]-ego[None,:,:,1:3];co=np.cos(ego[None,:,:,3]);si=np.sin(ego[None,:,:,3])
    dx,dy=delta[...,0],delta[...,1];hx,hy=oh[...,0],oh[...,1];ex,ey=eh[...,0],eh[...,1]
    mask=((np.abs(dx)<=hx+ex*np.abs(co)+ey*np.abs(si)) & (np.abs(dy)<=hy+ex*np.abs(si)+ey*np.abs(co)) &
          (np.abs(dx*co+dy*si)<=ex+hx*np.abs(co)+hy*np.abs(si)) &
          (np.abs(-dx*si+dy*co)<=ey+hx*np.abs(si)+hy*np.abs(co)))
    brake_index=next((i for i,p in enumerate(paths) if p['intent']=='BRAKE'),None)
    for mi,pi in zip(*np.where(mask.any(axis=2))):
        i=int(np.argmax(mask[mi,pi]));mode=accepted[mi];tr=indexed[mode['track_id']]
        # A padded overlap already behind the vehicle cannot be resolved by
        # holding still. Permit only motion that increases longitudinal
        # separation at every sampled instant and completely clears that
        # overlap without re-entering it. Closing rear traffic, front hazards,
        # and future crossings retain their normal conflict decision.
        rear_separating = bool(mask[mi,pi,0] and dx[mi,pi,0] < -ex[0,pi,0]
            and np.all(np.diff(dx[mi,pi]) <= 1e-6) and not mask[mi,pi,-1]
            and not np.any(np.diff(mask[mi,pi].astype(np.int8)) > 0))
        # A rear conflict is still recorded, but must not command the action
        # that makes it worse. Forward motion dominates braking only if every
        # forward overlap also occurs under braking, braking has strictly more
        # overlap samples, the object stays behind, and forward motion clears
        # it within the same horizon. Other objects are assessed independently.
        brake_worse=bool(brake_index is not None and pi!=brake_index
            and dx[mi,pi,0] < -ex[0,pi,0] and np.all(dx[mi,pi]<0)
            and not mask[mi,pi,-1] and not np.any(mask[mi,pi] & ~mask[mi,brake_index])
            and np.sum(mask[mi,pi]) < np.sum(mask[mi,brake_index]))
        conflicts.append({'track_id':tr['id'],'mode':mode['mode'],'source':mode['source'],
            'ego_intent':paths[pi]['intent'],'time_s':float(grid[i]),'point_m':centers[mi,i].tolist(),
            'half_size_m':tr['half_size_m'],'trajectory':mode['points'],'probability':mode['probability'],
            'separating_rear_overlap':rear_separating,'braking_worsens_rear_conflict':brake_worse})
    return sorted(conflicts, key=lambda c: c['time_s'])


class PredictionEngine:
    def __init__(self, session_id, *, enhanced=False, geometry=None):
        self.session_id = session_id;self.enhanced=enhanced;self.geometry=geometry
        self.tracker = MotionTracker(enhanced=enhanced,geometry=geometry); self.latest = None

    def evaluate(self, points, observation, base, learned_modes=None, *, control_only=False):
        began = time.perf_counter()
        tracks = self.tracker.update(points, observation)
        # Control labels are associated after tracking; its physical modes are
        # then generated once from those labels and the complete stop horizon.
        modes = [] if control_only else (kinematic_modes(tracks) if self.enhanced else geometric_modes(tracks)) if learned_modes is None else learned_modes
        paths = [] if control_only else ego_paths(observation.ego.speed_mps, base.steering, base.throttle,geometry=self.geometry)
        conflicts = [] if control_only else assess_conflicts(tracks, modes, paths)
        self.latest = {'version': 3 if self.enhanced else 2, 'session_id': self.session_id, 'evaluation_frame': observation.frame_id,
            'timestamp_s': observation.timestamp_s, 'prediction_source_frame': observation.frame_id,
            'prediction_source_timestamp_s': observation.timestamp_s, 'coordinate_frame': 'EGO_AT_EVALUATION',
            'odometry_origin_m': self.tracker.origin.tolist(), 'odometry_yaw_rad': self.tracker.yaw,
            'horizon_s': 3., 'control_interval_s': .1, 'tracks': tracks, 'trajectories': modes,
            'ego_trajectories': [{'intent': p['intent'], 'points': p['points'].tolist()} for p in paths],
            'conflict_point': intended_conflict(conflicts, observation.ego.speed_mps, base.throttle),
            'conflicts': conflicts, 'decision_source': 'RULE',
            'quality_metrics': {'geometry_ms': (time.perf_counter()-began)*1000,
                'confirmed_tracks': sum(t['confirmed'] for t in tracks),
                'coverage': 'MEASURED_SURFACES_ONLY; OCCLUDED SPACE UNKNOWN'}}
        return self.latest
