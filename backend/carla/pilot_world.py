"""Independent native fixture construction and simulation-time event evidence.

This module lives on the evaluator side. Actor identities, future schedules and
native poses never enter a ControlScene or a policy observation.
"""
import hashlib
import json
import math
import random

SUPPORTED={'EMPTY_ROAD','CURVE','BENIGN_MANUAL','FRONT_OBSTACLE','SUDDEN_BRAKING',
           'PEDESTRIAN_CROSSING','REAR_APPROACH','PARALLEL_TRAFFIC','BLOCKED_REVERSE',
           'FULLY_BLOCKED','MIXED_TRAFFIC','HESITATION_RETREAT','CUT_IN'}


def identity(value):return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()).hexdigest()


def condition_spec(manifest,started_s):
    """Hash physical conditions and schedules, independent of allocated IDs."""
    actors=manifest['actors'];aliases={a['id']:f'actor_{i}' for i,a in enumerate(actors)}
    def physical(a):return {k:v for k,v in a.items() if k!='id'}
    pop=manifest['population']
    walkers={}
    for key,value in pop.get('walker_profiles',{}).items():
        profile=dict(value)
        for field in ('ready_at_s','wait_until_s'):
            if profile.get(field) is not None:profile[field]-=started_s
        walkers[aliases.get(int(key),key)]=profile
    return {'version':2,'scenario':manifest['scenario'],'seed':manifest['seed'],'map':manifest['map'],
            'spawn_index':manifest['spawn_index'],'route':manifest['route'],'native_route':manifest['native_route'],
            'actors':{aliases[a['id']]:physical(a) for a in actors},'ego_initial':physical(manifest['ego_initial']),
            'events':[{**{k:v for k,v in e.items() if k not in ('actor_id','eligible','realized','start_position')},
                       'actor':aliases[e['actor_id']]} for e in manifest['events']],
            'population_request':pop['requested'],
            'driver_profiles':{aliases.get(int(k),k):v for k,v in pop.get('driver_profiles',{}).items()},
            'walker_profiles':walkers,'sensor_configuration':manifest.get('sensor_configuration'),
            'ego_geometry':manifest.get('ego_geometry'),'weather':manifest.get('weather')}


