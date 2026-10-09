"""Controlled scenarios share the existing provider, tick owner and ego lifecycle.

Two validated vehicle demonstrations and the explicit Urban Chaos recipe are admitted.
No ego driver, perception model, RL policy or reward weights are implemented here.
"""
import copy
from datetime import datetime, timezone
import json
import hashlib
import math
from pathlib import Path
import random
import time
import uuid
from ..core.contracts import RotationRad, Transform, from_dict, to_dict
from ..core.scenarios import EnvironmentMode, ScenarioType, ScenarioSpec, ScenarioActor, ActorControlSegment, DatasetSplit
from .contracts import CARLA_WORLD
from .geometry import footprint, rectangle_clearance

ROOT=Path(__file__).resolve().parents[2]
SUPPORTED=(ScenarioType.FRONT_OBSTACLE, ScenarioType.SUDDEN_BRAKING)


def canonical_transform(t):
    return Transform((t.location.x,t.location.y,t.location.z),
                     RotationRad(*(math.radians(v) for v in (t.rotation.roll,t.rotation.pitch,t.rotation.yaw))),CARLA_WORLD)


def native_transform(api,t):
    return api.Transform(api.Location(*t.position_m),api.Rotation(
        roll=math.degrees(t.rotation_rad.roll),pitch=math.degrees(t.rotation_rad.pitch),yaw=math.degrees(t.rotation_rad.yaw)))


def demonstration(provider, scenario_type, seed=42, split='TRAIN', difficulty=1):
    """Resolve a seeded straight native lane; record the compiled absolute poses."""
    kind=ScenarioType(scenario_type)
    if kind not in SUPPORTED: raise ValueError('This scenario family has a contract but no native demonstration')
    if type(seed) is not int or type(difficulty) is not int: raise ValueError('Seed/difficulty must be integers')
    world=provider.world.world; native_map=world.get_map(); api=provider.connection.api
    spawns=native_map.get_spawn_points(); order=list(range(len(spawns))); random.Random(seed).shuffle(order)
    distance=24. if kind==ScenarioType.FRONT_OBSTACLE else 18.
    selected=None
    for index in order:
        wp=native_map.get_waypoint(spawns[index].location,lane_type=api.LaneType.Driving)
        if wp is None or wp.is_junction: continue
        ahead=wp.next(distance)
        if len(ahead)!=1 or ahead[0].is_junction: continue
        target=ahead[0]
        if (wp.road_id,wp.lane_id)!=(target.road_id,target.lane_id):continue
        angle=(target.transform.rotation.yaw-wp.transform.rotation.yaw+180)%360-180
        if abs(angle)>2.:continue
        selected=(index,target.transform);break
    if selected is None: raise ValueError('No compatible straight native lane for this demonstration')
    index,t=selected; t.location.z+=.3
    schedule=(ActorControlSegment(0.,brake=1.),) if kind==ScenarioType.FRONT_OBSTACLE else (
        ActorControlSegment(0.,throttle=.35),ActorControlSegment(2.,brake=1.))
    actor=ScenarioActor('obstacle' if kind==ScenarioType.FRONT_OBSTACLE else 'leader',
                        'vehicle.tesla.model3',canonical_transform(t),0. if kind==ScenarioType.FRONT_OBSTACLE else 5.,schedule)
    return ScenarioSpec(kind.value.lower()+'_v1',kind,seed,native_map.name,index,0.,(actor,),
                        weather={'cloudiness':0.,'precipitation':0.,'wetness':0.,'sun_altitude_angle':70.},
                        traffic_density={'vehicle_count':0,'pedestrian_count':0},difficulty=difficulty,
                        timeout=15.,split=DatasetSplit(split),metadata={'native_demo':True,
                        'ego_control':'MANUAL_OR_EXISTING_BASE_DRIVER','avoidability':'UNKNOWN',
                        'prototype_difficulty_note':'Difficulty is a recorded curriculum label; geometry is fixed in these v1 demos'})


