"""Read-only stop review using recorded native evidence, never control inputs."""
import argparse
from collections import Counter
import json
import math
from pathlib import Path
import numpy as np
from scripts.audit_reliable_driving import recorded_samples


def obstruction_evidence(oracle,vehicle,geometry):
    half_width=geometry['half_width_m'];front=geometry['front_m']
    yaw=vehicle['transform']['rotation_rad']['yaw'];found=[]
    for actor in oracle.get('actors',[]):
        bounds=actor.get('bounding_box');relative=actor.get('relative_position_m')
        if not bounds or not relative or actor.get('category') not in ('VEHICLE','WALKER'):continue
        angle=math.radians(actor['yaw_deg'])-yaw
        co,si=math.cos(angle),math.sin(angle);extent=bounds['extent_m'];offset=bounds['offset_m']
        corners=[(relative[0]+co*(offset[0]+sign_x*extent[0])-si*(offset[1]+sign_y*extent[1]),
            relative[1]+si*(offset[0]+sign_x*extent[0])+co*(offset[1]+sign_y*extent[1]))
            for sign_x in (-1,1) for sign_y in (-1,1)]
        forward=[point[0] for point in corners];lateral=[point[1] for point in corners]
        if (max(forward)>front and min(lateral)<half_width+.2 and max(lateral)>-half_width-.2
                and max(forward)<front+20. and abs(relative[2])<3.):
            found.append({'actor_id':actor['actor_id'],'type':actor['type'],
                'bumper_gap_m':max(0.,min(forward)-front),'relative_position_m':relative,
                'source':'RECORDED_NATIVE_BOUNDS_AND_SNAPSHOT_POSES'})
    return sorted(found,key=lambda item:item['bumper_gap_m'])


def audit(recording):
    root=Path(recording);samples=recorded_samples(root)
    oracles={}
    with (root/'telemetry/comparison-controls.jsonl').open(encoding='utf8') as stream:
        for wire in map(json.loads,stream):
            if wire.get('kind')=='NATIVE_VALIDATION_ORACLE':oracles[wire['evaluation_frame']]=wire['oracle']
    frames={}
    with (root/'telemetry/frames.jsonl').open(encoding='utf8') as stream:
        for frame in map(json.loads,stream):
            frames[frame['frame_id']]={'vehicle':frame['vehicle'],'camera':next((channel['asset']
                for channel in frame['sensors'] if channel['sensor_id']=='frontCamera'),None)}
    segments=[];start=None
    for index,sample in enumerate(samples):
        stopped=sample['speed_kmh']<.72
        if stopped and start is None:start=index
        if start is None or stopped and index<len(samples)-1:continue
        end=index if stopped else index-1;duration=samples[end]['timestamp_s']-samples[start]['timestamp_s']
        if duration>=.5:
            rows=[];counts=Counter()
            for item in samples[start:end+1]:
                frame=item['frame_id'];oracle=oracles.get(frame);native=frames[frame]
                diagnostic=item.get('stop') or {};geometry=diagnostic.get('vehicle_geometry')
                exact=bool(oracle and oracle.get('frame_id')==frame and
                    abs(oracle.get('timestamp_s',-1)-item['timestamp_s'])<=1e-6)
                obstacles=obstruction_evidence(oracle,native['vehicle'],geometry) if exact and geometry else []
                light=oracle.get('traffic_light',{}) if exact else {}
                signal=bool(light.get('relevant') and light.get('state','').split('.')[-1]=='Red')
                label='NATIVE_OBSTRUCTION_PRESENT' if obstacles else 'NATIVE_RELEVANT_RED' if signal else 'UNRESOLVED'
                counts[label]+=1
                rows.append({'frame':frame,'timestamp_s':item['timestamp_s'],'source':label,
                    'obstacles':obstacles[:3],'traffic_light':light,'logged_reason':diagnostic.get('reason'),
                    'brake':item['brake'],'sensor_fresh':diagnostic.get('application_timing',{}).get('fresh_aligned'),
                    'camera':native['camera']})
            middle=rows[len(rows)//2];gaps=[row['obstacles'][0]['bumper_gap_m'] for row in rows if row['obstacles']]
            segments.append({'start_frame':rows[0]['frame'],'end_frame':rows[-1]['frame'],'duration_s':duration,
                'frames':len(rows),'independent_presence_counts':dict(counts),
                'nearest_native_bumper_gap_m':{'minimum':min(gaps),'median':float(np.median(gaps)),'maximum':max(gaps)} if gaps else None,
                'representative':middle,'independently_verified_necessary_for_whole_stop':False,
                'qualification':'Native presence is independent of detector/controller; presence alone does not prove stop necessity, safe gap or release timing.'})
        start=None
    return {'source':'OFFLINE_NATIVE_ORACLE_REVIEW','recording':str(root),'oracle_frames':len(oracles),
        'segments':segments,'accepted':False,
        'qualification':'Straight forward-body bounds screen, not a swept-route feasibility proof; no quality gates waived.'}


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('recording');parser.add_argument('--output',required=True)
    args=parser.parse_args();result=audit(args.recording)
    Path(args.output).write_text(json.dumps(result,indent=2),encoding='utf8')
    print(json.dumps({'oracle_frames':result['oracle_frames'],'segments':len(result['segments']),'accepted':False}))
