"""Condense retained native diagnostics without converting them to acceptance."""
import argparse
import hashlib
import json
from pathlib import Path
from backend.learning.hybrid_budget import HybridBudget,DIRECTORY

ROOT=Path(__file__).resolve().parents[1]


def digest(path):return hashlib.sha256(path.read_bytes()).hexdigest()


def summarize(path):
    report=json.loads(path.read_text(encoding='utf8'));samples=report.get('samples',[])
    fields=('id','scope','source','mode','scenario','seed','speed_kmh','journey','graphics',
            'native_planar_distance_m','maximum_speed_kmh','maximum_unexplained_stop_s',
            'source_unchanged','native_worker_exit_code','error','orchestration_error',
            'cleanup_error','restore_error','restored','wall_s','reservation_wall_s','scenario_validity',
            'reservation_working_s','platform_suspend_s','platform_interrupted')
    row={key:report.get(key) for key in fields}
    row.update(native_report=str(path.resolve()),native_report_sha256=digest(path),
        source_identity_sha256=hashlib.sha256(json.dumps(report.get('source_hashes',{}),sort_keys=True).encode()).hexdigest(),
        contacts=len(report['contacts']) if isinstance(report.get('contacts'),list) else None,
        recorded_samples=len(samples),completed_maneuvers=sorted({name for sample in samples
            for name in sample.get('maneuver',{}).get('completed_maneuvers',[])}))
    requested=report.get('speed_kmh');began=None;best=0.;last=None;best_values=[];values=[]
    for sample in samples:
        stamp=sample['timestamp_s'];speed=sample['speed_kmh']
        if requested is not None and abs(speed-requested)<=3. and sample.get('journey',{}).get('status')=='RUNNING':
            if began is None or last is None or stamp-last>.11:began=stamp;values=[]
            values.append(speed)
            if stamp-began>best:best=stamp-began;best_values=list(values)
        else:began=None;values=[]
        last=stamp
    row['cruise']={'duration_within_3_kmh_s':best,'mean_speed_kmh':sum(best_values)/len(best_values) if best_values else None,
                   'sustained_5s':best>=5.}
    accelerations=[s['longitudinal_acceleration_mps2'] for s in samples if isinstance(s.get('longitudinal_acceleration_mps2'),(int,float))]
    row['response']={'acceleration_samples':len(accelerations),
        'maximum_acceleration_mps2':max(accelerations) if accelerations else None,
        'minimum_acceleration_mps2':min(accelerations) if accelerations else None}
    runs=report.get('recording',{}).get('runs',{})
    arm=runs.get(report.get('mode'),{})
    row['initial_condition_audit']=arm.get('initial_condition_audit')
    row['matched_pair_verified']=report.get('recording',{}).get('conditions_match') is True
    if len(report.get('arms',[]))>1:
        row['paired_arms']=[{key:arm.get(key) for key in ('mode','journey','native_planar_distance_m',
            'maximum_speed_kmh','maximum_unexplained_stop_s')}|{
            'contacts':len(arm['contacts']) if isinstance(arm.get('contacts'),list) else None,
            'initial_condition_audit':arm.get('recording',{}).get('runs',{}).get(arm.get('mode'),{}).get('initial_condition_audit')}
            for arm in report['arms']]
    recording=Path(arm['recording']) if arm.get('recording') else None
    if recording:
        row['recording']=str(recording)
        for filename,key in (('recording-status.json','recording_status'),('video-status.json','video_status')):
            p=recording/filename
            if p.exists():row[key]=json.loads(p.read_text(encoding='utf8'))
        trace=recording/'telemetry/comparison-controls.jsonl';total=fresh=measured=unknown_alignment=0;veto={};outages=[]
        if trace.exists():
            for line in trace.open(encoding='utf8'):
                # Forecast/decision rows can be hundreds of KiB; none are
                # needed for execution freshness. Parse matching rows only.
                if '"HYBRID_EXECUTION"' not in line:continue
                event=json.loads(line)
                if event.get('kind')!='HYBRID_EXECUTION':continue
                total+=1
                wall=event.get('scene_wall_age_s');simulation=event.get('scene_sim_age_s')
                aligned=event.get('aligned_current_frame')
                if aligned is None:unknown_alignment+=1
                if isinstance(wall,(int,float)) and isinstance(simulation,(int,float)) and type(aligned) is bool:
                    measured+=1;valid=(0<=wall<=.25 and 0<=simulation<=.1+1e-6
                        and event.get('aligned_current_frame') is True);fresh+=int(valid)
                    if not valid:outages.append({'frame_id':event['frame_id'],'wall_age_s':wall,'simulation_age_s':simulation})
                if event.get('accepted') is False:veto[event['reason']]=veto.get(event['reason'],0)+1
        row['timing']={'execution_decisions':total,'measured_decisions':measured,
            'alignment_unknown_decisions':unknown_alignment,
            'fresh_decisions':fresh,'fresh_fraction':fresh/total if total and measured==total else None,
            'outages':outages,'veto_counts':veto}
    return row


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',default='docs/evidence/hybrid_driving/diagnostics.json');args=parser.parse_args()
    rows=[summarize(p) for p in sorted(DIRECTORY.glob('probe-*/report.json'),key=lambda p:p.parent.stat().st_mtime)]
    budget=HybridBudget().status()
    for adjustment in budget.get('sleep_adjustments',[]):
        for row in rows:
            if Path(row['native_report']).resolve()==Path(adjustment['report_path']).resolve():
                row.update(platform_interrupted=True,verified_sleep_excluded_s=adjustment['excluded_s'],
                           interruption_evidence='budget_sleep_reconciliation.json')
    result={'version':1,'scope':'DIAGNOSTICS_ACROSS_DIFFERENT_SOURCE_REVISIONS_NOT_ACCEPTANCE',
        'native_accepted':False,'budget':budget,'trials':rows,
        'qualification':'Raw reports/assets are retained locally and referenced by checksums. Incomplete or changed-source trials never prove a frozen acceptance gate.'}
    output=ROOT/args.output;output.parent.mkdir(parents=True,exist_ok=True)
    output.write_text(json.dumps(result,indent=2,ensure_ascii=False,allow_nan=False),encoding='utf8')
    print(json.dumps({'trials':len(rows),'output':str(output),'remaining_s':budget['remaining_s']}))


if __name__=='__main__':main()
