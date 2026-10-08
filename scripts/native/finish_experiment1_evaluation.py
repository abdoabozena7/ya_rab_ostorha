"""Evaluate the frozen interrupted Experiment 1. NO learn/resume calls."""
from datetime import datetime,timezone
import hashlib
import json
from pathlib import Path
import torch
from stable_baselines3 import SAC
from .run_experiment1 import (ROOT,VALIDATION_SEEDS,TEST_SEEDS,evaluate,state,
                             memory,model_hash,write)


def main():
    guard=json.loads((ROOT/'runs/experiments/experiment1-training-started.json').read_text())
    root=Path(guard['run'])
    if (root/'result.json').exists():raise RuntimeError('Experiment 1 evaluation already complete')
    training=json.loads((root/'training-result.json').read_text())
    frozen=model_hash(root/'final_model.zip')
    assert frozen==training['model_sha256']
    torch.set_num_threads(2);torch.set_num_interop_threads(1)
    # The control-delivery repair happened after training stopped. Record that
    # distinction; all held-out controllers use this same confirmed native path.
    source_files=sorted((ROOT/'backend').rglob('*.py'))+[Path(__file__).resolve()]
    write(root/'evaluation-source-hashes.json',{str(p.relative_to(ROOT)).replace('\\','/'):
        hashlib.sha256(p.read_bytes()).hexdigest() for p in source_files})
    write(root/'evaluation-protocol.json',{'started_at_utc':datetime.now(timezone.utc).isoformat(),
        'training_resumed':False,'model_sha256':frozen,'model_selection':'INTERRUPTED_FINAL_WEIGHTS_FROZEN',
        'control_delivery':'Existing provider client; acknowledged identical control batch with do_tick=False',
        'reason':'Training stopped on one 1.31e-5 normalized steering discrepancy; no tolerance was relaxed',
        'reward_changes':False})
    initial=SAC.load(root/'initial_model.zip',device='cpu')
    final=SAC.load(root/'final_model.zip',device='cpu')
    evaluate(root,f"validation_{training['steps']}",'VALIDATION',VALIDATION_SEEDS,'SAC',final)
    comparisons={}
    for name,controller,policy in [('basic_agent','NONE',None),('rule_safety','RULE',None),
                                    ('untrained_sac','SAC',initial),('trained_sac','SAC',final)]:
        identity=name+'_'+(frozen[:16] if name=='trained_sac' else 'EXPERIMENT1')
        result=evaluate(root,identity,'TEST',TEST_SEEDS,controller,policy)
        comparisons[name]=result
        write(root/'evaluation-progress.json',{k:v['summary'] for k,v in comparisons.items()})
    for i,seed in enumerate(TEST_SEEDS):
        if len({v['episodes'][i]['condition_hash'] for v in comparisons.values()})!=1:
            raise RuntimeError('Held-out comparison configurations do not match')
    restored=state()
    assert restored['connected'] and not restored['rlRuntime']['active'] and restored['mode']=='PAUSED'
    assert model_hash(root/'final_model.zip')==frozen
    result={'run':str(root),'training':training,'comparisons':comparisons,
            'matched_test_configurations':True,'final_memory':memory(),
            'normal_runtime_restored':True,'production_policy_enabled':False,
            'training_resumed_after_failure':False,'post_stop_control_delivery_repair':True}
    write(root/'result.json',result)
    write(ROOT/'output/native-validation/experiment1-run.json',{'run':str(root),'result':str(root/'result.json')})
    print(json.dumps({'run':str(root),'comparisons':{k:v['summary'] for k,v in comparisons.items()}}),flush=True)


if __name__=='__main__':main()
