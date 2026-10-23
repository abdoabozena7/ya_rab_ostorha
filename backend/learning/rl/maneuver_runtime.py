"""New sensor-only maneuver task executed by the existing native tick owner."""
from dataclasses import replace
import json
import math
from pathlib import Path
import time
import uuid
import hashlib
import numpy as np
from .runtime import RLRuntime
from .maneuver_observations import ManeuverObservationEncoder
from .maneuver_reward import ManeuverReward,driver_controls_changed
from .route_progress import FrozenRouteProgress
from ...core.contracts import ControlCommand,CommandSource,to_dict,ExperimentMetadata,DataOrigin
from ...core.recording import RunRecorder,BufferedRunRecorder
from ...core.control import safe_command
from ...core.maneuver_candidates import CandidateGenerator,ExecutionShield,signed_path,MODES
from ...core.scenarios import SEED_RANGES
from ...learning.pilot_budget import active_ticket,DEFAULT_ROOT
from ...carla.pilot_world import PilotWorld
from ...core.reposition_lease import RepositionLease


class ManeuverRuntime(RLRuntime):
    def __init__(self,service):
        super().__init__(service)
        self.world_fixture=PilotWorld(service.provider)
        self.encoder=ManeuverObservationEncoder();self.generator=CandidateGenerator();self.shield=ExecutionShield()
        self.records=[];self.bundle=None;self.current_policy_observation=None;self.policy_identity='PHYSICAL_BASELINE'
        self.reposition=RepositionLease()

    def status(self):
        result=super().status()
        result.update(environment_id='YaRabOstorha-Maneuver-v1',policy_active=self.policy_identity!='PHYSICAL_BASELINE',
                      policy_id=self.policy_identity,mode=getattr(self,'mode',None))
        return result

    def expired(self):return super().expired() or active_ticket() is None

    def acquire(self,*,split='TRAIN',max_steps=600,policy_id='PHYSICAL_BASELINE'):
        if active_ticket() is None:raise RuntimeError('A live independent four-hour pilot reservation is required')
        if not isinstance(policy_id,str) or not 1<=len(policy_id)<=160:raise ValueError('Identified policy required')
        value=super().acquire(split=split,max_steps=max_steps,baseline_id='SCRIPTED_DIAGNOSTIC')
        self.policy_identity=policy_id
        return {**value,**self.status()}

    def reset(self,seed,mode,scenario,parameters):
        if mode not in MODES:raise ValueError('Unknown task mode')
        lo,hi=SEED_RANGES[self.split]
        if type(seed) is not int or not lo<=seed<=hi:raise ValueError('Seed outside reserved split')
        allowed={'spawn_index','route_length','vehicles','pedestrians','time_limit_s','driver_trace','cap_mps','curriculum_stage','expected_map'}
        if not isinstance(parameters,dict) or set(parameters)-allowed:raise ValueError('Unknown maneuver parameters')
        expected_map=parameters.get('expected_map')
        if expected_map and self.service.provider.world.world.get_map().name.split('/')[-1]!=expected_map:
            raise ValueError('Scenario requires '+expected_map+'; current native map differs. No map substitution is permitted')
        if not self.done:self._finish_new('ABORTED')
        self.world_fixture.close();self.encoder.clear();self.records=[]
        self.service.control_decision_prediction=None
        self.reposition.reset()
        s=self.service;p=s.provider
        self.mode=mode;self.steps=0;self.total_reward=0.;self.episode_id='maneuver_'+uuid.uuid4().hex
        self.directory=DEFAULT_ROOT/'episodes'/self.split.value/self.episode_id
        self.directory.mkdir(parents=True,exist_ok=False)
        self.trace=parameters.get('driver_trace',[])
        if mode=='MANUAL_PROTECTION' and not self.trace:raise ValueError('Manual protection requires an explicit driver command trace')
        self.cap_mps=float(parameters.get('cap_mps',4.))
        self.time_limit=float(parameters.get('time_limit_s',60.))
        self.curriculum_stage=parameters.get('curriculum_stage')
        if self.curriculum_stage is not None and (type(self.curriculum_stage) is not int or not 0<=self.curriculum_stage<=5):
            raise ValueError('Invalid curriculum stage')
        if not .2<=self.cap_mps<=8.33 or not 1<=self.time_limit<=120:raise ValueError('Invalid pilot operating bounds')
        self.done=True;self.bundle=None
        self._clear_sync();s.control_scene=None;s.control_scene_builder=None
        try:
            self.world_fixture.setup(scenario,seed,**{k:v for k,v in parameters.items() if k in ('spawn_index','route_length','vehicles','pedestrians')})
            self._clear_sync();s.control_scene=None;s.control_scene_builder=None
            for _ in range(25):self._advance(safe_command(*s._context()),warmup=True)
            frame=self._advance(replace(safe_command(*s._context()),source=CommandSource.TRAINING))
            if frame.vehicle.speed_mps>.15:raise RuntimeError('Ego initialization did not settle')
            # CARLA's native automatic gearbox can remain neutral after the
            # explicit neutral warmup. A held R then held D transition requests
            # first gear natively, without throttle or unrecorded driving.
            for reverse in (True,False):
                frame=self._advance(replace(safe_command(*s._context()),source=CommandSource.TRAINING,
                                            reverse=reverse,gear=-1 if reverse else 1))
                if frame.vehicle.speed_mps>.15:raise RuntimeError('Gear initialization moved the settled ego')
            if frame.vehicle.gear!=1 or frame.vehicle.reverse:raise RuntimeError('Native forward gear initialization did not confirm')
            self.world_fixture.configure_route()
            if scenario=='MIXED_TRAFFIC':
                for _ in range(50):frame=self._advance(replace(safe_command(*s._context()),source=CommandSource.TRAINING),warmup=True)
                frame=self._advance(replace(safe_command(*s._context()),source=CommandSource.TRAINING))
                if not p.population.get_population_state()['walker_controllers_ready']:
                    raise RuntimeError('Mixed traffic walker controllers did not become ready')
            self.last_frame=frame;self.started=frame.timestamp_s;self.previous_speed=frame.vehicle.speed_mps
            self.world_fixture.begin(frame.timestamp_s)
            self.condition=self.world_fixture.manifest
            self.collision_start=frame.frame_id;self.seen_contacts=set();self.contacts=[]
            self.reward_projection=FrozenRouteProgress(self.condition['native_route'],frame.vehicle.transform.position_m)
            self.reward_v1=ManeuverReward(self.reward_projection.route_length)
            self.metrics={'valid_transitions':0,'completed_episodes':0,'native_distance_m':0.,'clear_path_stop_s':0.,
                          'maximum_clear_path_stop_s':0.,'fresh_decision_frames':0,'decision_frames':0,'shield_rejections':0,
                          'learned_proposals':0,'native_commands':0,'collisions':0,'reverse_distance_m':0.}
            self.done=False;self._prepare()
            self.native_recorder=BufferedRunRecorder(RunRecorder(self.directory,ExperimentMetadata(
                'sensors','Native maneuver pilot','carla',DataOrigin.REAL_SIMULATION,seed=seed,
                config={'condition_hash':self.condition['condition_hash'],'mode':mode,'policy_id':self.policy_identity})))
            s.recorder=self.native_recorder
            (self.directory/'manifest.json').write_text(json.dumps({**self.condition,'mode':mode,'driver_trace':self.trace,
                'policy_id':self.policy_identity,'environment_id':'YaRabOstorha-Maneuver-v1'},indent=2),encoding='utf8')
            return self._result()
        except Exception as error:
            (self.directory/'reset-failure.json').write_text(json.dumps({'outcome':'INVALID_SCENARIO','error':str(error)}),encoding='utf8')
            p.apply_control(safe_command(*s._context()));self.world_fixture.close();raise

    def _prepare(self):
        began=time.monotonic()
        s=self.service;p=s.provider;o=s.control_scene
        if o is None or o.observation.frame_id!=self.last_frame.frame_id:raise RuntimeError('No complete measured ControlScene for decision')
        self.base=p.navigation_command(self.last_frame.frame_id,self.last_frame.timestamp_s,self.cap_mps*3.6)
        base_ready=time.monotonic()
        if self.mode=='MANUAL_PROTECTION':
            elapsed=self.last_frame.timestamp_s-self.started
            segment=next((t for t in reversed(self.trace) if t['at_s']<=elapsed),None)
            if segment is None:raise ValueError('Driver trace must begin at zero')
            self.base=replace(self.base,source=CommandSource.MANUAL,throttle=segment.get('throttle',0.),
                brake=segment.get('brake',0.),steering=segment.get('steering',0.),reverse=segment.get('reverse',False),
                gear=-1 if segment.get('reverse',False) else 1)
        self.road=p.local_road_context(s.session_id)
        permitted=('HOLD','DRIVER','CONTINUE','SLOW','STOP') if self.curriculum_stage==0 else None
        self.bundle=self.generator.build(o,self.base,self.road,self.mode,self.cap_mps,wall_s=s.now(),permitted_candidates=permitted)
        masks_ready=time.monotonic()
        self.current_policy_observation=self.encoder.append(o,self.bundle,self.base,self.road)
        observation_digest=hashlib.sha256()
        for key,value in sorted(self.current_policy_observation.items()):
            observation_digest.update(key.encode());observation_digest.update(value.tobytes())
            value.flags.writeable=False
        observation_hash=observation_digest.hexdigest()
        bound_hash=hashlib.sha256((self.bundle.snapshot_hash+observation_hash).encode()).hexdigest()
        self.bundle=replace(self.bundle,snapshot_hash=bound_hash,observation_hash=observation_hash)
        self.preparation_timing={'base_ms':(base_ready-began)*1000,'candidates_ms':(masks_ready-base_ready)*1000,
            'observation_ms':(time.monotonic()-masks_ready)*1000,'scene_age_after_ms':(s.now()-o.received_wall_s)*1000}

    def _result(self,**kwargs):
        return {'observation':{k:v.tolist() for k,v in self.current_policy_observation.items()},'bundle':self.bundle.wire(),
                'info':{'environment_id':'YaRabOstorha-Maneuver-v1','episode_id':self.episode_id,'frame_id':self.last_frame.frame_id,
                        'timestamp_s':self.last_frame.timestamp_s,'mode':self.mode,'policy_id':self.policy_identity,
                        'policy_active':self.policy_identity!='PHYSICAL_BASELINE','metrics':dict(self.metrics),
                        'recording_path':str(self.directory),**kwargs.pop('info',{})},**kwargs}

    def step(self,action,snapshot_hash,frame_id,timestamp_s):
        if self.done:raise RuntimeError('Reset before stepping')
        if snapshot_hash!=self.bundle.snapshot_hash or frame_id!=self.bundle.scene_frame or timestamp_s!=self.bundle.timestamp_s:
            raise ValueError('Action does not reference its frozen observation/candidate/mask bundle')
        if type(action) is not int or not 0<=action<len(self.bundle.candidates):raise ValueError('Invalid action index')
        s=self.service;p=s.provider
        action_received_wall=s.now()
        action_scene=s.control_scene
        scene_age_at_action_s=action_received_wall-action_scene.received_wall_s
        self.metrics['decision_frames']+=1
        self.metrics['fresh_decision_frames']+=int(action_scene.usable(self.last_frame.timestamp_s,action_received_wall))
        self.metrics['maximum_scene_age_at_action_s']=max(self.metrics.get('maximum_scene_age_at_action_s',0.),scene_age_at_action_s)
        candidate=self.bundle.candidates[action]
        proposed=ControlCommand(**{**to_dict(candidate['command']),'source':CommandSource.TRAINING})
        rejection=None;applied=[];before=self.last_frame
        previous_position=np.asarray(before.vehicle.transform.position_m)
        try:
            if not candidate['admitted'] or candidate.get('fallback_unverified'):
                rejection=candidate['reason'] if not candidate['admitted'] else 'NO_VERIFIED_SAFE_ACTION'
            ticks=max(1,round(.1/p.fixed_delta))
            for tick in range(ticks):
                if self.expired():raise RuntimeError('Pilot reservation or execution lease expired')
                scene=s.control_scene;frame=self.last_frame
                command=replace(proposed,frame_id=frame.frame_id,timestamp_s=frame.timestamp_s)
                # Revalidate reachable motion under the actual command each native
                # frame. This never chooses another useful maneuver for the policy.
                from ...core.ego_motion import motion_speed
                path=signed_path(motion_speed(scene.observation.ego),command.steering,
                    command.throttle*2.5-command.brake*5.,scene.geometry,command.reverse,
                    bounded=command.reverse)
                if rejection is None:
                    lease_ok,lease_reason=self.reposition.allow(candidate['id'],frame.vehicle,frame.timestamp_s)
                    if not lease_ok:rejection=lease_reason
                if rejection is None:
                    ok,reason,evidence=self.shield.check(scene,path,command,self.road,
                        timestamp_s=frame.timestamp_s,wall_s=s.now())
                    if not ok:rejection=reason
                if rejection:
                    command=replace(command,throttle=0.,brake=1.,reverse=frame.vehicle.reverse,
                        gear=-1 if frame.vehicle.reverse else 1)
                    if self.reposition.phase=='SETTLING' and frame.vehicle.speed_mps<.15:
                        command=replace(command,reverse=False,gear=1)
                if command.reverse and frame.vehicle.speed_mps>=1.:
                    command=replace(command,throttle=0.,brake=1.)
                if command.reverse!=frame.vehicle.reverse:
                    command=replace(command,throttle=0.,brake=1.)
                self.world_fixture.before_tick(frame.timestamp_s)
                s.control_decision_prediction={**to_dict(scene.prediction),
                    'used_for_applied_decision':True,'decision_source':'EXECUTION_SHIELD' if rejection else self.policy_identity,
                    'policy_proposal_source':self.policy_identity,'selected_candidate':candidate['id'],
                    'applied_command':to_dict(command),'shield_rejection':rejection,
                    'render_reference':s.render_pose_cache.get(scene.observation.frame_id)}
                s.maneuver_status={'version':1,'action':candidate['id'] if not rejection else 'HOLD',
                    'phase':self.reposition.phase,'source_frame':scene.observation.frame_id,
                    'timestamp_s':scene.observation.timestamp_s,'reason':rejection or 'VERIFIED_MEASURED_CORRIDOR',
                    'selected_path':path.tolist(),'experimental':True,
                    'learned_control_used':self.policy_identity!='PHYSICAL_BASELINE' and rejection is None}
                receipt=s.arbiter.safety.receipts.get(CommandSource.TRAINING)
                if receipt is not None:time.sleep(max(0.,s.arbiter.safety.min_interval_s-(s.now()-receipt)))
                s.arbiter.submit(command,frame_id=frame.frame_id,timestamp_s=frame.timestamp_s,connected=True)
                selected=s._choose()
                if selected.source!=CommandSource.TRAINING:raise RuntimeError('Independent command arbitration rejected policy execution')
                self.last_frame=self._advance(selected)
                actual=self.last_frame.vehicle
                applied.append({'command':to_dict(selected),'native':{'throttle':actual.throttle,'brake':actual.brake,
                    'steering':actual.steering,'reverse':actual.reverse,'gear':actual.gear},'frame_id':self.last_frame.frame_id})
                movement=math.dist(previous_position,actual.transform.position_m);previous_position=np.asarray(actual.transform.position_m)
                self.metrics['native_distance_m']+=movement
                self.reposition.observe(movement)
                self.metrics['reverse_distance_m']+=movement*int(actual.reverse)
                for event in s.collision_events:
                    key=(event.frame_id,event.other_actor_id,event.impulse_ns)
                    if event.frame_id>self.collision_start and key not in self.seen_contacts:
                        self.seen_contacts.add(key);self.contacts.append(to_dict(event))
                self.metrics['native_commands']+=1
                if self.contacts:break
            frame=self.last_frame;dt=frame.timestamp_s-before.timestamp_s
            route=p.route_state();progress=self.reward_projection.measure(frame.vehicle.transform.position_m)
            completed=route['arrived'] and frame.vehicle.speed_mps<.15 and self.metrics['native_distance_m']>=5.
            if self.mode=='MANUAL_PROTECTION':
                final=self.trace[-1]
                completed=(final.get('brake',0.)>=.99 and frame.timestamp_s-self.started>=final['at_s']+1. and
                           frame.vehicle.speed_mps<.15 and self.metrics['native_distance_m']>=1.)
            validity=self.world_fixture.validity();collision=None
            if self.contacts:
                actor=p.world.world.get_actor(self.contacts[-1]['other_actor_id'])
                vulnerable=bool(actor and actor.type_id.startswith('walker.'))
                if actor and actor.type_id.startswith('vehicle.'):
                    blueprint=p.world.world.get_blueprint_library().find(actor.type_id)
                    vulnerable=blueprint.has_attribute('base_type') and blueprint.get_attribute('base_type').as_str() in ('bicycle','motorcycle')
                collision='VULNERABLE' if vulnerable else 'VEHICLE'
            acceleration=(frame.vehicle.speed_mps-self.previous_speed)/max(.001,dt)
            safe_driver=self.mode=='MANUAL_PROTECTION' and self.bundle.candidates[1]['admitted']
            desired=to_dict(self.base)
            unnecessary=safe_driver and any(driver_controls_changed(desired,v['command']) for v in applied)
            self.metrics['unnecessary_manual_intervention_s']=self.metrics.get('unnecessary_manual_intervention_s',0.)+dt*int(unnecessary)
            # Verified forward motion available at decision time, not taken.
            clear=any(c['admitted'] and c['id'] not in ('HOLD','STOP','REVERSE_STRAIGHT','REVERSE_LEFT','REVERSE_RIGHT')
                      and c['command']['throttle']>0 for c in self.bundle.candidates)
            driver_wait=self.mode=='MANUAL_PROTECTION' and (self.base.brake>.01 or self.base.throttle<=.01)
            idle=frame.vehicle.speed_mps<.15 and clear and not self.road.get('traffic_stop') and not driver_wait
            reward,components=self.reward_v1.evaluate(progress_m=progress,dt=dt,collision=collision,
                completed=completed and self.mode=='AUTONOMOUS',risk=self.world_fixture.near_miss_exposure(),
                acceleration_mps2=acceleration,unnecessary_manual_intervention=unnecessary,
                stationary_with_verified_forward=idle and self.mode=='AUTONOMOUS')
            self.previous_speed=frame.vehicle.speed_mps;self.steps+=1;self.total_reward+=reward
            self.metrics['valid_transitions']+=1;self.metrics['shield_rejections']+=int(rejection is not None)
            self.metrics['learned_proposals']+=int(self.policy_identity!='PHYSICAL_BASELINE');self.metrics['collisions']=len(self.contacts)
            if idle:
                self.metrics['clear_path_stop_s']+=dt
                self.metrics['maximum_clear_path_stop_s']=max(self.metrics['maximum_clear_path_stop_s'],self.metrics['clear_path_stop_s'])
            else:self.metrics['clear_path_stop_s']=0.
            outcome='COLLISION' if collision else 'SUCCESS' if completed and validity['valid'] else None
            if completed and not validity['valid']:outcome='INVALID_SCENARIO'
            if not outcome and (self.steps>=self.max_steps or frame.timestamp_s-self.started>=self.time_limit):outcome='TIME_LIMIT'
            row={'step':self.steps,'frame':frame.frame_id,'timestamp_s':frame.timestamp_s,'bundle_hash':snapshot_hash,
                 'scene_age_at_action_s':scene_age_at_action_s,'original_scene_receipt_wall_s':action_scene.received_wall_s,
                 'action_received_wall_s':action_received_wall,
                 'observation_sha256':self.bundle.observation_hash,'selected_candidate_evidence':to_dict(candidate['evidence']),
                 'candidate_masks':self.bundle.masks.tolist(),'candidate_reasons':[c['reason'] for c in self.bundle.candidates],
                 'proposed_path':to_dict(candidate['path']),'preparation_timing':self.preparation_timing,
                 'policy_proposal':action,'candidate_id':candidate['id'],'masked':not candidate['admitted'],
                 'shield_rejection':rejection,'fallback':'UNVERIFIED_HOLD' if rejection else None,
                 'applied':applied,'reward':reward,'reward_components':components,'outcome':outcome,
                 'ego':to_dict(frame.vehicle),'independent_actor_labels':self.world_fixture.truth(),
                 'reposition':{'phase':self.reposition.phase,'distance_m':self.reposition.distance,'started_s':self.reposition.started},
                 'prediction':to_dict(s.control_scene.prediction),
                 'applied_decision_prediction':to_dict(s.control_decision_prediction),'scenario_validity':validity}
            with (self.directory/'transitions.jsonl').open('a',encoding='utf8') as stream:stream.write(json.dumps(row,allow_nan=False)+'\n')
            self._prepare()
            if outcome:self._finish_new(outcome)
            return self._result(reward=reward,terminated=outcome in ('SUCCESS','COLLISION'),truncated=bool(outcome and outcome not in ('SUCCESS','COLLISION')),
                info={'outcome':outcome,'scenario_validity':validity,'shield_rejection':rejection,'candidate_id':candidate['id'],
                      'reward_components':components,'avoidability':'UNKNOWN'})
        except Exception as error:
            self._finish_new('SIMULATOR_FAILURE',error=str(error));raise

    def _finish_new(self,outcome,**details):
        self.done=True;self.outcome=outcome
        if hasattr(self,'metrics'):
            self.metrics['completed_episodes']=int(outcome=='SUCCESS')
            report={'outcome':outcome,'reward':self.total_reward,'metrics':self.metrics,'contacts':self.contacts,
                    'avoidability':'UNKNOWN','scenario_validity':self.world_fixture.validity(),**details}
            (self.directory/'outcome.json').write_text(json.dumps(report,indent=2,allow_nan=False),encoding='utf8')
        if getattr(self,'native_recorder',None):
            self.service.recorder=None;self.native_recorder.close()
            self.recording_status=self.native_recorder.status();self.native_recorder=None
        self.service.provider.apply_control(safe_command(*self.service._context()));self.service.arbiter.safety.clear()

    def close(self,reason='client_close'):
        if not self.active:return {'active':False}
        if not self.done:self._finish_new('ABORTED',reason=reason)
        self.world_fixture.close()
        self.service.control_decision_prediction=None
        camera=dict(self.saved['camera']);self.saved['camera']['_suppress_pilot_surround']=True
        try:return super().close(reason)
        finally:
            self.saved['camera']=camera;self.service.provider.camera_settings=camera
