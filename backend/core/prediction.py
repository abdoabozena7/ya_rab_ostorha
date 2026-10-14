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


def occupied_overlap(centers, half, ego, ego_half, uncertainty):
    """Vectorized rectangle SAT (object axis-aligned conservative measured bounds)."""
    delta = centers-ego[:, 1:3]; co = np.cos(ego[:, 3]); si = np.sin(ego[:, 3])
    oh = np.asarray(half)[None, :] + np.asarray(uncertainty)[:, None] + .2
    return ((np.abs(delta[:, 0]) <= oh[:, 0]+ego_half[0]*np.abs(co)+ego_half[1]*np.abs(si)) &
            (np.abs(delta[:, 1]) <= oh[:, 1]+ego_half[0]*np.abs(si)+ego_half[1]*np.abs(co)) &
            (np.abs(delta[:, 0]*co+delta[:, 1]*si) <= ego_half[0]+oh[:, 0]*np.abs(co)+oh[:, 1]*np.abs(si)) &
            (np.abs(-delta[:, 0]*si+delta[:, 1]*co) <= ego_half[1]+oh[:, 0]*np.abs(si)+oh[:, 1]*np.abs(co)))


class MotionTracker:
    def __init__(self, *, enhanced=False, geometry=None):
        self.enhanced=enhanced;self.geometry=geometry
        self.tracks = {}; self.next_id = 1; self.timestamp = None
        self.origin = np.zeros(2); self.yaw = 0.; self.speed = 0.

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
        clusters = surfaces(np.asarray(points),bounds=(-40.,45.,15.) if self.enhanced else (-10.,30.,9.),
                            geometry=self.geometry,ground_plane=plane)
        r = rotation(self.yaw); available = set(self.tracks)
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
        for j, (c, pos) in enumerate(measurements):
            key = assigned.get(j)
            cloud = c['cloud'][::max(1,math.ceil(len(c['cloud'])/24))]@r.T+self.origin
            if key is None:
                key = self.next_id; self.next_id += 1
                tr = {'id': key, 'position': pos, 'half': c['half'], 'velocity': np.zeros(2),
                      'acceleration': np.zeros(2), 'hits': 0, 'history': deque(maxlen=100),
                      'class': 'UNKNOWN', 'quality': 0., 'last_seen': now, 'cloud': cloud}
                self.tracks[key] = tr
            else:
                tr = self.tracks[key]; elapsed = now-tr['last_seen']
                # Register surfaces rather than differentiate unstable box centers.
                translation = tr['velocity']*elapsed
                seeds=[translation]
                if self.enhanced:
                    # A fast target can move farther than the registration
                    # inlier radius between scans. A zero-velocity initial guess
                    # then incorrectly freezes its anchor and repeatedly births
                    # new IDs. Seed from measured surface displacement too.
                    seeds.append(pos-tr.get('surface_center',tr['position']))
                registrations=[]
                for seed in seeds:
                    trial=seed.copy();count=0
                    for _ in range(3 if self.enhanced else 2):
                        differences = cloud[:, None, :]-(tr['cloud']+trial)[None, :, :]
                        nearest = np.argmin(np.sum(differences*differences, axis=2), axis=1)
                        residual = differences[np.arange(len(cloud)), nearest]
                        selected = residual[np.linalg.norm(residual, axis=1) < .65]
                        if len(selected) < 3:break
                        count=len(selected);trial+=np.median(selected,axis=0)
                    if count>=3:
                        residuals=cloud[:,None,:]-(tr['cloud']+trial)[None,:,:]
                        fit=float(np.median(np.min(np.linalg.norm(residuals,axis=2),axis=1)))
                        registrations.append((fit+.01*np.linalg.norm(trial-translation),trial))
                if registrations:translation=min(registrations,key=lambda r:r[0])[1]
                measured = translation/max(.025, elapsed)
                if self.enhanced:
                    # Carry a registered material anchor through changing visible
                    # faces. Box-centroid changes are not object displacement.
                    pos=tr['position']+translation
                    if np.linalg.norm(measured)<.25: measured=np.zeros(2)
                if np.linalg.norm(measured) <= 18:
                    old = tr['velocity'].copy()
                    tr['velocity'] = .65*old+.35*measured
                    change=(tr['velocity']-old)/max(.025, elapsed)
                    tr['acceleration'] = (.8*tr['acceleration']+.2*np.clip(change,-3.,2.)) if self.enhanced else np.clip(change,-5.,5.)
                    old_angle=math.atan2(old[1],old[0]);new_angle=math.atan2(tr['velocity'][1],tr['velocity'][0])
                    turn=(new_angle-old_angle+math.pi)%(2*math.pi)-math.pi
                    tr['turn_rate']=.8*tr.get('turn_rate',0.)+.2*np.clip(turn/max(.025,elapsed),-.7,.7) if min(np.linalg.norm(old),np.linalg.norm(tr['velocity']))>.5 else 0.
                tr['hits'] = tr['hits'] if elapsed <= (.251 if self.enhanced else .151) else 0
            surface_center=self.origin+r@c['center']
            tr.update(position=pos, surface_center=surface_center,half=c['half'], last_seen=now, cloud=cloud, hits=tr['hits']+1)
            tr['quality'] = min(1., tr['hits']/3.)*min(1., c['points']/6.)
            tr['history'].append((now, *pos, *tr['velocity']))
        for key in list(available):
            if now-self.tracks[key]['last_seen'] > .3+1e-6: del self.tracks[key]
            else: self.tracks[key]['hits'] = 0  # reacquisition requires consecutive evidence
        result = []
        for tr in self.tracks.values():
            age = now-tr['last_seen']
            if tr['hits'] >= 3: tr['confirmed'] = True
            local = r.T@(tr['position']+tr['velocity']*age-self.origin)
            result.append({'id': str(tr['id']), 'position_m': local.tolist(),
                'half_size_m': tr['half'].tolist(), 'velocity_mps': (r.T@tr['velocity']).tolist(),
                'acceleration_mps2': (r.T@tr['acceleration']).tolist(),
                'class': tr['class'], 'confirmed': tr.get('confirmed', False),
                'motion_observations':tr['hits'],'turn_rate_radps':float(tr.get('turn_rate',0.)),
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


def assess_conflicts(tracks, modes, paths):
    conflicts = []; indexed = {t['id']: t for t in tracks if t['confirmed']}
    accepted = [m for m in modes if m['track_id'] in indexed]
    if not accepted: return conflicts
    centers = []
    for mode in accepted:
        points = np.asarray(mode['points'])
        centers.append(np.column_stack([np.interp(GRID,points[:,0],points[:,i]) for i in (1,2)]))
    centers=np.asarray(centers); ego=np.array([p['points'] for p in paths]); eh=np.array([p['half'] for p in paths])[None,:,None,:]
    half=np.array([indexed[m['track_id']]['half_size_m'] for m in accepted])[:,None,None,:]
    uncertainty=np.array([indexed[m['track_id']]['uncertainty_m'] for m in accepted])[:,None,None,None]
    oh=half+uncertainty+.12*GRID[None,None,:,None]+.2
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
            'ego_intent':paths[pi]['intent'],'time_s':float(GRID[i]),'point_m':centers[mi,i].tolist(),
            'half_size_m':tr['half_size_m'],'trajectory':mode['points'],'probability':mode['probability'],
            'separating_rear_overlap':rear_separating,'braking_worsens_rear_conflict':brake_worse})
    return sorted(conflicts, key=lambda c: c['time_s'])


class PredictionEngine:
    def __init__(self, session_id, *, enhanced=False, geometry=None):
        self.session_id = session_id;self.enhanced=enhanced;self.geometry=geometry
        self.tracker = MotionTracker(enhanced=enhanced,geometry=geometry); self.latest = None

    def evaluate(self, points, observation, base, learned_modes=None):
        began = time.perf_counter()
        tracks = self.tracker.update(points, observation)
        modes = (kinematic_modes(tracks) if self.enhanced else geometric_modes(tracks)) if learned_modes is None else learned_modes
        paths = ego_paths(observation.ego.speed_mps, base.steering, base.throttle,geometry=self.geometry)
        conflicts = assess_conflicts(tracks, modes, paths)
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
