"""Physical, repeatable road users. Schedules/truth are never policy inputs."""
import copy
import hashlib
import json
import math
import random
from pathlib import Path
from .dense_chaos import DenseChaos

CONFIG=Path(__file__).resolve().parents[2]/'config/crossing-comparison.json'
PROTOCOL='SUDDEN_PEDESTRIAN_COMPARISON_V1'


def catalogue():return json.loads(CONFIG.read_text(encoding='utf8'))


def sidewalk_pair(candidates,arc,right_start,local,used):
    """Construction-only native navigation endpoints, outside driving lanes.

    A long synthetic sidewalk approach crossed static street furniture and
    could displace a character far from the scheduled crossing. Stage the
    waiting character on the actual navmesh and preserve its measured point.
    """
    def side(y,right):return 7.<=y<=18. if right else -26.<=y<=-10.
    rows=[([float(p.x),float(p.y),float(p.z)],*local([p.x,p.y,p.z])) for p,*_ in candidates]
    starts=[r for r in rows if side(r[2],right_start) and abs(r[1]-arc)<=12.
        and all(math.dist(r[0][:2],prior[:2])>2. for prior in used)]
    if not starts:raise ValueError('No clear native sidewalk start near the scheduled crossing')
    pairs=[(a,b)for a in starts for b in rows if side(b[2],not right_start) and abs(a[1]-b[1])<=6.]
    selected=min(pairs,key=lambda pair:abs(pair[0][1]-arc)+2.*abs(pair[0][1]-pair[1][1])
        +.5*abs(pair[0][2]-(9. if right_start else -16.)),default=None)
    if selected is None:raise ValueError('No opposite native sidewalk endpoint near the scheduled crossing')
    start,end=selected
    return start[0],end[0]


def approach_occupied(x,y,category,critical_m=90.):
    # A rider is also a real camera-detected person. Keep motorcycles/bicycles
    # out of adjacent approach lanes so their possible ingress cannot become
    # the earlier explanation for slowing before the critical walker. This is
    # construction-only and is replayed identically, never a policy exception.
    return (0<x<140 and abs(y)<(8. if category in ('motorcycle','bicycle') else 2.5)
        or 0<x<critical_m+10 and 0<y<8.)


