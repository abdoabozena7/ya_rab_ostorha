"""Gate 5 live acceptance. Production WebSocket commands; no second tick owner."""
import argparse
import json
import math
from pathlib import Path
import statistics
import time
from websockets.sync.client import connect
from .stability_run import backend_pid, memory


class Session:
    def __enter__(self):
        import carla
        self.client = carla.Client('127.0.0.1', 2000); self.client.set_timeout(10)
        assert self.client.get_client_version() == self.client.get_server_version() == '0.9.16'
        self.world = self.client.get_world(); self.world.wait_for_tick(10)
        self.socket = connect('ws://127.0.0.1:8001', max_size=2**23)
        self.sequence = 0; self.state = None
        self.probe_sensors=[]
        self.started_recording=False
        self.wait(lambda s:s['connected']); self.send('take_control')
        return self

    def wait(self, predicate, timeout=45):
        deadline = time.monotonic()+timeout
        while time.monotonic()<deadline:
            message = json.loads(self.socket.recv(timeout=10))
            if message['type']=='error': raise RuntimeError(message['error'])
            if message['type']!='snapshot': continue
            self.state = message
            if message.get('error'): raise RuntimeError(message['error'])
            if predicate(message): return message
        raise TimeoutError('Native condition timed out')

    def send(self, kind, **payload):
        self.sequence += 1
        self.socket.send(json.dumps({'type':kind, 'sequence':self.sequence, **payload}))
        self.wait(lambda s:s.get('acknowledged')==self.sequence)

    def action(self, kind, value=None):
        self.send(kind, value=value)
        self.wait(lambda s:(s.get('dashboardResult') or {}).get('action')==kind and
                  s['dashboardResult']['status'] in ('APPLIED','REJECTED'))
        if self.state['dashboardResult']['status']=='REJECTED':
            raise RuntimeError(self.state['dashboardResult']['error'])
        if kind=='recording':self.started_recording=value['enabled']
        frame = self.state['vehicle']['frame']
        self.wait(lambda s:s['vehicle']['frame']>frame+10)
        return self.state['dashboardResult']['result']

    def inventory(self):
        actors=self.world.get_actors()
        return {name:len(actors.filter(pattern)) for name,pattern in
                [('vehicles','vehicle.*'),('walkers','walker.pedestrian.*'),
                 ('controllers','controller.ai.walker'),('sensors','sensor.*')]}

    def __exit__(self, *args):
        for sensor in self.probe_sensors:
            try:
                if sensor.is_alive:sensor.stop();sensor.destroy()
            except RuntimeError:pass
        if self.started_recording:self.action('recording',{'enabled':False})
        self.socket.close()


