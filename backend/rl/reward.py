"""Reward-only native geometry and hypothesis weights; never policy perception."""
from dataclasses import asdict, dataclass
import math
from ..carla.geometry import footprint, rectangle_clearance
from ..carla.scenarios import native_transform


@dataclass(frozen=True)
class RewardWeights:
    collision: float = -100.
    severity: float = -.01  # Native impulse N*s; not injury severity.
    proximity: float = -2.
    progress: float = 1.
    delay: float = -.2
    smoothness: float = -.1
    unnecessary_braking: float = -.1
    success: float = 25.


class RewardEvaluator:
    def __init__(self, weights=None):
        self.weights=weights or RewardWeights()
        from ..core.contracts import finite
        for key,value in asdict(self.weights).items():
            finite(value,key)
            if key in ('progress','success') and value<0 or key not in ('progress','success') and value>0:
                raise ValueError('Reward component has an inconsistent sign')

    def evaluate(self, context, previous_action, applied_action, dt, success):
        gap,ttc=context['clearance_m'],context['ttc_s']
        safe=gap is not None and gap>=2. and (ttc is None or ttc>=1.) and context['lane_valid'] and not context['collisions']
        values={
            'collision':float(bool(context['collisions'])),
            'severity':sum(e.impulse_magnitude_ns or math.hypot(*e.impulse_ns) for e in context['collisions']),
            'proximity':max(0.,2.-gap)*dt if gap is not None else 0.,
            # Signed progress: reversing/oscillating cannot harvest positive deltas.
            'progress':context['progress_delta_m'] if context['progress_delta_m']<0 or safe else 0.,
            'delay':dt*(1.+float(context['speed_mps']<.2)),
            'smoothness':sum((float(a)-float(b))**2 for a,b in zip(applied_action,previous_action)),
            'unnecessary_braking':float(applied_action[2])*dt if gap is not None and gap>12 and (ttc is None or ttc>5) else 0.,
            'success':float(success),
        }
        components={k:v*getattr(self.weights,k) for k,v in values.items()}
        return float(sum(components.values())),components,values