class NativeScenarioManager:
    def __init__(self,provider):
        self.provider=provider
        self.mode=EnvironmentMode.LIVING_CITY; self.spec=None; self.phase='EMPTY'
        self.actors={}; self.resetting=False; self.run=None; self.started_at=None; self.previous=None
        self.outcome=None; self.initial_pending=False; self.capture_start=False
        self.metrics={}; self.last_contact={}; self.cache={}
        self.seen_collision_events=set()
        self.urban=None
        self._publish()

    def load(self,spec):
        if not isinstance(spec,ScenarioSpec):spec=from_dict(ScenarioSpec,spec)
        p=self.provider; world=p.world.world
        urban=spec.metadata.get('urban_chaos',False)
        if not urban and (spec.scenario_type not in SUPPORTED or spec.pedestrian_definitions):
            raise ValueError('Only the two verified vehicle prototypes are implemented; other families remain contracts')
        if spec.map_id!=world.get_map().name:raise ValueError('Scenario map differs from the live map; use managed map restart first')
        if spec.ego_spawn>=len(world.get_map().get_spawn_points()):raise ValueError('Ego spawn absent from native map')
        if not urban and (any(spec.traffic_density.get(key,0)!=0 for key in ('vehicle_count','pedestrian_count')) or set(spec.traffic_density)-{'vehicle_count','pedestrian_count'}):
            raise ValueError('Native v1 prototypes require isolated zero background density')
        for a in spec.other_actor_definitions:
            if world.get_blueprint_library().find(a.blueprint) is None:raise ValueError('Native blueprint absent')
            wp=world.get_map().get_waypoint(p.connection.api.Location(*a.transform.position_m))
            if wp is None or wp.transform.location.distance(p.connection.api.Location(*a.transform.position_m))>3.:
                raise ValueError('Scenario vehicle pose is outside a native driving lane')
        if set(spec.weather)-{'cloudiness','precipitation','wetness','sun_altitude_angle','sun_azimuth_angle','fog_density'}:
            raise ValueError('Unsupported native scenario weather field')
        if any(not 0<=v<=100 for k,v in spec.weather.items() if k not in ('sun_altitude_angle','sun_azimuth_angle')):
            raise ValueError('Invalid native weather percentage')
        # CARLA 0.9.16's native ClearNoon preset uses -1 for azimuth.
        azimuth=spec.weather.get('sun_azimuth_angle',0)
        if not -90<=spec.weather.get('sun_altitude_angle',70)<=90 or not (azimuth == -1 or 0<=azimuth<=360):
            raise ValueError('Invalid native sun angle')
        self.spec=spec; self.mode=EnvironmentMode.TRAINING
        self.reset()

    def cleanup(self):
        p=self.provider
        if self.urban:
            self.urban.close(); self.urban=None
        if self.actors:
            p.population._destroy(list(self.actors.values()))
            self.actors.clear()
        self.initial_pending=False; self.capture_start=False
        self._publish()

    def reset(self):
        if self.spec is None:raise ValueError('Load a scenario first')
        p=self.provider; self.stop(reason='reset'); self.cleanup()
        p.population.reset_population(); p.stop_navigation()
        if p.dashboard_tools:p.dashboard_tools.route=None
        self.resetting=True
        began=time.monotonic()
        self.initialization_began=began
        try:
            p.spawn_index=self.spec.ego_spawn; p.strict_ego_spawn=True
            p.reset_vehicle()
            from .dashboard_tools import WEATHER_PRESET_FIELDS
            weather=p.connection.api.WeatherParameters()
            clear=p.connection.api.WeatherParameters.ClearNoon
            for k in WEATHER_PRESET_FIELDS:
                if hasattr(clear,k):setattr(weather,k,getattr(clear,k))
            for k,v in self.spec.weather.items():setattr(weather,k,v)
            p.world.world.set_weather(weather)
            for definition in self.spec.other_actor_definitions:
                bp=p.world.world.get_blueprint_library().find(definition.blueprint)
                bp.set_attribute('role_name','ostorha_scenario')
                for key,value in self.spec.metadata.get('blueprint_attributes',{}).get(definition.name,{}).items():bp.set_attribute(key,value)
                actor=p.world.world.try_spawn_actor(bp,native_transform(p.connection.api,definition.transform))
                if actor is None:raise ValueError(f'Scenario spawn is occupied: {definition.name}')
                self.actors[definition.name]=actor.id
                actor.set_autopilot(False)
                actor.apply_control(p.connection.api.VehicleControl(brake=1.))
            if self.spec.metadata.get('urban_chaos'):
                from .urban_chaos import UrbanPhysics
                self.urban=UrbanPhysics(self);self.urban.spawn_walkers()
            self.phase='INITIALIZING'; self.initial_pending=True; self.outcome=None
            self.metrics={'collision_callback_count':0,'collision_count':0,'collision_impulse_total_ns':0.,
                'collision_peak_impulse_ns':0.,'distance_traveled_m':0.,'progress_m':0.,'elapsed_simulation_s':0.,
                'average_speed_mps':None,'minimum_clearance_m':None,'minimum_ttc_s':None,
                'near_miss_count':None,'emergency_braking_frequency':None,'steering_intervention_frequency':None,
                'safety_intervention_count':0,'unsafe_intervention_count':None,'route_completion':None,
                'control_variation':0.,'progress_under_congestion_m':None}
            self.previous=None; self.last_contact={}; self.started_at=None
            self.seen_collision_events=set()
            self.run={'run_id':'scenario_'+uuid.uuid4().hex,'created_at_utc':datetime.now(timezone.utc).isoformat(),
                      'spec':to_dict(self.spec),'condition_id':self.spec.condition_id,
                      'safety_policy_enabled':False,'comparison_group':'NO_YA_RAB_OSTORHA_BASELINE',
                      'native_version':p.connection.server_version,'api_version':p.connection.api_version,
                      'map':self.spec.map_id,'fixed_delta_seconds':p.fixed_delta,'camera':dict(p.camera_settings),
                      'launch':getattr(p,'active_launch',None),'reset_duration_wall_s':time.monotonic()-began,
                      'initial_states':None,'start_states':None,'avoidability':'UNKNOWN'}
        except Exception as error:
            self.cleanup(); self.phase='ERROR'; self._publish()
            if isinstance(error,ValueError):raise
            raise ValueError('Native scenario initialization failed: '+str(error)) from error
        finally:self.resetting=False
        self._publish()

    def start(self):
        if self.phase!='READY':raise ValueError('Scenario must be ready before start')
        p=self.provider
        # One-time physical initial-condition initialization. Subsequent movement
        # uses VehicleControl/physics only. Ego controls still come from arbitration.
        def velocity(actor,speed):
            v=actor.get_transform().get_forward_vector()
            actor.set_target_velocity(p.connection.api.Vector3D(v.x*speed,v.y*speed,v.z*speed))
        velocity(p.ego.actor,self.spec.ego_initial_speed)
        for a in self.spec.other_actor_definitions:
            if a.initial_speed_mps:velocity(p.world.world.get_actor(self.actors[a.name]),a.initial_speed_mps)
        if self.urban:self.urban.start()
        self.started_at=p.last_vehicle['timestamp']; self.phase='RUNNING'; self.capture_start=True
        safety=getattr(p,'active_safety_status',None) or {}
        enabled=safety.get('enabled',False) and safety.get('status')!='SUSPENDED_RL'
        self.run.update(safety_policy_enabled=enabled,
            comparison_group='YA_RAB_OSTORHA_RULE_BASED' if enabled else 'NO_YA_RAB_OSTORHA_BASELINE',
            safety_configuration={'status':safety,'parameters':getattr(p,'active_safety_configuration',None)},
            initial_intervention_count=safety.get('intervention_count',0))
        self._publish()

    def before_tick(self):
        p=self.provider
        if self.urban:
            self.urban.before_tick();return
        for a in self.spec.other_actor_definitions if self.spec else ():
            actor=p.world.world.get_actor(self.actors.get(a.name)) if a.name in self.actors else None
            if actor is None:continue
            segment=None
            if self.phase=='RUNNING':
                elapsed=p.last_vehicle['timestamp']-self.started_at
                segment=next((s for s in reversed(a.control_schedule) if s.start_s<=elapsed),None)
            actor.apply_control(p.connection.api.VehicleControl(throttle=segment.throttle if segment else 0.,
                brake=segment.brake if segment else 1.,steer=segment.steering if segment else 0.))

    def after_tick(self,snapshot):
        if self.initial_pending or self.capture_start:
            rows=[]
            for name,actor_id in [('ego',self.provider.ego.actor.id),*self.actors.items()]:
                a=snapshot.find(actor_id)
                if a is None:return
                t=a.get_transform();v=a.get_velocity()
                actor=self.provider.world.world.get_actor(actor_id);box=actor.bounding_box;control=actor.get_control()
                rows.append({'name':name,'actor_id':actor_id,'transform':to_dict(canonical_transform(t)),
                             'velocity_mps':[v.x,v.y,v.z],'blueprint':actor.type_id,
                             'bounding_box':{'extent_m':[box.extent.x,box.extent.y,box.extent.z],
                                'center_offset_m':[box.location.x,box.location.y,box.location.z],
                                'rotation_deg':[box.rotation.roll,box.rotation.pitch,box.rotation.yaw]},
                             'control':{'throttle':getattr(control,'throttle',0.),'brake':getattr(control,'brake',0.),'steering':getattr(control,'steer',0.)}})
            from .dashboard_tools import WEATHER_PRESET_FIELDS
            states={'frame_id':snapshot.frame,'timestamp_s':snapshot.timestamp.elapsed_seconds,'actors':rows,
                    'weather':{k:getattr(self.provider.world.world.get_weather(),k) for k in WEATHER_PRESET_FIELDS
                               if hasattr(self.provider.world.world.get_weather(),k)},
                    'sensor_registry':self.provider.sensor_registry()}
            if self.initial_pending:
                self.run['initial_states']=states; self.initial_pending=False; self.phase='READY'
                self.run['initialization_duration_wall_s']=time.monotonic()-self.initialization_began
                signature={'actors':[{k:v for k,v in row.items() if k!='actor_id'} for row in rows],
                           'weather':states['weather'],'camera':self.run['camera'],'map':self.run['map'],
                           'fixed_delta_seconds':self.run['fixed_delta_seconds']}
                self.run['actual_initial_condition_id']=hashlib.sha256(json.dumps(signature,sort_keys=True).encode()).hexdigest()
            if self.capture_start:self.run['start_states']=states;self.capture_start=False
            self._publish()

    def step(self,frame):
        if self.phase!='RUNNING':return
        v=frame.vehicle; m=self.metrics
        safety=getattr(self.provider,'active_safety_status',None) or {}
        if self.run.get('safety_policy_enabled'):
            m['safety_intervention_count']=max(0,safety.get('intervention_count',0)-self.run.get('initial_intervention_count',0))
        m['elapsed_simulation_s']=frame.timestamp_s-self.started_at
        initial=self.run['initial_states']['actors'][0]['transform']
        x,y,_=initial['position_m'];yaw=initial['rotation_rad']['yaw']
        m['progress_m']=max(0.,(v.transform.position_m[0]-x)*math.cos(yaw)+(v.transform.position_m[1]-y)*math.sin(yaw))
        if self.urban and self.run.get('route'):
            from .routes import RouteService
            progress=RouteService.progress(self.run['route'],v.transform.position_m)
            m['progress_m']=max(0.,self.run['route']['length_m']-progress['remaining_m'])
            m['route_completion']=min(1.,m['progress_m']/self.run['route']['length_m'])
        if self.previous is not None:
            m['distance_traveled_m']+=math.dist(self.previous.vehicle.transform.position_m,v.transform.position_m)
            m['control_variation']+=sum(abs(getattr(self.previous.vehicle,k)-getattr(v,k)) for k in ('throttle','brake','steering'))
        m['average_speed_mps']=m['distance_traveled_m']/m['elapsed_simulation_s'] if m['elapsed_simulation_s']>0 else None
        for c in frame.collisions:self._accept_collision(c)
        p=self.provider; ego_t=native_transform(p.connection.api,v.transform)
        ego_box=p.ego.actor.bounding_box
        for item in frame.ground_truth.objects if frame.ground_truth else ():
            if not self.urban and item.actor.actor_id not in self.actors.values():continue
            actor=next((a for a in self.urban.handles.values() if a.id==item.actor.actor_id),None) if self.urban else p.world.world.get_actor(item.actor.actor_id)
            if actor is None:continue
            gap=rectangle_clearance(footprint(ego_t,ego_box),footprint(native_transform(p.connection.api,item.actor.transform),actor.bounding_box))
            m['minimum_clearance_m']=gap if m['minimum_clearance_m'] is None else min(m['minimum_clearance_m'],gap)
        self.previous=frame
        if m['collision_count']>self.spec.failure_conditions.get('max_collision_episodes',float('inf')):
            self.stop(reason='failure_condition')
        elif m['elapsed_simulation_s']>=self.spec.timeout:self.stop(reason='timeout')
        else:self._publish()

    def _accept_collision(self,collision):
        if collision.ego_actor_id!=self.provider.ego.actor.id or collision.timestamp_s<self.started_at:return False
        key=(collision.frame_id,collision.other_actor_id)
        if key in self.seen_collision_events:return False
        self.seen_collision_events.add(key)
        m=self.metrics;m['collision_callback_count']+=1
        if collision.timestamp_s-self.last_contact.get(collision.other_actor_id,-float('inf'))>1.:m['collision_count']+=1
        self.last_contact[collision.other_actor_id]=collision.timestamp_s
        impulse=math.hypot(*collision.impulse_ns)
        m['collision_impulse_total_ns']+=impulse;m['collision_peak_impulse_ns']=max(m['collision_peak_impulse_ns'],impulse)
        return True

    def observe_collision(self,collision):
        """Event-driven native collisions are not synchronous sensor channels."""
        if self.phase!='RUNNING' or not self._accept_collision(collision):return None
        if self.metrics['collision_count']>self.spec.failure_conditions.get('max_collision_episodes',float('inf')):
            self.stop(reason='failure_condition')
            return self.collect_outcome()
        self._publish()

    def stop(self,reason='operator_stop'):
        if self.phase=='RUNNING':
            m=self.metrics; success=(m['progress_m']>=self.spec.success_conditions['min_progress_m'] and
                m['collision_count']<=self.spec.success_conditions.get('max_collision_episodes',float('inf')))
            self.phase='FINISHED'
            if self.urban:
                for name,plan in self.spec.metadata['vehicle_plans'].items():
                    if plan['kind']=='TRAFFIC_MANAGER':self.urban.handles[name].set_autopilot(False)
                for entry in self.urban.controllers.values():
                    if entry['started'] and entry['prepared']:entry['handle'].set_max_speed(0.)
            self.outcome={'run_id':self.run['run_id'],'condition_id':self.spec.condition_id,'reason':reason,
                          'scenario_success':success,'metrics':dict(m),'avoidability':'UNKNOWN',
                          'comparison_group':self.run['comparison_group'],'safety_policy_enabled':self.run['safety_policy_enabled'],
                          'measurement_notes':{'collision_severity':'Native impulse proxy in N*s, not injury or kinetic energy',
                              'clearance':'Planar yaw-oriented bounding boxes; pitch/roll/meshes excluded',
                              'collision_count':'Contact episodes separated by >1 simulation second; raw callbacks retained',
                              'null_metrics':'Not measured; no TTC/near-miss/intervention classifier is supplied'}}
            directory=ROOT/'output/scenarios';directory.mkdir(parents=True,exist_ok=True)
            (directory/(self.run['run_id']+'.json')).write_text(json.dumps({'run':self.run,'outcome':self.outcome},indent=2),encoding='utf8')
        self._publish()

    def collect_outcome(self):
        if self.outcome is None:raise ValueError('Stop or finish the scenario before collecting its outcome')
        return copy.deepcopy(self.outcome)

    def living_city(self):
        self.stop(reason='return_to_living_city');self.cleanup()
        self.mode=EnvironmentMode.LIVING_CITY;self.phase='EMPTY';self.spec=None
        self.provider.strict_ego_spawn=False
        self._publish()

    def _publish(self):
        self.cache={'mode':self.mode.value,'scenario_phase':self.phase,
                    'scenario':to_dict(self.spec) if self.spec else None,'run':copy.deepcopy(self.run),
                    'outcome':copy.deepcopy(self.outcome),'metrics':dict(self.metrics),
                    'actor_ids':dict(self.actors),
                    'safety_policy':{'status':'INTERFACE_PREPARED_NO_POLICY','active':False,'interventions':0}}

    def status(self, compact=False):
        if not compact:return copy.deepcopy(self.cache)
        # Full native starts/calibration stay in recordings; browser snapshots
        # carry operator state rather than the entire experiment manifest.
        run=self.cache['run']
        return {**{k:copy.deepcopy(v) for k,v in self.cache.items() if k not in ('run','scenario')},
            'scenario':{'scenario_id':self.spec.scenario_id,'random_seed':self.spec.random_seed,
                        'timeout':self.spec.timeout} if self.spec else None,
            'run':{k:copy.deepcopy(run[k]) for k in ('run_id','safety_policy_enabled','hazard_observations') if k in run} if run else None}
