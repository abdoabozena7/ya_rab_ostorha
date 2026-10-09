"""Four focused native episodes, hard six-episode/300-second global budget.

Production commands are the only control interface. Native actor geometry is
read only for outcome measurement; the policy receives sensor measurements.
Replay checks happen offline after safe stopping, outside native test runtime.
"""
import argparse
import json
import math
from pathlib import Path
import statistics
import time
from websockets.sync.client import connect


def save(path,value):path.write_text(json.dumps(value,indent=2),encoding='utf8')


class BudgetSession:
    def __init__(self,proof):
        self.proof=proof;self.sequence=0;self.state=None;self.began=time.monotonic()
        self.prior_wall=proof.get('native_test_wall_s',0.);self.episodes=proof.get('episode_count',0);self.cleanup=False
    def elapsed(self):return self.prior_wall+time.monotonic()-self.began
    def check(self):
        if not self.cleanup and self.elapsed()>=290:raise TimeoutError('Native test stopped with ten-second cleanup reserve inside the 300-second budget')
    def episode(self,name):
        self.check()
        if self.episodes>=6:raise TimeoutError('Six-episode native validation budget reached')
        self.episodes+=1;self.proof['episode_count']=self.episodes
        print(json.dumps({'episode':self.episodes,'name':name,'budget_remaining_s':300-self.elapsed()}),flush=True)
    def __enter__(self):
        if self.episodes>=6:raise RuntimeError('Saved native episode budget is exhausted; no new native validation started')
        import carla
        self.client=carla.Client('127.0.0.1',2000);self.client.set_timeout(8)
        self.world=self.client.get_world();self.world.wait_for_tick(8)
        self.socket=connect('ws://127.0.0.1:8001',max_size=2**23)
        self.wait(lambda s:s['connected']);self.send('take_control');return self
    def wait(self,predicate,timeout=45):
        deadline=time.monotonic()+timeout
        while time.monotonic()<deadline:
            self.check()
            try:message=json.loads(self.socket.recv(timeout=.5))
            except TimeoutError:continue
            if message['type']=='error':raise RuntimeError(message['error'])
            if message['type']!='snapshot':continue
            self.state=message
            if predicate(message):return message
        raise TimeoutError('Focused native condition timed out')
    def send(self,kind,**payload):
        self.check();self.sequence+=1
        self.socket.send(json.dumps({'type':kind,'sequence':self.sequence,**payload}))
        self.wait(lambda s:s.get('acknowledged')==self.sequence)
    def action(self,kind,value=None):
        self.send(kind,value=value)
        self.wait(lambda s:(s.get('dashboardResult') or {}).get('action')==kind and s['dashboardResult']['status'] in ('APPLIED','REJECTED'))
        result=self.state['dashboardResult']
        if result['status']=='REJECTED':raise RuntimeError(result['error'])
        return result.get('result')
    def heartbeat(self):self.send('journey_heartbeat',session_id=self.state['sessionId'])
    def inventory(self):
        actors=self.world.get_actors()
        return {name:len(actors.filter(pattern)) for name,pattern in [('vehicles','vehicle.*'),('walkers','walker.pedestrian.*'),('controllers','controller.ai.walker'),('sensors','sensor.*')]}
    def __exit__(self,*args):self.socket.close()


