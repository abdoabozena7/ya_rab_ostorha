"""Reproduce a persisted failed journey and audit its complete native recording.

Preparation runs with the backend stopped; the observer never ticks CARLA.
"""
import argparse
import copy
import hashlib
import json
import math
from pathlib import Path
import threading
import time
import uuid
from websockets.sync.client import connect

ROOT=Path(__file__).resolve().parents[2]


def prepare(source, output):
    import carla
    from backend.carla.urban_chaos import extend_scripted_exits
    original=json.loads(source.read_text());pair=copy.deepcopy(original)
    client=carla.Client('127.0.0.1',2000);client.set_timeout(10);native_map=client.get_world().get_map()
    metadata=pair['spec']['metadata'];route=metadata['route_points'];previous=native_map.get_waypoint(carla.Location(*route[-1]));extension=[]
    for _ in range(20):
        choices=previous.next(2.)
        if not choices:raise ValueError('No exit beyond destination')
        previous=min(choices,key=lambda w:abs((w.transform.rotation.yaw-previous.transform.rotation.yaw+180)%360-180))
        loc=previous.transform.location;extension.append([loc.x,loc.y,loc.z])
    if not metadata.get('scripted_exits_clear_destination'):
        extend_scripted_exits(metadata['vehicle_plans'],route,extension)
    metadata['scripted_exits_clear_destination']=True
    pair.update(pair_id=uuid.uuid4().hex,results={},attempts=[],retest_of=original['pair_id'])
    for key in ('approved_initial_states','configuration_id','route','latest_initial_audit','approved_traffic_lights'):
        pair.pop(key,None)
    output.mkdir(parents=True,exist_ok=True)
    (output/'retest-manifest.json').write_text(json.dumps(pair,indent=2))
    (ROOT/'output/comparison_v2/active-pair.json').write_text(json.dumps(pair,indent=2))
    print(json.dumps({'prepared_pair':pair['pair_id'],'seed':pair['seed'],'retest_of':original['pair_id']}))


def audit(recording, result, source_pair):
    frames=[json.loads(line) for line in (recording/'telemetry/frames.jsonl').open()]
    elapsed=stopped=distance=intervention_time=emergency_time=0.;collisions=set();counts={};last_active=False;interventions=0
    geometry=[];pipelines=[];longest_stop=stop_duration=0.
    for a,b in zip(frames,frames[1:]):
        dt=b['timestamp_s']-a['timestamp_s'];elapsed+=dt
        if a['vehicle']['speed_mps']<.2:stopped+=dt;stop_duration+=dt
        else:longest_stop=max(longest_stop,stop_duration);stop_duration=0.
        distance+=math.dist(a['vehicle']['transform']['position_m'],b['vehicle']['transform']['position_m'])
    last_time=None
    for line in (recording/'telemetry/safety-v2.jsonl').open():
        row=json.loads(line);s=row['safety'];dt=0. if last_time is None else row['timestamp_s']-last_time;last_time=row['timestamp_s']
        active=s.get('active',False);interventions+=int(active and not last_active);last_active=active
        if active:intervention_time+=dt
        if s.get('emergency_active'):emergency_time+=dt
        key=s.get('reason','UNKNOWN');counts[key]=counts.get(key,0)+dt
        quality=(s.get('prediction') or {}).get('quality_metrics') or {}
        if quality.get('geometry_ms') is not None:geometry.append(quality['geometry_ms'])
        if quality.get('controller_pipeline_ms') is not None:pipelines.append(quality['controller_pipeline_ms'])
    for line in (recording/'events/events.jsonl').open():
        event=json.loads(line)
        if event.get('event_type')=='CollisionDetected':
            c=event.get('payload',{}).get('collision')
            if c:collisions.add((c['frame_id'],c['other_actor_id']))
    pair=(json.loads((ROOT/'output/comparison_v2'/f"{result['run']['pair_id']}.json").read_text())
        if result.get('run') else source_pair)
    end=frames[-1]['vehicle'];remaining=math.dist(end['transform']['position_m'],pair['destination']['location'])
    from backend.carla.comparison_v2 import pose_audit
    initial_audit=(pose_audit(source_pair['approved_initial_states'],result['run']['initial_states']['actors'])
        if result.get('run') else {'passed':True,'scope':'Persisted original approved initial states'})
    import numpy as np
    return dict(recording=str(recording),reason=result['reason'],destination_arrived=result['destination_arrived'],
        independently_verified_arrival=bool(result['destination_arrived'] and remaining<=5 and end['speed_mps']<.15),
        destination_distance_m=remaining,final_speed_mps=end['speed_mps'],collision_count=result['outcome']['metrics']['collision_count'],
        collision_callbacks=len(collisions),duration_sim_s=elapsed,distance_traveled_m=distance,stopped_s=stopped,
        longest_stop_s=max(longest_stop,stop_duration),geometry_p95_ms=float(np.percentile(geometry,95)) if geometry else None,
        controller_p95_ms=float(np.percentile(pipelines,95)) if pipelines else None,
        useful_route_progress_m=result['outcome']['metrics']['progress_m'],route_completion=result['outcome']['metrics']['route_completion'],
        interventions=interventions,intervention_s=intervention_time,emergency_s=emergency_time,reason_durations_s=counts,
        initial_poses_match_failed_run=initial_audit)


