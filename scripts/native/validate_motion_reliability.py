"""Bounded native measured-motion checks; restore operator pose/settings held.

This observer never owns the physics clock. Native actor poses are used only to
arrange/evaluate test fixtures, never as planner/predictor inputs.
"""
import argparse
from contextlib import contextmanager
import hashlib
import json
from pathlib import Path
import time
import threading
import numpy as np
from .evaluate_drive_experience import ObservationSession as BaseObservationSession
from backend.learning.motion_budget import MotionBudget

ROOT=Path(__file__).resolve().parents[2];OUT=ROOT/'output/motion-reliability'

class ObservationSession(BaseObservationSession):
    """Keep the driver lease independent of slow diagnostic HTTP/disk reads."""
    def __enter__(self):
        self.send_lock=threading.Lock();self.heartbeat_stop=threading.Event()
        super().__enter__()
        def heartbeat():
            while not self.heartbeat_stop.wait(.1):
                state=self.state
                if not state or state['journey']['status'] not in ('STARTING','RUNNING'):continue
                try:self._send('journey_heartbeat',session_id=state['sessionId'])
                except (OSError,RuntimeError):return
        self.heartbeat_thread=threading.Thread(target=heartbeat,daemon=True);self.heartbeat_thread.start()
        return self

    def _send(self,kind,**payload):
        with self.send_lock:
            self.sequence+=1;sequence=self.sequence
            self.socket.send(json.dumps({'type':kind,'sequence':sequence,**payload}))
        return sequence

    def send(self,kind,**payload):
        sequence=self._send(kind,**payload)
        self.wait(lambda state:state.get('acknowledged',0)>=sequence)

    def __exit__(self,*args):
        self.heartbeat_stop.set();self.heartbeat_thread.join(timeout=1)
        return super().__exit__(*args)

def write(name,data):
    OUT.mkdir(parents=True,exist_ok=True);(OUT/name).write_text(json.dumps(data,indent=2),encoding='utf8')

def ego(session):return session.world.get_actor(session.state['vehicle']['actorId'])

def place(session,pose):
    import carla
    session.send('stop_driving');session.wait(lambda s:s['vehicle']['speedMagnitudeMps']<.15)
    actor=ego(session);p=pose['positionWorldM'];r=pose['rotationDeg']
    actor.set_target_velocity(carla.Vector3D());actor.set_target_angular_velocity(carla.Vector3D())
    actor.set_transform(carla.Transform(carla.Location(*p),carla.Rotation(**r)))
    first=session.state['vehicle']['frame'];session.wait(lambda s:s['vehicle']['frame']>first+12)

def sample(session,seconds,drive=False):
    rows=[];end=time.monotonic()+seconds
    while time.monotonic()<end:
        if drive:session.send('journey_heartbeat',session_id=session.state['sessionId'])
        else:session.wait(lambda s:True)
        s=session.state;v=s['vehicle'];m=s.get('maneuver') or {}
        rows.append({'wall':time.monotonic(),'frame':v['frame'],'timestamp':v['timestamp'],'speed':v['speedKmh'],
            'acceleration':v['accelerationMps2'],'steering':v['steeringInput'],'brake':v['brake'],
            'position':v['positionWorldM'],'journey':s['journey'],'remaining':s['route'].get('remaining_m'),
            'mode':s['mode'],'maneuver':m,'stop':s.get('stopDiagnostics'),
            'performance':s['performance'],'contacts':s['collisionEvents'],'sensorErrors':s['sensorErrors'],
            'prediction':None})
        if drive and s['journey']['status'] not in ('STARTING','RUNNING'):break
        time.sleep(.1)
    return rows

