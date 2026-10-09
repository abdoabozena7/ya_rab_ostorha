"""Compile configurable versions of the two existing native prototypes."""
from dataclasses import replace
import math
import random
from ...carla.scenarios import demonstration, canonical_transform
from ...core.scenarios import ActorControlSegment, ScenarioType
from ...core.contracts import finite

DEFAULTS={'ego_speed_mps':8.,'obstacle_distance_m':24.,'following_distance_m':18.,
          'lead_speed_mps':5.,'lead_brake':1.,'trigger_s':2.,'time_limit_s':12.,
          'heading_offset_deg':0.,'spawn_index':None}


def compile_scenario(provider, kind, seed, split, parameters):
    if set(parameters)-set(DEFAULTS):raise ValueError('Unknown scenario parameter')
    params={**DEFAULTS,**parameters}
    ranges={'ego_speed_mps':(0,15),'obstacle_distance_m':(12,45),'following_distance_m':(12,45),
            'lead_speed_mps':(0,25),'lead_brake':(.1,1),'trigger_s':(0,30),'time_limit_s':(.05,120),
            'heading_offset_deg':(-2,2)}
    for key,(lo,hi) in ranges.items():
        if not lo<=finite(params[key],key)<=hi:raise ValueError('Scenario parameter outside range: '+key)
    spec=demonstration(provider,kind,seed,split)
    world=provider.world.world; api=provider.connection.api
    distance=params['obstacle_distance_m'] if spec.scenario_type==ScenarioType.FRONT_OBSTACLE else params['following_distance_m']
    spawns=world.get_map().get_spawn_points()
    if params['spawn_index'] is not None:
        if type(params['spawn_index']) is not int or not 0<=params['spawn_index']<len(spawns):raise ValueError('Invalid road spawn index')
        spec=replace(spec,ego_spawn=params['spawn_index'])
    order=list(range(len(spawns)));random.Random(seed).shuffle(order)
    order=[spec.ego_spawn]+[i for i in order if i!=spec.ego_spawn] if params['spawn_index'] is None else [spec.ego_spawn]
    wp=None
    for index in order:
        trial=world.get_map().get_waypoint(spawns[index].location,lane_type=api.LaneType.Driving)
        if trial is None or trial.is_junction:continue
        valid=True
        # Check the entire corridor, not merely two matching endpoints.
        for s in range(1,math.ceil(distance)+3):
            candidates=trial.next(float(s))
            if len(candidates)!=1 or candidates[0].is_junction or (candidates[0].road_id,candidates[0].lane_id)!=(trial.road_id,trial.lane_id):
                valid=False;break
            angle=(candidates[0].transform.rotation.yaw-trial.transform.rotation.yaw+180)%360-180
            if abs(angle)>2.:valid=False;break
        if valid:wp=trial;spec=replace(spec,ego_spawn=index);break
    if wp is None:raise ValueError('Scenario distance requires an uninterrupted straight native lane')
    target=wp.next(distance)[0].transform;target.location.z+=.3
    sudden=spec.scenario_type==ScenarioType.SUDDEN_BRAKING
    schedule=(ActorControlSegment(0.,throttle=.35),ActorControlSegment(params['trigger_s'],brake=params['lead_brake'])) if sudden and params['trigger_s']>0 else (ActorControlSegment(0.,brake=params['lead_brake'] if sudden else 1.),)
    actor=replace(spec.other_actor_definitions[0],transform=canonical_transform(target),
                  initial_speed_mps=params['lead_speed_mps'] if sudden else 0.,control_schedule=schedule)
    return replace(spec,scenario_id=kind.lower()+'_rl_v1',ego_initial_speed=params['ego_speed_mps'],
                   other_actor_definitions=(actor,),timeout=params['time_limit_s'],
                   success_conditions={'min_progress_m':max(6.,distance-10.) if not sudden else 10.,'max_collision_episodes':0.},
                   metadata={**dict(spec.metadata),'rl_parameters':params,'lane_width_m':wp.lane_width,
                             'task':'safe_approach_and_stop','ego_control':'EXCLUSIVE_SCRIPTED_RL_INTERFACE'})