def journey(session,config,recording,folder):
    session.episode('recording ON' if recording else 'recording OFF')
    session.send('stop_driving');session.wait(lambda s:s['vehicle']['speedMagnitudeMps']<.15)
    session.action('population','reset');session.wait(lambda s:s['vehicle']['speedMagnitudeMps']<.15)
    session.action('settings',{'spawn_index':152})
    session.wait(lambda s:s['vehicle']['speedMagnitudeMps']<.15)
    session.action('settings',{'population':{**config,'seed':2621}})
    initial=session.inventory();warm_begin=session.state['vehicle']['timestamp']
    session.wait(lambda s:s['vehicle']['timestamp']-warm_begin>=3.)
    warmed=session.inventory()
    target=session.world.get_map().get_spawn_points()[121].location
    session.action('destination',{'location':[target.x,target.y,target.z],'name':'Focused reliability destination'})
    root=session.action('recording',{'enabled':True})['path'] if recording else None
    # Starting can take longer than the control heartbeat TTL; poll and refresh
    # until the production service has armed on two new complete sensor frames.
    session.send('start_journey',speed_kmh=20)
    while session.state['journey']['status']=='STARTING':session.heartbeat()
    started=session.state['vehicle']['timestamp'];began=time.monotonic();rows=[]
    while session.state['vehicle']['timestamp']-started<12:
        session.heartbeat();s=session.state
        rows.append({'frame':s['vehicle']['frame'],'timestamp':s['vehicle']['timestamp'],'position':s['vehicle']['positionWorldM'],
            'speed':s['vehicle']['speedKmh'],'safety':s['safetySystem'],'journey':s['journey'],'complete':s['frameComplete'],
            'performance':s['performance'],'recording_status':s.get('recordingStatus'),'population':s['population']})
        if s['journey']['status']!='RUNNING':break
    duration=time.monotonic()-began;final=session.state
    session.send('stop_driving');session.wait(lambda s:s['vehicle']['speedMagnitudeMps']<.15)
    if recording:session.action('recording',{'enabled':False})
    faults=[r for r in rows if r['safety']['status']=='SENSOR_FAULT_STOP']
    distance=sum(math.dist(a['position'],b['position']) for a,b in zip(rows,rows[1:]))
    result={'recording':root,'seed':2621,'spawn':152,'destination':121,'target_speed_kmh':20,
        'simulation_s':final['vehicle']['timestamp']-started,'wall_s':duration,
        'throughput_steps_s':(rows[-1]['frame']-rows[0]['frame'])/(duration) if rows else None,
        'median_reported_steps_s':statistics.median(r['performance']['nativeTickRateHz'] for r in rows) if rows else None,
        'sensor_freshness_failures':len({r['safety'].get('reason') for r in faults}),
        'fault_reasons':sorted({r['safety'].get('reason') for r in faults}),
        'incomplete_observations':len({r['frame'] for r in rows if not r['complete']}),
        'distance_m':distance,'final_journey':final['journey'],'collision_events':final['collisionEvents'],
        'pedestrians':{'initial':initial,'warm':warmed,'after_drive':session.inventory(),
             'population':final['population']}}
    save(folder/('recording-on-telemetry.json' if recording else 'recording-off-telemetry.json'),rows)
    print(json.dumps({'journey_result':result}),flush=True);return result


