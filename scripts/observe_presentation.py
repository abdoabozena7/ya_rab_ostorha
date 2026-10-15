"""Read-only native E2E evidence; never owns ticks or starts/retries a drive."""
import argparse
import hashlib
import json
from pathlib import Path
import time
from scripts.final_runtime import state


def compact(s):
    stop=s.get('stopDiagnostics') or {}
    return {'wall_s':time.time(), 'connected':s.get('connected'), 'mode':s.get('mode'),
        'presentation':s.get('presentation'), 'journey':s.get('journey'),
        'vehicle':{k:(s.get('vehicle') or {}).get(k) for k in ('frame','timestamp','speedKmh','brake')},
        'stop':{k:stop.get(k) for k in ('reason','decision_source','stopped_for_s','sensor_wall_age_s','control_timing_ms')},
        'comparison':{'pair_id':(s.get('journeyComparison') or {}).get('pair_id'),
            'conditions_match':(s.get('journeyComparison') or {}).get('conditions_match'),
            'runs':{m:{k:r.get(k) for k in ('id','status','reason','recording','duration_s','distance_m','collisions',
                'near_misses','harsh_braking_events','safety_interventions','mean_speed_kmh','maximum_speed_kmh','initial_condition_audit')}
                for m,r in (s.get('journeyComparison') or {}).get('runs',{}).items()}}}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--seconds',type=float,default=600)
    parser.add_argument('--output',default='output/presentation-native-observation.json')
    args=parser.parse_args();target=Path(args.output);target.parent.mkdir(parents=True,exist_ok=True)
    roots=[Path('backend'),Path('frontend')]
    files=[Path('index.html')]+[p for root in roots for p in root.rglob('*') if p.suffix in ('.py','.js','.css')]
    hashes={p.as_posix():hashlib.sha256(p.read_bytes()).hexdigest() for p in files}
    rows=[];prior=None;deadline=time.monotonic()+args.seconds
    while time.monotonic()<deadline:
        row=compact(state() or {});rows.append(row)
        p=row['presentation'] or {};key=(p.get('status'),p.get('arm'))
        if key!=prior:print(json.dumps(row),flush=True);prior=key
        terminal=p.get('status') in ('COMPLETE','ERROR','CANCELLED')
        report={'source':'LIVE_NATIVE_CARLA_HTTP_OBSERVATION','source_sha256':hashes,'samples':rows,
            'complete':p.get('status')=='COMPLETE','timed_out':not terminal and time.monotonic()>=deadline}
        temporary=target.with_suffix('.tmp');temporary.write_text(json.dumps(report,indent=2),encoding='utf8');temporary.replace(target)
        if terminal:return
        time.sleep(2)
    report['timed_out']=True
    temporary=target.with_suffix('.tmp');temporary.write_text(json.dumps(report,indent=2),encoding='utf8');temporary.replace(target)


if __name__=='__main__':main()
