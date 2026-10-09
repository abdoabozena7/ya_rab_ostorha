"""Small frozen native comparison, service owns all physics ticks and commands.

Normal BasicAgent retains its own native hazard handling in ALL automatic arms.
TEST seeds are frozen before driving, not used for training/calibration. Read-only
world access below compiles scenario/navigation or evaluates actor cleanup only.
"""
import argparse
from collections import Counter
from dataclasses import replace
import hashlib
import json
import math
from pathlib import Path
import statistics
import subprocess
import time
import uuid
from types import SimpleNamespace
from backend.carla.scenarios import demonstration, canonical_transform
from backend.core.scenarios import ActorControlSegment
from backend.core.contracts import to_dict
from backend.core.replay import ReplayReader
from .verify_urban_world import Session
from .stability_run import backend_pid, memory

ROOT=Path(__file__).resolve().parents[2]
DEST=ROOT/'output/final-delivery/native'
EVIDENCE=ROOT/'docs/evidence/final_delivery'
CASES=[('SUDDEN_BRAKING',2473),('FRONT_OBSTACLE',2589)]


def compiled(s,kind,seed,split='TEST'):
    import carla
    observer=SimpleNamespace(world=SimpleNamespace(world=s.world),connection=SimpleNamespace(api=carla))
    spec=demonstration(observer,kind,seed,split); actor=spec.other_actor_definitions[0]
    # Changed conditions and physical resumption. No future schedule enters
    # the policy. Static obstacle completion still requires actual progress.
    wp=s.world.get_map().get_waypoint(carla.Location(*spec.other_actor_definitions[0].transform.position_m))
    transform=wp.previous(3.)[0].transform;transform.location.z+=.3
    schedule=(ActorControlSegment(0.,throttle=.25),ActorControlSegment(1.5,brake=.85),ActorControlSegment(7.,throttle=.45)) if kind=='SUDDEN_BRAKING' else (ActorControlSegment(0.,brake=1.),ActorControlSegment(7.,throttle=.45))
    actor=replace(actor,transform=canonical_transform(transform),initial_speed_mps=4. if kind=='SUDDEN_BRAKING' else 0.,control_schedule=schedule)
    return replace(spec,other_actor_definitions=(actor,),timeout=14.,metadata={**spec.metadata,'final_held_out':True,
        'base_agent_hazard_handling':'NORMAL_UNCHANGED','actor_resumption_diagnostic':True})


