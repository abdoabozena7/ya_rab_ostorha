"""Post-drive user-plan review, separate from the stricter first-motion audit.

The user asks for prediction before a pedestrian enters the vehicle's path.
First native foot motion is retained as an additional, stricter diagnostic.
Neither this evaluator nor native poses are imported by the driving policy.
Historical native reports and their original acceptance fields are never edited.
"""
import math

POLICY='PREDICTIVE_BRAKING_BEFORE_CRITICAL_PATH_INGRESS_V1'


def prediction_before_ingress(report):
    pair=report.get('pair') or {};runs=pair.get('runs') or {};project=runs.get('ROBOSPHERE') or {}
    manifest=pair.get('manifest') or {};origin=manifest.get('origin') or {}
    location=origin.get('location');angles=origin.get('rotation')
    native=project.get('scenario_evidence') or {};epoch=native.get('clock_epoch_s')
    normal_epoch=runs.get('NORMAL',{}).get('scenario_evidence',{}).get('clock_epoch_s')
    contacts=[c['timestamp_s']-normal_epoch
        for c in runs.get('NORMAL',{}).get('collision_events',[])
        if normal_epoch is not None and c.get('role')=='critical_pedestrian' and str(c.get('type','')).startswith('walker.')]
    result={'policy':POLICY,'source':'POST_DRIVE_NATIVE_ASSOCIATION_ONLY',
        'corridor_half_width_m':2.,'minimum_lead_s':.5,'first_native_motion_elapsed_s':
            native.get('events',{}).get('critical_pedestrian',{}).get('first_motion_elapsed_s'),
        'first_path_ingress_elapsed_s':None,'first_forecast':None,'passed':False}
    if not location or not angles or epoch is None or not contacts:return result
    heading=math.radians(angles[1]);co,si=math.cos(heading),math.sin(heading)
    samples=[s for s in report.get('samples',[]) if s.get('mode')=='ROBOSPHERE']
    first_ingress=None;forecasts=[]
    for sample in samples:
        scene=sample.get('scenario') or {};target=(scene.get('events') or {}).get('critical_pedestrian',{}).get('position_m')
        if not target:continue
        elapsed=sample['timestamp_s']-epoch
        lateral=-(target[0]-location[0])*si+(target[1]-location[1])*co
        if abs(lateral)<=2. and first_ingress is None:first_ingress=elapsed
        stop=sample.get('stop') or {};safety=stop.get('safety') or {};forecast=safety.get('pedestrian_prediction') or {}
        command=stop.get('applied_command') or {};points=forecast.get('trajectory') or []
        if (abs(lateral)<=2. or forecast.get('source') not in ('PEDESTRIAN_POSSIBLE_START','PEDESTRIAN_POSSIBLE_RUN')
                or command.get('source')!='SAFETY' or command.get('brake',0)<.5 or sample.get('speed_kmh',0)<20.
                or stop.get('reason')!='Braking for a person who may cross the driving path'
                or safety.get('reactive_risk')!='FORWARD_CLEAR_SIDE_REAR_UNVERIFIED'
                or forecast.get('measurement_frame')!=stop.get('evaluation_frame') or not points
                or 'yaw_rad' not in sample):continue
        _,x,y=points[0];yaw=sample['yaw_rad'];ox,oy=sample['position_m'][:2]
        error=math.dist((ox+math.cos(yaw)*x-math.sin(yaw)*y,oy+math.sin(yaw)*x+math.cos(yaw)*y),target[:2])
        if error<=1.2:forecasts.append({'elapsed_s':elapsed,'speed_kmh':sample['speed_kmh'],'source':forecast['source'],
            'native_association_error_m':error,'native_lateral_m':lateral,'reactive_risk':safety['reactive_risk']})
    first=min(forecasts,key=lambda f:f['elapsed_s'],default=None)
    ingress_lead=first_ingress-first['elapsed_s'] if first and first_ingress is not None else None
    contact_lead=min(contacts)-first['elapsed_s'] if first else None
    result.update(first_path_ingress_elapsed_s=first_ingress,first_forecast=first,
        path_ingress_lead_s=ingress_lead,normal_contact_lead_s=contact_lead,
        passed=bool(ingress_lead is not None and ingress_lead>=.5-1e-6 and contact_lead>=.5-1e-6))
    return result


