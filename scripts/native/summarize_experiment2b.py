"""YA RAB OSTORHA native evidence audit. Reads records only; no physics/learning.

Ground-truth association below is an evaluation channel, never teacher input.
"""
import time
START=time.perf_counter()
import ast
from collections import Counter,defaultdict
import hashlib
import json
import math
from pathlib import Path
import statistics
import numpy as np
import psutil
from backend.core.contracts import SimulationFrame,SensorKind,from_dict
from backend.core.recording import resolve_asset
from .experiment2b_common import ROOT,write,rows


def main():
    process=psutil.Process();cpu_start=process.cpu_times()
    dest=ROOT/'docs/evidence/experiment2b';native=json.loads((dest/'native.json').read_text())
    protocol=json.loads((dest/'protocol.json').read_text());root=Path(native['run'])
    episodes=native['episodes'];assert native['run_complete'] and len(episodes)==16
    lock=json.loads((dest/'frozen-config.json').read_text())
    assert hashlib.sha256((ROOT/'backend/rl/teacher.py').read_bytes()).hexdigest()==lock['teacher_source_sha256']
    assert hashlib.sha256((ROOT/'backend/rl/teacher_config_v1.json').read_bytes()).hexdigest()==lock['config_sha256']
    # Extract only existing pure diagnostic geometry, without importing Torch/SAC.
    source=ast.parse((ROOT/'scripts/native/diagnose_experiment1_recordings.py').read_text())
    nodes=[n for n in source.body if isinstance(n,ast.FunctionDef) and n.name in ('rotation','world_hits','leader_masks')]
    geometry={'np':np,'math':math}
    exec(compile(ast.Module(body=nodes,type_ignores=[]),'existing-offline-diagnostic-geometry','exec'),geometry)
    radar_blind=Counter();blind_examples=[];per_episode=[];asset_bytes=0;assets=0;hash_samples=0
    latencies=[];step_latencies=[];total_frames=0
    for e in episodes:
        trace=rows(root/f"{e['split']}_{e['seed']}_{e['controller']}-steps.jsonl")
        assert len(trace)==e['outcome']['steps']
        stream_path=Path(e['recording_path']);metadata=json.loads((stream_path/'metadata.json').read_text())
        brake_edges=[];old_braking=False;stop_run=0.;max_stop=0.;stop_total=0.;last=None
        with (stream_path/'telemetry/frames.jsonl').open(encoding='utf8') as stream:
            for i,line in enumerate(stream):
                frame=from_dict(SimulationFrame,json.loads(line));total_frames+=1
                assert frame.complete and all(s.frame_id==frame.frame_id and abs(s.sensor_timestamp_s-frame.timestamp_s)<=1e-6 for s in frame.sensors)
                assert len({s.sensor_id for s in frame.sensors})==len(frame.sensors)
                for sensor in frame.sensors:
                    if sensor.asset:
                        assets+=1;asset_bytes+=sensor.asset.byte_count
                        if i in (0, len(trace)-1, len(trace)):
                            resolve_asset(stream_path,sensor.asset);hash_samples+=1
                if last is not None:
                    assert frame.frame_id==last.frame_id+1
                    dt=frame.timestamp_s-last.timestamp_s
                    if frame.vehicle.speed_mps<.2:stop_run+=dt;stop_total+=dt
                    else:stop_run=0.
                    max_stop=max(max_stop,stop_run)
                last=frame
                if i>=len(trace):continue
                r=trace[i];braking=r['info']['intervention']['accepted']
                if braking!=old_braking:brake_edges.append({'elapsed_s':frame.timestamp_s-e['initial']['timestamp_s'],'braking':braking})
                old_braking=braking
                assert frame.frame_id==r['source_observation_frame_id']
                features=np.asarray(r['policy_inputs']['sensor_features_47'])
                assert features.shape==(47,) and np.isfinite(features).all() and np.all(np.abs(features)<=1)
                if e['controller']=='TEACHER':
                    latencies.append(r['decision_wall_ms']);step_latencies.append(r['capture_step_response_wall_ms'])
                    if not r['teacher']['diagnostics']['foreground_valid']:
                        sensor=next(s for s in frame.sensors if s.kind==SensorKind.RADAR)
                        d,hits=geometry['world_hits'](sensor);_,inside=geometry['leader_masks'](frame,metadata,d,hits)
                        order=np.argsort(d[:,0],kind='stable')[:32]
                        full=int(inside.sum());retained=int(inside[order].sum())
                        reason='RAW_RADAR_HAS_NO_LEAD_ASSOCIATED_RETURN' if full==0 else (
                            'NEAREST32_DISCARDS_LEAD' if retained==0 else 'RETAINED_LEAD_SCREENED_OR_OUTSIDE_CONE')
                        radar_blind[reason]+=1
                        blind_examples.append({'split':e['split'],'seed':e['seed'],'step':i+1,
                            'elapsed_s':frame.timestamp_s-e['initial']['timestamp_s'],'reason':reason,
                            'full_lead_associated_returns':full,'retained_lead_associated_returns':retained,
                            'raw_returns':len(d),'teacher_decision':r['teacher']['decision'],
                            'actual_unnecessary_braking_component':r['info']['reward_components']['unnecessary_braking']})
        durations=[b['elapsed_s']-a['elapsed_s'] for a,b in zip(brake_edges,brake_edges[1:])]
        per_episode.append({'split':e['split'],'seed':e['seed'],'controller':e['controller'],
            'brake_release_edges':brake_edges,'shortest_bout_or_release_s':min(durations) if durations else None,
            'longest_stopped_s':max_stop,'total_stopped_s':stop_total,'outcome':e['outcome']})
    matched=[]
    for condition in protocol['held_out_test']:
        group=[e for e in episodes if e['split']=='TEST' and e['seed']==condition['seed']]
        assert len(group)==3
        specs=[e['initial']['initial_configuration']['scenario_spec'] for e in group]
        assert specs[0]==specs[1]==specs[2]
        configs=[e['initial']['initial_configuration'] for e in group]
        assert len({(c['map'],c['ego_blueprint'],c['fixed_delta_seconds']) for c in configs})==1
        delta_position=delta_velocity=0.
        for key,field in [('intended_initial_states','transform'),('actual_velocity_initialization','transform')]:
            reference={a['name']:a for a in configs[0][key]['actors']}
            for c in configs[1:]:
                for actor in c[key]['actors']:
                    a=reference[actor['name']]
                    delta_position=max(delta_position,math.dist(a[field]['position_m'],actor[field]['position_m']))
                    if key=='actual_velocity_initialization':delta_velocity=max(delta_velocity,math.dist(a['velocity_mps'],actor['velocity_mps']))
        assert delta_position<.05 and delta_velocity<.05
        matched.append({'seed':condition['seed'],'identical_scenario_specs':True,'map':configs[0]['map'],
            'maximum_initial_pose_position_difference_m':delta_position,'maximum_initialized_velocity_difference_mps':delta_velocity})
    summaries={}
    for controller in ('BASIC_AGENT','EXISTING_RULE','TEACHER'):
        es=[e for e in episodes if e['split']=='TEST' and e['controller']==controller]
        metrics=[e['outcome']['metrics'] for e in es]
        keys=['collision_peak_impulse_ns','distance_traveled_m','forward_progress_m','average_speed_mps',
              'minimum_clearance_m','duration_s','intervention_count','hard_braking_events','unnecessary_intervention_count']
        summaries[controller]={'episodes':len(es),'outcomes':dict(Counter(e['outcome']['outcome'] for e in es)),
            **{'mean_'+k:statistics.mean(m[k] for m in metrics) for k in keys},
            'minimum_clearance_m':min(m['minimum_clearance_m'] for m in metrics),
            'minimum_valid_ttc_s':min(m['minimum_ttc_s'] for m in metrics if m['minimum_ttc_s'] is not None)}
    before=protocol['initial_state']['synchronization'];after=native['final_state']['synchronization']
    issue_delta={k:after['issues'][k]-before['issues'][k] for k in before['issues']}
    assert all(issue_delta[k]==0 for k in ('LATE','STALE','DUPLICATE','OUT_OF_ORDER','TIMESTAMP_MISMATCH'))
    memory=defaultdict(list)
    for sample in native['memory_samples']:
        for p in sample:memory['runner' if p['experiment_runner'] else p['name']+'-'+str(p['pid'])].append(p['private_mib'])
    cpu=process.cpu_times();mem=process.memory_info()
    report={'held_out':summaries,'matched_conditions':matched,'per_episode_control_analysis':per_episode,
        'radar_no_foreground_diagnosis':dict(radar_blind),'radar_no_foreground_examples':blind_examples,
        'recorded_complete_frames':total_frames,'recorded_asset_references':assets,'recorded_sensor_binary_mib':asset_bytes/2**20,
        'sampled_asset_integrity_checks':hash_samples,'synchronization_issue_delta':issue_delta,
        'incomplete_warmup_frame_delta':after['incompleteFrames']-before['incompleteFrames'],
        'teacher_decision_wall_ms_including_isolation_shadow':{'median':float(np.median(latencies)),
            'p95':float(np.percentile(latencies,95)),'max':max(latencies)},
        'teacher_capture_step_response_wall_ms':{'median':float(np.median(step_latencies)),
            'p95':float(np.percentile(step_latencies,95)),'max':max(step_latencies)},
        'sampled_private_memory_mib':{k:{'initial':v[0],'final':v[-1],'min':min(v),'max':max(v)} for k,v in memory.items()},
        'config_hash_preserved_after_test':True,'teacher_source_preserved_after_test':True,
        'model_sha256':native['model_sha256_unchanged'],'resource':{'wall_s':time.perf_counter()-START,
            'cpu_s_after_imports':cpu.user+cpu.system-cpu_start.user-cpu_start.system,
            'os_peak_working_set_mib':getattr(mem,'peak_wset',mem.rss)/2**20}}
    write(dest/'analysis.json',report)
    write(root/'budget-ledger.json',{'attempts':native['attempted_episodes'],'steps':native['actual_steps'],
        'native_wall_s':native['native_wall_s'],'status':'STOPPED_COMPLETE'})
    for path in ('backend/rl/teacher.py','backend/rl/teacher_config_v1.json','backend/rl/radar.py'):
        (root/Path(path).name).write_bytes((ROOT/path).read_bytes())
    print(json.dumps({'held_out':summaries,'matched':matched,'missing_radar':dict(radar_blind),
        'recorded_frames':total_frames,'resource':report['resource']},indent=2))


if __name__=='__main__':main()