class NativeMeasurements:
    """Ground truth is restricted to reward/outcome/evaluation context."""
    def __init__(self, provider, initial_frame, scenario):
        self.provider,self.scenario=provider,scenario
        self.initial=initial_frame.vehicle.transform
        self.previous=initial_frame
        self.progress=0.;self.stop_duration=0.
        self.metrics={'collision_count':0,'collision_callback_count':0,'collision_peak_impulse_ns':0.,
                      'collision_impulse_total_ns':0.,'minimum_clearance_m':None,'minimum_ttc_s':None,
                      'forward_progress_m':0.,'distance_traveled_m':0.,'duration_s':0.,'average_speed_mps':0.,
                      'hard_braking_events':0,'steering_oscillation':0.,'intervention_count':0,
                      'intervention_frequency':None,'scenario_success':False,'time_to_completion_s':None}
        self.contacts={};self.last_steering_delta=0.;self.was_hard_braking=False

    def collect(self, frame, collisions, previous_action, action):
        p=self.provider; v=frame.vehicle;dt=frame.timestamp_s-self.previous.timestamp_s
        yaw=self.initial.rotation_rad.yaw;axis=(math.cos(yaw),math.sin(yaw))
        dx=v.transform.position_m[0]-self.initial.position_m[0];dy=v.transform.position_m[1]-self.initial.position_m[1]
        progress=dx*axis[0]+dy*axis[1];lateral=-dx*axis[1]+dy*axis[0]
        heading=(v.transform.rotation_rad.yaw-yaw+math.pi)%(2*math.pi)-math.pi
        lane_valid=abs(lateral)<=float(self.scenario.metadata['lane_width_m'])/2-.5 and abs(heading)<math.radians(30)
        gap=ttc=leader_speed=None
        if frame.ground_truth:
            ego_shape=footprint(native_transform(p.connection.api,v.transform),p.ego.actor.bounding_box)
            for item in frame.ground_truth.objects:
                if item.actor.actor_id not in p.scenarios.actors.values():continue
                actor=p.world.world.get_actor(item.actor.actor_id)
                if actor is None:continue
                clearance=rectangle_clearance(ego_shape,footprint(native_transform(p.connection.api,item.actor.transform),actor.bounding_box))
                gap=clearance if gap is None else min(gap,clearance)
                leader_speed=math.hypot(*item.actor.linear_velocity_mps)
                rel=[item.actor.transform.position_m[i]-v.transform.position_m[i] for i in (0,1)]
                ahead=rel[0]*axis[0]+rel[1]*axis[1];across=-rel[0]*axis[1]+rel[1]*axis[0]
                closing=sum((v.linear_velocity_mps[i]-item.actor.linear_velocity_mps[i])*axis[i] for i in (0,1))
                # Straight aligned longitudinal TTC only; undefined for opening,
                # crossing and non-collinear traffic. Overlap alone is not contact.
                if ahead>0 and abs(across)<1.5 and abs(heading)<math.radians(10) and closing>.1:
                    estimate=clearance/closing;ttc=estimate if ttc is None else min(ttc,estimate)
        m=self.metrics
        m['duration_s']+=dt;m['distance_traveled_m']+=math.dist(self.previous.vehicle.transform.position_m,v.transform.position_m)
        m['forward_progress_m']=progress;m['average_speed_mps']=m['distance_traveled_m']/m['duration_s']
        for key,val in (('minimum_clearance_m',gap),('minimum_ttc_s',ttc)):
            if val is not None:m[key]=val if m[key] is None else min(m[key],val)
        for e in collisions:
            m['collision_callback_count']+=1
            if e.timestamp_s-self.contacts.get(e.other_actor_id,-float('inf'))>1.:m['collision_count']+=1
            self.contacts[e.other_actor_id]=e.timestamp_s
            impulse=e.impulse_magnitude_ns or math.hypot(*e.impulse_ns)
            m['collision_peak_impulse_ns']=max(m['collision_peak_impulse_ns'],impulse);m['collision_impulse_total_ns']+=impulse
        hard=v.longitudinal_acceleration_mps2 is not None and v.longitudinal_acceleration_mps2<=-4.
        if hard and not self.was_hard_braking:m['hard_braking_events']+=1
        self.was_hard_braking=hard
        delta=float(action[0]-previous_action[0])
        if delta*self.last_steering_delta<0:m['steering_oscillation']+=abs(delta)
        if delta:self.last_steering_delta=delta
        stopped=v.speed_mps<.2 and leader_speed is not None and leader_speed<.3
        self.stop_duration=self.stop_duration+dt if stopped else 0.
        context={'progress_delta_m':progress-self.progress,'progress_m':progress,'clearance_m':gap,'ttc_s':ttc,
                 'lane_valid':lane_valid,'speed_mps':v.speed_mps,'leader_speed_mps':leader_speed,
                 'collisions':tuple(collisions),'stop_duration_s':self.stop_duration,'dt':dt}
        self.progress=progress;self.previous=frame
        return context


def episode_outcome(context, metrics, spec, steps, max_steps, collision_impulse_threshold=0.):
    if any((e.impulse_magnitude_ns or math.hypot(*e.impulse_ns))>=collision_impulse_threshold for e in context['collisions']):
        return 'COLLISION',True,False,'collision_threshold',None
    if not context['lane_valid']:
        return 'ABORTED',True,False,'left_supported_lane',None
    trigger=float(spec.metadata['rl_parameters']['trigger_s']) if spec.scenario_type.value=='SUDDEN_BRAKING' else 0.
    success=(metrics['collision_count']==0 and context['progress_m']>=spec.success_conditions['min_progress_m'] and
             context['clearance_m'] is not None and context['clearance_m']>=2. and
             context['stop_duration_s']>=.5 and metrics['duration_s']>=trigger)
    if success:return 'SUCCESS',True,False,'safe_approach_and_stop',None
    if metrics['duration_s']+1e-6>=spec.timeout:return 'TIMEOUT',False,True,None,'simulation_time_limit'
    if steps>=max_steps:return 'TIMEOUT',False,True,None,'maximum_steps'
    return None,False,False,None,None