def check(s,spec,controller,mode,deadline,*,record_images=True):
    wall=time.monotonic();name=mode+'_'+spec.scenario_type.value+'_'+controller
    s.action('scenario',{'operation':'load','spec':to_dict(spec)});s.wait(lambda st:st['environment']['scenario_phase']=='READY')
    assert s.inventory()==dict(vehicles=2,walkers=0,controllers=0,sensors=7)
    s.wait(lambda st:st['vehicle']['speedMagnitudeMps']<=.15)
    s.send('safety_mode',value={'enabled':controller!='BASE','controller':'RULE' if controller=='BASE' else controller})
    if mode=='AUTOMATIC':
        ego=s.world.get_actor(s.state['vehicle']['actorId']);wp=s.world.get_map().get_waypoint(ego.get_location())
        target=wp.next(45.)[0].transform.location
        s.action('destination',{'location':[target.x,target.y,target.z],'name':'YA RAB OSTORHA final demonstration'})
    if record_images:s.action('recording',{'enabled':True})
    s.action('scenario',{'operation':'start'})
    if mode=='MANUAL':s.send('start_driving')
    else:s.send('start_journey',speed_kmh=28)
    before=s.state['safetySystem']['intervention_count'];source_before=s.state['safetySystem']['source_counts']
    start=s.state['vehicle']['timestamp'];rows=[];seen=set();edges=[];previous=None
    while s.state['vehicle']['timestamp']-start<11.5:
        if time.monotonic()>=deadline:raise TimeoutError('Final compact native budget reached')
        if s.state['environment']['scenario_phase']=='FINISHED':break
        if s.state['mode']=='PAUSED' and s.state['journey']['status']!='STARTING':
            raise RuntimeError('Unexpected paused driving: '+json.dumps(s.state['safetySystem']))
        if mode=='MANUAL':
            s.send('controls',frame_id=s.state['vehicle']['frame'],timestamp_s=s.state['vehicle']['timestamp'],
                controls={'throttle':.55,'brake':0.,'steering':0.,'parkingbrake':0,'gear':1})
        else:s.send('journey_heartbeat',session_id=s.state['sessionId'])
        st=s.state
        if st['vehicle']['frame'] in seen:continue
        seen.add(st['vehicle']['frame']);saf=st['safetySystem']
        if saf['active']!=previous:
            edges.append({'elapsed_s':st['vehicle']['timestamp']-start,'active':saf['active'],'generator':saf['actual_generator'],'reason':saf['reason']});previous=saf['active']
        rows.append({'frame':st['vehicle']['frame'],'time_s':st['vehicle']['timestamp'],'speed_mps':st['vehicle']['speedMagnitudeMps'],
            'mode':st['mode'],'source':st['controlSource'],'safety':saf,'command':st['canonical']['control'],
            'applied':{k:st['canonical']['vehicle'][k] for k in ('throttle','brake','steering')},
            'collisions':st['collisionEvents'],'complete':st['frameComplete'],'sensor_errors':st['sensorErrors'],
            'step_ms':st['backendStepMs']})
        if st['environment']['scenario_phase']=='FINISHED':break
    s.send('stop_driving');s.wait(lambda st:st['vehicle']['speedKmh']<.3)
    outcome=s.action('scenario',{'operation':'stop'});recording=s.action('recording',{'enabled':False}) if record_images else None
    applied=[];mismatches=[];frames=0
    if recording:
        reader=ReplayReader(recording['path'])
        for f in reader.frames():
            frames+=1
            if f.control and f.control.source.value=='SAFETY' and f.control.gear==1 and f.control.throttle==0:
                applied.append(f.frame_id)
                if max(abs(getattr(f.control,k)-getattr(f.vehicle,k)) for k in ('throttle','brake','steering'))>1e-5:mismatches.append(f.frame_id)
    else:
        frames=len(rows)
        for row in rows:
            c=row['command']
            if c and c['source']=='SAFETY' and c['gear']==1 and c['throttle']==0:
                applied.append(row['frame'])
                if max(abs(c[k]-row['applied'][k]) for k in ('throttle','brake','steering'))>1e-5:mismatches.append(row['frame'])
    metrics=outcome['outcome']['metrics'];counts=s.state['safetySystem']['source_counts']
    counts={k:counts[k]-source_before[k] for k in counts}
    latencies=[r['safety'].get('inference_ms',0.) for r in rows if r['safety'].get('inference_ms',0.)>0]
    summary={'case':name,'kind':spec.scenario_type.value,'mode':mode,'controller':controller,'seed':spec.random_seed,
        'condition_id':spec.condition_id,'metrics':metrics,'outcome':outcome['outcome']['reason'],
        'success':not metrics['collision_count'] and metrics['progress_m']>=spec.success_conditions['min_progress_m'],
        'interventions':s.state['safetySystem']['intervention_count']-before,'generator_frames':counts,
        'learned_decisions':dict(Counter(r['safety'].get('learned_decision') for r in rows)),
        'fallback_reasons':dict(Counter(r['safety'].get('fallback_reason') for r in rows)),
        'inference_median_ms':statistics.median(latencies) if latencies else None,
        'inference_max_ms':max(latencies,default=None),'backend_step_median_ms':statistics.median([r['step_ms'] for r in rows if r['step_ms'] is not None]),
        'recording':recording['path'] if recording else None,'evidence_type':'RECORDER_FRAMES_AND_ASSETS' if recording else 'LIVE_SYNCHRONIZED_SCALAR_TRACE_NO_DUPLICATE_IMAGES',
        'recorded_frames':frames,'applied_safety_frames':len(applied),'application_mismatches':mismatches,
        'all_observations_complete':all(r['complete'] for r in rows),'sensor_errors':any(r['sensor_errors'] for r in rows),
        'resumed_progress':any(r['speed_mps']>1 and not r['safety']['active'] for r in rows if r['time_s']-start>7.),
        'edges':edges,'wall_s':time.monotonic()-wall}
    trace=DEST/(name+'_'+str(spec.random_seed)+'_'+uuid.uuid4().hex[:8]+'.jsonl')
    trace.write_text(''.join(json.dumps(r)+'\n' for r in rows));summary['trace_path']=str(trace)
    s.action('scenario',{'operation':'cleanup'});assert s.inventory()==dict(vehicles=1,walkers=0,controllers=0,sensors=7)
    summary['actor_cleanup_verified']=True
    print(json.dumps(summary),flush=True);return summary


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--demo',choices=['BASE','RULE','LEARNED','HYBRID']);parser.add_argument('--manual',action='store_true')
    args=parser.parse_args();DEST.mkdir(parents=True,exist_ok=True);EVIDENCE.mkdir(parents=True,exist_ok=True)
    if not args.demo and (EVIDENCE/'native.json').exists():
        raise ValueError('Frozen pilot evidence is preserved. Use --demo for a diagnostic demonstration, not another TEST campaign.')
    began=time.monotonic();deadline=began+600;pid=backend_pid(8000)
    result={'source':'LIVE_NATIVE_PRODUCTION_COMMAND_LOOP','tick_owner':'simulation-worker','versions':['0.9.16','0.9.16'],
        'baseline':'BasicAgent normal native hazard handling unchanged','cases':[],'before_resources':memory(pid)}
    try:
        with Session() as s:
            result['initial_inventory']=s.inventory();result['initial_sync']=s.state['synchronization']
            specs=[compiled(s,k,seed) for k,seed in CASES]
            protocol={'predeclared_epoch':time.time(),'selection':'Two fixed unused TEST namespace seeds; whole conditions held out before native outcomes. No final TEST retuning.',
                'weights_sha256':hashlib.sha256((ROOT/'artifacts/learned_safety/v1/weights.npz').read_bytes()).hexdigest(),
                'cases':[to_dict(spec) for spec in specs],'controllers':['BASE','RULE','LEARNED','HYBRID'],
                'maximum_episodes':10,'maximum_native_wall_s':600,'success_conditions_unchanged':True,
                'fallbacks_visible':True,'model_frozen_before_test':True}
            if not args.demo:(EVIDENCE/'protocol.json').write_text(json.dumps(protocol,indent=2))
            if args.demo:
                result['cases'].append(check(s,specs[1],args.demo,'MANUAL' if args.manual else 'AUTOMATIC',deadline))
            else:
                for spec in specs:
                    for controller in ('BASE','RULE','LEARNED','HYBRID'):
                        result['cases'].append(check(s,spec,controller,'AUTOMATIC',deadline))
                        (EVIDENCE/'native.json').write_text(json.dumps(result,indent=2))
                for controller in ('BASE','RULE'):
                    result['cases'].append(check(s,specs[1],controller,'MANUAL',deadline))
                    (EVIDENCE/'native.json').write_text(json.dumps(result,indent=2))
            s.send('safety_mode',value={'enabled':True,'controller':'RULE'})
            result['final_inventory']=s.inventory();result['final_sync']=s.state['synchronization'];result['rl_runtime']=s.state['rlRuntime']
            result['final_mode']=s.state['mode'];result['final_safety']=s.state['safetySystem']
    except Exception as error:
        result['error']=repr(error);raise
    finally:
        result['wall_s']=time.monotonic()-began;result['after_resources']=memory(pid)
        path=DEST/('demo-'+uuid.uuid4().hex+'.json') if args.demo else EVIDENCE/'native.json'
        path.write_text(json.dumps(result,indent=2));print(json.dumps({'wall_s':result['wall_s'],'completed_episodes':len(result['cases']),'error':result.get('error')}),flush=True)

if __name__=='__main__':main()
