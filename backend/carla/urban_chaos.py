"""Seed-compiled urban experiment. No tick calls and no ego controls here."""
import math
import random
from dataclasses import replace
from ..core.scenarios import ScenarioSpec, ScenarioActor, ScenarioPedestrian, ScenarioType, DatasetSplit
from .scenarios import canonical_transform
from .population import passenger_blueprints, DEFAULT_POPULATION
from .urban import sample_driver, apply_driver

CITY = {**DEFAULT_POPULATION, 'vehicle_count': 40, 'pedestrian_count': 30,
        'seed': 2589, 'driver_behavior': 'UNREGULATED', 'light_compliance_percent': 20,
        'world_profile': 'VISUAL_DEMO', 'crossing_percent': 15}


def extend_scripted_exits(plans, route, extension):
    """Keep each hazard, then drive through the destination instead of parking."""
    plans['sudden_brake']['points'].extend(extension)
    plans['cut_in']['points'].extend(route[66:]+extension)
    plans['curb_return']['return_points'].extend(route[70:]+extension)


def compile_urban(provider, seed=2589, *, clear_scripted_route=False):
    api=provider.connection.api; world=provider.world.world; native_map=world.get_map()
    rng=random.Random(seed); start=native_map.get_waypoint(native_map.get_spawn_points()[152].location)
    path=[start]
    for _ in range(90):
        previous=path[-1]; choices=previous.next(2.)
        if not choices: raise ValueError('Urban route ends before 180 m')
        path.append(min(choices,key=lambda w:abs((w.transform.rotation.yaw-previous.transform.rotation.yaw+180)%360-180)))
    def waypoint(distance): return path[min(90, round(distance/2))]
    def pose(wp):
        t=wp.transform; t.location.z+=.3
        return canonical_transform(t)
    def point(wp, lateral=0.):
        t=wp.transform; right=t.get_right_vector()
        return [t.location.x+right.x*lateral,t.location.y+right.y*lateral,t.location.z]
    schedule={'sudden_brake_s':round(rng.uniform(8,12),2),'cut_in_s':round(rng.uniform(14,18),2),
              'pedestrian_crossing_s':round(rng.uniform(20,24),2),
              'curb_up_s':round(rng.uniform(28,31),2),'curb_return_s':round(rng.uniform(35,40),2)}
    vehicles=[]; plans={}
    leader=waypoint(22)
    vehicles.append(ScenarioActor('sudden_brake','vehicle.tesla.model3',pose(leader)))
    plans['sudden_brake']={'kind':'BRAKE','speed_mps':4.5,'points':[point(w) for w in path[11:]],
                         'start_s':0.,'brake_s':schedule['sudden_brake_s'],'release_s':schedule['sudden_brake_s']+5.}
    cut=waypoint(82).get_left_lane()
    if cut is None or cut.lane_type!=api.LaneType.Driving: raise ValueError('Urban cut-in needs a native adjacent driving lane')
    vehicles.append(ScenarioActor('cut_in','vehicle.audi.tt',pose(cut)))
    plans['cut_in']={'kind':'CUT_IN','speed_mps':4.,'start_s':schedule['cut_in_s'],
                    'points':[point(waypoint(88),-1.75),point(waypoint(94)),point(waypoint(110)),point(waypoint(130))]}
    for name,distance,delay in [('curb_up',48,schedule['curb_up_s']),('curb_return',92,schedule['curb_up_s']+1.)]:
        wp=waypoint(distance);adjacent=wp.get_left_lane()
        if adjacent is None or adjacent.lane_type!=api.LaneType.Driving:raise ValueError('SUV start needs a native adjacent lane')
        initial=adjacent.transform;initial.location.z+=.3
        vehicles.append(ScenarioActor(name,'vehicle.nissan.patrol',canonical_transform(initial)))
        # Map sidewalk is beyond the shoulder. These are steering targets only;
        # the SUV's tires and mesh must cross the actual curb through physics.
        sidewalk=native_map.get_waypoint(api.Location(*point(wp,7.)),lane_type=api.LaneType.Sidewalk)
        if sidewalk is None: raise ValueError('Urban SUV needs a native sidewalk target')
        lateral=math.dist(point(wp)[:2],point(sidewalk)[:2])
        plans[name]={'kind':'CURB','speed_mps':4.,'start_s':delay,'return_s':schedule['curb_return_s'],
                     'points':[point(waypoint(distance+12),lateral),point(waypoint(distance+20),lateral)],
                     'reverse_exit_points':[point(waypoint(distance+4))],
                     'return_points':[point(waypoint(distance+28)),point(waypoint(distance+36)),point(waypoint(distance+46))]}
    occupied=[api.Location(*a.transform.position_m) for a in vehicles]+[start.transform.location]
    candidates=[w for w in native_map.generate_waypoints(12.) if not w.is_junction and w.lane_width>=2.5
                and 24<=w.transform.location.distance(start.transform.location)<=190
                and min(w.transform.location.distance(p.transform.location) for p in path)<=90]
    rng.shuffle(candidates)
    candidates.sort(key=lambda w:min(w.transform.location.distance(p.transform.location) for p in path)+rng.random()*30)
    attributes={}; library=world.get_blueprint_library(); bps=passenger_blueprints(library)
    for wp in candidates:
        location=wp.transform.location
        if any(location.distance(p)<8 for p in occupied):continue
        # Keep the scripted approaches clear at their initial poses.
        if wp.road_id==start.road_id and wp.lane_id==start.lane_id:continue
        bp=rng.choice(bps); name=f'traffic_{len(vehicles)-4:02d}'
        vehicles.append(ScenarioActor(name,bp.id,pose(wp))); occupied.append(location)
        attributes[name]={key:rng.choice(bp.get_attribute(key).recommended_values) for key in ('color','driver_id')
                          if bp.has_attribute(key) and bp.get_attribute(key).recommended_values}
        ordinal=len(vehicles)-5
        plans[name]={'kind':'TRAFFIC_MANAGER','ordinal':ordinal,'route_policy':'SEEDED_NATIVE_LANE_ROUTING',
            'driver_profile':sample_driver(seed,ordinal,'UNREGULATED',15.,20)}
        if len(vehicles)==40:break
    if len(vehicles)!=40:raise ValueError(f'Urban map admitted {len(vehicles)}/40 vehicle starts')
    world.set_pedestrians_seed(seed)
    nav=[]
    for _ in range(2200):
        loc=world.get_random_location_from_navigation()
        if loc is None or min(loc.distance(p.transform.location) for p in path)>48:continue
        sidewalk=native_map.get_waypoint(loc,lane_type=api.LaneType.Sidewalk)
        if sidewalk is None or sidewalk.transform.location.distance(loc)>2.5:continue
        if native_map.get_waypoint(loc,project_to_road=False,lane_type=api.LaneType.Driving) is not None:continue
        if any(loc.distance(old)<3.2 for old in occupied):continue
        if all(loc.distance(old)>2.5 for old in nav):nav.append(loc)
    crossing=[]
    for loc in sorted(nav,key=lambda x:x.distance(waypoint(100).transform.location)):
        opposite=[q for q in nav if 7<q.distance(loc)<22 and native_map.get_waypoint(
            api.Location((q.x+loc.x)/2,(q.y+loc.y)/2,(q.z+loc.z)/2),project_to_road=False,lane_type=api.LaneType.Driving)]
        if opposite and all(loc.distance(a)>3 for a,b in crossing):crossing.append((loc,min(opposite,key=lambda q:q.distance(loc))))
        if len(crossing)==2:break
    if len(crossing)<2:raise ValueError('Native navmesh has no two nearby crossing pairs')
    walkers=[]; walker_bps=sorted(library.filter('walker.pedestrian.*'),key=lambda b:b.id)
    chosen=[]
    for i,(loc,target) in enumerate(crossing):
        chosen.append(loc); walkers.append(ScenarioPedestrian(f'crossing_{i}',rng.choice(walker_bps).id,
            canonical_transform(api.Transform(api.Location(loc.x,loc.y,loc.z+.4))),(target.x,target.y,target.z),1.5,schedule['pedestrian_crossing_s']+i))
    rng.shuffle(nav)
    nav.sort(key=lambda q:q.distance(start.transform.location)+rng.random()*45)
    for loc in nav:
        if any(loc.distance(a)<2 for a in chosen):continue
        targets=[q for q in nav if 8<q.distance(loc)<30]
        if not targets:continue
        target=rng.choice(targets); chosen.append(loc)
        walkers.append(ScenarioPedestrian(f'walker_{len(walkers)-2:02d}',rng.choice(walker_bps).id,
            canonical_transform(api.Transform(api.Location(loc.x,loc.y,loc.z+.4))),(target.x,target.y,target.z),round(rng.uniform(1.,1.8),2)))
        if len(walkers)==30:break
    if len(walkers)!=30:raise ValueError('Urban map admitted fewer than 30 native walker starts')
    if clear_scripted_route:
        exit_path=[];previous=path[-1]
        for _ in range(20):
            choices=previous.next(2.)
            if not choices:raise ValueError('Urban hazards have no route beyond the destination')
            previous=min(choices,key=lambda w:abs((w.transform.rotation.yaw-previous.transform.rotation.yaw+180)%360-180))
            exit_path.append(point(previous))
        extend_scripted_exits(plans,[point(w) for w in path],exit_path)
    spec=ScenarioSpec('urban_chaos_v1',ScenarioType.MULTI_HAZARD,seed,native_map.name,152,0.,tuple(vehicles),tuple(walkers),
        weather={k:getattr(world.get_weather(),k) for k in ('cloudiness','precipitation','wetness','sun_altitude_angle','sun_azimuth_angle','fog_density')},
        traffic_density={'vehicle_count':40,'pedestrian_count':30},timeout=60.,split=DatasetSplit.TEST,
        failure_conditions={'max_collision_episodes':1000000},metadata={'urban_chaos':True,'target_speed_kmh':20,
        'hazard_schedule':schedule,'vehicle_plans':plans,'blueprint_attributes':attributes,
        'route_points':[point(w) for w in path],'scripted_exits_clear_destination':clear_scripted_route,
        'recycling':False,'traffic_behavior':'UNREGULATED',
        'trajectory_matching':'Same initial manifest and hazard plan; traffic can diverge after ego intervention'})
    end=path[-1].transform.location
    return spec,{'location':[end.x,end.y,end.z],'name':'Urban Chaos destination'}


