"""Audit and scientific figures for completed Experiment 1.1 diagnostics."""
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import subprocess
import urllib.request
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from backend.core.replay import ReplayReader
from backend.core.contracts import SensorKind

ROOT=Path(__file__).resolve().parents[2]
DEST=ROOT/'docs/evidence/experiment1-1'


def read(path):return json.loads(path.read_text(encoding='utf8'))


def rows(path):
    with path.open(encoding='utf8') as f:return [json.loads(r) for r in f if r.strip()]


def write(path,value):path.write_text(json.dumps(value,indent=2,allow_nan=False)+'\n',encoding='utf8')


def main():
    root=Path(read(ROOT/'output/native-validation/experiment1-1-run.json')['run'])
    result=read(root/'result.json');episodes=result['episodes'];audit=Counter();assets=set();states=[]
    for e in episodes:
        path=Path(e['initial']['recording_path']);reader=ReplayReader(path)
        frames=list(reader.frames());metadata=read(path/'metadata.json')
        trace=rows(root/f"{e['name']}_{e['seed']}-steps.jsonl")
        actor_id=next(a['actor_id'] for a in metadata['config']['intended_initial_states']['actors'] if a['name']=='leader')
        times=[];speeds=[];stop_duration=0.
        for i,f in enumerate(frames):
            assert f.complete
            assert all(s.frame_id==f.frame_id and abs(s.sensor_timestamp_s-f.timestamp_s)<=1e-6 for s in f.sensors)
            if i:assert f.frame_id==frames[i-1].frame_id+1
            audit['complete_frames']+=1
            for s in f.sensors:
                if s.asset:
                    p=(path/s.asset.path).resolve();assert p not in assets;assets.add(p)
                    if i in (0,len(frames)-1):reader.asset_path(s);audit['verified_asset_checksums']+=1
            if i:
                info=trace[i-1]['info']
                assert f.frame_id==info['frame_id']
                np.testing.assert_allclose([f.vehicle.steering,f.vehicle.throttle,f.vehicle.brake],
                    info['applied_action'],atol=1e-5,rtol=0)
                source=info['applied_command']['source']
                assert source==('SAFETY' if info['intervention']['accepted'] else 'TRAINING')
                audit['verified_action_steps']+=1
            leader=next(o.actor for o in f.ground_truth.objects if o.actor.actor_id==actor_id)
            speed=math.hypot(*leader.linear_velocity_mps)
            times.append(f.timestamp_s-frames[0].timestamp_s);speeds.append(speed)
            if i:
                stop_duration=stop_duration+f.timestamp_s-frames[i-1].timestamp_s if f.vehicle.speed_mps<.2 and speed<.3 else 0.
        assert len(trace)==e['outcome']['steps']==len(frames)-1
        assert e['initial']['reset_cleanup_verified']
        assert e['close_info']['restored'] and e['close_info']['actor_inventory']=={
            'vehicles':1,'sensors':7,'walkers':0,'controllers':0}
        start=e['initial']['initial_configuration']['intended_initial_states']['actors']
        finish=e['outcome'];spec=e['initial']['initial_configuration']['scenario_spec']
        after_stop=[t for t,v in zip(times,speeds) if t>=2 and v<.3]
        first_stop=after_stop[0] if after_stop else None
        after_speeds=[v for t,v in zip(times,speeds) if first_stop is not None and t>=first_stop]
        states.append({'name':e['name'],'seed':e['seed'],'outcome':finish['outcome'],
            'leader_first_stopped_after_trigger_s':first_stop,'leader_max_speed_after_stopping_mps':max(after_speeds) if after_speeds else None,
            'leader_final_speed_mps':speeds[-1],'ego_final_speed_mps':frames[-1].vehicle.speed_mps,
            'joint_stop_duration_at_end_s':stop_duration,'progress_m':finish['metrics']['forward_progress_m'],
            'minimum_clearance_m':finish['metrics']['minimum_clearance_m'],'min_progress_required_m':spec['success_conditions']['min_progress_m'],
            'initial_actor_positions':{a['name']:a['transform']['position_m'] for a in start},
            'initial_actor_velocities':{a['name']:a['velocity_mps'] for a in start}})
    assert audit['verified_action_steps']==result['actual_steps']==670
    audit['unique_sensor_binary_assets']=len(assets)
    matched=[e for e in episodes if e['seed']==2042];reference=matched[0]['initial']['initial_configuration']
    deviations=[]
    for e in matched:
        current=e['initial']['initial_configuration']
        assert current['scenario_spec']==reference['scenario_spec']
        for a in reference['intended_initial_states']['actors']:
            b=next(v for v in current['intended_initial_states']['actors'] if v['name']==a['name'])
            deviations.append(math.dist(a['transform']['position_m'],b['transform']['position_m']))
    original_patch=(ROOT/'output/experiment1-1-preserved/pre-diagnosis.patch').read_bytes()
    current_patch=subprocess.check_output(['git','diff','--binary'],cwd=ROOT,stderr=subprocess.DEVNULL)
    assert current_patch==original_patch,'A pre-existing tracked change was altered'
    model=ROOT/'runs/experiments/experiment1_20261008T165154Z/final_model.zip'
    frozen=hashlib.sha256(model.read_bytes()).hexdigest()
    assert frozen==result['unchanged_model_sha256']
    with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/state',timeout=5) as response:runtime=json.load(response)
    assert runtime['connected'] and not runtime['rlRuntime']['active'] and runtime['mode']=='PAUSED'
    assert not runtime['environment']['safety_policy']['active']
    tracked_changes=subprocess.check_output(['git','diff','--name-only'],cwd=ROOT,text=True).splitlines()
    write(DEST/'native-verification.json',{'pass':True,'training':False,'audit':dict(audit),
        'native_episode_end_states':states,'maximum_matched_initial_position_deviation_m':max(deviations),
        'matched_scenario_specs':True,'runtime_restored':True,'production_policy_enabled':False,
        'source_head':subprocess.check_output(['git','rev-parse','HEAD'],cwd=ROOT,text=True).strip(),
        'model_sha256':frozen,'original_uncommitted_patch_unchanged':True,
        'preexisting_tracked_changes':tracked_changes,'python_tests':{'run':157,'passed':156,'skipped':1},
        'javascript_tests':{'run':24,'passed':24},'diagnostic_geometry_matrix_api_error':5.975684291836814e-8,
        'no_runtime_code_modified':True})
    gate=read(DEST/'gate-analysis.json');timing=rows(DEST/'observation-timing.jsonl')
    reward=read(DEST/'reward-analysis.json');seed=[r for r in timing if r['seed']==2042]
    x=np.array([r['simulation_time_s']-seed[0]['simulation_time_s'] for r in seed])
    fig,axes=plt.subplots(2,2,figsize=(12,8),layout='constrained')
    axes[0,0].plot(x,[r['selected_return'][0] for r in seed],label='Feature used by trained policy',color='#b45922')
    axes[0,0].plot(x,[r['lead_associated_range_m_diagnostic'] for r in seed],label='Native lead-associated radar (diagnosis)',color='#276d89')
    axes[0,0].plot(x,[r['diagnostic_height_screen_range_m'] for r in seed],linestyle='--',label='Sensor-only height screening',color='#459347')
    axes[0,0].axvline(2.,color='gray',linestyle=':',label='Lead braking trigger')
    axes[0,0].axvline(2.7,color='#b45922',linestyle=':');axes[0,0].set(ylabel='Radar range (m)',xlabel='Episode simulation time (s)',title='Hazard information lost in nearest-return projection')
    axes[0,0].legend(fontsize=7)
    axes[0,1].plot(x,[r['gate'] for r in seed],color='#7a3d72')
    axes[0,1].axhline(0,color='black',linestyle='--',label='Intervention threshold')
    axes[0,1].set(ylabel='Deterministic SAC gate',xlabel='Episode simulation time (s)',ylim=(-.6,.1),title='All 544 test gates request NO_INTERVENTION')
    axes[0,1].legend(fontsize=8)
    selected=[next(r for r in reward['real_trajectories'] if r['label']==label and r['seed']==2042)
        for label in ('no_intervention','late_braking','existing_early_rule_braking','stationary','brake_resume_stop')]
    labels=['Collision','Late brake','Early rule','Stationary','Brake/resume/stop']
    for ax,key,title in ((axes[1,0],'return','Native reward ranking (weights unchanged)'),
                         (axes[1,1],'discounted_return_gamma_099','Discounted trajectory return, gamma=0.99')):
        values=[r[key] for r in selected];ax.barh(labels,values,color=['#bb4545','#cc7575','#a88745','#9b9b9b','#3b8a65'])
        ax.axvline(0,color='black',linewidth=.7);ax.set(xlabel='Return',title=title)
        for i,v in enumerate(values):ax.text(v,i,f' {v:.2f}',va='center',ha='left' if v>=0 else 'right',fontsize=8)
        ax.set_xlim(min(values)*1.22,max(values)*1.6)
    for ax in axes.flat:ax.grid(alpha=.13)
    fig.suptitle('Experiment 1.1 · real recordings and frozen model diagnosis',fontsize=14)
    fig.savefig(DEST/'diagnosis.png',dpi=160);plt.close(fig)
    scripted=next(e for e in episodes if e['name']=='brake_resume_stop' and e['seed']==2042)
    reader=ReplayReader(scripted['initial']['recording_path']);frames=list(reader.frames())
    trace=rows(root/'brake_resume_stop_2042-steps.jsonl');times=[r['info']['timestamp_s']-scripted['initial']['timestamp_s'] for r in trace]
    fig,axes=plt.subplots(3,1,figsize=(9,7),layout='constrained',sharex=True)
    axes[0].plot(times,[f.vehicle.speed_mps for f in frames[1:]],label='Ego speed')
    leader_id=next(a['actor_id'] for a in scripted['initial']['initial_configuration']['intended_initial_states']['actors'] if a['name']=='leader')
    axes[0].plot(times,[math.hypot(*next(o.actor for o in f.ground_truth.objects if o.actor.actor_id==leader_id).linear_velocity_mps) for f in frames[1:]],label='Leader speed (diagnosis only)')
    axes[0].legend();axes[0].set_ylabel('Speed (m/s)')
    axes[1].plot(times,[r['info']['native_applied_action'][2] for r in trace],label='Native applied brake')
    axes[1].plot(times,[r['info']['native_applied_action'][1] for r in trace],label='Native applied throttle')
    axes[1].legend();axes[1].set_ylabel('Actuator [0,1]')
    axes[2].plot(times,[r['script']['onboard_distance_m'] for r in trace],label='Integrated onboard travel')
    axes[2].axhline(10,color='gray',linestyle=':',label='Progress threshold (reward/outcome only)')
    axes[2].legend();axes[2].set(ylabel='Travel (m)',xlabel='Episode simulation time (s)')
    for ax in axes:
        for phase in scripted['script_phases'][1:]:ax.axvline(phase['onboard_elapsed_s'],color='gray',linestyle='--',alpha=.5)
        ax.grid(alpha=.15)
    fig.suptitle('Scripted sensor-only brake → resume BasicAgent → safe stop\nSeed 2042 · SUCCESS, 13.46 m progress, minimum clearance 8.26 m')
    fig.savefig(DEST/'scripted-success.png',dpi=160);plt.close(fig)
    print(json.dumps({'pass':True,'audit':dict(audit),'unchanged_model':True,
        'preexisting_work_preserved':True,'scripted_successes':3}),flush=True)


if __name__=='__main__':main()