def summary(rows):
    if not rows:return {'samples':0}
    warm=rows[len(rows)//4:];contacts={}
    start=rows[0]['timestamp']
    for row in rows:
        for c in row['contacts']:
            if c['timestamp_s']>=start:contacts[(c['other_actor_id'],int(c['timestamp_s']*2))]=c
    ticks=[r['performance']['nativeTickRateHz'] for r in warm if r['performance']['nativeTickRateHz']]
    images=[r['performance']['sensorWallRatesHz'].get('drivingCamera',r['performance']['sensorWallRatesHz'].get('frontCamera')) for r in warm]
    images=[i for i in images if i is not None]
    return {'samples':len(rows),'native_hz':float(np.median(ticks)) if ticks else None,
        'camera_hz':float(np.median(images)) if images else None,'contact_half_second_bins':len(contacts),
        'contacts':list(contacts.values()),'max_speed_kmh':max(r['speed'] for r in rows),
        'stopped_fraction':sum(r['speed']<.5 for r in rows)/len(rows),
        'comfort_accel_exceedances':sum(r['acceleration']>2.2 for r in rows),
        'comfort_decel_exceedances':sum(r['acceleration']<-3.2 for r in rows),
        'arrived':rows[-1]['journey']['status']=='ARRIVED','terminal':rows[-1]['journey'],
        'remaining_m':rows[-1]['remaining'],'actions':sorted(set(r['maneuver'].get('action','BASELINE') for r in rows)),
        'sensor_errors':[r['sensorErrors'] for r in rows if r['sensorErrors']]}

@contextmanager
def preserved(session):
    session.send('stop_driving');session.wait(lambda s:s['vehicle']['speedMagnitudeMps']<.15)
    saved={'vehicle':session.state['vehicle'],'destination':(session.state.get('route') or {}).get('destination'),
        'population':session.state['population']['requested'],'preferences':(ROOT/'config/dashboard-preferences.json').read_text()}
    write('operator-before.json',saved)
    try:yield saved
    finally:
        session.send('stop_driving');session.wait(lambda s:s['vehicle']['speedMagnitudeMps']<.15)
        if session.state['population']['requested']!=saved['population']:session.action('settings',{'population':saved['population']})
        place(session,saved['vehicle'])
        if saved['destination']:session.action('destination',{'location':saved['destination']['location'],'name':saved['destination']['name']})
        (ROOT/'config/dashboard-preferences.json').write_text(saved['preferences'],encoding='utf8')
        write('operator-restored.json',{'position':session.state['vehicle']['positionWorldM'],'expected':saved['vehicle']['positionWorldM'],
            'destination':session.state['route'].get('destination'),'mode':session.state['mode'],'speed_kmh':session.state['vehicle']['speedKmh']})

def main():
    p=argparse.ArgumentParser();p.add_argument('--baseline',action='store_true');p.add_argument('--journeys',action='store_true');p.add_argument('--seconds',type=float,default=25.)
    p.add_argument('--allowance',type=float);p.add_argument('--seeds',default='7301,7302,7303');p.add_argument('--trip-seconds',type=float,default=55.)
    p.add_argument('--chaos',default='0,50,85')
    p.add_argument('--report',default='native-validation.json');p.add_argument('--prefix',default='journey')
    args=p.parse_args();budget=MotionBudget();allowance=args.allowance or (120. if args.baseline else 700.)
    ticket=budget.reserve('validation',allowance);began=time.monotonic();report={}
    try:
        with ObservationSession() as s,preserved(s) as saved:
            if args.baseline:
                report={'scope':'Matched stopped city throughput; driving safety is assessed separately',
                    'settings':saved,'result':summary(sample(s,args.seconds))}
                write('baseline.json',report)
            else:
                rows=sample(s,args.seconds);report['matched_stopped_performance']=summary(rows)
                baseline=json.loads((OUT/'baseline.json').read_text())['result']
                report['degradation_percent']={k:100*(1-report['matched_stopped_performance'][k]/baseline[k]) for k in ('native_hz','camera_hz') if baseline[k]}
                report['stopped_performance_gate']=all(v<=10. for v in report['degradation_percent'].values())
                report['driving_performance_accepted']=False
                report['journeys']=[]
                if args.journeys:
                    start=s.world.get_map().get_spawn_points()[152]
                    pose={'positionWorldM':[start.location.x,start.location.y,start.location.z],
                          'rotationDeg':{'roll':start.rotation.roll,'pitch':start.rotation.pitch,'yaw':start.rotation.yaw}}
                    for chaos in map(int,args.chaos.split(',')):
                        for seed in map(int,args.seeds.split(',')):
                            if (OUT/'cancel-native').exists():raise RuntimeError('Validation interrupted for correction; saved attempts remain counted')
                            if time.monotonic()-began>allowance-args.trip_seconds-25:raise TimeoutError('Native validation deadline; remaining trips incomplete')
                            s.action('settings',{'population':{**saved['population'],'vehicle_count':0,'pedestrian_count':0}})
                            place(s,pose)
                            s.action('settings',{'population':{**saved['population'],'chaos_percent':chaos,'seed':seed}})
                            s.wait(lambda a:a['vehicle']['speedMagnitudeMps']<.15)
                            s.action('destination',{'location':[-36.883373,-68.379028,0.],'name':'Motion validation destination'})
                            s.send('start_journey',speed_kmh=30)
                            rows=sample(s,args.trip_seconds,drive=True)
                            s.send('stop_driving');s.wait(lambda a:a['vehicle']['speedMagnitudeMps']<.15)
                            name=f'{args.prefix}-{chaos}-{seed}.json';write(name,rows)
                            report['journeys'].append({'chaos':chaos,'seed':seed,'telemetry':name,**summary(rows)})
                            write(args.report,report)
                report['native_lateral_gate']=False;report['learned_control_gate']=False
                write(args.report,report)
    except Exception as error:
        report['error']=str(error);write('baseline-error.json' if args.baseline else args.report,report);raise
    finally:
        budget.finish(ticket);write('budget.json',budget.status())
    print(json.dumps(report.get('result',report)),flush=True)

if __name__=='__main__':main()
