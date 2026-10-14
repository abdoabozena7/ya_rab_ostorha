"""Reconcile native failures, source identities and admission without cherry-picking."""
import hashlib
import json
import math
from pathlib import Path
from backend.learning.pilot_budget import PilotBudget,DEFAULT_ROOT
from backend.learning.pilot_acceptance import validate
from backend.learning.pilot_provenance import control_hashes
from scripts.run_core_repair_pilot import historical_hashes

ROOT=Path(__file__).resolve().parents[1]


def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()
def read(path):return json.loads(path.read_text(encoding='utf-8-sig'))


def main():
    runs=[];files=[]
    for path in sorted(DEFAULT_ROOT.glob('run-*.json')):
        value=read(path);runs.append({'report':str(path),'sha256':digest(path),'phase':value['phase'],
            'outcomes':[e.get('outcome') for e in value.get('episodes',[])],
            'ordinary_gate':value.get('ordinary_gate',False),'error':value.get('error'),
            'historical_ledgers_unchanged':value.get('historical_ledgers_unchanged',False),
            'qualification':value.get('qualification')})
    initialization=[];episodes=[];reset_failures=[]
    for path in sorted((DEFAULT_ROOT/'episodes').glob('*/*/reset-failure.json')):
        reset_failures.append({'episode':str(path.parent),'split':path.parent.parent.name,**read(path),'sha256':digest(path)})
        files.append({'path':str(path),'sha256':digest(path),'bytes':path.stat().st_size})
    for manifest_path in sorted((DEFAULT_ROOT/'episodes').glob('*/*/manifest.json')):
        manifest=read(manifest_path);directory=manifest_path.parent
        pose=manifest.get('ego_initial',{}).get('position');intended=manifest.get('intended_ego_pose',{}).get('position')
        separation=math.dist(pose[:2],intended[:2]) if pose and intended else None
        valid_init=bool(manifest.get('initialization_version',0)>=2 and separation is not None and separation<=1.)
        initialization.append({'episode':str(directory),'version':manifest.get('initialization_version',1),
            'initial_pose_gap_m':separation,'valid_initialization':valid_init})
        outcome=read(directory/'outcome.json') if (directory/'outcome.json').exists() else {'outcome':'INCOMPLETE_OR_RESET_FAILURE'}
        episodes.append({'episode':str(directory),'split':directory.parent.name,'scenario':manifest['scenario'],
            'mode':manifest['mode'],'policy_id':manifest['policy_id'],'condition_hash':manifest['condition_hash'],
            'constructor_valid':valid_init,'outcome':outcome.get('outcome'),'metrics':outcome.get('metrics'),
            'scenario_validity':outcome.get('scenario_validity')})
        for path in (manifest_path,directory/'outcome.json',directory/'transitions.jsonl',
            directory/'sensors/metadata.json',directory/'sensors/recording-status.json',directory/'sensors/telemetry/frames.jsonl'):
            if path.exists():files.append({'path':str(path),'sha256':digest(path),'bytes':path.stat().st_size})
    trainings=[{'report':str(p),**read(p)} for p in sorted(DEFAULT_ROOT.glob('training-*.json'))]
    prediction=[{'report':str(p),**read(p)} for p in sorted(DEFAULT_ROOT.glob('prediction-training-*.json'))]
    evaluation_paths=sorted(DEFAULT_ROOT.glob('evaluation-*.json'),key=lambda p:p.stat().st_mtime_ns)
    evaluations=[{'report':str(p),**read(p)} for p in evaluation_paths]
    physical=[{'report':str(p),**read(p)} for p in sorted(DEFAULT_ROOT.glob('physical-frozen-*.json'),key=lambda p:p.stat().st_mtime_ns)]
    manifest_path=DEFAULT_ROOT/'frozen-test-v2.json';manifest=read(manifest_path)
    latest=evaluations[-1] if evaluations else {}
    implementation=control_hashes()
    implementation_verified=manifest.get('implementation_sha256')==implementation
    checkpoint_records=[]
    for training in trainings:
        if not training.get('trained'):continue
        path=Path(training['checkpoint'])
        verified=path.is_file() and digest(path)==training['sha256']
        checkpoint_records.append({'path':str(path),'sha256':training['sha256'],'hash_verified':verified,
            'implementation_matches_frozen_manifest':training.get('implementation_sha256')==manifest.get('implementation_sha256')})
        if path.is_file():files.append({'path':str(path),'sha256':digest(path),'bytes':path.stat().st_size})
    evaluated_checkpoint_verified=any(c['hash_verified'] and c['implementation_matches_frozen_manifest'] and
        c['sha256']==latest.get('checkpoint_sha256') for c in checkpoint_records)
    cases=[]
    for value in latest.get('outcomes',[]):
        m=value.get('metrics',{})
        case={'case_id':value['case_id'],'outcome':value.get('outcome'),
            'scenario_valid':value.get('scenario_validity',{}).get('valid',False),'complete_episode':value.get('outcome') in ('SUCCESS','TIME_LIMIT','COLLISION'),
            'contacts':m.get('collisions'),'native_distance_m':m.get('native_distance_m',0.)}
        stop=m.get('maximum_clear_path_stop_s')
        if isinstance(stop,(int,float)) and math.isfinite(stop):case['maximum_unexplained_stop_s']=stop
        cases.append(case)
    metrics=[v.get('metrics',{}) for v in latest.get('outcomes',[])]
    frames=sum(m.get('decision_frames',0) for m in metrics);fresh=sum(m.get('fresh_decision_frames',0) for m in metrics)
    results={'cases':cases,'identical_driver_traces_verified':False,
        'manifest_hash_verified':latest.get('manifest_hash_verified',False) and implementation_verified,
        'checkpoint_hash_verified':latest.get('checkpoint_hash_verified',False) and evaluated_checkpoint_verified,
        'implementation_hash_verified':implementation_verified,
        'performance':{'fresh_control_scene_fraction':fresh/frames if frames else 0.,
            'long_outages_reported':bool(metrics) and all('maximum_scene_age_at_action_s' in m for m in metrics),
            'maximum_scene_age_at_action_s':max((m.get('maximum_scene_age_at_action_s',0) for m in metrics),default=None),
            'matched':False,'degradation_fraction':None},
        'prediction':{'paired_independent_error_improvement':0.,'hazard_coverage_not_reduced':False,'driving_not_worse':False}}
    acceptance=validate(manifest,results)
    result_path=DEFAULT_ROOT/'acceptance-results.json';result_path.write_text(json.dumps(results,indent=2,allow_nan=False),encoding='utf8')
    (DEFAULT_ROOT/'acceptance.json').write_text(json.dumps(acceptance,indent=2),encoding='utf8')
    (DEFAULT_ROOT/'initialization-audit.json').write_text(json.dumps(initialization,indent=2),encoding='utf8')
    for pattern in ('run-*.json','training-*.json','prediction-training-*.json','prediction-*.json','segmentation-*.json','evaluation-*.json','physical-frozen-*.json','applied-commands-*.json','applied-commands-*.commands.jsonl'):
        for path in sorted(DEFAULT_ROOT.glob(pattern)):
            files.append({'path':str(path),'sha256':digest(path),'bytes':path.stat().st_size})
    for path in (manifest_path,manifest_path.with_suffix('.lock.json'),result_path,DEFAULT_ROOT/'acceptance.json',DEFAULT_ROOT/'initialization-audit.json'):
        files.append({'path':str(path),'sha256':digest(path),'bytes':path.stat().st_size})
    for pattern in ('frozen-source-v2*.*','dependencies-*.txt','tests-*.txt','restored-state.json'):
        for path in sorted(DEFAULT_ROOT.glob(pattern)):
            files.append({'path':str(path),'sha256':digest(path),'bytes':path.stat().st_size})
    for path in sorted((DEFAULT_ROOT/'clips').glob('*')):
        if path.is_file():files.append({'path':str(path),'sha256':digest(path),'bytes':path.stat().st_size})
    report={'scope':'FIRST_FEASIBILITY_PILOT','accepted':False,'budget':PilotBudget().status(),
        'historical_ledger_hashes':historical_hashes(),'historical_ledgers_unchanged':all(r['historical_ledgers_unchanged'] for r in runs),
        'implementation_sha256':implementation,'frozen_manifest_sha256':digest(manifest_path),
        'implementation_hash_verified':implementation_verified,'checkpoint_records':checkpoint_records,
        'runs':runs,'episodes':episodes,'reset_failures':reset_failures,'training_reports':trainings,'prediction_training_reports':prediction,
        'evaluations':evaluations,'physical_frozen_probes':physical,'acceptance':acceptance,'evidence_files':files}
    (DEFAULT_ROOT/'evidence-index.json').write_text(json.dumps(report,indent=2,allow_nan=False),encoding='utf8')
    print(json.dumps({'index':str(DEFAULT_ROOT/'evidence-index.json'),'episodes':len(episodes),
        'learned_transitions':sum(t.get('valid_transitions',0) for t in trainings),
        'accepted':acceptance['accepted'],'unfinished_gates':acceptance['unfinished_gates']}))


if __name__=='__main__':main()
