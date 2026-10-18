"""Seeded physical stress traffic; never an ego policy or an outcome script."""
import math
import random
from types import SimpleNamespace


class DenseChaos:
    def __init__(self, provider, seed):
        self.provider=provider;self.seed=seed;self.running=False;self.plans={};self.bindings={}
        self.started_at=None;self.observations={};self.samples={};self.moved=set();self.audit_started=None
        self.sample_at=None;self.motion_ready=False;self.motion_window_s=None
        self.latest_audit=None;self.last_audit_at=-float('inf')
        self.audit_series={'samples':0,'density_failures':0,'motion_samples':0,'motion_failures':0}
        # Reuse the existing physical waypoint follower, without scenario/RL ownership.
        from .urban_chaos import UrbanPhysics
        self.follower=SimpleNamespace(manager=SimpleNamespace(provider=provider),indices={})
        self.follow=lambda *args:UrbanPhysics.follow(self.follower,*args)

    def bind(self, rows):
        self.bindings={r['role']:r['id'] for r in rows}
        self.follower.indices.clear();self.observations={};self.running=False
        # Native IDs change after reconstruction. Each arm needs a fresh
        # displacement baseline; setup motion must not count as driving motion.
        self.samples={};self.moved=set();self.audit_started=None
        self.sample_at=None;self.motion_ready=False;self.motion_window_s=None
        self.latest_audit=None;self.last_audit_at=-float('inf')
        self.audit_series={'samples':0,'density_failures':0,'motion_samples':0,'motion_failures':0}

    def compile(self, rows):
        self.bind(rows);p=self.provider;api=p.connection.api;native_map=p.world.world.get_map()
        rng=random.Random(self.seed)
        vehicles=[r for r in rows if r['blueprint'].startswith('vehicle.')]
        origin=p.ego.actor.get_location()
        vehicles.sort(key=lambda r:math.dist(r['pose']['location'],(origin.x,origin.y,origin.z)))
        opposing={}
        for row in vehicles:
            wp=native_map.get_waypoint(api.Location(*row['pose']['location']))
            frontier=[wp];visited=set()
            for _ in range(4):
                next_frontier=[]
                for candidate in frontier:
                    if candidate is None or candidate.lane_type!=api.LaneType.Driving:continue
                    key=(candidate.road_id,candidate.lane_id)
                    if key in visited:continue
                    visited.add(key)
                    if abs((candidate.transform.rotation.yaw-wp.transform.rotation.yaw+180)%360-180)>120:
                        opposing[row['role']]=candidate;break
                    next_frontier.extend((candidate.get_left_lane(),candidate.get_right_lane()))
                if row['role'] in opposing:break
                frontier=next_frontier
        oncoming=next((r['role'] for r in vehicles[2:] if r['role'] in opposing),None)
        for index,row in enumerate(vehicles):
            role=row['role'];kind='BRAKE' if index==0 else 'CUT_IN' if index==1 else 'ONCOMING' if role==oncoming or oncoming is None and index==2 else 'TRAFFIC_MANAGER'
            plan={'kind':kind,'start_s':round(rng.uniform(4.,10.),2),'duration_s':round(rng.uniform(2.,4.),2)}
            if kind=='ONCOMING':
                if role in opposing:
                    other=opposing[role];path=[other]
                    for _ in range(12):
                        choices=path[-1].next(2.)
                        if not choices:break
                        path.append(choices[0])
                    plan['points']=[[w.transform.location.x,w.transform.location.y,w.transform.location.z] for w in path]
                    plan['target_lane']=[other.road_id,other.lane_id]
                else:plan.update(kind='ONCOMING',available=False,reason='No adjacent opposing native lane')
            self.plans[role]=plan

    def start(self):
        self.running=True;self.started_at=self.provider.last_vehicle['timestamp']

    def after_tick(self,snapshot):
        if self.running and snapshot.timestamp.elapsed_seconds-self.last_audit_at>=1.:
            self.last_audit_at=snapshot.timestamp.elapsed_seconds
            self.latest_audit=self.audit(snapshot)
            self.audit_series['samples']+=1
            self.audit_series['density_failures']+=int(not self.latest_audit['density_passed'])
            if self.latest_audit['motion_measurement_ready']:
                self.audit_series['motion_samples']+=1
                self.audit_series['motion_failures']+=int(not self.latest_audit['motion_passed'])
            self.latest_audit['series']=dict(self.audit_series)
            self.latest_audit['sustained_passed']=bool(self.audit_series['motion_samples'] and not (
                self.audit_series['density_failures'] or self.audit_series['motion_failures']))

    def before_tick(self):
        if not self.running:return
        p=self.provider;api=p.connection.api;tm=p.population.traffic_manager;elapsed=p.last_vehicle['timestamp']-self.started_at
        for role,plan in self.plans.items():
            if plan['kind']=='TRAFFIC_MANAGER' or elapsed<plan['start_s']:continue
            actor=p.world.world.get_actor(self.bindings.get(role))
            event=self.observations.setdefault(role,{'kind':plan['kind']})
            if actor is None:event['status']='ACTOR_LOST';continue
            if plan.get('available') is False:event.update(status='UNAVAILABLE',reason=plan['reason']);continue
            if plan['kind']=='CUT_IN':
                if not event.get('requested'):
                    tm.manager.force_lane_change(actor, bool(self.seed%2));event.update(requested=True,status='REQUESTED')
            elif elapsed<plan['start_s']+plan['duration_s'] or plan['kind']=='ONCOMING':
                if not event.get('claimed'):actor.set_autopilot(False,tm.port);event['claimed']=True
                if plan['kind']=='BRAKE':actor.apply_control(api.VehicleControl(brake=1.));event['status']='BRAKING'
                else:
                    reached=self.follow(actor,plan['points'],3.,role)
                    event['status']='TARGET_REACHED' if reached else 'MOVING'
                    if reached:actor.apply_control(api.VehicleControl(brake=1.))
            elif event.get('claimed') and not event.get('released'):
                actor.set_autopilot(True,tm.port);event.update(released=True,status='RELEASED')
            loc=actor.get_location();event['position_m']=[loc.x,loc.y,loc.z]
            event['speed_mps']=actor.get_velocity().length()
            if plan['kind']=='ONCOMING' and plan.get('target_lane'):
                wp=p.world.world.get_map().get_waypoint(loc)
                if wp and [wp.road_id,wp.lane_id]==plan['target_lane']:event['opposing_lane_observed']=True

    def audit(self,snapshot=None):
        p=self.provider;snapshot=snapshot or p.world.world.get_snapshot();ego=snapshot.find(p.ego.actor.id)
        if ego is None:raise ValueError('Stress-test ego missing')
        pose=ego.get_transform();origin=pose.location;forward=pose.get_forward_vector();right=pose.get_right_vector()
        counts={};current={};groups={}
        for category,ids in (('vehicles',p.population.vehicles),('pedestrians',p.population.walkers)):
            rows=[snapshot.find(i) for i in ids];rows=[r for r in rows if r is not None]
            nearby=[];frustum=[]
            for row in rows:
                loc=row.get_transform().location;distance=loc.distance(origin)
                current[row.id]=(loc.x,loc.y,loc.z)
                if distance<=120:nearby.append(row.id)
                dx=loc.x-origin.x;dy=loc.y-origin.y;f=dx*forward.x+dy*forward.y;l=abs(dx*right.x+dy*right.y)
                if 0<f<=100 and l<=f:frustum.append(row.id)
            counts[category]={'total':len(rows),'near_120m':len(nearby),'front_frustum_100m':len(frustum),
                'moving_near':0,'moving_front_frustum':0}
            groups[category]=(set(nearby),set(frustum))
        stamp=snapshot.timestamp.elapsed_seconds
        if self.sample_at is None:self.samples=current;self.sample_at=stamp
        elif stamp-self.sample_at>=1.:
            # Measure actual displacement over the latest window. Snapshot
            # velocity is not used as a proxy for native walker movement.
            self.moved={i for i,pose in current.items() if i in self.samples and math.dist(pose,self.samples[i])>.25}
            self.motion_window_s=stamp-self.sample_at;self.motion_ready=True
            self.samples=current;self.sample_at=stamp
        for category,(nearby,frustum) in groups.items():
            counts[category].update(moving_near=len(nearby&self.moved),moving_front_frustum=len(frustum&self.moved))
        if self.audit_started is None:self.audit_started=stamp
        elapsed=stamp-self.audit_started
        v=counts['vehicles'];w=counts['pedestrians']
        density=v['total']>=40 and w['total']>=50 and v['near_120m']>=15 and w['near_120m']>=20 and v['front_frustum_100m']>=5 and w['front_frustum_100m']>=4
        motion=v['moving_front_frustum']>=3 and w['moving_front_frustum']>=2
        return {'frame_id':snapshot.frame,'counts':counts,'requested':{'vehicles':40,'pedestrians':50},
            'passed':density and motion,'pending':elapsed<8 and not (density and motion),
            'scope':'Native positions and displacement in front viewing cone; occlusion and behavior diversity require camera review',
            'density_passed':density,'motion_passed':motion,'motion_measurement_ready':self.motion_ready,
            'motion_window_s':self.motion_window_s,'motion_sample_age_s':stamp-self.sample_at,'observations':self.observations}
