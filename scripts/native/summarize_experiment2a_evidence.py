"""Small offline reward, demonstration and feature-cost analysis; no model/ticks.

TEST demonstrations are described as history, never used for calibration.
Candidate settings are a proposal only, not an installed controller.
"""
import time
START = time.perf_counter()
import ast
from collections import defaultdict
import json
from pathlib import Path
import psutil
import numpy as np
from backend.core.contracts import SimulationFrame, from_dict
from backend.core.safety_policy import sensor_observation
from backend.rl.observations import CONFIGS, ObservationAssembler
from backend.rl.supervisor import policy_features

ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / 'docs/evidence/experiment2a'
RUN = ROOT / 'runs/experiments/experiment1_20261008T165154Z'
DIAG = ROOT / 'runs/diagnostics/experiment1_1_20261008T190202Z'
PROCESS = psutil.Process()
CPU_START = PROCESS.cpu_times()


def read(path):
    return json.loads(path.read_text(encoding='utf8'))


def rows(path):
    with path.open(encoding='utf8') as stream:
        return [json.loads(line) for line in stream if line.strip()]


def write(name, value):
    (DEST/name).write_text(json.dumps(value, indent=2, allow_nan=False)+'\n', encoding='utf8')


def distribution(values):
    values = np.asarray(values, float)
    return {'count': len(values), 'min': float(values.min()), 'max': float(values.max()),
            'mean': float(values.mean()), 'median': float(np.median(values)),
            'p95': float(np.percentile(values, 95))}


