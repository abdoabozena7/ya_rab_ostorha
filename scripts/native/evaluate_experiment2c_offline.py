"""Historical sensor reliability audit; no training or counterfactual physics.

Ground truth below is confined to geometric selection-quality evaluation.
Historical TEST records are diagnostic only, not fresh evaluation or calibration.
"""
import time
START=time.perf_counter()
from collections import Counter
from dataclasses import replace
import hashlib
import json
from pathlib import Path
import statistics
import numpy as np
import psutil
from backend.core.contracts import SimulationFrame, SensorKind, from_dict, to_dict
from backend.core.safety_policy import sensor_observation
from backend.rl.radar import foreground_index
from backend.rl.radar_retention import retention_indices, retained_radar_observation, RETENTION_VERSION
from backend.rl.teacher import YaRabOstorhaSafetyTeacher
from backend.rl.observations import ObservationAssembler, CONFIGS
from backend.rl.supervisor import policy_features, decide_intervention
from .experiment2b_common import ROOT, write, rows, base_command
from .inspect_experiment2c_dropouts import diagnostic_geometry


def legacy_radar():
    # Execute the preserved pure NumPy module, not neural or simulator code.
    import subprocess
    source=subprocess.check_output(['git','show','61c9ea98:backend/rl/radar.py'],cwd=ROOT).decode()
    import types,sys
    module=types.ModuleType('experiment2c_legacy_radar');sys.modules[module.__name__]=module
    exec(compile(source,module.__name__,'exec'),module.__dict__)
    return module


def timing(values):
    return {'median_ms':float(np.median(values)), 'p95_ms':float(np.percentile(values,95)), 'max_ms':max(values)}


