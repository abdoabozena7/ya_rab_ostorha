"""YA RAB OSTORHA teacher verification using VALIDATION recordings only."""
import time
START=time.perf_counter()
from collections import Counter
from dataclasses import replace
import json
import psutil
from backend.core.contracts import SimulationFrame,from_dict,to_dict
from backend.core.safety_policy import sensor_observation
from backend.core.control import CommandArbiter,ControlMode
from backend.rl.teacher import YaRabOstorhaSafetyTeacher,TeacherConfig
from backend.rl.supervisor import decide_intervention
from .experiment2b_common import ROOT,write,rows,base_command


def main():
    process=psutil.Process();cpu_start=process.cpu_times()
    config=TeacherConfig(**json.loads((ROOT/'backend/rl/teacher_config_v1.json').read_text()))
    destination=ROOT/'docs/evidence/experiment2b';destination.mkdir(parents=True,exist_ok=True)
    run=ROOT/'runs/experiments/experiment1_20261008T165154Z'
    script=rows(ROOT/'runs/diagnostics/experiment1_1_20261008T190202Z/brake_resume_stop_1042-steps.jsonl')
    groups=[('VALIDATION_COLLISION',rows(run/'validation_1255-steps.jsonl')),
        ('VALIDATION_STATIONARY',rows(run/'diagnostic_always_brake-steps.jsonl')),
        ('VALIDATION_SCRIPTED_SUCCESS',[{**r['info'],'reward':r['reward'],'script':r['script']} for r in script])]
    summary={};records=[]
    variants={'nominal':config,'deceleration_4':replace(config,assumed_deceleration_mps2=4.),
              'deceleration_6':replace(config,assumed_deceleration_mps2=6.),
              'release_hysteresis_15':replace(config,release_hysteresis_m=1.5)}
    for name,trace in groups:
        counts=Counter();episodes={}
        for row in trace:episodes.setdefault(row['episode_id'],[]).append(row)
        for sequence in episodes.values():
            teachers={k:YaRabOstorhaSafetyTeacher(v) for k,v in variants.items()}
            shadow=YaRabOstorhaSafetyTeacher(config);prior=None
            path=Path(sequence[0]['recording_path'])/'telemetry/frames.jsonl'
            with path.open(encoding='utf8') as stream:
                for row in sequence:
                    frame=from_dict(SimulationFrame,json.loads(stream.readline()))
                    assert frame.complete and frame.frame_id==row['frame_id']-1
                    observation=sensor_observation(frame);base=base_command(observation,row['base_proposed_action'])
                    decisions={k:t.propose(observation,base) for k,t in teachers.items()};decision=decisions['nominal']
                    clean=shadow.propose(sensor_observation(replace(frame,ground_truth=None,actors=())),base)
                    assert to_dict(decision)==to_dict(clean);counts['real_frame_isolation_checks']+=1
                    selected,admission=decide_intervention(observation,base,decision.action,config.version)
                    arbiter=CommandArbiter();arbiter.machine.transition(ControlMode.MANUAL,connected=True)
                    arbiter.machine.allow_training=True;arbiter.machine.transition(ControlMode.TRAINING,connected=True,explicit=True)
                    arbiter.submit(base,frame_id=frame.frame_id,timestamp_s=frame.timestamp_s,connected=True)
                    if selected.source.value=='SAFETY':arbiter.submit(selected,frame_id=frame.frame_id,timestamp_s=frame.timestamp_s,connected=True)
                    final=arbiter.choose(frame_id=frame.frame_id,timestamp_s=frame.timestamp_s,connected=True)
                    assert final==selected and final.steering==base.steering
                    counts['observations']+=1;counts[decision.decision]+=1
                    counts['accepted']+=int(admission['accepted'])
                    counts['rejected_proposals']+=int(decision.action[0]>0 and admission['decision']=='REJECTED')
                    counts['missing_foreground_brakes']+=int(not decision.diagnostics['foreground_valid'])
                    braking=decision.action[0]>0
                    if prior is not None and prior!=braking:counts['brake_release_edges']+=1
                    prior=braking
                    for variant,d in decisions.items():counts[variant+'_decision_differences_from_nominal']+=int(d.action!=decision.action)
                    if 'script' in row:counts['historical_script_decision_mismatches']+=int(braking!=(row['proposed_action'][0]>0))
                    records.append({'group':name,'seed':row['seed'],'step':row['step'],
                        'teacher':to_dict(decision),'base_proposed_control':to_dict(base),
                        'admission':admission,'offline_selected_control':to_dict(final),
                        'actual_recorded_reward':row['reward'],'recording_path':row['recording_path'],
                        'counterfactual_physics_evaluated':False})
        summary[name]=dict(counts)
    cpu=process.cpu_times();memory=process.memory_info()
    result={'experiment':'YA RAB OSTORHA Experiment 2B offline teacher verification','split':'VALIDATION',
        'config':to_dict(config),'groups':summary,'sensitivity_configs':{k:to_dict(v) for k,v in variants.items()},
        'parameters_changed_after_sensitivity':False,'reward_weights_changed':False,'training':False,'native_episodes':0,
        'calibration_evidence':'Experiment 2A VALIDATION full-brake stroke: 3.659 m at 8.027 m/s; energy-equivalent a=8.805 m/s²; retain assumed a=5',
        'resource':{'wall_s':time.perf_counter()-START,'cpu_s_after_imports':cpu.user+cpu.system-cpu_start.user-cpu_start.system,
            'os_peak_working_set_mib':getattr(memory,'peak_wset',memory.rss)/2**20,'private_mib_at_end':getattr(memory,'private',memory.rss)/2**20}}
    write(destination/'offline.json',result)
    with (destination/'offline-decisions.jsonl').open('w',encoding='utf8') as stream:
        for record in records:stream.write(json.dumps(record,allow_nan=False)+'\n')
    print(json.dumps(result,indent=2))


from pathlib import Path
if __name__=='__main__':main()
