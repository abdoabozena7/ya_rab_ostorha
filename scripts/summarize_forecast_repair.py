"""Compact retained native evidence; read-only, never starts a simulator."""
import argparse
import hashlib
import json
from pathlib import Path
from collections import Counter
from scripts.validate_rule_bypass import summarize,gates
from backend.core.route_bypass import source_fingerprint

ROOT=Path(__file__).resolve().parents[1]


def pedestrian_case(path):
    r=json.loads(path.read_text());samples=r.get('samples',[]);zero=samples[0]['timestamp_s'] if samples else 0.
    predicted=[s for s in samples if s.get('stop',{}).get('safety',{}).get('pedestrian_prediction')]
    first=predicted[0] if predicted else None
    moving=[s for s in samples if any(a['category']=='WALKER' and
        sum(v*v for v in a['velocity_mps'])>.04 for a in s['independent_reference']['actors'])]
    stopped=[s for s in samples if predicted and s['timestamp_s']>=predicted[0]['timestamp_s'] and s['speed_kmh']<.54]
    return {'id':r['id'],'scenario':r.get('scenario'),'source':r.get('source'),
        'ego_blueprint':r.get('fixture',{}).get('ego_initial',{}).get('blueprint'),
        'ego_geometry':r.get('fixture',{}).get('ego_geometry'),
        'current_control_source_matches':all(hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==digest
            for name,digest in r.get('source_hashes',{}).items() if name.replace('\\','/').startswith(
                ('backend/core/','backend/carla/','backend/computer_vision/'))),
        'raw_report':str(path.relative_to(ROOT)).replace('\\','/'),'raw_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
        'source_archive_sha256':r.get('source_archive',{}).get('sha256'),'source_unchanged':r.get('source_unchanged'),
        'semantic_source':r.get('semantic_source'),'journey':r.get('journey'),'contacts':len(r.get('contacts',[])),
        'contact_types':[c.get('other_actor_type') for c in r.get('contacts',[])],
        'distance_m':r.get('native_planar_distance_m'),'maximum_speed_kmh':r.get('maximum_speed_kmh'),
        'maximum_unexplained_stop_s':r.get('maximum_unexplained_stop_s'),
        'first_forecast_elapsed_s':first['timestamp_s']-zero if first else None,
        'first_forecast_source':first['stop']['safety']['pedestrian_prediction']['source'] if first else None,
        'first_forecast_speed_kmh':first['speed_kmh'] if first else None,
        'first_forecast_measured_position_m':first['stop']['safety']['pedestrian_prediction']['trajectory'][0][1:] if first else None,
        'first_forecast_independent_person':first['independent_reference']['actors'] if first else None,
        'first_physical_crossing_elapsed_s':moving[0]['timestamp_s']-zero if moving else None,
        'first_stopped_elapsed_s':stopped[0]['timestamp_s']-zero if stopped else None,
        'maneuvers':dict(Counter(s.get('maneuver',{}).get('action','UNAVAILABLE') for s in samples)),
        'scenario_validity':r.get('scenario_validity'),'native_cleanup_confirmed':r.get('native_cleanup_confirmed'),
        'restored':r.get('restored'),'driving_quality_accepted':r.get('driving_quality',{}).get('accepted'),
        'driving_quality_gates':r.get('driving_quality',{}).get('gates'),
        'error':r.get('error'),'orchestration_error':r.get('orchestration_error')}


def main():
    p=argparse.ArgumentParser();p.add_argument('reports',nargs='+');p.add_argument('--out',required=True);args=p.parse_args()
    paths=[(ROOT/path).resolve() for path in args.reports]
    passing=[summarize(path) for path in paths if json.loads(path.read_text()).get('scenario','').startswith('RULE_BYPASS_')]
    people=[pedestrian_case(path) for path in paths if json.loads(path.read_text()).get('scenario')=='PEDESTRIAN']
    result={'scope':'Retained scoped native probes; failed attempts included; not full dense/high-speed driving acceptance',
        'current_source_fingerprint':source_fingerprint(),'passing_current_gates':gates(passing),
        'passing':passing,'pedestrian':people}
    Path(args.out).write_text(json.dumps(result,indent=2)+'\n',encoding='utf8')
    print(json.dumps({'passing_gates':result['passing_current_gates'],'cases':len(paths)},indent=2))


if __name__=='__main__':main()
