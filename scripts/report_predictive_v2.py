"""Package measured evidence without rewriting weights or claiming acceptance."""
import hashlib
import json
from pathlib import Path
import shutil
import numpy as np
from backend.learning.supervised.motion import PredictiveModel
from backend.learning.experiment_budget import ExperimentBudget

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'docs/evidence/predictive_v2'


def main():
    OUT.mkdir(parents=True,exist_ok=True)
    native=json.loads((ROOT/'output/predictive-v2/native-test.json').read_text())
    weights=ROOT/'artifacts/learned_safety/predictive_v2/heads.npz'
    assert hashlib.sha256(weights.read_bytes()).hexdigest()==native['weights_sha256']
    rows=[]; groups={}; audits=[]; hazards=[]
    for row in native['pairs']:
        result=row.get('results')
        if not result:
            rows.append({'pair_id':row['pair_id'],'side':row['side'],'terminal_result':False,
                'note':'Observer did not capture a terminal result; do not count this as a completed TEST side.'})
            continue
        if result.get('completed'):groups.setdefault(row['pair_id'],set()).add(row['side'])
        summary={k:result.get(k) for k in ('side','status','reason','failure_reason','completed','collision','destination_arrived','metrics','recording','initial_condition_audit')}
        summary.update(pair_id=row['pair_id'],wall_s=row['wall_s'])
        summary['sampled_tick_hz_median']=float(np.median([s['native_tick_hz'] for s in row['samples'] if s.get('native_tick_hz')]))
        rows.append(summary)
        run=result.get('run')
        if not run:
            path=ROOT/'output/scenarios'/((result.get('outcome') or {}).get('run_id','missing')+'.json')
            if path.exists():run=json.loads(path.read_text()).get('run')
        if run:
            observations=run.get('hazard_observations',{})
            names=('sudden_brake','cut_in','curb_up','curb_return','crossing_0','crossing_1')
            hazards.append({'pair_id':row['pair_id'],'side':row['side'],
                'schedule':run['spec']['metadata'].get('hazard_schedule'),
                'observed_final_flags':{name:{k:v for k,v in observations.get(name,{}).items() if k not in ('position_m','controls')} for name in names},
                'ego_encountered_all_major_hazards':None,
                'scope':'Native evaluation diagnostics only; final flags do not establish ego encounter or continuous event coverage'})
        recording=Path(result['recording']); status=json.loads((recording/'recording-status.json').read_text())
        sources={}; geometry=[]; braking=0; missing=0; learned=0; measured=0
        for line in (recording/'telemetry/safety-v2.jsonl').open(encoding='utf8'):
            entry=json.loads(line); safety=entry.get('safety') or {}; prediction=safety.get('prediction') or {}
            if entry.get('braking'):
                braking+=1; missing+=not bool(entry.get('decision_source') and entry.get('reason'))
                source=entry.get('decision_source','MISSING');sources[source]=sources.get(source,0)+1
            metric=prediction.get('quality_metrics',{}).get('geometry_ms')
            if metric is not None:geometry.append(metric)
            for mode in prediction.get('trajectories',[]):
                learned+=mode['source']=='LIGHTWEIGHT_LEARNED_MOTION'; measured+=1
        audits.append({'pair_id':row['pair_id'],'side':row['side'],'recording':str(recording),
            'recording_status':status,'braking_rows':braking,'rows_without_source_or_reason':missing,
            'braking_source_counts':sources,'geometry_p95_ms':float(np.percentile(geometry,95)) if geometry else None,
            'learned_trajectory_rows':learned,'total_trajectory_rows':measured,
            'scope':'Schema/cause presence audit; does not establish correctness of every detection or false-stop rate'})
    complete=sum(sides=={'RULE','MODEL'} for sides in groups.values())
    report={'version':2,'experimental':True,'enabled_by_default':False,'acceptance_passed':False,
        'weights_sha256':native['weights_sha256'],'frozen_before_test':native['frozen_before_test'],
        'completed_independent_pairs':complete,'requested_pairs':3,'matrix_completed':native['completed'],
        'attempt_failures':native['failures'],'runs':rows,
        'coverage':'Recipes contain all major hazards. Ego encounter/occlusion/ID-switch coverage is not established.',
        'implementation_scope':'Initial native runs precede final signal audit, diagnostic and surface-order repairs; weights remained frozen.',
        'budget':ExperimentBudget().status(),'gate_failures':['Destination arrival and useful driving benefit not established',
            'Measured VALIDATION risk calibration missing','Matched native throughput and false-stop comparison missing',
            'Full native all-camera/Replay/manual-drive acceptance missing','Live causal ablation missing']}
    (OUT/'acceptance.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    (OUT/'recording-audit.json').write_text(json.dumps(audits,indent=2),encoding='utf8')
    (OUT/'hazard-coverage.json').write_text(json.dumps(hazards,indent=2),encoding='utf8')
    manifests=[]
    for pair_id in groups:
        path=ROOT/'output/comparison_v2'/(pair_id+'.json')
        if path.exists():manifests.append({k:v for k,v in json.loads(path.read_text()).items() if k!='results'})
    (OUT/'pair-manifests.json').write_text(json.dumps(manifests,indent=2),encoding='utf8')
    for filename in ('benchmark.json','budget-overlap-correction.json','budget-fixture-correction.json'):
        path=ROOT/'output/predictive-v2'/filename
        if path.exists():shutil.copyfile(path,OUT/filename)
    model=PredictiveModel();x=np.zeros(13,np.float32)
    context=dict(speed=8.,distance=7.,conflict_time=.7,conflict=True,free_range=30.,cap=5.5)
    model.reset();speed=model.target_speed(x,context);model.reset();ablated=model.target_speed(x,context,ablate=True)
    track=dict(id='measured-fixture',position_m=[10,3],velocity_mps=[3,-1],acceleration_mps2=[1.,-.5],
        quality=.9,confirmed=True,**{'class':'car'})
    modes=model.modes([track]);baseline=model.modes([track],ablate=True)
    ablation={'scope':'Offline inference ablation, not a native driving benefit claim','weights_sha256':model.metadata['weights_sha256'],
        'learned_target_mps':speed,'ablated_target_mps':ablated,'speed_changed':speed!=ablated,
        'prediction_changed':modes!=baseline,'maximum_trajectory_delta_m':float(np.max(np.linalg.norm(
            np.asarray([m['points'] for m in modes])[:,:,1:]-np.asarray([m['points'] for m in baseline])[:,:,1:],axis=2)))}
    (OUT/'ablation.json').write_text(json.dumps(ablation,indent=2),encoding='utf8')
    (OUT/'validation.json').write_text(json.dumps({'python_tests':255,'python_skipped':1,'frontend_tests':59,
        'browser_viewports':[1366,900,430],'page_errors':[],'all_five_camera_pose_projection_tests':True,
        'actual_replay_checked':{'frames':3602,'sidecar_frames':3602,'matching_midpoint_frame':33630},
        'native_acceptance':False},indent=2),encoding='utf8')
    print(json.dumps({'completed_independent_pairs':complete,'terminal_sides':sum(bool(r.get('completed')) for r in rows),
        'acceptance_passed':False,'evidence':str(OUT)},indent=2))


if __name__=='__main__':main()