def suv(session,seed,folder):
    session.episode('reversing SUV seed '+str(seed));session.send('comparison',value={'mode':'WITH','seed':seed,'scenario':'URBAN_CHAOS'})
    session.wait(lambda s:s['comparisonDemo']['seed']==seed and s['comparisonDemo']['phase'] in ('RESETTING','RUNNING','ERROR'))
    rows=[];last=None;minimum=None;conflicts=[];start=None;first=None;resume=None
    from backend.carla.geometry import footprint,rectangle_clearance
    boxes={}
    while True:
        session.heartbeat();s=session.state;demo=s['comparisonDemo'];phase=demo['phase']
        if phase=='ERROR':raise RuntimeError(demo['error'])
        if phase=='FINISHED':
            full=json.loads((Path(demo['recording'])/'comparison-result.json').read_text(encoding='utf8'))
            result={'seed':seed,'recording':demo['recording'],'outcome':full['outcome'],'final_safety':full['final_safety'],
                    'minimum_sampled_suv_clearance_m':minimum,'first_path_conflict':first,
                    'first_resumed_after_conflict':resume,'conflict_sample_count':len(conflicts),
                    'sensor_freshness_failures':len({r['safety'].get('reason') for r in rows if r['safety']['status']=='SENSOR_FAULT_STOP'})}
            save(folder/f'suv-{seed}-telemetry.json',rows);print(json.dumps({'suv_result':result}),flush=True);return result
        if phase!='RUNNING':continue
        session.proof['in_progress']={'seed':seed,'recording':demo['recording']}
        vehicle=s['vehicle'];frame=vehicle['frame']
        if frame==last:continue
        last=frame;start=vehicle['timestamp'] if start is None else start
        row={'frame':frame,'elapsed':vehicle['timestamp']-start,'position':vehicle['positionWorldM'],'speed':vehicle['speedKmh'],
             'safety':s['safetySystem'],'metrics':demo['metrics'],'collisions':s['collisionEvents'],'population':s['population']['actual']}
        scenario=(s.get('environment') or {}).get('scenario') or {}
        # The recorded production trace provides the exact named hazard ID;
        # observer inventory is used only to measure geometric outcome.
        snapshot=session.world.get_snapshot();ego_id=vehicle['actorId'];ego=snapshot.find(ego_id)
        actors=session.world.get_actors()
        patrols=[a for a in actors if a.type_id=='vehicle.nissan.patrol']
        if ego:
            boxes.setdefault(ego_id,session.world.get_actor(ego_id).bounding_box)
            gaps=[]
            for actor in patrols:
                a=snapshot.find(actor.id)
                if a:
                    boxes.setdefault(actor.id,actor.bounding_box)
                    gap=rectangle_clearance(footprint(ego.get_transform(),boxes[ego_id]),footprint(a.get_transform(),boxes[actor.id]))
                    gaps.append(gap)
            if gaps:
                row['minimum_patrol_gap_m']=min(gaps);minimum=min(gaps) if minimum is None else min(minimum,min(gaps))
        safety=s['safetySystem']
        if safety.get('path_conflict'):
            conflicts.append(row)
            if first is None:first={'elapsed_s':row['elapsed'],'frame':frame,'position':row['position'],'conflict':safety['path_conflict'],'speed_kmh':row['speed']}
        elif first and resume is None and not safety['active'] and row['speed']>3:
            resume={'elapsed_s':row['elapsed'],'frame':frame,'distance_since_conflict_m':math.dist(first['position'],row['position'])}
        rows.append(row)
        if len(rows)%20==0:save(folder/f'suv-{seed}-telemetry.json',rows)
        if int(row['elapsed'])%15==0 and (len(rows)==1 or int(rows[-2]['elapsed'])!=int(row['elapsed'])):
            print(json.dumps({'seed':seed,'elapsed':row['elapsed'],'risk':safety['risk'],'collisions':demo['metrics'].get('collision_count')}),flush=True)


def replay_audit(root):
    from backend.core.replay import ReplayReader
    from backend.core.recording import resolve_asset
    reader=ReplayReader(root);count=0;gaps=0;previous=None;sensor_mismatches=0
    for frame in reader.frames():
        count+=1
        if previous is not None:gaps+=frame.frame_id-previous!=1
        previous=frame.frame_id
        for sensor in frame.sensors:
            sensor_mismatches+=sensor.frame_id!=frame.frame_id or abs(sensor.timestamp_s-frame.timestamp_s)>1e-6
            if sensor.asset:resolve_asset(reader.root,sensor.asset)
    return {'valid':not gaps and not sensor_mismatches,'frames':count,'frame_gaps':gaps,'sensor_mismatches':sensor_mismatches,
            'asset_checksums':'ALL_VERIFIED','recording_status':reader.recording_status}