class PilotWorld:
    def __init__(self,provider):
        self.p=provider;self.actors=[];self.events=[];self.started=None;self.errors=[]

    def close(self):
        for actor in reversed(self.actors):
            if actor.is_alive and not actor.destroy():self.errors.append(f'Actor cleanup failed: {actor.id}')
        self.actors=[]
        if self.errors:raise RuntimeError('; '.join(self.errors))

    def setup(self,kind,seed,*,spawn_index=152,route_length=40.,vehicles=25,pedestrians=20):
        if kind not in SUPPORTED:raise ValueError('Scenario has no validated native constructor: '+kind)
        p=self.p;w=p.world.world;api=p.connection.api;native_map=w.get_map()
        spawns=native_map.get_spawn_points()
        if type(spawn_index) is not int or not 0<=spawn_index<len(spawns):raise ValueError('Invalid native spawn')
        if not 5<=route_length<=120:raise ValueError('Invalid pilot route length')
        self.kind=kind;self.seed=seed;self.rng=random.Random(seed);self.events=[];self.initialized=False
        p.scenarios.living_city();p.population.reset_population()
        p.spawn_index=spawn_index;p.strict_ego_spawn=True;p.reset_vehicle()
        # A newly spawned Actor's cached pose is not authoritative until the
        # native owner ticks. Construct from the requested map spawn, then
        # verify the actual settled pose before admitting the fixture.
        intended=spawns[spawn_index]
        self.intended_pose={'position':[intended.location.x,intended.location.y,intended.location.z],
                            'yaw_deg':intended.rotation.yaw}
        start=native_map.get_waypoint(intended.location)
        path=[start]
        for _ in range(math.ceil(route_length/2)):
            choices=path[-1].next(2.)
            if not choices:raise RuntimeError('Route ends before required journey length')
            choices=sorted(choices,key=lambda q:(q.road_id,q.lane_id,q.s))
            path.append(choices[self.rng.randrange(len(choices))])
        self.route_points=[[q.transform.location.x,q.transform.location.y,q.transform.location.z] for q in path]
        turns=[abs((q.transform.rotation.yaw-start.transform.rotation.yaw+180)%360-180) for q in path]
        if kind=='CURVE' and max(turns)<5:raise RuntimeError('Curve fixture has no physical curve')
        pose=intended;self.origin=pose.location;self.rotation=pose.rotation;self.forward=pose.get_forward_vector();self.right=pose.get_right_vector()
        if kind in ('FRONT_OBSTACLE','BLOCKED_REVERSE','FULLY_BLOCKED'):
            self._spawn(8. if kind!='FRONT_OBSTACLE' else 18.,0.)
        if kind=='FULLY_BLOCKED':self._spawn(-8.,0.)
        if kind in ('SUDDEN_BRAKING','REAR_APPROACH','PARALLEL_TRAFFIC','CUT_IN'):
            x,y={'SUDDEN_BRAKING':(20.,0.),'REAR_APPROACH':(-18.,0.),'PARALLEL_TRAFFIC':(12.,3.5),'CUT_IN':(18.,3.5)}[kind]
            actor=self._spawn(x,y)
            # Initial velocity belongs to construction, before the native owner
            # settles and freezes initial conditions. Never inject velocity into
            # an already running episode to make a scheduled event appear real.
            actor.set_target_velocity(api.Vector3D(self.forward.x*5.,self.forward.y*5.,0.))
            actor.apply_control(api.VehicleControl(throttle=.35))
            self.events.append({'actor_id':actor.id,'kind':kind,'at_s':2.+self.rng.random(),
                                'duration_s':4.,'scheduled':True,'eligible':False,'realized':False,
                                'initial_speed_mps':5.,'pre_event_speed_mps':0.,'start_position':None})
        if kind in ('PEDESTRIAN_CROSSING','HESITATION_RETREAT'):
            actor=self._spawn(14.,4.,person=True)
            self.events.append({'actor_id':actor.id,'kind':kind,'at_s':1.5+self.rng.random(),
                                'duration_s':6.,'scheduled':True,'eligible':False,'realized':False,
                                'start_position':None})
        if kind=='MIXED_TRAFFIC':
            self.mixed_request={'seed':seed,'vehicle_count':vehicles,'pedestrian_count':pedestrians,
                                'placement':'EGO_SURROUNDING','vehicle_mix':'MIXED'}
        self.manifest={'version':1,'scenario':kind,'seed':seed,'map':native_map.name,'spawn_index':spawn_index,
                       'route':self.route_points,'events':self.events,'full_native_physics':True,
                       'in_episode_teleport':False,'actors':[]}
        self.manifest['intended_ego_pose']=self.intended_pose
        self.manifest['initialization_version']=3
        return self.manifest

    def configure_route(self):
        actual=self._actor(self.p.ego.actor)
        if math.dist(actual['position'][:2],self.intended_pose['position'][:2])>1.:
            raise RuntimeError('Settled native ego pose differs from the requested fixture spawn')
        angle=(actual['yaw_deg']-self.intended_pose['yaw_deg']+180)%360-180
        if abs(angle)>3.:raise RuntimeError('Settled native ego heading differs from the fixture')
        self.p.dashboard_tools.set_destination({'location':self.route_points[-1],'name':'Pilot destination'})
        self.p.start_navigation(15.,driving_mode='NORMAL')
        actual_route=self.p.route_state()
        expected=sum(math.dist(a,b) for a,b in zip(self.route_points,self.route_points[1:]))
        if actual_route['length_m']>expected+12.:
            raise RuntimeError('Native routing took an unintended detour; scenario invalid')
        self.manifest['native_route']=actual_route['points'];self.initialized=True
        if self.kind=='MIXED_TRAFFIC':self.p.population.apply({**self.p.population.config,**self.mixed_request})

    def _spawn(self,x,y,person=False):
        p=self.p;api=p.connection.api;library=p.world.world.get_blueprint_library()
        bp=sorted(library.filter('walker.pedestrian.*'),key=lambda b:b.id)[0] if person else library.find('vehicle.tesla.model3')
        if bp.has_attribute('role_name'):bp.set_attribute('role_name','ostorha_pilot')
        transform=api.Transform(api.Location(self.origin.x+self.forward.x*x+self.right.x*y,
            self.origin.y+self.forward.y*x+self.right.y*y,self.origin.z+.3),self.rotation)
        actor=p.world.world.try_spawn_actor(bp,transform)
        if actor is None:raise RuntimeError(f'Invalid fixture spawn at {x},{y}; no geometry substitution')
        self.actors.append(actor)
        if not person:actor.apply_control(api.VehicleControl(brake=1.))
        return actor

    def begin(self,timestamp_s):
        self.started=timestamp_s
        self.manifest['actors']=self.truth()
        self.manifest['ego_initial']=self._actor(self.p.ego.actor)
        self.manifest['population']=self.p.population.get_population_state()
        self.manifest['ego_geometry']=self.p.vehicle_geometry.snapshot()
        self.manifest['sensor_configuration']={name:{k:v for k,v in config.items() if not k.startswith('latest') and k!='actorId'}
                                               for name,config in self.p.sensor_registry().items()}
        self.manifest['weather']=self.p.restart_configuration()['weather']
        self.manifest['condition_spec']=condition_spec(self.manifest,timestamp_s)
        self.manifest['condition_hash']=identity(self.manifest['condition_spec'])

    @staticmethod
    def _actor(actor):
        t=actor.get_transform();v=actor.get_velocity()
        result={'id':actor.id,'blueprint':actor.type_id,'position':[t.location.x,t.location.y,t.location.z],
                'yaw_deg':t.rotation.yaw,'velocity_mps':[v.x,v.y,v.z],
                'half_size_m':[actor.bounding_box.extent.x,actor.bounding_box.extent.y]}
        if actor.type_id.startswith('vehicle.'):
            c=actor.get_control();result['control']={'gear':c.gear,'reverse':c.reverse,'manual_gear_shift':c.manual_gear_shift,
                'throttle':c.throttle,'brake':c.brake,'steering':c.steer,'handbrake':c.hand_brake}
        return result

    def truth(self):
        p=self.p
        # Score every native vehicle/person, including unexpected actors. The
        # evaluator must not hide a detection miss by limiting labels to actors
        # that its constructor or tracker successfully registered.
        all_actors=[a for a in p.world.world.get_actors() if a.id!=p.ego.actor.id and
                    a.type_id.startswith(('vehicle.','walker.pedestrian.')) and a.is_alive]
        owned={a.id for a in self.actors}|set(p.population.vehicles)|set(p.population.walkers)
        self.unmanaged_actor_ids=sorted(a.id for a in all_actors if a.id not in owned)
        return [self._actor(a) for a in sorted(all_actors,key=lambda a:a.id)]

    def near_miss_exposure(self):
        ego=self._actor(self.p.ego.actor);half=math.hypot(*ego['half_size_m']);risk=0.
        for actor in self.truth():
            # Independent conservative disc clearance, stated explicitly as an
            # exposure proxy. Actual contacts come from the native collision sensor.
            gap=max(0.,math.dist(ego['position'][:2],actor['position'][:2])-half-math.hypot(*actor['half_size_m']))
            risk=max(risk,max(0.,1.-gap/3.))
        return risk

    def before_tick(self,timestamp_s):
        if self.started is None:return
        elapsed=timestamp_s-self.started;api=self.p.connection.api
        for event in self.events:
            actor=next(a for a in self.actors if a.id==event['actor_id'])
            delta=actor.get_location()-self.p.ego.actor.get_location()
            event['eligible']|=elapsed>=event['at_s'] and delta.length()<80.
            if event['start_position'] is None and event['eligible']:
                event['start_position']=self._actor(actor)['position']
            kind=event['kind'];vx=event.get('initial_speed_mps',0.);vy=0.
            if elapsed<event['at_s'] and not actor.type_id.startswith('walker.'):
                event['pre_event_speed_mps']=max(event.get('pre_event_speed_mps',0.),actor.get_velocity().length())
            active=event['eligible'] and elapsed<event['at_s']+event['duration_s']
            if kind=='SUDDEN_BRAKING' and active:
                actor.apply_control(api.VehicleControl(brake=1.))
                event['realized']|=event['pre_event_speed_mps']>=3. and actor.get_velocity().length()<.3
                continue
            if kind in ('PEDESTRIAN_CROSSING','HESITATION_RETREAT'):
                vy=-1.4 if active else 0.
                if kind=='HESITATION_RETREAT' and active:
                    progress=elapsed-event['at_s']
                    vy=0. if progress<1. else -1.2 if progress<3. else 1.2
            if kind=='CUT_IN':vy=-1.2 if active else 0.
            direction=api.Vector3D(self.forward.x*vx+self.right.x*vy,self.forward.y*vx+self.right.y*vy,0.)
            if actor.type_id.startswith('walker.'):
                speed=math.hypot(vx,vy)
                actor.apply_control(api.WalkerControl(direction=direction/speed if speed else direction,speed=speed))
            else:
                actor.apply_control(api.VehicleControl(throttle=.35,steer=-.2 if kind=='CUT_IN' and active else 0.))
            if event['start_position'] is not None:
                moved=math.dist(self._actor(actor)['position'],event['start_position'])
                current=self._actor(actor)['position'];initial=event['start_position']
                lateral=(current[0]-initial[0])*self.right.x+(current[1]-initial[1])*self.right.y
                if kind=='CUT_IN':
                    road_lateral=(current[0]-self.origin.x)*self.right.x+(current[1]-self.origin.y)*self.right.y
                    event['realized']|=active and abs(road_lateral)<=1.15+actor.bounding_box.extent.y
                elif kind in ('PEDESTRIAN_CROSSING','HESITATION_RETREAT'):
                    event['realized']|=active and abs(lateral)>.5
                else:event['realized']|=active and moved>.5

    def validity(self):
        population=self.p.population.get_population_state()
        mixed=self.kind=='MIXED_TRAFFIC'
        valid=(getattr(self,'initialized',False) and not getattr(self,'unmanaged_actor_ids',[]) and
               all(a.is_alive for a in self.actors) and not self.errors and
               all(e['eligible'] and e['realized'] for e in self.events) and
               (not mixed or population['actual']['vehicles']==population['requested']['vehicle_count'] and
                population['actual']['pedestrians']==population['requested']['pedestrian_count'] and
                population['walker_controllers_ready']))
        return {'valid':bool(valid),'events':self.events,'errors':list(self.errors),
                'unmanaged_actor_ids':list(getattr(self,'unmanaged_actor_ids',[])),
                'population_valid':not mixed or population['walker_controllers_ready']}
