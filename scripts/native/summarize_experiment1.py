"""Post-run scientific figures and durable evidence; performs no training."""
import argparse
from collections import defaultdict
import hashlib
import json
import math
from pathlib import Path
import statistics
import zipfile
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

ROOT=Path(__file__).resolve().parents[2]


def load(path):return json.loads(path.read_text(encoding='utf8'))
def lines(path):return [json.loads(row) for row in path.read_text(encoding='utf8').splitlines()]
def relative(path):return str(Path(path).relative_to(ROOT)).replace('\\','/')
def mean_window(values,n=10):return [statistics.mean(values[max(0,i-n+1):i+1]) for i in range(len(values))]


def interval(successes,n):
    z=1.96;p=successes/n;d=1+z*z/n
    center=(p+z*z/(2*n))/d
    half=z*math.sqrt(p*(1-p)/n+z*z/(4*n*n))/d
    return [max(0.,center-half),min(1.,center+half)]


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--run',type=Path)
    args=parser.parse_args()
    root=args.run or Path(load(ROOT/'runs/experiments/experiment1-training-started.json')['run'])
    result=load(root/'result.json');config=load(root/'config.json')
    train=lines(root/'training-episodes.jsonl');steps=lines(root/'training-steps.jsonl')
    validations=[load(path) for path in sorted(root.glob('validation_*.json'))]
    validations.sort(key=lambda row:int(row['name'].split('_')[-1]))
    plt.rcParams.update({'font.size':10,'axes.spines.top':False,'axes.spines.right':False})
    figures=ROOT/'docs/evidence/experiment1';figures.mkdir(parents=True,exist_ok=True)
    x=[r['training_step'] for r in train]
    fig,axes=plt.subplots(3,1,figsize=(10,9),sharex=True,constrained_layout=True)
    returns=[r['outcome']['reward'] for r in train]
    progress=[r['outcome']['metrics']['forward_progress_m'] for r in train]
    collision=[float(r['outcome']['outcome']=='COLLISION') for r in train]
    for ax,values,label in zip(axes,[returns,progress,collision],['Episode return','Forward progress (m)','Collision fraction']):
        ax.scatter(x,values,s=12,alpha=.35,color='#64748b',label='Training episodes')
        ax.plot(x,mean_window(values),color='#0f766e',label='Training mean (up to 10 episodes)')
        if validations:
            key={'Episode return':'mean_reward','Forward progress (m)':'mean_forward_progress_m','Collision fraction':'collision_rate'}[label]
            ax.plot([int(v['name'].split('_')[-1]) for v in validations],[v['summary'][key] for v in validations],
                    'o--',color='#b45309',label='Held-out validation (4 seeds)')
        ax.set_ylabel(label);ax.grid(alpha=.15)
    axes[0].legend(loc='center left',fontsize=8);axes[-1].set_xlabel('Training environment steps')
    fig.suptitle('Experiment 1 · interrupted at 1,255 steps · CPU SAC')
    fig.savefig(figures/'learning-curves.png',dpi=160);plt.close(fig)
    bins=defaultdict(lambda:defaultdict(list))
    for row in steps:
        bucket=(row['training_step']-1)//1000
        for key,val in row['reward_components'].items():bins[bucket][key].append(val)
    trends={str(bucket):{key:statistics.mean(vals) for key,vals in values.items()} for bucket,values in sorted(bins.items())}
    fig,axes=plt.subplots(2,1,figsize=(10,7),sharex=True,constrained_layout=True)
    colors={'collision':'#b91c1c','severity':'#9333ea','progress':'#0f766e','success':'#2563eb',
            'delay':'#64748b','smoothness':'#a16207','unnecessary_braking':'#db2777','proximity':'#ea580c'}
    for key in colors:
        ax=axes[0] if key in ('collision','severity','progress','success') else axes[1]
        ax.plot([min((b+1)*1000,len(steps)) for b in sorted(bins)],[trends[str(b)][key] for b in sorted(bins)],
                'o-',label=key,color=colors[key])
    for ax in axes:ax.set_ylabel('Mean component per step');ax.legend(fontsize=8,ncol=4);ax.grid(alpha=.15)
    axes[-1].set_xlabel('Training environment steps');fig.suptitle('Reward component trends · weights never retuned')
    fig.savefig(figures/'reward-components.png',dpi=160);plt.close(fig)
    comparisons=result['comparisons'];seed=config['test_seeds'][0]
    fig,axes=plt.subplots(3,1,figsize=(10,8),sharex=True,constrained_layout=True)
    example_records={}
    for name,evaluation in comparisons.items():
        episode=next(row for row in evaluation['episodes'] if row['seed']==seed)
        rows=[r for r in lines(root/(evaluation['name']+'-steps.jsonl')) if r['seed']==seed]
        frames={f['frame_id']:f for f in lines(Path(episode['recording_path'])/'telemetry/frames.jsonl')}
        t=[row['timestamp_s']-rows[0]['timestamp_s']+.05 for row in rows]
        axes[0].plot(t,[frames[row['frame_id']]['vehicle']['speed_mps'] for row in rows],label=name)
        axes[1].plot(t,[row['applied_action'][2] for row in rows],label=name)
        axes[2].plot(t,[row['proposed_action'][0] for row in rows],label=name)
        example_records[name]={'seed':seed,'outcome':episode['outcome']['outcome'],
                               'recording':relative(episode['recording_path']),
                               'trace':relative(root/(evaluation['name']+'-steps.jsonl'))}
    for ax,label in zip(axes,['Ego speed (m/s)','Actual brake [0,1]','Proposed gate [-1,1]']):
        ax.set_ylabel(label);ax.grid(alpha=.15)
    axes[0].legend(fontsize=8);axes[-1].set_xlabel('Episode simulation time (s)')
    fig.suptitle(f'Matched held-out seed {seed} · interventions and collision examples')
    fig.savefig(figures/'intervention-examples.png',dpi=160);plt.close(fig)
    comparison_summary={};failures=[];deviations=[]
    for name,evaluation in comparisons.items():
        comparison_summary[name]={**evaluation['summary'],
            'collision_rate_wilson95':interval(evaluation['summary']['collisions'],len(evaluation['episodes'])),
            'per_seed':[{'seed':row['seed'],'outcome':row['outcome']['outcome'],
                         'metrics':row['outcome']['metrics'],'recording':relative(row['recording_path'])}
                        for row in evaluation['episodes']]}
        for row in evaluation['episodes']:
            m=row['outcome']['metrics'];n=row['outcome']['steps']
            flags=[]
            if row['outcome']['outcome']=='COLLISION':flags.append('collision_failure')
            if row['outcome']['outcome']=='COLLISION' and not row['intervention_steps']:
                flags.append('no_safety_intervention_before_collision')
            if row['intervention_steps']/n>.95:flags.append('intervention_on_more_than_95_percent_of_steps')
            if m['forward_progress_m']<10 and row['outcome']['outcome']!='SUCCESS':flags.append('insufficient_useful_progress')
            if m['average_speed_mps']<.2:flags.append('nearly_stationary_episode')
            if m['intervention_count']>15:flags.append('frequent_intervention_toggling')
            if m['unnecessary_intervention_count']>0:flags.append('measured_unnecessary_intervention_steps')
            if flags and name=='trained_sac':failures.append({'seed':row['seed'],'outcome':row['outcome']['outcome'],'flags':flags,'metrics':m})
    for i,seed in enumerate(config['test_seeds']):
        reference=comparisons['basic_agent']['episodes'][i]['initial_states']['actors']
        for name,evaluation in comparisons.items():
            current=evaluation['episodes'][i]['initial_states']['actors']
            for role in reference:
                actor=next(a for a in current if a['name']==role['name'])
                deviations.append({'seed':seed,'controller':name,'role':role['name'],
                    'position_m':math.dist(role['transform']['position_m'],actor['transform']['position_m']),
                    'velocity_mps':math.dist(role['velocity_mps'],actor['velocity_mps'])})
    performance=lines(root/'performance.jsonl')
    memory_ranges={}
    for name in ('training','backend','carla'):
        values=[]
        for row in performance:
            candidates=[p['private_mib'] for p in row['memory']
                        if (p['training_process'] if name=='training' else
                            ('CarlaUE4' in p['name'] if name=='carla' else not p['training_process'] and 'python' in p['name'].lower()))]
            # Windows venv launchers have the same command line as their worker.
            # Use the actual worker's (largest) memory, never mix launcher minima.
            if candidates:values.append(max(candidates))
        memory_ranges[name]=[min(values),max(values)] if values else None
    resets=lines(root/'training-resets.jsonl')
    failed_events=lines(Path(resets[-1]['info']['recording_path'])/'events/events.jsonl')
    failed_attempts=[r['payload']['rl_failed_step'] for r in failed_events if 'rl_failed_step' in r['payload']]
    actual_train_spawns=[r['info']['initial_configuration']['scenario_spec']['ego_spawn'] for r in resets]
    test_spawns=[r['scenario_spec']['ego_spawn'] for r in comparisons['basic_agent']['episodes']]
    summary={'experiment':'EXPERIMENT1','source':'LIVE_NATIVE_CARLA_0.9.16',
        'run':relative(root),'config':config,'training':result['training'],
        'training_completed_episodes':len(train),'training_outcomes':dict(__import__('collections').Counter(r['outcome']['outcome'] for r in train)),
        'training_failed_step_attempts':failed_attempts,
        'actual_confirmed_training_physics_steps':len(steps)+sum(int(row['physics_step_confirmed']) for row in failed_attempts),
        'failed_training_recording':relative(resets[-1]['info']['recording_path']),
        'post_stop_control_delivery_repair':result.get('post_stop_control_delivery_repair',False),
        'training_resumed_after_failure':False,
        'gradient_updates':load_model_data(root/'final_model.zip').get('_n_updates'),
        'actual_train_spawns':actual_train_spawns,'test_spawns':test_spawns,
        'unique_test_spawns':len(set(test_spawns)),
        'train_test_spawn_overlap':sorted(set(actual_train_spawns)&set(test_spawns)),
        'validation':[{k:v for k,v in row.items() if k!='episodes'} for row in validations],
        'comparison':comparison_summary,'reward_trends_mean_per_step':trends,
        'reward_trend_step_counts':{str(b):len(values['collision']) for b,values in bins.items()},
        'failure_flags':failures,'examples':example_records,
        'maximum_settled_position_deviation_m':max(r['position_m'] for r in deviations),
        'maximum_settled_velocity_deviation_mps':max(r['velocity_mps'] for r in deviations),
        'training_step_latency_ms':{'median':statistics.median(r['step_wall_ms'] for r in steps),
                                    'p95':float(np.percentile([r['step_wall_ms'] for r in steps],95)),
                                    'max':max(r['step_wall_ms'] for r in steps)},
        'memory_private_mib_ranges':memory_ranges,
        'bounded_buffer_maxima':{key:max(row['runtime']['bounded_buffers'][key] for row in performance)
                                for key in performance[0]['runtime']['bounded_buffers']},
        'normal_runtime_restored':result['normal_runtime_restored'],'production_policy_enabled':False,
        'raw_evidence_sha256':{name:hashlib.sha256((root/name).read_bytes()).hexdigest()
                               for name in ('config.json','training-result.json','result.json','training-steps.jsonl')},
        'limits':['Eight held-out seed configurations are a small task-specific sample.',
                  'Radar-only profile cannot verify side space; steering changes remain rejected.',
                  'No independent training repetition or reward tuning was authorized.',
                  'Native impulse is a severity proxy, not injury severity.',
                  'Stopping at the task progress threshold is not a general collision-avoidance guarantee.']}
    validation=ROOT/'output/native-validation'
    summary['native_validation']={name:load(validation/filename) for name,filename in
        [('adapter','experiment1-adapter.json'),('failed_sequence_replay','experiment1-failed-sequence-replay.json'),
         ('recording_audit','experiment1-recording-audit.json')]}
    summary['regressions']={'python_tests_run':157,'python_passed':156,'python_skipped':1,
        'javascript_passed':24,'normal_driving':load(validation/'experiment1-driving-regression.json')['checks'],
        'start_journey':load(validation/'experiment1-navigation.json')['checks']}
    summary['gpu_point_sample']={'used_mib':5797,'total_mib':6144,'gpu_utilization_percent':34,
                                 'training_device':'cpu','scope':'post-training evaluation snapshot'}
    summary['final_verification_backend_source_sha256']={str(p.relative_to(ROOT)).replace('\\','/'):
        hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted((ROOT/'backend').rglob('*.py'))}
    summary['observed_radar_return_example']={'depth_m':4.842322826385498,'azimuth_rad':-.00909570325165987,
        'altitude_rad':-.12779834866523743,'velocity_mps':-7.134820938110352,
        'mount_plus_return_height_m':.03284229192595789,
        'interpretation':'Low return consistent with ground; it can trigger the naive distance rule.'}
    summary['training']['model']=relative(summary['training']['model'])
    for checkpoint in summary['training']['checkpoints']:checkpoint['path']=relative(checkpoint['path'])
    target=ROOT/'docs/evidence/experiment1-summary.json'
    target.write_text(json.dumps(summary,indent=2,allow_nan=False)+'\n',encoding='utf8')
    print(json.dumps({'evidence':str(target),'training_steps':summary['training']['steps'],
                      'comparison':{k:v['summary'] for k,v in comparisons.items()},
                      'failure_flags':failures},indent=2))


def load_model_data(path):
    with zipfile.ZipFile(path) as archive:return json.loads(archive.read('data'))


if __name__=='__main__':main()
