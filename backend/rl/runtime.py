"""Exclusive episodes executed only by SimulationService's existing worker."""
import copy
from datetime import datetime, timezone
import json
import math
from pathlib import Path
import sys
import time
import uuid
import numpy as np
import gymnasium
from ..core.contracts import CommandSource, ControlCommand, DataOrigin, ExperimentMetadata, finite, to_dict
from ..core.control import ControlMode, safe_command
from ..core.events import EventType, SimulationEvent
from ..core.recording import RunRecorder
from ..core.safety_policy import sensor_observation
from ..core.scenarios import DatasetSplit
from ..core.timing import SensorSynchronizer
from .actions import physical_command
from .observations import CONFIGS, ObservationAssembler, pack_observation
from .reward import RewardEvaluator, RewardWeights, NativeMeasurements, episode_outcome
from .scenarios import compile_scenario

ROOT=Path(__file__).resolve().parents[2]


class RLRuntime:
    LEASE_SECONDS=120.

    def __init__(self, service):
        self.service=service;self.active=False;self.token=None;self.last_request=0.
        self.done=True;self.episode_id=None;self.recorder=None;self.outcome=None
        self.last_observation=None;self.last_frame=None;self.baseline_agent=None
        self.supervisor=False;self.policy_id=None

    def expired(self):return time.monotonic()-self.last_request>self.LEASE_SECONDS

    def status(self):
        return {'active':self.active,'tick_owner':'simulation-worker','episode_id':self.episode_id,
                'episode_done':self.done,'outcome':self.outcome,'policy_active':False,
                'lease_seconds':self.LEASE_SECONDS,'pending_requests':self.service.rl_requests.qsize(),
                'bounded_buffers':{'observation_history':len(self.assembler.history) if hasattr(self,'assembler') else 0,
                    'sensor_assets':len(self.service.provider.sensor_manager.assets) if getattr(self.service.provider,'sensor_manager',None) else 0,
                    'camera_cache':len(self.service.camera_cache),'sensor_frame_cache':len(self.service.sensor_frame_cache),
                    'synchronizer_pending':len(self.service.synchronizer.pending)}}

    def dispatch(self, operation, **data):
        if operation=='acquire':
            with self.service.lock:return self.acquire(**data)
        token=data.pop('token',None)
        if not self.active or token!=self.token:raise RuntimeError('RL session token is absent, expired or owned by another client')
        if self.expired():
            self.close(reason='lease_expired')
            raise RuntimeError('RL runtime lease expired')
        self.last_request=time.monotonic()
        if operation=='heartbeat':return self.status()
        if operation=='reset':return self.reset(**data)
        if operation=='step':return self.step(**data)
        if operation=='close':return self.close()
        if operation=='baseline':return self.baseline(**data)
        raise ValueError('Unknown RL operation')

    def acquire(self, profile='lightweight', split='TRAIN', max_steps=400, baseline_id='SCRIPTED_DIAGNOSTIC',
                reward_weights=None, collision_impulse_threshold=0., supervisor=False, policy_id=None):
        s=self.service;p=s.provider
        if self.active:raise RuntimeError('An exclusive RL session already exists')
        if p.name!='carla' or not getattr(p,'sensor_suite',False):raise RuntimeError('RL requires REAL CARLA with the native sensor suite')
        if s.recorder or s.restarting or s.reconfiguring or s.actions:raise RuntimeError('Finish recording or pending reconfiguration before acquiring RL')
        if s.arbiter.safety.emergency:raise RuntimeError('Acknowledge the emergency stop before acquiring RL')
        if type(max_steps) is not int or not 1<=max_steps<=2400:raise ValueError('Invalid maximum steps')
        if type(supervisor) is not bool:raise ValueError('supervisor must be boolean')
        if supervisor and (profile!='lightweight' or baseline_id!='BASIC_AGENT_WITH_SUPERVISOR' or
                           not isinstance(policy_id,str) or not 1<=len(policy_id)<=160):
            raise ValueError('Experiment 1 requires lightweight sensors and an identified supervisor')
        if not supervisor and baseline_id not in ('SCRIPTED_DIAGNOSTIC','CONSERVATIVE_RADAR_BRAKING','BASIC_AGENT_NO_SAFETY'):
            raise ValueError('Unknown baseline identity; no learned policy exists')
        config=CONFIGS[profile];split=DatasetSplit(split)
        self.collision_impulse_threshold=finite(collision_impulse_threshold)
        if self.collision_impulse_threshold<0:raise ValueError('Collision threshold must be nonnegative')
        try:self.reward=RewardEvaluator(RewardWeights(**(reward_weights or {})))
        except TypeError as error:raise ValueError('Unknown reward weight') from error
        s.require_connected()
        self.saved={'camera':dict(p.camera_settings),'spawn_index':p.spawn_index,'blueprint':p.blueprint,
                    'transform':p.ego.actor.get_transform(),'weather':p.world.world.get_weather(),
                    'population':dict(p.population.config),'paused':s.paused,
                    'route':copy.deepcopy(p.dashboard_tools.route) if p.dashboard_tools else None,
                    'sensor_timeout':s.synchronizer.timeout_s}
        s._stop_navigation('rl_runtime_acquired');s.arbiter.safety.clear()
        # Transition AUTOMATIC -> PAUSED is handled by _stop_navigation above.
        if s.arbiter.machine.mode not in (ControlMode.MANUAL,ControlMode.PAUSED):raise RuntimeError('Driving state cannot enter RL mode')
        s.arbiter.machine.allow_training=True
        s.arbiter.machine.transition(ControlMode.TRAINING,connected=True,explicit=True)
        p.apply_control(safe_command(*s._context()))
        p.world.paused=False;s.paused=False
        self.config,self.split,self.max_steps,self.baseline_id=config,split,max_steps,baseline_id
        self.supervisor,self.policy_id=supervisor,policy_id
        self.active=True;self.token=uuid.uuid4().hex;self.last_request=time.monotonic()
        self.assembler=ObservationAssembler(config,p.get_sensor_asset)
        return {'token':self.token,**self.status()}

    def _clear_sync(self, timeout=2.):
        s=self.service
        s._drain_collision_events();s.provider.drain_sensor_frames()
        s.synchronizer=SensorSynchronizer(s.synchronizer.required,s.synchronizer.optional,timeout_s=timeout,now=s.now)
        s.policy_history.clear();s.camera_cache.clear();s.sensor_frame_cache.clear();s.collision_events.clear()
        s.frame_tick_started.clear()

    def _advance(self, command, *, warmup=False):
        s=self.service;p=s.provider
        # Detect an external ticker before issuing another action/step.
        if p.world.world.get_snapshot().frame!=p.last_vehicle['frame']:
            raise RuntimeError('Competing simulation tick owner detected')
        previous=p.last_vehicle['frame']
        s._iteration(training_command=command)
        expected=p.last_vehicle['frame']
        if expected!=previous+1:raise RuntimeError('RL step must advance exactly one native frame')
        deadline=time.monotonic()+(.12 if warmup else 2.)
        while (s.observation is None or s.observation.frame_id<expected) and time.monotonic()<deadline:
            s._ingest_provider_sensors()
            for frame in s.synchronizer.drain():s._publish(frame);s._record(frame)
            if s.observation is None or s.observation.frame_id<expected:time.sleep(.002)
        frame=s.observation
        if warmup:
            for pending in s.synchronizer.drain(force=True):s._publish(pending)
            return s.observation
        if frame is None or frame.frame_id!=expected or not frame.complete:
            raise RuntimeError(f'Sensor synchronization failed: expected {expected}, published {frame.frame_id if frame else None}, '
                               f'missing {frame.missing_required_sensors if frame else None}; no stale frame substitution')
        if any(sensor.frame_id!=expected or abs(sensor.sensor_timestamp_s-frame.timestamp_s)>1e-6 for sensor in frame.sensors):
            raise RuntimeError('Native sensor frame/time mismatch')
        if p.sensor_errors():raise RuntimeError('Native sensor callback error: '+str(p.sensor_errors()))
        # Bounded callback grace for event-driven collision data. These retain
        # their actual anchor frame/time, including callbacks delivered late.
        time.sleep(.01);s._drain_collision_events()
        return frame

    def reset(self, seed, scenario, parameters):
        s=self.service;p=s.provider
        if self.supervisor and scenario!='SUDDEN_BRAKING':raise ValueError('Experiment 1 supports Sudden Braking only')
        spec=compile_scenario(p,scenario,seed,self.split.value,parameters)
        if not self.done:self._finish('ABORTED',False,True,None,'reset_requested')
        self.done=True;self.baseline_agent=None;self.assembler.clear()
        self.episode_id='rl_'+uuid.uuid4().hex;self.outcome=None;self.steps=0;self.total_reward=0.
        self.previous_action=np.zeros(3,np.float64)
        self.collision_closed_through=s._context()[0]
        self.seen_collisions=set()
        old_ids=self._owned_ids()
        try:
            p.camera_settings={**p.camera_settings,'camera_view':'front',
                               'camera_resolution':f'{max(160,self.config.width)}x{max(90,self.config.height)}'}
            self._clear_sync()
            p.scenarios.load(spec)
            # CARLA sensor callbacks from retired managers cannot enter this new
            # synchronizer; close() has removed their registration dictionaries.
            self._clear_sync()
            heading=float(spec.metadata['rl_parameters']['heading_offset_deg'])
            if heading:
                transform=p.ego.actor.get_transform();transform.rotation.yaw+=heading;p.ego.actor.set_transform(transform)
            for _ in range(30):self._advance(safe_command(*s._context()),warmup=True)
            if s.observation.vehicle.speed_mps>.15:raise RuntimeError('Ego did not stabilize before initialization')
            # Re-capture actual settled poses. Existing Gate 5 behavior is untouched.
            p.scenarios.initial_pending=True;p.scenarios.after_tick(p.world.world.get_snapshot())
            p.scenarios.start()
            frame=self._advance(ControlCommand(*s._context(),0.,0.,0.,False,False,CommandSource.TRAINING,1))
            self.collision_closed_through=frame.frame_id
            self.last_frame=frame
            self.measurements=NativeMeasurements(p,frame,spec)
            if self.supervisor:
                self.measurements.metrics.update(intervention_steps=0,intervention_proposals=0,
                    unnecessary_intervention_count=0,steering_adjustment_rejections=0)
                self.was_intervention=False
            self.spec=spec;self.done=False
            self.last_observation=self.assembler.append(sensor_observation(frame),self.previous_action)
            if self.supervisor:self._prepare_base()
            condition={'scenario_spec':to_dict(spec),'map':p.world.world.get_map().name,
                       'ego_blueprint':p.ego.actor.type_id,'fixed_delta_seconds':p.fixed_delta,
                       'intended_initial_states':p.scenarios.run['initial_states'],
                       'actual_velocity_initialization':p.scenarios.run['start_states'],
                       'versions':{'python':sys.version,'carla_server':p.connection.server_version,
                                   'carla_api':p.connection.api_version,'gymnasium':gymnasium.__version__,'numpy':np.__version__},
                       'observation_profile':self.config.name,'reward_weights':to_dict(self.reward.weights),
                       'weights_status':'HYPOTHESES_REQUIRING_EXPERIMENTAL_TUNING',
                       'collision_impulse_failure_threshold_ns':self.collision_impulse_threshold,
                       'baseline_id':self.baseline_id,'policy_active':False,
                       'supervisory_training_mode':self.supervisor,'training_policy_id':self.policy_id,
                       'base_driver':'BASIC_AGENT_NO_HAZARD_HANDLING' if self.supervisor else self.baseline_id}
            self.recorder=RunRecorder(ROOT/'runs/rl'/self.split.value,ExperimentMetadata(self.episode_id,
                'Experiment 1 supervisory episode' if self.supervisor else 'Gate 6 real CARLA episode',
                'carla',DataOrigin.REAL_SIMULATION,seed=seed,
                created_at_utc=datetime.now(timezone.utc).isoformat(),config=condition))
            s.recorder=self.recorder;s._record(frame)
            self.recording_path=str(self.recorder.root)
            info=self._info(frame)
            info.update(initial_configuration=condition,actor_inventory=self.inventory(),
                        retired_actor_ids=sorted(old_ids),reset_cleanup_verified=not bool(old_ids & self._owned_ids()))
            return {'observation':pack_observation(self.last_observation),'info':info}
        except Exception:
            if self.recorder and not self.recorder.closed:
                self._finish('SIMULATOR_FAILURE',False,True,None,'reset_infrastructure_failure')
            p.apply_control(safe_command(*s._context()))
            p.scenarios.cleanup();self.done=True
            raise

    def step(self, action, frame_id, timestamp_s):
        if self.done:raise RuntimeError('Reset before stepping a completed episode')
        s=self.service;p=s.provider
        if frame_id!=self.last_frame.frame_id or timestamp_s!=self.last_frame.timestamp_s:
            raise ValueError('Action must reference the latest RL observation exactly')
        decision=None;base=None
        if self.supervisor:
            from .supervisor import decide_intervention,normalize_intervention
            proposed,_=normalize_intervention(action)
            base=self.base_command
            command,decision=decide_intervention(sensor_observation(self.last_frame),base,action,self.policy_id)
            applied=np.array([command.steering,command.throttle,command.brake],np.float64)
        else:proposed,applied,command=physical_command(action,self.last_frame,self.previous_action,p.fixed_delta)
        # Retain the existing wall rate limit without silently losing requests.
        for source in (CommandSource.TRAINING,command.source):
            receipt=s.arbiter.safety.receipts.get(source)
            if receipt is not None:time.sleep(max(0.,s.arbiter.safety.min_interval_s-(s.now()-receipt)))
        try:
            if s.arbiter.safety.emergency:raise RuntimeError('External emergency stop')
            if self.supervisor:
                # A previous safety proposal cannot persist across NO_INTERVENTION.
                s.arbiter.safety.latest.pop(CommandSource.SAFETY,None)
                s.arbiter.safety.receipts.pop(CommandSource.SAFETY,None)
                s.arbiter.submit(base,frame_id=self.last_frame.frame_id,timestamp_s=self.last_frame.timestamp_s,connected=True)
            if not self.supervisor or command.source==CommandSource.SAFETY:
                s.arbiter.submit(command,frame_id=self.last_frame.frame_id,timestamp_s=self.last_frame.timestamp_s,connected=True)
            selected=s._choose()
            if selected.source!=command.source:raise RuntimeError('Training action rejected by safety arbitration')
            frame=self._advance(selected)
            if self.supervisor and not np.allclose(applied,[frame.vehicle.steering,frame.vehicle.throttle,frame.vehicle.brake],atol=1e-5,rtol=0):
                raise RuntimeError('Actual native controls differ from the accepted supervisory command')
            collisions=[]
            for event in s.collision_events:
                key=(event.frame_id,event.other_actor_id,event.impulse_ns)
                if event.ego_actor_id==frame.vehicle.actor_id and event.frame_id>self.collision_closed_through and key not in self.seen_collisions:
                    collisions.append(event);self.seen_collisions.add(key)
            context=self.measurements.collect(frame,collisions,self.previous_action,applied)
            if self.baseline_id=='CONSERVATIVE_RADAR_BRAKING':
                metrics=self.measurements.metrics
                if applied[2]>0 and self.previous_action[2]==0:metrics['intervention_count']+=1
                metrics['intervention_frequency']=metrics['intervention_count']/metrics['duration_s']
            self.steps+=1
            outcome,terminated,truncated,term_reason,trunc_reason=episode_outcome(
                context,self.measurements.metrics,self.spec,self.steps,self.max_steps,self.collision_impulse_threshold)
            reward,components,raw=self.reward.evaluate(context,self.previous_action,applied,context['dt'],outcome=='SUCCESS')
            if self.supervisor:
                m=self.measurements.metrics;intervened=decision['accepted']
                m['intervention_steps']+=int(intervened)
                m['intervention_proposals']+=int(decision['bounded_intervention'][0]>0)
                m['intervention_count']+=int(intervened and not self.was_intervention)
                m['intervention_frequency']=m['intervention_count']/m['duration_s']
                m['unnecessary_intervention_count']+=int(intervened and raw['unnecessary_braking']>0)
                m['steering_adjustment_rejections']+=int(decision['steering_adjustment_rejected'])
                self.was_intervention=intervened
            observation=self.assembler.append(sensor_observation(frame),applied)
            self.last_frame=frame;self.last_observation=observation;self.previous_action=applied
            self.total_reward+=reward
            if self.supervisor and not outcome:self._prepare_base()
            info=self._info(frame)
            info.update(proposed_action=proposed.tolist(),applied_action=applied.tolist(),reward_components=components,
                        reward_measurements=raw,collision_events=[to_dict(e) for e in collisions],
                        outcome=outcome,termination_reason=term_reason,truncation_reason=trunc_reason)
            if self.supervisor:
                info.update(base_proposed_action=[base.steering,base.throttle,base.brake],
                            next_base_proposed_action=[self.base_command.steering,self.base_command.throttle,self.base_command.brake],
                            intervention=decision,applied_command=to_dict(selected),
                            native_applied_action=[frame.vehicle.steering,frame.vehicle.throttle,frame.vehicle.brake])
            self._record_step(info,reward)
            if outcome:
                self._finish(outcome,terminated,truncated,term_reason,trunc_reason)
                info['episode_metrics']=dict(self.measurements.metrics)
            return {'observation':pack_observation(observation),'reward':reward,'terminated':terminated,'truncated':truncated,'info':info}
        except ValueError:
            raise
        except Exception as error:
            reason='external_emergency_stop' if s.arbiter.safety.emergency else str(error)
            outcome='ABORTED' if s.arbiter.safety.emergency else 'SIMULATOR_FAILURE'
            if self.recorder and not self.recorder.closed:
                self.recorder.record_event(SimulationEvent(EventType.ControlChanged,*s._context(),
                    {'rl_failed_step':{'proposed_action':proposed.tolist(),'attempted_action':applied.tolist(),
                        'attempted_command':to_dict(command),'physics_step_confirmed':p.last_vehicle['frame']>self.last_frame.frame_id,
                        'error':str(error),'outcome':outcome}}))
            self._finish(outcome,False,True,None,reason)
            invalid={k:v.copy() for k,v in self.last_observation.items()}
            for key in ('history_valid','radar_valid','lidar_valid'):
                if key in invalid:invalid[key].fill(0)
            info=self._info(self.last_frame)
            info.update(outcome=outcome,termination_reason=None,truncation_reason=reason,observation_valid=False,
                        proposed_action=proposed.tolist(),applied_action=None,safety_command_requested=[0.,0.,1.],
                        reward_components={},error=str(error))
            return {'observation':pack_observation(invalid),'reward':0.,'terminated':False,'truncated':True,'info':info}

    def _info(self,frame):
        info={'episode_id':self.episode_id,'scenario_id':self.spec.scenario_id,'seed':self.spec.random_seed,
                'split':self.split.value,'frame_id':frame.frame_id,'timestamp_s':frame.timestamp_s,
                'step':self.steps,'recording_path':self.recording_path,'observation_valid':True,
                'tick_owner':'simulation-worker','policy_active':False,'baseline_id':self.baseline_id}
        if self.supervisor:
            info.update(supervisory_training_mode=True,training_policy_id=self.policy_id,
                base_proposed_action=[self.base_command.steering,self.base_command.throttle,self.base_command.brake])
        return info

    def _prepare_base(self):
        # BasicAgent remains inside the native worker. Only its ControlCommand
        # crosses the sensor-only supervisory boundary; its route/map do not.
        action=self.baseline()['action']
        _,_,self.base_command=physical_command(action,self.last_frame,self.previous_action,self.service.provider.fixed_delta)

    def _record_step(self,info,reward):
        self.recorder.record_event(SimulationEvent(EventType.ControlChanged,info['frame_id'],info['timestamp_s'],
            {'rl_step':{**info,'reward':reward,'observation_assets':[to_dict(c.asset) for c in self.last_frame.sensors if c.asset]}}))

    def _finish(self,outcome,terminated,truncated,term_reason,trunc_reason):
        s=self.service;p=s.provider
        self.done=True;self.outcome=outcome
        if hasattr(self,'measurements'):
            m=self.measurements.metrics;m['scenario_success']=outcome=='SUCCESS'
            m['time_to_completion_s']=m['duration_s'] if outcome=='SUCCESS' else None
            result={'episode_id':self.episode_id,'scenario_id':self.spec.scenario_id,'seed':self.spec.random_seed,
                    'split':self.split.value,'baseline_id':self.baseline_id,'outcome':outcome,
                    'terminated':terminated,'truncated':truncated,'termination_reason':term_reason,
                    'truncation_reason':trunc_reason,'reward':self.total_reward,'steps':self.steps,'metrics':dict(m),
                    'policy_active':False,'collision_severity_units':'native impulse N*s',
                    'ttc_definition':'planar aligned longitudinal clearance / positive closing speed'}
            if self.supervisor:
                result.update(supervisory_training_mode=True,training_policy_id=self.policy_id)
                m['hard_braking_frequency_hz']=m['hard_braking_events']/m['duration_s'] if m['duration_s'] else 0.
                result['metrics']=dict(m)
            if self.recorder and not self.recorder.closed:
                self.recorder.record_event(SimulationEvent(EventType.ControlChanged,*s._context(),{'rl_episode_outcome':result}))
                (self.recorder.root/'outcome.json').write_text(json.dumps(result,indent=2,allow_nan=False),encoding='utf8')
                s.recorder=None;self.recorder.close()
        try:
            p.apply_control(safe_command(*s._context()))
        except Exception as error:
            self.safety_stop_error=str(error)
            if self.recorder and hasattr(self,'measurements'):
                result['safety_stop_command_error']=str(error)
                (self.recorder.root/'outcome.json').write_text(json.dumps(result,indent=2,allow_nan=False),encoding='utf8')
        finally:
            s.arbiter.safety.clear()
        p.scenarios.stop(reason=outcome)

    def _owned_ids(self):
        p=self.service.provider
        return {
            p.ego.actor.id,*[a.id for a in p.sensor_manager.actors.values()],*p.scenarios.actors.values()}

    def inventory(self):
        actors=self.service.provider.world.world.get_actors()
        return {k:len(actors.filter(pattern)) for k,pattern in
                (('vehicles','vehicle.*'),('sensors','sensor.*'),('walkers','walker.pedestrian.*'),('controllers','controller.ai.walker'))}

    def close(self,reason='client_close'):
        if not self.active:return {'active':False}
        s=self.service;p=s.provider
        if not self.done:self._finish('ABORTED',False,True,None,reason)
        try:
            p.scenarios.living_city()
            p.camera_settings=dict(self.saved['camera']);p.spawn_index=self.saved['spawn_index'];p.blueprint=self.saved['blueprint']
            p.world.paused=False;s.paused=False;p.reset_vehicle()
            p.ego.actor.set_transform(self.saved['transform']);p.world.world.set_weather(self.saved['weather'])
            self._clear_sync()
            for _ in range(5):self._advance(safe_command(*s._context()),warmup=True)
            p.population.apply(self.saved['population'])
            if p.dashboard_tools:p.dashboard_tools.route=self.saved['route']
            s.synchronizer.timeout_s=self.saved['sensor_timeout']
            s.arbiter.safety.clear();s.arbiter.machine.allow_training=False
            if s.arbiter.machine.mode==ControlMode.TRAINING:s.arbiter.machine.transition(ControlMode.PAUSED,connected=True)
            # Resume camera/service ticks with the vehicle safely paused. Journey
            # never resumes without the application's existing explicit start.
            s.state_at=s.now()
            return {'active':False,'restored':True,'actor_inventory':self.inventory()}
        finally:
            self.active=False;self.token=None;self.assembler.clear();self.baseline_agent=None
            s.arbiter.machine.allow_training=False
            if s.arbiter.machine.mode==ControlMode.TRAINING:
                s.arbiter.machine.transition(ControlMode.PAUSED,connected=True)

    def baseline(self):
        if self.done:raise RuntimeError('Baseline needs an active episode')
        from .baselines import conservative_action, scripted_action
        if self.baseline_id=='CONSERVATIVE_RADAR_BRAKING':action=conservative_action(self.last_observation)
        elif self.baseline_id=='SCRIPTED_DIAGNOSTIC':action=scripted_action(self.steps)
        else:
            if self.baseline_agent is None:
                p=self.service.provider
                # Reuse the existing native navigation package admission/path setup.
                p._ensure_dashboard_tools()
                wp=p.world.world.get_map().get_waypoint(p.ego.actor.get_location())
                target=wp.next(50.)
                if not target:raise RuntimeError('BasicAgent baseline requires a supported route')
                # The straight hazard corridor can lead to a later junction.
                # Select a reproducible native branch beyond that corridor.
                target.sort(key=lambda waypoint:(waypoint.road_id,waypoint.lane_id,waypoint.s))
                location=target[0].transform.location
                _,native_route=p.dashboard_tools.route_service.plan(p.ego.actor.get_location(),
                    {'map':p.world.world.get_map().name,'location':[location.x,location.y,location.z],
                     'name':'Gate 6 BasicAgent diagnostic route'})
                from agents.navigation.basic_agent import BasicAgent
                self.baseline_agent=BasicAgent(p.ego.actor,target_speed=28.,
                    opt_dict={'ignore_vehicles':True,'ignore_traffic_lights':True,'ignore_stop_signs':True,'dt':p.fixed_delta},
                    map_inst=p.dashboard_tools.map,grp_inst=p.dashboard_tools.route_service.planner)
                self.baseline_agent.set_global_plan(native_route,stop_waypoint_creation=True,clean_queue=True)
            value=self.baseline_agent.run_step();action=[value.steer,value.throttle,value.brake]
        return {'action':list(map(float,action)),'baseline_id':self.baseline_id,'policy_active':False}
