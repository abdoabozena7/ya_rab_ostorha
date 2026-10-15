"""Compact retained native presentation evidence, including failed attempts."""
from collections import Counter
import hashlib
import json
from pathlib import Path
import statistics

ROOT=Path(__file__).resolve().parents[1]


def summary(presentation_id):
    path=ROOT/'output/presentations'/f'{presentation_id}.json'
    data=json.loads(path.read_text(encoding='utf8'))
    result={'id':data['id'],'status':data['status'],'reason':data.get('reason'),
        'seed':data['seed'],'setup':data.get('setup'),'events':data['events'],
        'conditions_match':data.get('conditions_match'),'evidence_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
        'pair_id':data.get('pair_id'),'runs':{}}
    pair=ROOT/'output/journey-comparisons'/f"{data.get('pair_id')}.json"
    if not pair.is_file():return result
    comparison=json.loads(pair.read_text(encoding='utf8'))
    for mode,run in comparison['runs'].items():
        item={k:run.get(k) for k in ('id','status','reason','duration_s','distance_m','route_completion_percent',
            'destination_reached','collisions','near_misses','harsh_braking_events','safety_interventions',
            'safety_intervention_s','mean_speed_kmh','maximum_speed_kmh','samples','sensor_coverage_percent')}
        root=Path(run['recording']);item['recording_id']=root.name
        trace=root/'telemetry/safety-v2.jsonl';counts=Counter();ages=[];max_wait=0.;delays=0
        with trace.open(encoding='utf8') as stream:
            for line in stream:
                row=json.loads(line);counts[(row.get('decision_source'),row.get('reason'))]+=1
                if row.get('sensor_wall_age_s') is not None:ages.append(row['sensor_wall_age_s'])
                max_wait=max(max_wait,row.get('stopped_for_s',0))
                delays+=row.get('decision_source')=='SENSOR_FRESHNESS' and 'Sensor delay' in str(row.get('reason'))
        item.update(maximum_stopped_s=max_wait,delay_hold_decisions=delays,
            sensor_age_p50_ms=statistics.median(ages)*1000 if ages else None,
            decision_reasons=[{'source':source,'reason':reason,'count':count} for (source,reason),count in counts.most_common(12)])
        audit=run.get('initial_condition_audit') or {}
        item['initial_condition_audit']={k:audit.get(k) for k in ('passed','failures','condition_id')}
        video=root/'video-status.json'
        if video.exists():
            item['video']=json.loads(video.read_text(encoding='utf8'))
            output=root/'driving.mp4'
            item['video']['file_checksum_verified']=output.is_file() and hashlib.sha256(output.read_bytes()).hexdigest()==item['video'].get('sha256')
        result['runs'][mode]=item
    return result


def main():
    import argparse
    parser=argparse.ArgumentParser();parser.add_argument('ids',nargs='+');parser.add_argument('--output',required=True)
    args=parser.parse_args()
    data={'source':'RETAINED_NATIVE_PRESENTATION_RECORDINGS','presentations':[summary(i) for i in args.ids],
        'limits':['Individual presentations are not the frozen hybrid behavioral acceptance cohort.',
            'Normal retains its historical obstacle-protection-off behavior; it is not the independent BehaviorAgent baseline.',
            'Matched initial conditions do not imply identical reactive traffic futures.',
            'Interventions are not proven prevented collisions. Actual speeds differ from the request.']}
    target=Path(args.output);target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(data,indent=2,allow_nan=False),encoding='utf8')
    print(json.dumps({'output':str(target),'presentations':len(data['presentations'])}))


if __name__=='__main__':main()
