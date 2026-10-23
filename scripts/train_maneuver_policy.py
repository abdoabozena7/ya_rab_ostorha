"""Actual CPU MaskablePPO pilot; refuses to bypass native useful-motion gates."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
import uuid
from backend.learning.pilot_budget import PilotBudget,DEFAULT_ROOT
from scripts.run_core_repair_pilot import historical_hashes,take_control_and_hold
from backend.learning.pilot_provenance import qualified_physical_report,qualified_motion_viability,control_hashes

ROOT=Path(__file__).resolve().parents[1]


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--physical-report',type=Path,required=True)
    parser.add_argument('--seconds',type=float,default=5400.)
    parser.add_argument('--timesteps',type=int,default=20000)
    parser.add_argument('--stage',type=int,default=0)
    parser.add_argument('--feasibility-pilot',action='store_true',help='Stage-zero TRAIN experiment after current native motion viability; does not waive acceptance gates')
    parser.add_argument('--resume-checkpoint',type=Path)
    args=parser.parse_args()
    physical=json.loads(args.physical_report.read_text())
    admitted=qualified_physical_report(physical)
    viability=args.feasibility_pilot and args.stage==0 and qualified_motion_viability(physical)
    if not admitted and not viability:
        failure={'trained':False,'reason':'Current native ordinary motion/freshness qualification failed, incomplete or stale; RL rollout prohibited',
                 'physical_report':str(args.physical_report),'implementation_sha256':control_hashes(),
                 'rl_rollout_started':False,'checkpoint_created':False}
        DEFAULT_ROOT.mkdir(parents=True,exist_ok=True)
        path=DEFAULT_ROOT/('rl-blocked-'+uuid.uuid4().hex+'.json')
        path.write_text(json.dumps(failure,indent=2),encoding='utf8')
        print(json.dumps({**failure,'report':str(path)}));return 1
    from sb3_contrib import MaskablePPO
    from stable_baselines3.common.callbacks import BaseCallback
    from backend.learning.rl.maneuver_env import ManeuverEnv
    import torch
    import stable_baselines3,sb3_contrib
    if stable_baselines3.__version__!='2.9.0' or sb3_contrib.__version__!='2.9.0':
        raise RuntimeError('Pilot requires matching pinned SB3/contrib 2.9.0')
    config=json.loads((ROOT/'config/core-repair-pilot.json').read_text())
    curriculum=json.loads((ROOT/'config/maneuver-curriculum-v1.json').read_text())
    if not 0<=args.stage<len(curriculum['stages']):raise ValueError('Invalid curriculum stage')
    stage=curriculum['stages'][args.stage]
    class CurriculumEnv(ManeuverEnv):
        def __init__(self):
            super().__init__(policy_id='MASKABLE_PPO_MANEUVER_PILOT_V1');self.episodes=0;self.valid_transitions=0;self.completed=0
        def reset(self,*,seed=None,options=None):
            index=self.episodes;self.episodes+=1
            ordinary=curriculum['stages'][0]['scenarios']
            retained=index%max(1,round(1/stage['retain_benign_fraction']))==0
            choices=ordinary if retained else stage['scenarios']
            scenario=choices[index%len(choices)]
            mode='MANUAL_PROTECTION' if index%2 else 'AUTONOMOUS'
            # TRAIN sites alone; no scenario ID/seed enters the observation.
            indices=curriculum['split_locations']['TRAIN']['spawn_indices']
            site=curriculum.get('scenario_locations',{}).get(scenario,{})
            indices=site.get('TRAIN',indices)
            params={'spawn_index':indices[index%len(indices)],'route_length':site.get('route_length_m',40.),'time_limit_s':60.,'curriculum_stage':args.stage,
                    'expected_map':curriculum['split_locations']['TRAIN']['map']}
            if mode=='MANUAL_PROTECTION':params['driver_trace']=[{'at_s':0.,'throttle':.3,'brake':0.,'steering':0.},{'at_s':15.,'throttle':0.,'brake':1.,'steering':0.}]
            return super().reset(seed=index%1000 if seed is None else seed,options={'mode':mode,'scenario':scenario,'parameters':params})
        def step(self,action):
            result=super().step(action);self.valid_transitions+=1
            if result[-1].get('outcome')=='SUCCESS':self.completed+=1
            return result
    budget=PilotBudget();reservation=budget.reserve('rl',args.seconds);budget.publish_ticket(reservation)
    deadline=reservation[1]+args.seconds-30.
    report={'trained':False,'algorithm':'MaskablePPO','environment_id':config['environment_id'],
            'capabilities_accepted':False,'stage':stage,'requested_timesteps':args.timesteps,
            'qualification_kind':'FULL_ORDINARY_MOTION' if admitted else 'CONTROLLED_STAGE_ZERO_MOTION_VIABILITY',
            'full_ordinary_acceptance_passed':admitted,
            'reward_version':3,'native_initialization_version':3,
            'historical_before':historical_hashes(),
            'implementation_sha256':control_hashes(),
            'configuration_sha256':hashlib.sha256((ROOT/'config/core-repair-pilot.json').read_bytes()).hexdigest(),
            'curriculum_sha256':hashlib.sha256((ROOT/'config/maneuver-curriculum-v1.json').read_bytes()).hexdigest(),
            'physical_report_sha256':hashlib.sha256(args.physical_report.read_bytes()).hexdigest()}
    env=None;model=None;prior_updates=0
    class Deadline(BaseCallback):
        def _on_step(self):return time.monotonic()<deadline
    try:
        torch.set_num_threads(1)
        take_control_and_hold()
        env=CurriculumEnv()
        settings=config['policy']
        if args.resume_checkpoint:
            report['parent_checkpoint_sha256']=hashlib.sha256(args.resume_checkpoint.read_bytes()).hexdigest()
            model=MaskablePPO.load(args.resume_checkpoint,env=env,device='cpu',verbose=1)
        else:
            model=MaskablePPO('MultiInputPolicy',env,device='cpu',learning_rate=settings['learning_rate'],
                n_steps=settings['n_steps'],batch_size=settings['batch_size'],n_epochs=settings['n_epochs'],gamma=settings['gamma'],
                ent_coef=settings['ent_coef'],policy_kwargs={'net_arch':dict(pi=settings['net_arch'],vf=settings['net_arch'])},verbose=1,seed=73)
        prior_updates=model._n_updates
        model.learn(args.timesteps,callback=Deadline())
        report['trained']=model._n_updates>prior_updates
    except Exception as error:report['error']=str(error)
    finally:
        if model is not None and model._n_updates>prior_updates:
            destination=ROOT/'artifacts/learned_safety/maneuver_v1'/reservation[0]
            destination.mkdir(parents=True,exist_ok=False)
            checkpoint=destination/'maskable-ppo.zip';model.save(checkpoint)
            report.update(trained=True,checkpoint=str(checkpoint),sha256=hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
                          actual_updates=model._n_updates,actual_timesteps=model.num_timesteps)
            report['update_epochs_this_run']=model._n_updates-prior_updates
        if env:
            report.update(valid_transitions=env.valid_transitions,completed_episodes=env.completed,episodes_started=env.episodes)
            try:env.close();report['restoration']=env.last_close_info
            except Exception as error:report['restoration_error']=str(error)
        try:budget.finish(reservation)
        except Exception as error:report['budget_error']=str(error)
        report['budget']=budget.status()
        report['historical_after']=historical_hashes()
        report['historical_ledgers_unchanged']=report['historical_before']==report['historical_after']
        report['requested_rollout_complete']=report.get('actual_timesteps',0)>=args.timesteps
        if report.get('checkpoint'):
            (Path(report['checkpoint']).parent/'metadata.json').write_text(json.dumps(report,indent=2),encoding='utf8')
        (DEFAULT_ROOT/('training-'+reservation[0]+'.json')).write_text(json.dumps(report,indent=2),encoding='utf8')
        print(json.dumps(report),flush=True)
    return 0 if report['trained'] and not report.get('error') else 1


if __name__=='__main__':sys.exit(main())