def evaluate_user_plan(report):
    from backend.core.crossing_result import evaluate_pair
    prediction=prediction_before_ingress(report);scenario=evaluate_pair(report.get('pair') or {}) or {}
    gates={'actual_scenario_outcomes':scenario.get('passed') is True,
        'predictive_braking_before_ingress':prediction['passed'],
        'complete_recordings':report.get('completed_without_shortening') is True,
        'finish_waited_for_exports':report.get('finish_completed') is True,
        'cleanup_confirmed':report.get('cleanup_confirmed') is True,
        'independent_cleanup':(report.get('independent_cleanup_probe') or {}).get('passed') is True,
        'engine_exited':report.get('simulator_exit_confirmed') is True,
        'three_videos_after_exit':(report.get('video_playback_after_exit') or {}).get('passed') is True,
        'source_unchanged':report.get('source_unchanged') is True}
    return {'policy':POLICY,'passed':all(gates.values()),'gates':gates,'prediction':prediction,
        'original_strict_first_motion_acceptance':report.get('native_acceptance',False),
        'original_strict_first_motion_evidence':report.get('critical_prediction_evidence')}


def source_compatible_with_matrix(report,matrix,folder):
    """Verify exact controls and the selected fixture, including checked reuse.

    An edit to another unvalidated candidate is not a change to this case.
    Keep the exact-file match separately; never equate changed driving code,
    the selected fixture or common city/version settings with tested bytes.
    """
    import hashlib,json,zipfile
    from pathlib import Path
    try:
        archive=report['source_archive'];path=Path(archive['path'])
        if hashlib.sha256(path.read_bytes()).hexdigest()!=archive['sha256']:return False
        if report.get('source_hashes')==matrix['source_hashes']:return True
        if matrix.get('scenario_catalogue_file')!='scenario-catalogue.json':return False
        raw=(Path(folder)/'scenario-catalogue.json').read_bytes()
        expected=next(v for k,v in matrix['source_hashes'].items() if k.replace('\\','/')=='config/crossing-comparison.json')
        if hashlib.sha256(raw).hexdigest()!=expected:return False
        with zipfile.ZipFile(path) as sources:old=json.loads(sources.read('config/crossing-comparison.json'))
        from scripts.native.validate_crossing_matrix import same_case_sources
        return same_case_sources(report,matrix['source_hashes'],old,json.loads(raw))
    except (OSError,ValueError,KeyError,StopIteration,zipfile.BadZipFile):return False


def main():
    import argparse
    import hashlib
    import json
    from pathlib import Path
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--matrix',required=True);parser.add_argument('--output',required=True)
    args=parser.parse_args();path=Path(args.matrix);matrix=json.loads(path.read_text(encoding='utf8'));cases=[]
    for case in matrix['cases']:
        native=Path(case['report_path']);raw=native.read_bytes();report=json.loads(raw)
        reviewed=evaluate_user_plan(report)
        reviewed.update(attempt=native.parent.name,report_sha256=hashlib.sha256(raw).hexdigest(),
            seed=report['seed'],first_mode=report['first_mode'],source_archive=report.get('source_archive'),
            source_matches_matrix=report.get('source_hashes')==matrix['source_hashes'],
            source_compatible_with_matrix=source_compatible_with_matrix(report,matrix,path.parent),
            runs={mode:{k:run.get(k) for k in ('status','reason','collisions','duration_s','distance_m',
                'actual_max_speed_kmh','longest_observed_standstill_s','standstill_reason_samples')}
                for mode,run in case['runs'].items()},shared_perception=case.get('shared_perception'))
        cases.append(reviewed)
    expected={(seed,mode) for seed in (1701,1702,1703) for mode in ('NORMAL','ROBOSPHERE')}
    complete=len(cases)==6 and {(c['seed'],c['first_mode']) for c in cases}==expected
    value={'scope':'POST_DRIVE_USER_PLAN_REVIEW_ORIGINAL_FIRST_MOTION_REPORTS_UNCHANGED',
        'policy':POLICY,'evaluator_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        'matrix':str(path),'matrix_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
        'matrix_selected_policy':matrix.get('acceptance_policy','STRICT_BEFORE_FIRST_NATIVE_MOTION'),
        'original_strict_matrix_passed':complete and all(c['original_strict_first_motion_acceptance'] for c in cases),
        'complete_six_cases':complete,
        'passed':complete and all(c['passed'] and c['source_compatible_with_matrix'] for c in cases),'cases':cases}
    target=Path(args.output);target.parent.mkdir(parents=True,exist_ok=True)
    target.write_text(json.dumps(value,indent=2),encoding='utf8')
    print(json.dumps({'output':str(target),'complete_six_cases':complete,'user_plan_passed':value['passed'],
        'reviewed':len(cases),'accepted':sum(c['passed'] for c in cases)}))


if __name__=='__main__':main()