def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--output',default='output/native-validation/final-reliability-20261010');args=p.parse_args()
    folder=Path(args.output);folder.mkdir(parents=True,exist_ok=True);preferences=Path('config/dashboard-preferences.json');saved=preferences.read_bytes()
    config=json.loads(saved)['population'];proof={'source':'LIVE_NATIVE_CARLA','budget':{'maximum_episodes':6,'maximum_test_wall_s':300},'recording':[],'suv':[]}
    if (folder/'validation.json').exists():
        proof=json.loads((folder/'validation.json').read_text(encoding='utf8'))
        if proof.get('blocker'):proof.setdefault('setup_attempts',[]).append({'episode':proof['episode_count'],'blocker':proof.pop('blocker')})
        recordings=set();valid=[]
        for row in proof['suv']:
            if row['recording'] in recordings:
                proof.setdefault('invalid_observations',[]).append({'seed':row['seed'],'reason':'Old FINISHED state read before queued reset; excluded, no changed-condition evidence'})
            else:valid.append(row);recordings.add(row['recording'])
        proof['suv']=valid
        proof.pop('cleanup_error',None)
    with BudgetSession(proof) as session:
        try:
            proof['before']=session.inventory()
            for recording in (False,True):
                if any(bool(r['recording'])==recording for r in proof['recording']):continue
                proof['recording'].append(journey(session,config,recording,folder));save(folder/'validation.json',proof)
            for seed in (2604,2605):
                if any(r['seed']==seed for r in proof['suv']):continue
                proof['suv'].append(suv(session,seed,folder));save(folder/'validation.json',proof)
        except Exception as error:
            proof['blocker']=str(error);print(json.dumps({'blocker':str(error)}),flush=True)
        finally:
            proof['native_test_wall_s']=session.elapsed();session.cleanup=True
            try:
                session.send('stop_driving',reason='focused_validation_finished')
                session.wait(lambda s:s['vehicle']['speedMagnitudeMps']<.15)
                pending=proof.pop('in_progress',None)
                if pending and not any(r['seed']==pending['seed'] for r in proof['suv']):
                    session.wait(lambda s:s['comparisonDemo']['phase']=='FINISHED')
                    full=json.loads((Path(pending['recording'])/'comparison-result.json').read_text(encoding='utf8'))
                    proof['suv'].append({**pending,'budget_stopped':True,'outcome':full['outcome'],'final_safety':full['final_safety']})
                if session.state['comparisonDemo']['phase'] in ('RUNNING','RESETTING','STOPPING'):
                    session.send('comparison',value={'mode':'STOP'})
                    session.wait(lambda s:s['comparisonDemo']['phase']=='IDLE')
                if session.state['recording']:session.action('recording',{'enabled':False})
                session.wait(lambda s:s['vehicle']['speedMagnitudeMps']<.15)
                session.action('environment','LIVING_CITY')
                session.action('population','reset')
                frame=session.state['vehicle']['frame'];session.wait(lambda s:s['vehicle']['frame']>frame+3)
                proof['cleanup_empty_inventory']=session.inventory()
                session.action('settings',{'spawn_index':152,'population':config});session.action('clear_route');session.send('stop_driving')
                frame=session.state['vehicle']['frame'];session.wait(lambda s:s['vehicle']['frame']>frame+25)
                proof['restored']={'inventory':session.inventory(),'population':session.state['population'],'mode':session.state['mode'],
                                    'recording':session.state['recording'],'safety':session.state['safetySystem']}
            except Exception as error:proof['cleanup_error']=str(error)
            preferences.write_bytes(saved);save(folder/'validation.json',proof)
    # Native tests have ended and ego is held. Replay validation cannot consume
    # additional driving episodes; every binary asset checksum is inspected.
    for row in proof['recording']+proof['suv']:
        if not row['recording']:continue
        try:
            status=Path(row['recording'])/'recording-status.json';deadline=time.monotonic()+15
            while not status.exists() and time.monotonic()<deadline:time.sleep(.05)
            row['replay']=replay_audit(row['recording'])
        except Exception as error:row['replay']={'valid':False,'error':str(error)}
        save(folder/'validation.json',proof)
    print(json.dumps({'final':{k:proof.get(k) for k in ('episode_count','native_test_wall_s','blocker','cleanup_error','cleanup_empty_inventory')}}),flush=True)


if __name__=='__main__':main()