def run(side, output, source):
    weights=ROOT/'artifacts/learned_safety/predictive_v2/heads.npz';checksum=hashlib.sha256(weights.read_bytes()).hexdigest()
    code_files=('backend/core/prediction.py','backend/core/predictive_safety.py',
        'backend/carla/urban_chaos.py','backend/carla/comparison_v2.py')
    code_checksums={f:hashlib.sha256((ROOT/f).read_bytes()).hexdigest() for f in code_files}
    seq=0;state=None;lock=threading.Lock();stop=threading.Event();samples=[];result=None;failure=None;began=time.monotonic()
    with connect('ws://127.0.0.1:8001',max_size=2**24) as ws:
        def send(kind,**payload):
            nonlocal seq
            with lock:seq+=1;ws.send(json.dumps({'type':kind,'sequence':seq,**payload}))
        def receive():
            nonlocal state
            m=json.loads(ws.recv(timeout=5))
            if m.get('type')=='error' or m.get('error'):raise RuntimeError(m.get('error'))
            if m.get('type')=='snapshot':state=m
        while state is None:receive()
        send('take_control')
        def heartbeat():
            while not stop.wait(.1):
                if state and state.get('journey',{}).get('status') in ('STARTING','RUNNING'):
                    try:send('journey_heartbeat',session_id=state['sessionId'])
                    except Exception:break
        t=threading.Thread(target=heartbeat,daemon=True);t.start()
        try:
            send('comparison_v2',value={'operation':'RUN','side':side});seen=False;last=0.
            while time.monotonic()-began<600:
                receive();v=state.get('comparisonV2') or {};seen|=v.get('phase')=='RUNNING'
                if time.monotonic()-last>=10:
                    last=time.monotonic();s=state.get('safetySystem') or {}
                    row=dict(wall_s=round(last-began,2),phase=v.get('phase'),speed_kmh=(state.get('vehicle') or {}).get('speedKmh'),
                        remaining_m=(state.get('route') or {}).get('remaining_m'),risk=s.get('risk'),reason=s.get('reason'),
                        measured_range_m=s.get('measured_range_m'),target_speed_mps=s.get('target_speed_mps'))
                    samples.append(row);print(json.dumps(row),flush=True)
                if seen and v.get('phase') in ('FINISHED','ERROR'):
                    compact=v.get('latest_attempt');result=json.loads((Path(compact['recording'])/'comparison-v2-result.json').read_text());break
            if result is None:raise TimeoutError('Bounded native journey did not terminate')
        except Exception as error:
            failure=str(error)
        finally:
            stop.set();t.join(timeout=1)
            try:send('comparison_v2',value={'operation':'STOP'})
            except Exception:pass
    if hashlib.sha256(weights.read_bytes()).hexdigest()!=checksum:raise RuntimeError('Weights changed')
    if any(hashlib.sha256((ROOT/f).read_bytes()).hexdigest()!=h for f,h in code_checksums.items()):
        raise RuntimeError('Runtime code changed during retest')
    if result is None:
        report=dict(completed=False,failure=failure,wall_s=time.monotonic()-began,samples=samples,weights_sha256=checksum)
        output.mkdir(parents=True,exist_ok=True);(output/'journey-incomplete.json').write_text(json.dumps(report,indent=2))
        raise RuntimeError(failure or 'Native journey incomplete')
    report=audit(Path(result['recording']),result,json.loads(source.read_text()))
    report.update(side=side,seed=result['run']['seed'] if 'seed' in result['run'] else json.loads(source.read_text())['seed'],
        weights_sha256=checksum,weights_unchanged=True,code_checksums=code_checksums,
        source_manifest_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),wall_s=time.monotonic()-began,samples=samples)
    output.mkdir(parents=True,exist_ok=True);(output/'journey-result.json').write_text(json.dumps(report,indent=2))
    print(json.dumps({k:v for k,v in report.items() if k!='samples'}))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--source',type=Path,required=True);p.add_argument('--output',type=Path,required=True)
    p.add_argument('--prepare',action='store_true');p.add_argument('--side',choices=['RULE','MODEL'],default='RULE');args=p.parse_args()
    if args.prepare:prepare(args.source,args.output)
    else:run(args.side,args.output,args.source)
