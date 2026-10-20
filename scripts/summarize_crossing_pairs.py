"""Compact actual native evidence; raw samples/recordings stay local and ignored."""
import argparse
import collections
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]


def summarize(path):
    report=json.loads(path.read_text(encoding='utf8'));pair=report.get('pair') or {}
    result={'attempt':path.parent.name,'seed':report.get('seed'),'first_mode':report.get('first_mode'),
        'source_archive':report.get('source_archive'),'source_unchanged':report.get('source_unchanged'),
        'source_set_sha256':hashlib.sha256(json.dumps(report.get('source_hashes',{}),sort_keys=True).encode()).hexdigest(),
        'scenario_validation':pair.get('scenario_validation'),'conditions_match':pair.get('conditions_match'),
        'completed_without_shortening':report.get('completed_without_shortening'),
        'finish_completed':report.get('finish_completed'),'cleanup_confirmed':report.get('cleanup_confirmed'),
        'independent_cleanup_probe':report.get('independent_cleanup_probe'),
        'simulator_exit_confirmed':report.get('simulator_exit_confirmed'),
        'video_playback_after_exit':report.get('video_playback_after_exit'),
        'native_acceptance':report.get('native_acceptance',False),'wall_s':report.get('wall_s'),
        'critical_prediction_evidence':report.get('critical_prediction_evidence'),
        'current_acceptance':bool(report.get('native_acceptance') and report.get('critical_prediction_evidence',{}).get('passed')),
        'error':report.get('error'),'calibration_aborted':report.get('calibration_aborted'),
        'phases':report.get('phases'),'exports_at_finish_request':report.get('exports_at_finish_request'),
        'shared_perception':report.get('shared_perception'),'runs':{}}
    for mode,run in pair.get('runs',{}).items():
        samples=[s for s in report.get('samples',[]) if s.get('mode')==mode]
        longest=0.;stopped_at=None;reasons=collections.Counter();first_prediction=None
        for sample in samples:
            stamp=sample['timestamp_s'];stop=sample.get('stop') or {}
            if sample['speed_kmh']<.5:
                if stopped_at is None:stopped_at=stamp
                longest=max(longest,stamp-stopped_at);reasons[stop.get('reason','unavailable')]+=1
            else:stopped_at=None
            safety=stop.get('safety') or {}
            if first_prediction is None and safety.get('pedestrian_prediction'):
                first_prediction={'timestamp_s':stamp,'position_m':sample['position_m'],
                    'speed_kmh':sample['speed_kmh'],'forecast':safety['pedestrian_prediction']['source']}
        result['runs'][mode]={key:run.get(key) for key in ('id','status','reason','recording','duration_s',
            'distance_m','collisions','collision_events','scenario_evidence','initial_condition_audit')}
        result['runs'][mode].update(requested_speed_kmh=run.get('setup',{}).get('speed_kmh'),
            perception_profile=run.get('setup',{}).get('perception_profile'),
            actual_max_speed_kmh=max((s['speed_kmh'] for s in samples),default=None),
            longest_observed_standstill_s=longest,standstill_reason_samples=dict(reasons),
            first_applied_pedestrian_forecast=first_prediction)
    return result


def compact(result):
    """Keep replayable attempt identities, gates and measured limits, not poses."""
    value={k:v for k,v in result.items() if k not in ('runs','independent_cleanup_probe','video_playback_after_exit','phases')}
    value['cleanup_probe_passed']=(result.get('independent_cleanup_probe') or {}).get('passed')
    playback=result.get('video_playback_after_exit') or {}
    value['video_playback_after_exit']={k:v for k,v in playback.items() if k!='checks'}
    value['runs']={}
    for mode,run in result['runs'].items():
        item={k:v for k,v in run.items() if k not in ('scenario_evidence','initial_condition_audit')}
        native=run.get('scenario_evidence') or {}
        item['critical_event']=(native.get('events') or {}).get('critical_pedestrian')
        item['initial_condition_audit_passed']=(run.get('initial_condition_audit') or {}).get('passed')
        value['runs'][mode]=item
    return value


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',default='output/crossing-evidence.json')
    parser.add_argument('--compact',action='store_true')
    args=parser.parse_args();attempts=[]
    for path in sorted((ROOT/'output/crossing-pairs').glob('*/report.json')):
        result=summarize(path);attempts.append(compact(result) if args.compact else result)
    target=ROOT/args.output;target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps({'scope':'ACTUAL_NATIVE_REPORT_SUMMARIES_NOT_SYNTHETIC_OUTCOMES',
        'attempts':attempts},indent=2,ensure_ascii=False),encoding='utf8')
    print(json.dumps({'path':str(target),'attempts':len(attempts),
        'accepted_with_current_causality_gate':sum(bool(r['current_acceptance']) for r in attempts)}))


if __name__=='__main__':main()
