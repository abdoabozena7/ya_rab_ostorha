"""Focused production MANUAL/BasicAgent safety checks. Observer client never ticks.

Controlled actors use the existing scenario manager. Resume schedules verify
release after a hazard clears; these are diagnostic conditions, not new families.
All driving requests go through the production WebSocket command interface.
"""
from dataclasses import replace
import json
import math
from pathlib import Path
import time
from types import SimpleNamespace
from collections import Counter
from backend.carla.scenarios import demonstration
from backend.core.scenarios import ActorControlSegment
from backend.core.contracts import to_dict
from backend.core.replay import ReplayReader
from .verify_urban_world import Session

DEST = Path('output/native-validation/active-safety')


def check(s, kind, mode, seed, deadline):
    import carla
    observer = SimpleNamespace(world=SimpleNamespace(world=s.world), connection=SimpleNamespace(api=carla))
    spec = demonstration(observer, kind, seed, 'VALIDATION')
    actor = spec.other_actor_definitions[0]
    # Actual physical actor resumes after stopping; the safety layer receives
    # only sensor data, never this schedule, its actor pose or future events.
    actor = replace(actor, control_schedule=actor.control_schedule + (ActorControlSegment(7., throttle=.45),))
    spec = replace(spec, other_actor_definitions=(actor,), timeout=14.)
    s.action('scenario', {'operation':'load', 'spec':to_dict(spec)})
    s.wait(lambda st:st['environment']['scenario_phase']=='READY')
    assert s.inventory()==dict(vehicles=2,walkers=0,controllers=0,sensors=7)
    if mode=='AUTOMATIC':
        ego=s.world.get_actor(s.state['vehicle']['actorId'])
        wp=s.world.get_map().get_waypoint(ego.get_location())
        # Native road graph is base-driver navigation data only.
        target=wp.next(45.)[0].transform.location
        s.action('destination',{'location':[target.x,target.y,target.z],'name':'YA RAB OSTORHA verification'})
    record=s.action('recording',{'enabled':True})
    s.action('scenario',{'operation':'start'})
    if mode=='MANUAL': s.send('start_driving')
    else: s.send('start_journey', speed_kmh=28)
    initial_count=s.state['safetySystem']['intervention_count']; start=s.state['vehicle']['timestamp']
    rows=[]; seen=set(); previous=None; edges=[]
    while s.state['vehicle']['timestamp']-start<11.5:
        if time.monotonic()>=deadline: raise TimeoutError('Native ten-minute budget reached')
        if s.state['mode']=='PAUSED' and s.state['journey']['status']!='STARTING':
            raise RuntimeError('Driving paused unexpectedly: '+json.dumps(s.state['safetySystem']))
        if mode=='MANUAL':
            s.send('controls', frame_id=s.state['vehicle']['frame'], timestamp_s=s.state['vehicle']['timestamp'],
                controls={'throttle':.45,'brake':0.,'steering':0.,'parkingbrake':0,'gear':1})
        else: s.send('journey_heartbeat',session_id=s.state['sessionId'])
        st=s.state
        if st['vehicle']['frame'] in seen: continue
        seen.add(st['vehicle']['frame'])
        saf=st['safetySystem']; active=saf['active']
        if active!=previous:
            edges.append({'elapsed_s':st['vehicle']['timestamp']-start,'active':active,'reason':saf['reason']})
            previous=active
        row={'frame':st['vehicle']['frame'],'time_s':st['vehicle']['timestamp'],
            'speed_mps':st['vehicle']['speedMagnitudeMps'],'position':st['vehicle']['positionWorldM'],
            'mode':st['mode'],'source':st['controlSource'],'safety':saf,
            'command':st['canonical']['control'],'applied':{k:st['canonical']['vehicle'][k] for k in ('throttle','brake','steering')},
            'collisions':st['collisionEvents'],'frame_complete':st['frameComplete'],
            'sensor_errors':st['sensorErrors'],'step_ms':st['backendStepMs']}
        rows.append(row)
        if st['environment']['scenario_phase']=='FINISHED': break
    s.send('stop_driving'); s.wait(lambda st:st['vehicle']['speedKmh']<.3)
    outcome=s.action('scenario',{'operation':'stop'})
    recording=s.action('recording',{'enabled':False})
    reader=ReplayReader(recording['path']); frames=list(reader.frames())
    applied=[f for f in frames if f.control and f.control.source.value=='SAFETY' and f.control.gear==1 and f.control.throttle==0]
    mismatches=[f.frame_id for f in applied if max(abs(getattr(f.control,k)-getattr(f.vehicle,k)) for k in ('throttle','brake','steering'))>1e-5]
    metrics=outcome['outcome']['metrics']; passed=(not metrics['collision_count'] and metrics['progress_m']>=spec.success_conditions['min_progress_m']
        and not mismatches and any(r['safety']['active'] for r in rows)
        and any(not r['safety']['active'] and r['speed_mps']>1. for r in rows if r['time_s']-start>7.))
    summary={'kind':kind,'mode':mode,'seed':seed,'condition':to_dict(spec),'outcome':outcome,
        'recording':recording['path'],'applied_safety_frames':len(applied),'application_mismatch_frames':mismatches,
        'interventions':s.state['safetySystem']['intervention_count']-initial_count,'edges':edges,
        'maximum_speed_mps':max(r['speed_mps'] for r in rows),'pass':passed,
        'frame_complete':all(r['frame_complete'] for r in rows),'sensor_errors':any(r['sensor_errors'] for r in rows)}
    (DEST/f'{mode}_{kind}.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows))
    s.action('scenario',{'operation':'cleanup'})
    assert s.inventory()==dict(vehicles=1,walkers=0,controllers=0,sensors=7)
    summary['cleanup_verified']=True
    print(json.dumps({k:summary[k] for k in ('kind','mode','seed','applied_safety_frames','application_mismatch_frames','interventions','maximum_speed_mps','pass')} | {'metrics':metrics,'edges':edges}),flush=True)
    return summary


def clear_road(s,deadline):
    s.send('start_driving'); start=s.state['vehicle']['timestamp']; position=s.state['vehicle']['positionWorldM']
    initial=s.state['safetySystem']['intervention_count']; rows=[]
    while s.state['vehicle']['timestamp']-start<3.:
        if time.monotonic()>=deadline:raise TimeoutError('Native budget')
        s.send('controls', frame_id=s.state['vehicle']['frame'], timestamp_s=s.state['vehicle']['timestamp'],
            controls={'throttle':.35,'brake':0.,'steering':0.,'parkingbrake':0,'gear':1})
        rows.append({'time':s.state['vehicle']['timestamp'],'speed':s.state['vehicle']['speedMagnitudeMps'],
            'source':s.state['controlSource'],'safety':s.state['safetySystem']})
    s.send('stop_driving');s.wait(lambda st:st['vehicle']['speedKmh']<.3)
    added=s.state['safetySystem']['intervention_count']-initial
    result={'maximum_speed_mps':max(r['speed'] for r in rows),'distance_m':math.dist(position,s.state['vehicle']['positionWorldM']),
        'interventions':added,'pass':added==0 and max(r['speed'] for r in rows)>1.}
    (DEST/'clear-road.jsonl').write_text(''.join(json.dumps(r)+'\n' for r in rows))
    s.send('safety_mode',value={'enabled':False});assert not s.state['safetySystem']['enabled']
    s.send('safety_mode',value={'enabled':True});assert s.state['safetySystem']['enabled']
    result['comparison_switch_verified']=True
    return result


def main():
    DEST.mkdir(parents=True,exist_ok=True)
    budget=json.loads(Path('output/native-validation/active-safety-budget.json').read_text())
    if budget.get('final_check_started_epoch'):
        remaining=600-budget['consumed_before_final_check_s']-(time.time()-budget['final_check_started_epoch'])
    else: remaining=600-(time.time()-budget['began_epoch'])
    if remaining<65:raise TimeoutError('Insufficient native budget for checks and restoration')
    began=time.monotonic();deadline=began+min(480,remaining-25)
    result={'source':'LIVE_NATIVE_PRODUCTION_WEBSOCKET','checks':[]}
    try:
        with Session() as s:
            result['initial_inventory']=s.inventory()
            result['versions']=[s.client.get_server_version(),s.client.get_client_version()]
            result['initial_sync']=s.state['synchronization']
            for kind,mode,seed in [('SUDDEN_BRAKING','MANUAL',1781),('FRONT_OBSTACLE','AUTOMATIC',1782)]:
                row=check(s,kind,mode,seed,deadline);result['checks'].append(row)
                (DEST/'results.json').write_text(json.dumps(result,indent=2))
            result['clear_road']=clear_road(s,deadline)
            result['final_inventory']=s.inventory();result['final_sync']=s.state['synchronization']
            result['final_sensors']=s.state['sensorRegistry']; result['rl_runtime']=s.state['rlRuntime']
            result['pass']=all(r['pass'] for r in result['checks']) and result['clear_road']['pass']
    except Exception as error:
        result['error']=repr(error);result['pass']=False
        raise
    finally:
        result['wall_s']=time.monotonic()-began
        (DEST/'results.json').write_text(json.dumps(result,indent=2))
        print(json.dumps({'pass':result.get('pass'),'wall_s':result['wall_s'],'error':result.get('error')}),flush=True)


if __name__=='__main__':main()
