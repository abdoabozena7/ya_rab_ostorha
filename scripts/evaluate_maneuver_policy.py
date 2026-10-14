"""Frozen, mask-aware TEST evaluation with independent native outcomes."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
from backend.learning.pilot_budget import PilotBudget,DEFAULT_ROOT
from scripts.run_core_repair_pilot import historical_hashes,take_control_and_hold


def main():
    parser=argparse.ArgumentParser();parser.add_argument('checkpoint',type=Path)
    parser.add_argument('--seconds',type=float,default=3600.);parser.add_argument('--episodes',type=int,default=10)
    parser.add_argument('--manifest',type=Path,required=True)
    args=parser.parse_args()
    from sb3_contrib import MaskablePPO
    from sb3_contrib.common.maskable.evaluation import evaluate_policy
    from backend.learning.rl.maneuver_env import ManeuverEnv
    manifest=json.loads(args.manifest.read_text())
    cases=manifest['cases']
    if len(cases)<args.episodes or any(c['split']!='TEST' for c in cases):raise ValueError('Frozen TEST cases required')
    report={'checkpoint_sha256':hashlib.sha256(args.checkpoint.read_bytes()).hexdigest(),
            'manifest_sha256':hashlib.sha256(args.manifest.read_bytes()).hexdigest(),'accepted':False,'outcomes':[],
            'historical_before':historical_hashes()}
    class FrozenEnv(ManeuverEnv):
        def __init__(self):super().__init__(split='TEST',policy_id='MASKABLE_PPO:'+report['checkpoint_sha256']);self.index=0
        def reset(self,*,seed=None,options=None):
            if self.index>=args.episodes:self.index=0
            c=cases[self.index];self.index+=1
            self.current_case_id=c['case_id']
            return super().reset(seed=c['seed'],options={'mode':c['mode'],'scenario':c['scenario'],
                'parameters':{**c['parameters'],'expected_map':c['map']}})
        def step(self,action):
            if time.monotonic()>=deadline:raise TimeoutError('Frozen evaluation incomplete at its independent budget deadline')
            result=super().step(action)
            if result[2] or result[3]:report['outcomes'].append({**result[4],'case_id':self.current_case_id})
            return result
    budget=PilotBudget();reservation=budget.reserve('evaluation',args.seconds);budget.publish_ticket(reservation)
    deadline=reservation[1]+args.seconds-30.
    env=FrozenEnv()
    try:
        take_control_and_hold()
        model=MaskablePPO.load(args.checkpoint,device='cpu')
        mean,std=evaluate_policy(model,env,n_eval_episodes=args.episodes,deterministic=True,warn=False)
        report.update(mean_reward=float(mean),std_reward=float(std))
        # Reward is diagnostic; behavioral outcomes determine admission.
        report['ordinary_subset_passed']=len(report['outcomes'])==args.episodes and all(v['outcome']=='SUCCESS' and
            v['scenario_validity']['valid'] and v['metrics']['collisions']==0 and v['metrics']['maximum_clear_path_stop_s']<=3.
            for v in report['outcomes'])
        # A subset cannot admit general learned driving; the full acceptance
        # validator also requires recovery, matched comparisons and prediction.
    except Exception as error:report['error']=str(error)
    finally:
        try:env.close();report['restoration']=getattr(env,'last_close_info',None)
        except Exception as error:report['restoration_error']=str(error)
        budget.finish(reservation);report['budget']=budget.status()
        report['historical_after']=historical_hashes()
        report['historical_ledgers_unchanged']=report['historical_before']==report['historical_after']
        report['manifest_hash_verified']=report['manifest_sha256']==hashlib.sha256(args.manifest.read_bytes()).hexdigest()
        report['checkpoint_hash_verified']=report['checkpoint_sha256']==hashlib.sha256(args.checkpoint.read_bytes()).hexdigest()
        (DEFAULT_ROOT/('evaluation-'+reservation[0]+'.json')).write_text(json.dumps(report,indent=2),encoding='utf8')
        print(json.dumps(report))
    return 0 if report['accepted'] else 1


if __name__=='__main__':sys.exit(main())