def main():
    from backend.carla.population import DEFAULT_POPULATION
    from backend.carla.runtime import native_processes
    parser=argparse.ArgumentParser()
    parser.add_argument('--duration',type=float,default=60)
    parser.add_argument('--profiles-only',action='store_true')
    parser.add_argument('--single',action='store_true',help='Detailed 25/20 congestion probe')
    parser.add_argument('--crossing-percent',type=int,default=5)
    parser.add_argument('--npc-collision-probe',action='store_true',help='Temporary native collision sensors on NPCs; removed after each probe')
    parser.add_argument('--ego-spawn',type=int)
    parser.add_argument('--output',default='output/native-validation/gate5-urban.json')
    args=parser.parse_args()
    proof={'source':'LIVE_NATIVE','matrix':[],'render_fps':None}
    root=Path(args.output); root.parent.mkdir(parents=True,exist_ok=True)
    backend=backend_pid(8000)
    engine=next(p for p in native_processes() if 'Shipping' in p['ExecutablePath'])['ProcessId']
    with Session() as s:
        proof['versions']=[s.client.get_server_version(),s.client.get_client_version()]
        proof['map']=s.world.get_map().name
        if args.ego_spawn is not None:s.action('settings',{'spawn_index':args.ego_spawn})
        proof['sensor_registry']=s.state['sensorRegistry']
        matrix=[(10,5,b) for b in ('NORMAL','BUSY','AGGRESSIVE','UNREGULATED')] if args.profiles_only else [
            (0,0,'NORMAL'),(10,10,'BUSY'),(25,20,'BUSY'),(40,30,'BUSY'),(50,35,'UNREGULATED')]
        if args.single: matrix=[(25,20,'BUSY')]
        for vehicles,walkers,behavior in matrix:
            s.action('population','reset')
            s.action('settings',{'population':{**DEFAULT_POPULATION,'vehicle_count':vehicles,
                'pedestrian_count':walkers,'driver_behavior':behavior,'light_compliance_percent':80,
                'crossing_percent':args.crossing_percent}})
            s.wait(lambda st:st['population']['actual']['vehicles']==vehicles and
                   st['population']['actual']['pedestrians']==walkers)
            collision_probes=[];npc_contacts=[]
            if args.npc_collision_probe:
                import carla
                bp=s.world.get_blueprint_library().find('sensor.other.collision')
                for actor_id in s.state['population']['vehicle_ids']:
                    actor=s.world.get_actor(actor_id)
                    sensor=s.world.spawn_actor(bp,carla.Transform(),attach_to=actor)
                    sensor.listen(lambda event,actor_id=actor_id:npc_contacts.append({
                        'frame':event.frame,'timestamp_s':event.timestamp,'actor_id':actor_id,
                        'other_actor_id':event.other_actor.id,'other_type':event.other_actor.type_id,
                        'impulse_ns':math.hypot(event.normal_impulse.x,event.normal_impulse.y,event.normal_impulse.z)}))
                    collision_probes.append(sensor)
                    s.probe_sensors.append(sensor)
            began=time.monotonic(); initial=s.state['synchronization']; rows=[]; positions={}; distances={}
            sampled=-10.; stopped_then_moved=set(); previously_stopped=set(); nearby=[]; minimum_gap=None
            states=set(); lanes={}; changed=set(); ego_start=s.state['canonical']['vehicle']['transform']['position_m']
            overlap_samples=0; queue_sizes=[]; collision_ids=set()
            while time.monotonic()-began<args.duration:
                s.wait(lambda st:st['connected'])
                now=time.monotonic()
                if now-sampled<1.: continue
                sampled=now; pop=s.state['population']; snapshot=s.world.get_snapshot()
                ego=snapshot.find(s.state['vehicle']['actorId']).get_transform().location
                local=0; native=[]
                for i in pop['vehicle_ids']+pop['walker_ids']:
                    a=snapshot.find(i)
                    if a is None: continue
                    t=a.get_transform(); point=(t.location.x,t.location.y,t.location.z)
                    if i in positions: distances[i]=distances.get(i,0.)+math.dist(point,positions[i])
                    positions[i]=point
                    if i in pop['vehicle_ids']:
                        local+=t.location.distance(ego)<=120
                        speed=math.hypot(a.get_velocity().x,a.get_velocity().y)
                        if speed<.15: previously_stopped.add(i)
                        elif speed>1 and i in previously_stopped: stopped_then_moved.add(i)
                        wp=s.world.get_map().get_waypoint(t.location)
                        if wp:
                            if i in lanes and lanes[i][0]==wp.road_id and lanes[i][1]!=wp.lane_id: changed.add(i)
                            lanes[i]=(wp.road_id,wp.lane_id)
                        actor=s.world.get_actor(i)
                        if actor: native.append((t,actor.bounding_box))
                from backend.carla.geometry import footprint, rectangle_clearance
                overlapping=False
                for k,(a,ab) in enumerate(native):
                    for b,bb in native[k+1:]:
                        gap=rectangle_clearance(footprint(a,ab),footprint(b,bb))
                        minimum_gap=gap if minimum_gap is None else min(minimum_gap,gap)
                        overlapping |= gap==0.
                overlap_samples+=overlapping
                queue_sizes.append(sum(math.hypot(a.get_velocity().x,a.get_velocity().y)<.15
                                       for i in pop['vehicle_ids'] if (a:=snapshot.find(i)) is not None))
                collision_ids.update((c['frame_id'],c['other_actor_id']) for c in s.state['collisionEvents'])
                nearby.append(local)
                states.update(k for k,v in pop.get('activity_counts',{}).items() if v>0)
                rows.append({'performance':s.state['performance'],'step_ms':s.state['backendStepMs'],
                             'backend':memory(backend),'carla':memory(engine),'population':pop})
            final=s.state['synchronization']; warm=rows[len(rows)//4:]
            row={'requested':[vehicles,walkers],'behavior':behavior,'duration_wall_s':time.monotonic()-began,
                 'actual':s.inventory(),'local_vehicles_120m_minmax':[min(nearby),max(nearby)],
                 'tick_hz':statistics.median(r['performance']['nativeTickRateHz'] for r in warm),
                 'vram_mib_range':[min(r['performance']['gpu']['usedMiB'] for r in warm),max(r['performance']['gpu']['usedMiB'] for r in warm)],
                 'memory_private_mib':{p:[min(r[p]['private_mib'] for r in warm),max(r[p]['private_mib'] for r in warm)] for p in ('backend','carla')},
                 'sensor_wall_hz':{k:statistics.median(r['performance']['sensorWallRatesHz'][k] for r in warm) for k in ('frontCamera','depth','radar','lidar','imu','gnss')},
                 'step_ms_median':statistics.median(r['step_ms'] for r in warm),
                 'observation_pipeline_latency_ms_median':statistics.median(r['performance']['observationPipelineLatencyMs']['median'] for r in warm),
                 'sync_issues':{k:final['issues'][k]-initial['issues'][k] for k in final['issues']},
                 'incomplete_frames':final['incompleteFrames']-initial['incompleteFrames'],
                 'moved_vehicles':sum(distances.get(i,0)>2 for i in pop['vehicle_ids']),
                 'moved_walkers':sum(distances.get(i,0)>2 for i in pop['walker_ids']),
                 'stopped_then_moved_vehicles':len(stopped_then_moved),'observed_lane_changes':len(changed),
                 'minimum_planar_box_clearance_m':minimum_gap,'observed_activity_states':sorted(states),
                 'footprint_overlap_sample_count':overlap_samples,'queue_size_minmax':[min(queue_sizes),max(queue_sizes)],
                 'ego_collision_callback_count':len(collision_ids),'npc_collision_contacts':npc_contacts,
                 'npc_collision_probe_actor_count':len(collision_probes),
                 'ego_displacement_m':math.dist(ego_start,s.state['canonical']['vehicle']['transform']['position_m']),
                 'profile_names':sorted({p.get('name') for p in pop['driver_profiles'].values()}),
                 'final_population':pop,'sensor_errors':s.state['sensorErrors']}
            pairs={tuple(sorted((c['actor_id'],c['other_actor_id']))) for c in npc_contacts}
            row['npc_collision_summary']={'raw_callbacks':len(npc_contacts),'unique_contact_pairs':len(pairs),
                'maximum_impulse_ns':max((c['impulse_ns'] for c in npc_contacts),default=0.),
                'notes':'Temporary diagnostic sensors. Paired callbacks count twice; sustained contact is not multiple independent crashes.'}
            row['pass']=not any(row['sync_issues'].values()) and row['incomplete_frames']==0 and not row['sensor_errors'] and row['actual']['sensors']==7+len(collision_probes)
            row['transport_and_sensors_pass']=row['pass']
            row['collision_free_observed']=not npc_contacts if args.npc_collision_probe else None
            for sensor in collision_probes:
                sensor.stop();sensor.destroy()
            s.probe_sensors.clear()
            proof['matrix'].append(row); root.write_text(json.dumps(proof,indent=2),encoding='utf8')
            print(json.dumps({k:v for k,v in row.items() if k not in ('final_population','npc_collision_contacts')} |
                             {'npc_collision_callback_count':len(npc_contacts)}),flush=True)
        s.action('population','reset')
        proof['cleanup_inventory']=s.inventory()
        proof['pass']=all(r['pass'] for r in proof['matrix']) and proof['cleanup_inventory']==dict(vehicles=1,walkers=0,controllers=0,sensors=7)
        proof['pass_scope']='Transport, sensor synchronization and cleanup; not a collision-free assertion'
        root.write_text(json.dumps(proof,indent=2),encoding='utf8')
    if not proof['pass']: raise SystemExit(1)


if __name__=='__main__': main()