def main():
    process=psutil.Process();cpu_start=process.cpu_times()
    dest=ROOT/'docs/evidence/experiment2c'
    native=json.loads((ROOT/'docs/evidence/experiment2b/native.json').read_text())
    geometry=diagnostic_geometry();legacy=legacy_radar()
    groups={};episode_reports=[];problems=[];before_time=[];after_time=[];retention_time=[]
    refactor_checks=0;isolation_checks=0;observations=0;remaining_missing=[]
    for episode in native['episodes']:
        path=Path(episode['recording_path']);metadata=json.loads((path/'metadata.json').read_text())
        label=episode['split']+'_'+episode['controller'];counts=groups.setdefault(label,Counter())
        if episode['controller']=='TEACHER':
            trace=rows(Path(native['run'])/f"{episode['split']}_{episode['seed']}_TEACHER-steps.jsonl")
            old_teacher=YaRabOstorhaSafetyTeacher();new_teacher=YaRabOstorhaSafetyTeacher();shadow=YaRabOstorhaSafetyTeacher()
            assembler=ObservationAssembler(CONFIGS['lightweight'],lambda _:None)
            clean_assembler=ObservationAssembler(CONFIGS['lightweight'],lambda _:None)
            edges={'before':[],'after':[]};previous={'before':False,'after':False};differences=[]
        with (path/'telemetry/frames.jsonl').open() as stream:
            for i,line in enumerate(stream):
                frame=from_dict(SimulationFrame,json.loads(line));observations+=1
                assert frame.complete
                sensor=next(s for s in frame.sensors if s.kind==SensorKind.RADAR)
                points,hits=geometry['world_hits'](sensor);points=points.astype(np.float32)
                _,inside=geometry['leader_masks'](frame,metadata,points,hits)
                before=np.argsort(points[:,0],kind='stable')[:32]
                started=time.perf_counter();old_index=foreground_index(points[before])
                before_time.append((time.perf_counter()-started)*1000)
                assert old_index==legacy.foreground_index(points[before]);refactor_checks+=1
                started=time.perf_counter();after=retention_indices(points)
                retained_ms=(time.perf_counter()-started)*1000;retention_time.append(retained_ms)
                new_index=foreground_index(points[after]);after_time.append((time.perf_counter()-started)*1000)
                assert len(after)==min(32,len(points)) and len(set(after))==len(after)
                raw_lead=int(inside.sum());counts['frames']+=1;counts['raw_lead_observable_frames']+=int(raw_lead>0)
                for variant,indices,index in (('before',before,old_index),('after',after,new_index)):
                    counts[variant+'_lead_retained_frames']+=int(inside[indices].any())
                    counts[variant+'_raw_lead_false_exclusion_frames']+=int(raw_lead>0 and not inside[indices].any())
                    counts[variant+'_missing_foreground_frames']+=int(index is None)
                    if index is not None:
                        source=int(indices[index]);counts[variant+'_lead_selected_frames']+=int(inside[source])
                        counts[variant+'_ground_selected_frames']+=int(hits[source,2]<.25)
                        counts[variant+'_other_selected_frames']+=int(not inside[source] and hits[source,2]>=.25)
                if episode['controller']=='TEACHER' and new_index is None:
                    from backend.rl.radar import measured_heights
                    remaining_missing.append({'split':episode['split'],'seed':episode['seed'],'step':i+1,
                        'raw_lead_returns':raw_lead,'retained_lead_returns':int(inside[after].sum()),
                        'before_had_foreground':old_index is not None,'retained_points':points[after].tolist(),
                        'new_heights':measured_heights(points[after])[0].tolist()})
                if episode['controller']!='TEACHER' or i>=len(trace):continue
                r=trace[i];assert frame.frame_id==r['source_observation_frame_id']
                observation=sensor_observation(frame);base=base_command(observation,[r['policy_inputs']['base_proposed_control'][k] for k in ('steering','throttle','brake')])
                old=old_teacher.propose(observation,base)
                assert to_dict(old)==r['teacher'], 'Baseline teacher replay does not match saved decisions'
                adapted=retained_radar_observation(observation)
                new=new_teacher.propose(adapted,base)
                clean=sensor_observation(replace(frame,ground_truth=None,actors=()))
                assert to_dict(new)==to_dict(shadow.propose(retained_radar_observation(clean),base));isolation_checks+=1
                selected,admission=decide_intervention(adapted,base,new.action,'YA_RAB_OSTORHA_EXPERIMENT2C')
                assert selected.steering==base.steering and admission['decision']!='REJECTED'
                counts['new_accepted_brake_proposals']+=int(admission['accepted'])
                raw=assembler.append(observation,[observation.ego.steering,observation.ego.throttle,observation.ego.brake])
                clean_raw=clean_assembler.append(clean,[clean.ego.steering,clean.ego.throttle,clean.ego.brake])
                features=policy_features(raw,[base.steering,base.throttle,base.brake])
                np.testing.assert_array_equal(features,policy_features(clean_raw,[base.steering,base.throttle,base.brake]))
                assert features.shape==(47,) and np.isfinite(features).all()
                counts['observation_space_valid_frames']+=int(assembler.space.contains(raw))
                if old.decision!=new.decision: differences.append({'step':i+1,'before':old.decision,'after':new.decision})
                elapsed=frame.timestamp_s-episode['initial']['timestamp_s']
                for variant,decision in (('before',old),('after',new)):
                    braking=decision.action[0]>0
                    if braking!=previous[variant]:edges[variant].append({'elapsed_s':elapsed,'braking':braking})
                    previous[variant]=braking
                if old_index is None:
                    problems.append({'split':episode['split'],'seed':episode['seed'],'step':i+1,
                        'raw_lead_returns':raw_lead,'before_retained_lead_returns':int(inside[before].sum()),
                        'after_retained_lead_returns':int(inside[after].sum()),
                        'after_selected_lead':bool(new_index is not None and inside[after[new_index]]),
                        'before_decision':old.decision,'after_decision':new.decision})
        if episode['controller']=='TEACHER':
            def brief(es):return sum(b['elapsed_s']-a['elapsed_s']<=.150001 for a,b in zip(es,es[1:]))
            episode_reports.append({'split':episode['split'],'seed':episode['seed'],'steps':len(trace),
                'decision_differences':len(differences),'differences':differences,'brake_release_edges':edges,
                'brief_bout_or_release_count':{k:brief(v) for k,v in edges.items()},'counterfactual_physics_evaluated':False})
    assert len(problems)==16 and all(p['after_selected_lead'] for p in problems)
    assert all(c['after_ground_selected_frames']==0 for c in groups.values())
    offline_pass=sum(c['after_missing_foreground_frames'] for k,c in groups.items() if k.endswith('TEACHER'))==0
    cpu=process.cpu_times();m=process.memory_info()
    report={'experiment':'YA RAB OSTORHA Experiment 2C offline reliability audit',
        'retention_version':RETENTION_VERSION,'historical_test_is_diagnostic_not_fresh':True,
        'groups':{k:dict(v) for k,v in groups.items()},'sixteen_dropouts':problems,'teacher_replay':episode_reports,
        'remaining_missing_foreground':remaining_missing,'offline_pass':offline_pass,
        'total_frames':observations,'legacy_foreground_refactor_equivalence_checks':refactor_checks,
        'privileged_removal_teacher_and_47_feature_checks':isolation_checks,
        'foreground_before_latency':timing(before_time),'retention_latency':timing(retention_time),
        'retention_plus_foreground_after_latency':timing(after_time),
        'resource':{'wall_s':time.perf_counter()-START,'cpu_s_after_imports':cpu.user+cpu.system-cpu_start.user-cpu_start.system,
            'private_mib':m.private/2**20,'peak_working_set_mib':m.peak_wset/2**20},
        'teacher_source_sha256':hashlib.sha256((ROOT/'backend/rl/teacher.py').read_bytes()).hexdigest(),
        'teacher_config_sha256':hashlib.sha256((ROOT/'backend/rl/teacher_config_v1.json').read_bytes()).hexdigest(),
        'neural_training':False,'gpu_allocations':0}
    write(dest/'offline.json',report)
    print(json.dumps({k:v for k,v in report.items() if k not in ('teacher_replay','sixteen_dropouts','remaining_missing_foreground')},indent=2))
    assert offline_pass,'New missing foreground remains; see saved diagnostic frames'


if __name__=='__main__':main()
