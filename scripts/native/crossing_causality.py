"""Evaluation-only association of a measured forecast to the native test walker.

No values from this module enter planning, perception or command arbitration.
"""
import math


def critical_prediction_evidence(report):
    runs=report.get('pair',{}).get('runs',{});project=runs.get('ROBOSPHERE',{});normal=runs.get('NORMAL',{})
    native=project.get('scenario_evidence',{});motion=native.get('events',{}).get('critical_pedestrian',{}).get('first_motion_elapsed_s')
    matches=[]
    for sample in report.get('samples',[]):
        if sample.get('mode')!='ROBOSPHERE' or 'yaw_rad' not in sample:continue
        stop=sample.get('stop') or {};safety=stop.get('safety') or {};forecast=safety.get('pedestrian_prediction') or {}
        command=stop.get('applied_command') or {}
        if (forecast.get('source') not in ('PEDESTRIAN_POSSIBLE_START','PEDESTRIAN_POSSIBLE_RUN')
                or command.get('source')!='SAFETY' or command.get('brake',0)<.5):continue
        scene=sample.get('scenario') or {};target=scene.get('events',{}).get('critical_pedestrian',{}).get('position_m')
        points=forecast.get('trajectory') or [];epoch=scene.get('clock_epoch_s')
        if not target or not points or epoch is None:continue
        _,x,y=points[0];yaw=sample['yaw_rad'];ox,oy=sample['position_m'][:2]
        world=(ox+math.cos(yaw)*x-math.sin(yaw)*y,oy+math.sin(yaw)*x+math.cos(yaw)*y)
        error=math.dist(world,target[:2])
        if error>1.2:continue
        matches.append({'elapsed_s':sample['timestamp_s']-epoch,'speed_kmh':sample['speed_kmh'],
            'source':forecast['source'],'applied_brake':command['brake'],'native_association_error_m':error})
    first=min(matches,key=lambda row:row['elapsed_s'],default=None)
    early=bool(first and motion is not None and first['elapsed_s']<motion-1e-6)
    fast=bool(first and first['speed_kmh']>=20.)
    epoch=normal.get('scenario_evidence',{}).get('clock_epoch_s')
    contacts=[c['timestamp_s']-epoch for c in normal.get('collision_events',[]) if c.get('role')=='critical_pedestrian' and epoch is not None]
    return {'source':'POST_DRIVE_NATIVE_ASSOCIATION_NOT_A_POLICY_INPUT','first_critical_braking_forecast':first,
        'native_first_motion_elapsed_s':motion,'normal_critical_contact_elapsed_s':min(contacts,default=None),
        'predicted_before_actual_motion':early,'braked_from_at_least_20_kmh':fast,'passed':early and fast}
