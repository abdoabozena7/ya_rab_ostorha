"""Audit native matrix records without rewriting original outcomes or gates."""
import argparse
import hashlib
import json
import math
from pathlib import Path
from backend.core.driver_profiles import driver_profile

ROOT=Path(__file__).resolve().parents[1]


def assessment(path):
    path=Path(path).resolve();report=json.loads(path.read_text(encoding='utf8'))
    mode=report['mode'];samples=report.get('samples',[])
    active=[sample for sample in samples if sample.get('journey',{}).get('status')=='RUNNING']
    approach=[sample for sample in active if sample.get('stop',{}).get('comfort_control',{}).get('constraint')=='MEASURED_APPROACH']
    braking=[sample for sample in active if sample.get('stop',{}).get('applied_command',{}).get('brake',0)>.01
             and sample.get('stop',{}).get('decision_source') in ('REACTIVE_SENSORS','RULE')]
    stopped=[sample for sample in active if sample.get('speed_kmh',math.inf)<.54 and sample.get('brake',0)>.01]
    run=report.get('recording',{}).get('runs',{}).get(mode,{})
    setup=run.get('setup',{});recording=Path(run['recording']) if run.get('recording') else None
    video=json.loads((recording/'video-status.json').read_text(encoding='utf8')) if recording and (recording/'video-status.json').exists() else {}
    exposure=0
    for sample in active:
        for actor in (sample.get('independent_reference') or {}).get('actors',[]):
            position=actor.get('relative_position_m',[]);velocity=actor.get('velocity_mps',[])
            if (actor.get('category')=='WALKER' and len(position)==3 and len(velocity)==3
                    and math.hypot(*velocity[:2])>.3 and 2.4<position[0]<20 and abs(position[1])<3):
                exposure+=1
    contact_count=len(report.get('contacts',[]))
    normal_stop=(mode=='NORMAL' and report['scenario']=='FRONT_OBSTACLE' and contact_count==0
                 and report.get('native_planar_distance_m',0)>2 and bool(stopped) and bool(approach or braking))
    status=video.get('variants',{}).get('annotated',{})
    return {'id':report['id'],'scenario':report['scenario'],'seed':report['seed'],'mode':mode,
            'native_report':str(path.relative_to(ROOT)).replace('\\','/'),
            'native_report_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
            'source_archive_sha256':report.get('source_archive',{}).get('sha256'),
            'source_unchanged_during_trial':report.get('source_unchanged'),
            'contacts':contact_count,'arrived':report.get('journey',{}).get('status')=='ARRIVED',
            'scenario_valid':report.get('scenario_validity',{}).get('valid'),
            'native_cleanup_confirmed':report.get('native_cleanup_confirmed'),
            'distance_m':report.get('native_planar_distance_m'),'maximum_speed_kmh':report.get('maximum_speed_kmh'),
            'reactive_approach_frames':len(approach),'direct_sensor_brake_frames':len(braking),
            'stopped_running_frames':len(stopped),'normal_front_stop_observed':normal_stop,
            'pedestrian_crossing_exposure_frames':exposure,
            'profile_matches_runtime_contract':run.get('driver_profile')==driver_profile(mode),
            'recording':str(recording) if recording else None,'video_status':video.get('status'),
            'raw_sha256':video.get('sha256'),'annotated_sha256':status.get('sha256'),
            'overlay':status.get('overlay'),'physical_configuration':setup.get('vehicle_physics'),
            'sensor_configuration':setup.get('sensor_configuration'),'error':report.get('error')}


def summarize(matrix_path):
    matrix_path=Path(matrix_path);matrix=json.loads(matrix_path.read_text(encoding='utf8'))
    cases=[{**assessment(case['native_report']),'original_gate_passed':case['passed']} for case in matrix['cases']]
    for pair in matrix.get('pairs',[]):
        arms=[case for case in cases if case['seed']==pair['seed'] and case['scenario']==pair['scenario']]
        pair['physical_and_sensor_configuration_match']=len(arms)==2 and all(
            arms[0].get(key) is not None and arms[0][key]==arms[1][key] for key in ('physical_configuration','sensor_configuration'))
    for case in cases:
        case.pop('physical_configuration',None);case.pop('sensor_configuration',None)
    front=[case for case in cases if case['mode']=='NORMAL' and case['scenario']=='FRONT_OBSTACLE']
    return {'source':'RETAINED_NATIVE_SENSOR_COMPARISON','matrix':str(matrix_path),
            'matrix_sha256':hashlib.sha256(matrix_path.read_bytes()).hexdigest(),
            'original_matrix_accepted':matrix.get('accepted'),'trials':len(cases),
            'contacts':sum(case['contacts'] for case in cases),'arrivals':sum(case['arrived'] for case in cases),
            'normal_front_stop_cases':sum(case['normal_front_stop_observed'] for case in front),
            'required_normal_front_stop_cases':3,'general_driving_accepted':False,
            'limits':['Original pass/fail gates are retained. A reactive range approach may brake through NAVIGATION without an extra safety override.',
                      'A physical crossing is not a verified ego challenge when crossing-exposure frames are zero.',
                      'Incomplete arrivals, unmatched starts and timing/comfort failures do not establish predictive superiority.',
                      'The 30 km/h request does not qualify operation at 80 km/h. RL remains inactive.'],
            'cases':cases,'pairs':matrix.get('pairs',[]),'runtime_returned_to_stopped':matrix.get('runtime_returned_to_stopped')}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('matrix',type=Path);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args();report=summarize(args.matrix)
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,indent=2,allow_nan=False)+'\n',encoding='utf8')
    print(json.dumps({key:value for key,value in report.items() if key not in ('cases','pairs','limits')},indent=2))


if __name__=='__main__':main()
