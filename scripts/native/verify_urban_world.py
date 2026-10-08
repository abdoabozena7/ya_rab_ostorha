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

    def action(self, kind, value):
        self.send(kind, value=value)
        self.wait(lambda s:(s.get('dashboardResult') or {}).get('action')==kind and
                  s['dashboardResult']['status'] in ('APPLIED','REJECTED'))
        if self.state['dashboardResult']['status']=='REJECTED':
            raise RuntimeError(self.state['dashboardResult']['error'])
        frame = self.state['vehicle']['frame']
        self.wait(lambda s:s['vehicle']['frame']>frame+10)
        return self.state['dashboardResult']['result']

    def inventory(self):
        actors=self.world.get_actors()
        return {name:len(actors.filter(pattern)) for name,pattern in
                [('vehicles','vehicle.*'),('walkers','walker.pedestrian.*'),
                 ('controllers','controller.ai.walker'),('sensors','sensor.*')]}

    def __exit__(self, *args):
        self.socket.close()


def main():
    from backend.carla.population import DEFAULT_POPULATION
    from backend.carla.runtime import native_processes
    parser=argparse.ArgumentParser()
    parser.add_argument('--duration',type=float,default=60)
    parser.add_argument('--profiles-only',action='store_true')
    parser.add_argument('--output',default='output/native-validation/gate5-urban.json')
    args=parser.parse_args()
    proof={'source':'LIVE_NATIVE','matrix':[],'render_fps':None}
    root=Path(args.output); root.parent.mkdir(parents=True,exist_ok=True)
    backend=backend_pid(8000)
    engine=next(p for p in native_processes() if 'Shipping' in p['ExecutablePath'])['ProcessId']
    with Session() as s:
        proof['versions']=[s.client.get_server_version(),s.client.get_client_version()]
        proof['map']=s.world.get_map().name
        proof['sensor_registry']=s.state['sensorRegistry']
        matrix=[(10,5,b) for b in ('NORMAL','BUSY','AGGRESSIVE','UNREGULATED')] if args.profiles_only else [
            (0,0,'NORMAL'),(10,10,'BUSY'),(25,20,'BUSY'),(40,30,'BUSY'),(50,35,'UNREGULATED')]
        for vehicles,walkers,behavior in matrix:
            s.action('population','reset')
            s.action('settings',{'population':{**DEFAULT_POPULATION,'vehicle_count':vehicles,
                'pedestrian_count':walkers,'driver_behavior':behavior,'light_compliance_percent':80}})
            s.wait(lambda st:st['population']['actual']['vehicles']==vehicles and
                   st['population']['actual']['pedestrians']==walkers)
            began=time.monotonic(); initial=s.state['synchronization']; rows=[]; positions={}; distances={}
            sampled=-10.; stopped_then_moved=set(); previously_stopped=set(); nearby=[]; minimum_gap=None
            states=set(); lanes={}; changed=set(); ego_start=s.state['canonical']['vehicle']['transform']['position_m']
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
                # Conservative bounding-sphere clearance: diagnostic lower bound,
                # not a road-aligned bumper gap or a valid TTC measurement.
                for k,(a,ab) in enumerate(native):
                    for b,bb in native[k+1:]:
                        gap=a.location.distance(b.location)-math.hypot(ab.extent.x,ab.extent.y)-math.hypot(bb.extent.x,bb.extent.y)
                        minimum_gap=gap if minimum_gap is None else min(minimum_gap,gap)
                nearby.append(local)
                states.update(pop.get('activity_counts',{}))
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
                 'sync_issues':{k:final['issues'][k]-initial['issues'][k] for k in final['issues']},
                 'incomplete_frames':final['incompleteFrames']-initial['incompleteFrames'],
                 'moved_vehicles':sum(distances.get(i,0)>2 for i in pop['vehicle_ids']),
                 'moved_walkers':sum(distances.get(i,0)>2 for i in pop['walker_ids']),
                 'stopped_then_moved_vehicles':len(stopped_then_moved),'observed_lane_changes':len(changed),
                 'minimum_bounding_sphere_clearance_m':minimum_gap,'observed_activity_states':sorted(states),
                 'ego_displacement_m':math.dist(ego_start,s.state['canonical']['vehicle']['transform']['position_m']),
                 'profile_names':sorted({p.get('name') for p in pop['driver_profiles'].values()}),
                 'final_population':pop,'sensor_errors':s.state['sensorErrors']}
            row['pass']=not any(row['sync_issues'].values()) and row['incomplete_frames']==0 and not row['sensor_errors'] and row['actual']['sensors']==7
            proof['matrix'].append(row); root.write_text(json.dumps(proof,indent=2),encoding='utf8')
            print(json.dumps({k:v for k,v in row.items() if k!='final_population'}),flush=True)
        s.action('population','reset')
        proof['cleanup_inventory']=s.inventory()
        proof['pass']=all(r['pass'] for r in proof['matrix']) and proof['cleanup_inventory']==dict(vehicles=1,walkers=0,controllers=0,sensors=7)
        root.write_text(json.dumps(proof,indent=2),encoding='utf8')
    if not proof['pass']: raise SystemExit(1)


if __name__=='__main__': main()