class UrbanPhysics:
    def __init__(self, manager):
        self.manager=manager; self.controllers={}; self.indices={}; self.events={}; self.light_states=[];self.handles={}
        self.map=manager.provider.world.world.get_map()

    def spawn_walkers(self):
        p=self.manager.provider; w=p.world.world; api=p.connection.api
        self.handles={name:w.get_actor(i) for name,i in self.manager.actors.items()}
        w.set_pedestrians_seed(self.manager.spec.random_seed); w.set_pedestrians_cross_factor(1.)
        p.population.traffic_manager.configure('NORMAL',self.manager.spec.random_seed)
        for name,plan in self.manager.spec.metadata['vehicle_plans'].items():
            if plan['kind']=='TRAFFIC_MANAGER':
                apply_driver(p.population.traffic_manager.manager,self.handles[name],plan['driver_profile'])
        admitted_walkers=[]; corrections=[]
        for definition in self.manager.spec.pedestrian_definitions:
            from .scenarios import native_transform
            bp=w.get_blueprint_library().find(definition.blueprint)
            bp.set_attribute('role_name','ostorha_scenario')
            if bp.has_attribute('is_invincible'):bp.set_attribute('is_invincible','false')
            actor=w.try_spawn_actor(bp,native_transform(api,definition.transform))
            if actor is None and self.manager.spec.metadata.get('comparison_v2') and getattr(p,'comparison_v2_admitting',False):
                # Before the first approval only: bounded deterministic nearby
                # admission against native static geometry. Persist the admitted
                # pose; the other side must restore that exact pose without repair.
                x,y,z=definition.transform.position_m
                for radius in (.4,.8,1.2):
                    for dx,dy in ((radius,0),(-radius,0),(0,radius),(0,-radius),(radius,radius),(-radius,-radius)):
                        location=api.Location(x+dx,y+dy,z-.4)
                        sidewalk=self.map.get_waypoint(location,lane_type=api.LaneType.Sidewalk)
                        if sidewalk is None or sidewalk.transform.location.distance(location)>1.:continue
                        candidate=replace(definition,transform=replace(definition.transform,position_m=(x+dx,y+dy,z)))
                        actor=w.try_spawn_actor(bp,native_transform(api,candidate.transform))
                        if actor is not None:
                            definition=candidate;corrections.append({'name':definition.name,'offset_m':[dx,dy,0.]});break
                    if actor is not None:break
            if actor is None:raise ValueError('Occupied urban walker start: '+definition.name)
            admitted_walkers.append(definition)
            self.manager.actors[definition.name]=actor.id
            self.handles[definition.name]=actor
            controller=w.spawn_actor(w.get_blueprint_library().find('controller.ai.walker'),api.Transform(),attach_to=actor)
            self.controllers[definition.name]={'id':controller.id,'started':False,'prepared':False,'handle':controller}
        if corrections:
            self.manager.spec=replace(self.manager.spec,pedestrian_definitions=tuple(admitted_walkers),
                metadata={**self.manager.spec.metadata,'walker_spawn_corrections':corrections})
        if not self.manager.spec.metadata.get('preserve_traffic_lights'):
            for light in w.get_actors().filter('traffic.traffic_light*'):
                self.light_states.append((light.id,light.get_state(),light.is_frozen()))
                light.set_state(api.TrafficLightState.Green); light.freeze(True)

    def start(self):
        p=self.manager.provider
        p.connection.client.apply_batch_sync([p.connection.api.command.SetAutopilot(self.handles[name].id,
            True,p.population.traffic_manager.port) for name,plan in self.manager.spec.metadata['vehicle_plans'].items()
            if plan['kind']=='TRAFFIC_MANAGER'],False)

    def follow(self,actor,points,speed,name,tolerance=2.,reverse=False):
        api=self.manager.provider.connection.api; loc=actor.get_location(); v=actor.get_velocity(); actual=math.hypot(v.x,v.y)
        i=self.indices.get(name,0)
        while i<len(points)-1 and math.dist((loc.x,loc.y),points[i][:2])<tolerance:i+=1
        self.indices[name]=i; target=points[i]; t=actor.get_transform()
        angle=(math.atan2(target[1]-loc.y,target[0]-loc.x)-math.radians(t.rotation.yaw)-(math.pi if reverse else 0.)+math.pi)%(2*math.pi)-math.pi
        steer=max(-.8,min(.8,math.atan2(5.4*math.sin(angle),max(2.,math.dist((loc.x,loc.y),target[:2])))/.6))
        if reverse:steer=-steer
        reached=i==len(points)-1 and math.dist((loc.x,loc.y),target[:2])<tolerance
        if reached: speed=0.
        error=speed-actual; throttle=min(.95 if name.startswith('curb_') else .6,max(0.,.2+error*.22)) if error>0 else 0.
        brake=min(1.,-error*.3) if error<-.3 else 1. if reached else 0.
        actor.apply_control(api.VehicleControl(throttle=throttle,brake=brake,steer=steer,reverse=reverse))
        return reached

    def before_tick(self):
        m=self.manager; p=m.provider; w=p.world.world; api=p.connection.api
        if m.phase=='FINISHED':
            for name in m.spec.metadata['vehicle_plans']:
                actor=self.handles[name]
                if actor.id in p.last_actor_ids:actor.apply_control(api.VehicleControl(brake=1.))
            for definition in m.spec.pedestrian_definitions:
                if definition.name.startswith('crossing_'):
                    if self.handles[definition.name].id in p.last_actor_ids:
                        self.handles[definition.name].apply_control(api.WalkerControl(speed=0.))
            return
        running=m.phase=='RUNNING'; elapsed=p.last_vehicle['timestamp']-m.started_at if running else 0.
        if m.phase=='READY':
            for definition in m.spec.pedestrian_definitions:
                entry=self.controllers[definition.name]
                if not entry['prepared']:
                    entry['handle'].start();entry['handle'].set_max_speed(0.)
                    entry['handle'].go_to_location(api.Location(*definition.destination));entry['prepared']=True
        for name,plan in m.spec.metadata['vehicle_plans'].items():
            actor=self.handles[name]
            if running and actor.id not in p.last_actor_ids:
                current=self.events.setdefault(name,{});current['status']='NATIVE_ACTOR_LOST';current.setdefault('lost_at_s',elapsed);continue
            if plan['kind']=='TRAFFIC_MANAGER':
                if not running:actor.apply_control(api.VehicleControl(brake=1.))
                continue
            status='WAITING'; reached=False
            if not running or elapsed<plan['start_s']:actor.apply_control(api.VehicleControl(brake=1.))
            elif plan['kind']=='BRAKE' and plan['brake_s']<=elapsed<plan['release_s']:
                actor.apply_control(api.VehicleControl(brake=1.));status='BRAKING'
            else:
                returning=plan['kind']=='CURB' and elapsed>=plan['return_s'] and name=='curb_return'
                reverse_exit=returning and self.events.get(name,{}).get('sidewalk_observed_at_s') is not None and self.events.get(name,{}).get('road_reentry_observed_at_s') is None
                if returning and self.events.get(name,{}).get('sidewalk_observed_at_s') is None:returning=False
                points=plan['reverse_exit_points'] if reverse_exit else plan['return_points'] if returning else plan['points']
                reached=self.follow(actor,points,2. if reverse_exit else plan['speed_mps'],name+('_exit' if reverse_exit else '_return' if returning else ''),.7 if plan['kind']=='CURB' else 2.,reverse=reverse_exit)
                status=('REVERSING_FROM_CURB' if reverse_exit else 'MERGING' if returning else 'CURB_APPROACH' if plan['kind']=='CURB' else 'MOVING')
                if reached:status='TARGET_REACHED'
                elif actor.get_velocity().length()<.15 and elapsed>plan['start_s']+8:status='BLOCKED'
            current=self.events.setdefault(name,{})
            current.update(status=status,position_m=[actor.get_location().x,actor.get_location().y,actor.get_location().z],
                           controls={'throttle':actor.get_control().throttle,'brake':actor.get_control().brake,'steering':actor.get_control().steer,'reverse':actor.get_control().reverse})
            if reached:current['reached_at_s']=current.get('reached_at_s',elapsed)
            loc=actor.get_location(); sidewalk=self.map.get_waypoint(loc,project_to_road=False,lane_type=api.LaneType.Sidewalk)
            if plan['kind']=='CURB' and sidewalk is not None:
                current['sidewalk_observed_at_s']=current.get('sidewalk_observed_at_s',elapsed)
            if current.get('sidewalk_observed_at_s') is not None and plan['kind']=='CURB' and self.map.get_waypoint(loc,project_to_road=False,lane_type=api.LaneType.Driving):
                current.setdefault('road_reentry_observed_at_s',elapsed)
        for definition in m.spec.pedestrian_definitions:
            entry=self.controllers[definition.name]; controller=entry['handle']
            if running and self.handles[definition.name].id not in p.last_actor_ids:
                current=self.events.setdefault(definition.name,{});current['status']='NATIVE_ACTOR_LOST';current.setdefault('lost_at_s',elapsed)
                if not entry.get('destroyed'):
                    if entry['prepared']:controller.stop();entry['prepared']=False
                    p.population._destroy([entry['id']]);entry['destroyed']=True
                continue
            if running and elapsed>=definition.start_s and not entry['started']:
                if definition.name.startswith('crossing_'):
                    controller.stop();entry['prepared']=False
                    actor=self.handles[definition.name];actor.set_simulate_physics(True);actor.set_collisions(True)
                else:
                    controller.set_max_speed(definition.speed_mps)
                    controller.go_to_location(api.Location(*definition.destination))
                entry['started']=True
            if definition.name.startswith('crossing_'):
                actor=self.handles[definition.name]; loc=actor.get_location()
                delta=api.Location(*definition.destination)-loc;distance=math.hypot(delta.x,delta.y)
                if running and entry['started']:
                    # Two scripted crossings use native WalkerControl so the navmesh
                    # cannot reroute them around the research hazard. No teleport.
                    actor.apply_control(api.WalkerControl(direction=api.Vector3D(delta.x/max(distance,.001),delta.y/max(distance,.001),0.),
                        speed=definition.speed_mps if distance>.5 else 0.))
                status='WAITING' if not entry['started'] else 'ARRIVED' if distance<=.5 else 'WALKING'
                if self.map.get_waypoint(loc,project_to_road=False,lane_type=api.LaneType.Driving):
                    status='CROSSING';self.events.setdefault(definition.name,{})['road_observed_at_s']=elapsed
                self.events.setdefault(definition.name,{}).update(status=status,position_m=[loc.x,loc.y,loc.z])
        if m.run:m.run['hazard_observations']=self.events

    def close(self):
        p=self.manager.provider;w=p.world.world
        for entry in self.controllers.values():
            a=w.get_actor(entry['id'])
            if a and entry['prepared']:a.stop()
        p.population._destroy([entry['id'] for entry in self.controllers.values()]);self.controllers.clear()
        for i,state,frozen in self.light_states:
            a=w.get_actor(i)
            if a:a.set_state(state);a.freeze(frozen)
        self.light_states.clear()