class CrossingComparison(DenseChaos):
    def __init__(self,provider,seed):
        super().__init__(provider,seed)
        library=catalogue();self.library_revision=library['revision']
        self.spec=copy.deepcopy(library['variants'][seed%len(library['variants'])])
        self.variant_id=self.spec['id'];self.critical_role='critical_pedestrian'
        self.origin=None;self.forward=None;self.right=None

    def descriptor(self):
        spec={key:value for key,value in self.spec.items() if key!='validated'}
        definition={'protocol':PROTOCOL,'library_revision':self.library_revision,'seed':self.seed,'parameters':spec,'events':self.plans}
        return {'protocol':PROTOCOL,'id':self.variant_id,'seed':self.seed,'parameters':spec,
            'definition_sha256':hashlib.sha256(json.dumps(definition,sort_keys=True).encode()).hexdigest(),
            'validated':self.spec.get('validated',False),'library_revision':self.library_revision,'critical_role':self.critical_role,
            'events':copy.deepcopy(self.plans),
            'outcome_source':'NATIVE_COLLISION_SENSOR_AND_ROUTE_ARRIVAL'}

    def bind(self,rows):
        super().bind(rows)
        # libcarla caches the last WalkerControl on the Python actor handle.
        # A fresh wrapper starts at zero and suppresses a zero-speed command,
        # even when another wrapper previously sent movement to that actor.
        # Retain one handle per role throughout an episode, including stops.
        self.walker_handles={role:self.provider.world.world.get_actor(identity)
            for role,identity in self.bindings.items() if role in self.plans}
        for role,plan in self.plans.items():
            if plan.get('kind')!='CROSSING':continue
            entry=self.provider.population.walkers.get(self.bindings.get(role))
            if entry is not None:entry['scripted_crossing']=True
        for row in rows:
            entry=self.provider.population.walkers.get(row['id'])
            if entry is not None and row.get('sidewalk_only'):entry.update(sidewalk_only=True,no_wait=True)

    def compile(self,rows):
        p=self.provider;api=p.connection.api;pose=p.ego.actor.get_transform()
        self.origin=pose.location;self.forward=pose.get_forward_vector();self.right=pose.get_right_vector()
        self.yaw=pose.rotation.yaw;rng=random.Random(self.seed)
        people=[row for row in rows if row['blueprint'].startswith('walker.')]
        if len(people)<9:raise ValueError('Crossing comparison requires nine physical crossing participants')
        self.plans={};crossing_starts=[]
        for index,row in enumerate(people[:9]):
            role=self.critical_role if index==0 else f'crossing_{index:02d}';row['role']=role
            if index==0:row['blueprint']=self.spec['critical_blueprint']
            right_start=index==0 or index%2==0
            arc=(self.spec['crossing_m'] if index==0 else
                {1:74.,2:98.,3:105.,4:112.,5:119.55,6:127.,7:135.,8:144.}[index])
            lateral=self.spec['lateral_m'] if index==0 else 7. if right_start else -16.
            destination=-16. if right_start else 7.
            start=self.spec['start_s'] if index==0 else self.spec['start_s']+5.5+index*.7
            curb=self.point(arc,lateral,.95)
            target=self.point(arc,destination,.95)
            if index>0:curb,target=sidewalk_pair(p.population.sidewalk_locations or [],arc,right_start,self.local,crossing_starts)
            position=curb;crossing_starts.append(position)
            waiting_yaw=self.spec.get('waiting_yaw_offset_deg',-90) if index==0 else -90 if right_start else 90
            row.update(pose={'location':position,'rotation':[0.,self.yaw+waiting_yaw,0.]},
                destination=target,speed_mps=self.spec['speed_mps'] if index==0 else rng.uniform(1.3,2.5),
                activity='WAITING',crossing=True,wait_remaining_s=0.)
            # A walker previously attached to an AI controller cannot accept
            # manual WalkerControl, even after stop(). Construct a fresh,
            # unpossessed character before capture; never change an episode.
            p.population._remove_walker(row['id'])
            bp=p.world.world.get_blueprint_library().find(row['blueprint'])
            if bp.has_attribute('role_name'):bp.set_attribute('role_name','ostorha_participant_'+role)
            for key,value in row.get('attributes',{}).items():
                if bp.has_attribute(key):bp.set_attribute(key,value)
            actor=p.world.world.spawn_actor(bp,api.Transform(api.Location(position[0],position[1],position[2]+100.),
                api.Rotation(yaw=row['pose']['rotation'][1])))
            actor.set_simulate_physics(False)
            row.update(id=actor.id,control_owner='SCRIPTED_WALKER')
            p.population.walkers[actor.id]={'controller_id':None,'manual':True,'scripted_crossing':True,
                'speed':row['speed_mps'],'started':False,'seen':False,'ready_at':0.,'location':api.Location(*position),
                'destination':None,'last_retarget':0.,'wait_until':None,'crossing':False,'activity':'WAITING',
                'admitted_at_frame':p.population.frame_id}
            self.plans[role]={'kind':'CROSSING','critical':index==0,'origin':curb,'target':row['destination'],
                'start_s':start,'speed_mps':row['speed_mps'],'direction':-1 if right_start else 1,'repeat':False,
                'exit_target':[target[0]-12.*self.forward.x,target[1]-12.*self.forward.y,target[2]],'sidewalk_speed_mps':1.3}
        # Put ordinary walkers on real, navigable sidewalks near the route.
        candidates=list(p.population.sidewalk_locations or [])
        def score(candidate,arc=90.):
            location=candidate[0];dx=location.x-self.origin.x;dy=location.y-self.origin.y
            along=dx*self.forward.x+dy*self.forward.y;lateral=dx*self.right.x+dy*self.right.y
            return abs(along-arc)+abs(lateral)*2. if 10<along<210 and 14<=abs(lateral)<28 else 1e6
        rng.shuffle(candidates);candidates.sort(key=score);used=[r['pose']['location'] for r in people[:9]]
        for ordinal,row in enumerate(people[9:]):
            # Keep ordinary pedestrians visible along the street rather than
            # packing every sidewalk start into the critical crossing. Explicit
            # bidirectional events own crossings; ambient AI keeps its sidewalk.
            candidates.sort(key=lambda c:score(c,30.+(ordinal%8)*21.))
            candidate=next((c for c in candidates if score(c)<1e6 and all(math.dist((c[0].x,c[0].y),q[:2])>1.5 for q in used)),None)
            if candidate is None:
                # Preserve all actors on genuine navmesh without placing a
                # waiting crowd beside the critical approach. Later/behind
                # sidewalks remain part of the populated city.
                def safe(c):
                    x,y=self.local([c[0].x,c[0].y,c[0].z])
                    return (abs(y)>=14. or x<0 or x>self.spec['crossing_m']+30.) and all(math.dist((c[0].x,c[0].y),q[:2])>1.5 for q in used)
                candidate=next((c for c in candidates if safe(c)),None)
            if candidate is None:raise ValueError('Insufficient native sidewalk space for the comparison population')
            loc=candidate[0];row['pose']['location']=[loc.x,loc.y,.95]
            row.update(sidewalk_only=True,crossing=False,activity='WALKING',wait_remaining_s=0.)
            used.append(row['pose']['location'])
            target=p.population._sidewalk_destination(loc)
            row['destination']=[target.x,target.y,target.z] if target else None
        # Keep the critical approach lane and the real crossing unobstructed.
        # Relocation is construction only, before either recorded drive starts.
        vehicles=[r for r in rows if r['blueprint'].startswith('vehicle.')]
        spawns=list(p.dashboard_tools.spawns);rng.shuffle(spawns)
        occupied=[r['pose']['location'] for r in vehicles]
        for row in vehicles:
            x,y=self.local(row['pose']['location'])
            near_hero=math.dist(row['pose']['location'][:2],self.plans[self.critical_role]['origin'][:2])<9.
            category=row['profile'].get('category')
            if not (approach_occupied(x,y,category,self.spec['crossing_m']) or near_hero):continue
            old=row['pose']['location'];occupied.remove(old)
            def available(t):
                q=[t.location.x,t.location.y,t.location.z];xx,yy=self.local(q)
                return not (approach_occupied(xx,yy,category,self.spec['crossing_m']) or
                    0<xx<145 and abs(yy)<3.) and math.dist(q[:2],old[:2])>10 and all(math.dist(q[:2],o[:2])>9 for o in occupied)
            target=next((t for t in spawns if available(t)),None)
            if target is None:raise ValueError('No legal free construction slot for approach traffic')
            row['pose']={'location':[target.location.x,target.location.y,target.location.z],
                'rotation':[target.rotation.pitch,target.rotation.yaw,target.rotation.roll]}
            row['profile']['route_points']=[];occupied.append(row['pose']['location'])
        self.bind(rows)

    def point(self,x,y,z):
        return [self.origin.x+self.forward.x*x+self.right.x*y,self.origin.y+self.forward.y*x+self.right.y*y,z]

    def local(self,point):
        dx=point[0]-self.origin.x;dy=point[1]-self.origin.y
        return dx*self.forward.x+dy*self.forward.y,dx*self.right.x+dy*self.right.y

    def before_tick(self):
        if not self.running:return
        p=self.provider;api=p.connection.api;elapsed=p.last_vehicle['timestamp']-self.started_at
        for role,plan in self.plans.items():
            actor=self.walker_handles.get(role);entry=p.population.walkers.get(self.bindings.get(role))
            if actor is None or entry is None:continue
            controller=p.world.world.get_actor(entry['controller_id']) if entry['controller_id'] is not None else None
            if not entry.get('scripted_owner'):
                if controller:controller.stop()
                entry['scripted_owner']=True
            loc=actor.get_location();position=[loc.x,loc.y,loc.z]
            event=self.observations.setdefault(role,{'kind':'CROSSING','critical':plan['critical'],'start_s':plan['start_s'],
                'realized':False,'crossed_path':False,'cleared_ego_path':False,'completed':False,'start_position':None})
            crossing=elapsed>=plan['start_s'] and not event['completed']
            approaching=elapsed<plan['start_s'] and bool(plan.get('approach_origin'))
            leaving=event['completed'] and bool(plan.get('exit_target')) and not event.get('exit_completed')
            target=plan['origin'] if approaching else plan['exit_target'] if leaving else plan['target']
            if crossing and event['start_position'] is None:
                event.update(start_position=position,first_crossing_command_s=elapsed)
            distance=math.dist(position[:2],target[:2]);moving=(crossing or approaching or leaving) and distance>.4
            speed=plan.get('sidewalk_speed_mps',1.3) if approaching or leaving else plan['speed_mps']
            if moving:
                direction=api.Vector3D((target[0]-loc.x)/distance,(target[1]-loc.y)/distance,0.)
                actor.apply_control(api.WalkerControl(direction=direction,speed=speed))
            else:actor.apply_control(api.WalkerControl(speed=0.))
            event.update(position_m=position,speed_mps=actor.get_velocity().length(),
                phase='APPROACHING' if approaching else 'CROSSING' if crossing else 'LEAVING' if leaving else 'COMPLETE' if event['completed'] else 'WAITING')
            if plan['critical'] and 'first_motion_elapsed_s' not in event and math.dist(position[:2],plan['origin'][:2])>.05:
                event['first_motion_elapsed_s']=elapsed
            if event['start_position']:
                event['realized']|=math.dist(position[:2],event['start_position'][:2])>.5
                _,lateral=self.local(position);event['crossed_path']|=abs(lateral)<1.
                event['cleared_ego_path']|=lateral*plan['direction']>2.
                if crossing and distance<=.4:event['completed']=True
            if leaving and distance<=.4:event['exit_completed']=True
            entry.update(started=True,ready_at=0.,activity='WALKING' if moving and (approaching or leaving) else 'CROSSING' if moving else 'WAITING',crossing=moving and crossing)

    def after_tick(self,snapshot):
        super().after_tick(snapshot)
        fixture=getattr(self.provider,'benchmark_fixture',None)
        held=not self.running and fixture and fixture.frozen and not getattr(fixture,'held_current',False)
        if not self.running and not held:return
        elapsed=snapshot.timestamp.elapsed_seconds-self.started_at if self.running else None
        if elapsed is not None and elapsed>25.:return
        ego=snapshot.find(self.provider.ego.actor.id)
        if ego is None:return
        pose=ego.get_transform();f=pose.get_forward_vector();right=pose.get_right_vector();roles={}
        for role,identity in self.bindings.items():
            actor=snapshot.find(identity)
            if actor is None:continue
            t=actor.get_transform();dx=t.location.x-pose.location.x;dy=t.location.y-pose.location.y
            x=dx*f.x+dy*f.y;y=dx*right.x+dy*right.y
            if 0<x<=70 and abs(y)<=x:roles[role]=[t.location.x,t.location.y,t.location.z,t.rotation.yaw]
        self.provider.comparison_evidence={'frame_id':snapshot.frame,'timestamp_s':snapshot.timestamp.elapsed_seconds,
            'elapsed_s':elapsed,'phase':'HELD_START' if held else 'DRIVING','scenario_id':self.variant_id,'roles':roles,
            'source':'EVALUATOR_NATIVE_WORLD_NOT_POLICY_INPUT'}

    def run_evidence(self):
        return {'scenario':self.descriptor(),'critical_actor_id':self.bindings.get(self.critical_role),
            'clock_epoch_s':self.started_at,
            'events':copy.deepcopy(self.observations)}
