"""Offline quality audit of real recorded presentation arms; never drives CARLA."""
import argparse
import hashlib
import json
import math
from pathlib import Path
from backend.core.driving_quality import evaluate_quality


def rows(path):
    with path.open(encoding='utf8') as stream:
        for line in stream:
            if line.strip():yield json.loads(line)


def recorded_samples(root):
    """Keep every recorded frame, including missing decisions and held commands.

    This conservative audit includes startup/terminal holds. Only an independent
    stop audit may classify them; a DRIVER/VEHICLE_HOLD label is not an exemption.
    """
    safety_path=root/'telemetry/safety-v2.jsonl'
    safety={r['evaluation_frame']:r for r in rows(safety_path)} if safety_path.exists() else {}
    samples=[]
    for f in rows(root/'telemetry/frames.jsonl'):
        decision=safety.get(f['frame_id'],{})
        v=f['vehicle'];angular=v.get('angular_velocity_radps')
        samples.append({'frame_id':f['frame_id'],'timestamp_s':f['timestamp_s'],
            'journey':{'status':'RUNNING'},'speed_kmh':v['speed_mps']*3.6 if v.get('speed_mps') is not None else None,
            'longitudinal_acceleration_mps2':v.get('longitudinal_acceleration_mps2'),
            'yaw_rate_radps':angular[2] if angular and len(angular)==3 else None,'throttle':v.get('throttle'),
            'brake':v.get('brake'),'steering':v.get('steering'),'stop':decision,
            'maneuver':decision.get('behavior_decision')})
    return samples


def audit(pair):
    data=json.loads(Path(pair).read_text(encoding='utf8'));condition=data['manifest'].get('initial_conditions',{})
    pose=condition.get('ego',{}).get('pose');population={}
    if pose:
        origin=pose['location'];yaw=math.radians(pose['rotation'][1])
        for category,prefix in [('vehicles','vehicle.'),('pedestrians','walker.')]:
            actors=[a for a in condition['actors'] if a['blueprint'].startswith(prefix)]
            population[category]={'total':len(actors),'ahead':sum(
                (a['pose']['location'][0]-origin[0])*math.cos(yaw)+
                (a['pose']['location'][1]-origin[1])*math.sin(yaw)>0 for a in actors)}
    dense=bool(population and population['vehicles']['total']>=20 and population['vehicles']['ahead']>=10
        and population['pedestrians']['total']>=30 and population['pedestrians']['ahead']>=15)
    result={'pair_id':data['pair_id'],'seed':data['manifest']['population']['seed'],
        'population':population,'ahead_definition':'Positive longitudinal coordinate at frozen initial ego pose; all owned fixture actors',
        'dense_setup_valid':dense,'arms':{},'accepted':False}
    for mode,run in data['runs'].items():
        root=Path(run['recording']);samples=recorded_samples(root)
        quality=evaluate_quality(samples,arrived=run['status']=='ARRIVED',contacts=run['collisions'])
        quality['evidence_note']='Every recorded frame is included, including startup/terminal holds and frames without decisions. Stops require independent review; no logged reason automatically authorizes a stop. Browser performance is audited separately.'
        video_path=root/'video-status.json';video=json.loads(video_path.read_text()) if video_path.exists() else {'status':'MISSING'}
        if (root/'driving.mp4').exists():
            with (root/'driving.mp4').open('rb') as stream:video['verified_sha256']=hashlib.file_digest(stream,'sha256').hexdigest()
            video['checksum_matches']=video.get('sha256')==video['verified_sha256']
        result['arms'][mode]={'run':{k:run.get(k) for k in ('status','reason','recording','duration_s','distance_m','maximum_speed_kmh','collisions')},
            'samples':len(samples),'quality':quality,'video':video,
            'recording_status':json.loads((root/'recording-status.json').read_text())}
    return result


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('pair');parser.add_argument('--output',required=True)
    args=parser.parse_args();value=audit(args.pair)
    Path(args.output).write_text(json.dumps(value,indent=2),encoding='utf8')
    print(json.dumps({'pair_id':value['pair_id'],'dense_setup_valid':value['dense_setup_valid'],
        'arms':{m:{'gates':a['quality']['gates'],'run':a['run']} for m,a in value['arms'].items()}}))