def main():
    replay = rows(DEST/'prediction-replay.jsonl')
    demos = [e for e in read(DIAG/'episodes.json') if e['name']=='brake_resume_stop']
    summaries = []
    for episode in demos:
        trace = rows(DIAG/f"brake_resume_stop_{episode['seed']}-steps.jsonl")
        phases = episode['script_phases']
        assert len(phases)==3
        summaries.append({'seed': episode['seed'], 'split': episode['split'],
            'parameter_fitting': False, 'historical_native_outcome': episode['outcome'],
            'phases': phases, 'accepted_brake_steps': sum(t['info']['intervention']['accepted'] for t in trace),
            'reward_components': episode['reward_components']})

    trace = rows(DIAG/'brake_resume_stop_1042-steps.jsonl')
    validation = [r for r in replay if r['group']=='VALIDATION_SCRIPTED_SUCCESS']
    assert len(trace)==len(validation)==98
    by_phase = defaultdict(list)
    for t,r in zip(trace,validation):
        by_phase[t['script']['script_phase']].append(r)
    phase_gates = {phase: {'observations': len(rs),
        'positive_before': sum(r['before_prediction'][0]>0 for r in rs),
        'positive_after': sum(r['after_prediction'][0]>0 for r in rs),
        'after_gate': distribution([r['after_prediction'][0] for r in rs]),
        'speed_mps': distribution([r['ego_speed_mps'] for r in rs])} for phase,rs in by_phase.items()}

    final = next(i for i,t in enumerate(trace) if t['script']['script_phase']=='FINAL_BRAKE')
    stopped = next(i for i in range(final,len(trace)) if validation[i]['ego_speed_mps']<.2)
    speed = validation[final]['ego_speed_mps']
    travel = trace[stopped]['script']['onboard_distance_m']-trace[final]['script']['onboard_distance_m']
    duration = validation[stopped]['elapsed_s']-validation[final]['elapsed_s']
    braking = {'split': 'VALIDATION', 'seed': 1042, 'brake': 1.,
        'start_speed_mps': speed, 'stop_speed_mps': validation[stopped]['ego_speed_mps'],
        'time_to_under_02_mps_s': duration, 'onboard_braking_distance_m': travel,
        'mean_speed_deceleration_mps2': (speed-validation[stopped]['ego_speed_mps'])/duration,
        'energy_equivalent_deceleration_mps2': speed**2/(2*travel),
        'warning': 'One braking stroke, not a calibrated conservative bound across vehicles/weather/slopes',
        'original_script_range_at_final_brake_m': trace[final]['script']['elevated_radar_range_m'],
        'fixed_foreground_range_at_final_brake_m': validation[final]['after_return'][0],
        'original_trigger_threshold_m': trace[final]['script']['sensor_stopping_threshold_m']}

    stationary = rows(RUN/'diagnostic_always_brake-steps.jsonl')
    collisions = rows(RUN/'validation_1255-steps.jsonl')
    def totals(rs):
        sums = defaultdict(float)
        for r in rs:
            for k,v in r['reward_components'].items(): sums[k]+=v
        assert abs(sum(sums.values())-sum(r['reward'] for r in rs))<1e-8
        return {'steps': len(rs), 'total': sum(sums.values()), 'components': dict(sums)}
    first = [r for r in collisions if r['seed']==1042]
    reward = {'split': 'VALIDATION', 'seed': 1042, 'weights_changed': False,
        'collision_no_intervention': totals(first), 'stationary': totals(stationary),
        'safe_progress': totals([dict(r['info'],reward=r['reward']) for r in trace])}
    assert reward['safe_progress']['total']>reward['stationary']['total']>reward['collision_no_intervention']['total']

    # A proposed teacher can reproduce the old script with its original selector.
    # Substituting the fixed selector may alter decisions: measure disagreement
    # on the recorded states, without claiming new closed-loop performance.
    disagreements=[]; teacher_phase='INITIAL_BRAKE'; teacher_agreements=0
    for t,r in zip(trace,validation):
        speed=r['ego_speed_mps']; threshold=max(6.,3.+.35*speed+speed**2/(2*5.))
        fixed_safe=r['after_return'] is not None and r['after_return'][0]>threshold
        if teacher_phase=='INITIAL_BRAKE' and r['elapsed_s']>=1. and speed<.2 and fixed_safe:
            teacher_phase='RESUME_BASE'
        if teacher_phase=='RESUME_BASE' and (t['script']['onboard_distance_m']>=10.75 or not fixed_safe):
            teacher_phase='FINAL_BRAKE'
        teacher_agreements+=int((teacher_phase=='RESUME_BASE')==(t['info']['proposed_action'][0]<=0))
        if fixed_safe!=t['script']['safe_to_continue']:
            disagreements.append({'step':r['step'],'elapsed_s':r['elapsed_s'],
                'fixed_safe_to_continue':fixed_safe,'original_safe_to_continue':t['script']['safe_to_continue'],
                'fixed_range_m':r['after_return'][0] if r['after_return'] else None,'threshold_m':threshold})

    # Cost uses a complete four-frame history from a real validation recording.
    assembler=ObservationAssembler(CONFIGS['lightweight'],lambda _:b'')
    path=Path(collisions[0]['recording_path'])/'telemetry/frames.jsonl'
    with path.open(encoding='utf8') as stream:
        for i,line in enumerate(stream):
            frame=from_dict(SimulationFrame,json.loads(line))
            raw=assembler.append(sensor_observation(frame),[0,0,0] if i==0 else collisions[i-1]['applied_action'])
            if i==40:break
    base=collisions[40]['base_proposed_action']
    source=ast.parse((RUN/'supervisor.py').read_text())
    node=next(n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=='policy_features')
    namespace={'np':np,'FEATURE_DIM':47}
    exec(compile(ast.Module(body=[node],type_ignores=[]),'legacy-feature-function','exec'),namespace)
    costs={}
    for name,fn in [('legacy',namespace['policy_features']),('fixed',policy_features)]:
        for _ in range(10): fn(raw,base)
        samples=[]
        for _ in range(512):
            began=time.perf_counter_ns();fn(raw,base);samples.append((time.perf_counter_ns()-began)/1e6)
        costs[name+'_full_47_feature_projection_ms']=distribution(samples)
    array=np.load(DEST/'features.npz',allow_pickle=False)['after']
    val_ix=[i for i,r in enumerate(replay) if r['group'].startswith('VALIDATION')]
    latest=array[val_ix,33:44]
    normalization={'split':'VALIDATION','normalization_changed':False,
        'latest_history_dimension_extrema':[{'column':j+33,'min':float(latest[:,j].min()),
            'max':float(latest[:,j].max()),'abs_at_one_count':int((np.abs(latest[:,j])>=1).sum())}
            for j in range(11)],'observations':len(latest)}
    nominal=read(ROOT/'runs/diagnostics/experiment2a-nominal-screen/offline-result.json')
    final_result=read(DEST/'offline-result.json')
    cpu=PROCESS.cpu_times();mem=PROCESS.memory_info()
    write('analysis.json',{'demonstrations':summaries,'validation_phase_gate_replay':phase_gates,
        'validation_braking_measurement':braking,'validation_reward_ordering':reward,
        'validation_teacher_fixed_selector_disagreements':disagreements,'projection_cost':costs,
        'validation_teacher_action_replay':{'observations':len(validation),'identical_decisions':teacher_agreements,
            'closed_loop_execution':False,'state_source':'Recorded onboard elapsed time, speed and integrated distance'},
        'normalization':normalization,
        'nominal_screen_first_pass':{k:v['selection'] for k,v in nominal['groups'].items()},
        'replay_resource_total':{'two_offline_passes_wall_s':nominal['resource']['wall_s_including_imports']+final_result['resource']['wall_s_including_imports'],
            'two_offline_passes_cpu_user_system_s':sum(r['resource']['cpu_user_s']+r['resource']['cpu_system_s'] for r in (nominal,final_result)),
            'peak_private_mib':max(r['resource']['peak_sampled_private_mib'] for r in (nominal,final_result))},
        'this_analysis_resource':{'wall_s_including_imports':time.perf_counter()-START,
            'cpu_user_system_s':cpu.user+cpu.system-CPU_START.user-CPU_START.system,
            'os_peak_working_set_mib':getattr(mem,'peak_wset',mem.rss)/2**20},
        'native_episodes':0,'training_updates':0})
    write('teacher-proposal.json',{'version':'POSTHOC_RULE_TEACHER_PROPOSAL_V1',
        'status':'PROPOSED_NOT_EXECUTED','learning':'NONE_RULE_BASED','production_enabled':False,
        'calibration_data':'VALIDATION 1042 braking measurement; original pre-specified script constants retained',
        'radar_version':'RADAR_FOREGROUND_V2','parameters':{'buffer_m':3.,'reaction_margin_s':.35,
            'nominal_deceleration_mps2':5.,'minimum_resume_range_m':6.,'initial_dwell_s':1.,
            'stopped_speed_mps':.2,'additional_brake':1.,'steering_delta':0.,
            'onboard_goal_guard_m':10.75},
        'states':['INITIAL_BRAKE: admitted additional brake',
            'RESUME_BASE: release after dwell, stopped ego and valid range > max(6,3+.35*v+v*v/(2*5))',
            'FINAL_BRAKE: brake when range no longer exceeds envelope, validity lost or onboard travel >=10.75'],
        'admission':'Existing decide_intervention -> feasibility -> safety layer -> arbitration',
        'parameters_fitted_to_test':False,'new_native_validation_required':True,
        'limitations':['Initial dwell is a scenario diagnostic prior, not a universal hazard detector',
            'One measured brake stroke cannot establish robust deceleration bounds',
            'Radar foreground validity does not certify free space',
            'Teacher phase, dwell and odometer need permitted persistent onboard state; absent from the 47-D SAC snapshot',
            'Changed radar selector can change teacher decisions; three old successes are not evidence of new teacher performance']})
    print(json.dumps({'phase_gates':phase_gates,'braking':braking,'cost':costs,
        'selector_disagreements':len(disagreements),'reward_totals':{k:v['total'] for k,v in reward.items() if isinstance(v,dict)}}))


if __name__=='__main__':main()
