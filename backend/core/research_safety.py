"""Explicit learned/hybrid research modes around the unchanged rule supervisor.

The model never consumes scenario/world/reward data. Every intervention uses
the same feasibility admission and service command arbiter as RULE. The RULE
guard remains independent; a hybrid result is never reported as pure learning.
"""
from dataclasses import replace
import json
from pathlib import Path
import time
import numpy as np
from .active_safety import ActiveSafetySupervisor
from .contracts import CommandSource
from .safety_policy import ProposedSafetyAction, admit_proposal
from ..learned.features import features
from ..learned.inference import LearnedSafetyPolicy

CONFIG=Path(__file__).resolve().parents[2]/'config/learned_safety.json'


class ResearchSafetySupervisor(ActiveSafetySupervisor):
    def __init__(self, config=None, model_directory=None):
        self.controller='RULE';self.model=None;self.model_error=None
        self.learned_config=json.loads(CONFIG.read_text())
        lc=self.learned_config
        if (set(lc)!={'version','minimum_confidence','maximum_supported_speed_mps','maximum_supported_abs_yaw_rate_radps','hybrid_version','native_validated_modes','native_validation_status','notes'} or
                not .5<=lc['minimum_confidence']<=.95 or not 0<lc['maximum_supported_speed_mps']<=12 or
                not 0<lc['maximum_supported_abs_yaw_rate_radps']<=.3 or
                set(lc['native_validated_modes'])!={'RULE','LEARNED','HYBRID'} or
                lc['native_validated_modes']['RULE'] is not True or
                any(type(v) is not bool for v in lc['native_validated_modes'].values())):
            raise ValueError('Invalid learned safety configuration')
        self.source_counts={k:0 for k in ('LEARNED_BC','RULE_GUARD','RULE_FALLBACK','RULE','BASE_DRIVER')}
        super().__init__(config)
        self.guard=ActiveSafetySupervisor(self.config)
        try:
            self.model=LearnedSafetyPolicy() if model_directory is None else LearnedSafetyPolicy(model_directory)
        except (ValueError,KeyError,OSError,TypeError) as error:self.model_error=str(error)

    def reset(self):
        super().reset()
        if getattr(self,'model',None):self.model.reset()
        if getattr(self,'guard',None):self.guard.reset()
        self.learned_brake=0.;self.learned_started_s=None;self.learned_previous_s=None

    def set_controller(self, mode, *, controlled_validation=False):
        if mode not in ('RULE','LEARNED','HYBRID'):raise ValueError('Unknown safety controller')
        if mode!='RULE':
            if self.model is None:raise ValueError('Learned model unavailable: '+str(self.model_error))
            if not controlled_validation and not self.learned_config['native_validated_modes'][mode]:
                raise ValueError('Research controller has not passed native validation')
        self.controller=mode;self.reset()

    def snapshot(self):
        result=super().snapshot()
        return {**result,'controller':self.controller if self.anticipation_enabled else 'REACTIVE_SENSORS','model_health':'DEGRADED' if self.model_error and self.model else 'READY' if self.model else 'UNAVAILABLE',
            'model_identity':self.learned_config['version'],'model_error':self.model_error,
            'model_weights_sha256':self.model.metadata['weights_sha256'] if self.model else None,
            'model_validation':self.learned_config['native_validation_status'],
            'hybrid_version':self.learned_config['hybrid_version'],
            'available_controllers':['RULE']+[m for m in ('LEARNED','HYBRID')
                if self.model and self.learned_config['native_validated_modes'][m]],
            'source_counts':dict(self.source_counts),'experimental':self.controller!='RULE',
            'actual_generator':result.get('actual_generator','RULE' if self.controller=='RULE' else 'BASE_DRIVER')}

    def evaluate(self, observation, base, asset_reader, *, as_of_timestamp_s):
        if self.controller=='RULE':
            candidate=super().evaluate(observation,base,asset_reader,as_of_timestamp_s=as_of_timestamp_s)
            generator=('RULE' if self.anticipation_enabled else 'REACTIVE_SENSORS') if candidate else 'BASE_DRIVER'
            self.status.update(actual_generator=generator,inference_ms=0.)
            self.source_counts[generator]=self.source_counts.get(generator,0)+1
            return candidate
        # The independent existing guard also enforces freshness, physical sensor
        # validity and nonforward exclusions before learned proposals are used.
        guard_command=self.guard.evaluate(observation,base,asset_reader,as_of_timestamp_s=as_of_timestamp_s)
        now=observation.timestamp_s; gs=self.guard.snapshot()
        fallback=None; decision=None;probs=None;latency=0.;release_veto=False
        if gs['status']=='FORWARD_ONLY':
            self.reset();self.status.update(gs,actual_generator='BASE_DRIVER');return None
        if self.learned_previous_s is not None and now<=self.learned_previous_s:raise ValueError('Learned observation did not advance')
        gap=self.learned_previous_s is None or now-self.learned_previous_s>.15
        dt=.05 if gap else now-self.learned_previous_s
        previous=[0.,0.,0.] if gap else [observation.ego.steering,observation.ego.throttle,observation.ego.brake]
        if gap and self.model:self.model.reset()
        self.learned_previous_s=now
        try:
            if self.model is None:raise ValueError(self.model_error or 'Missing model')
            x=features(observation,base,previous)
            # A central radar return alone does not certify every hazard. Missing
            # returns, unsupported speed/turning, or closer nonradar targets use
            # the measured multisensor RULE fallback, never fabricated inputs.
            if not x[9]:fallback='No measured foreground radar target'
            elif observation.ego.speed_mps>self.learned_config['maximum_supported_speed_mps']:fallback='Speed outside learned support'
            elif abs(observation.ego.angular_velocity_radps[2])>self.learned_config['maximum_supported_abs_yaw_rate_radps']:fallback='Turning outside learned support'
            elif gs.get('target_source')!='RADAR' and gs.get('measured_range_m') is not None and gs['measured_range_m']<x[6]*50-1:
                fallback='Closer hazard supported by LiDAR/depth'
            start=time.perf_counter();decision,probs=self.model.predict(x);latency=(time.perf_counter()-start)*1000
            self.model_error=None
            if float(probs.max())<self.learned_config['minimum_confidence']:fallback='Low model confidence'
        except (ValueError,KeyError,OSError,TypeError,ArithmeticError) as error:
            fallback='Model failure: '+str(error);self.model_error=str(error)
            if self.model:self.model.reset()
        if fallback:
            if self.model:self.model.reset()
            desired=self.guard.brake;generator='RULE_FALLBACK';reason=fallback+'; '+gs['reason']
            self.learned_brake=desired
        else:
            if decision=='BRAKE_INTERVENTION':
                if self.learned_brake<=0:self.learned_started_s=now
                self.learned_brake=self.config.teacher.additional_brake
            elif self.learned_started_s is None or now-self.learned_started_s>=self.config.minimum_brake_hold_s:
                self.learned_brake=max(0.,self.learned_brake-self.config.brake_release_rate_per_s*dt)
            desired=self.learned_brake;generator='LEARNED_BC';reason='Learned sequence imitation: '+decision
            if self.controller=='HYBRID':
                # Symmetric safety guard: minimum braking under measured risk,
                # plus the existing physical release envelope after risk clears.
                # Never present this rule-enforced recovery as learned release.
                if gs['risk']=='FORWARD_CLEAR_SIDE_REAR_UNVERIFIED' and desired>self.guard.brake:
                    release_veto=True
                    desired=self.guard.brake;generator='RULE_GUARD';reason='RULE release guard vetoed unsupported learned braking: '+gs['reason']
                elif self.guard.brake>desired:
                    desired=self.guard.brake;generator='RULE_GUARD';reason='RULE guard: '+gs['reason']
        was_active=self.active;candidate=None
        if desired>base.brake or desired>0 and base.throttle>0:
            command=replace(base,source=CommandSource.SAFETY,throttle=0.,brake=max(base.brake,desired))
            proposal=ProposedSafetyAction(command,self.learned_config['version'],observation.frame_id,now,True,reason)
            admitted=admit_proposal(observation,base,proposal,self.validator.validate((observation,),base,proposal))
            if not admitted.accepted:raise ValueError('Research feasibility rejected: '+admitted.reason)
            candidate=admitted.command
        else:generator='BASE_DRIVER'
        self.active=candidate is not None;self.brake=desired;self.previous_s=now;self.last_fault=None
        if self.active and not was_active:self.interventions+=1
        self.source_counts[generator]+=1
        self.status.update(gs,type='HYBRID_SAFETY' if self.controller=='HYBRID' else 'LEARNED_BC_SAFETY',
            active=self.active,status='BRAKING' if self.active and desired>=.99 else 'RELEASING' if self.active else 'MONITORING',
            reason=reason,actual_generator=generator,learned_decision=decision,
            learned_probabilities=probs.tolist() if probs is not None else None,
            fallback_reason=fallback,inference_ms=latency,proposed_safety_brake=desired)
        self.status['hybrid_release_veto']=release_veto
        return candidate
