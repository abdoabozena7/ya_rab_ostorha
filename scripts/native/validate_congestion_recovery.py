"""Crash-charged native recovery checks with a single backend tick owner."""
import argparse
import json
from pathlib import Path
import time
import urllib.request
from .validate_motion_reliability import ObservationSession,place,summary
from backend.learning.recovery_budget import RecoveryBudget

ROOT=Path(__file__).resolve().parents[2]
OUT=ROOT/'output/congestion-recovery'


def write(name,value):
    OUT.mkdir(parents=True,exist_ok=True)
    (OUT/name).write_text(json.dumps(value,indent=2),encoding='utf8')


def get(path):
    with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/'+path,timeout=2) as response:return json.load(response)


def row(s):
    v=s['vehicle']
    return {'wall':time.monotonic(),'frame':v['frame'],'timestamp':v['timestamp'],'speed':v['speedKmh'],
        'acceleration':v['accelerationMps2'],'steering':v['steeringInput'],'brake':v['brake'],
        'throttle':v['throttle'],'gear':v['gear'],'reverse':v['reverse'],'position':v['positionWorldM'],
        'journey':s['journey'],'remaining':(s.get('route') or {}).get('remaining_m'),'mode':s['mode'],
        'maneuver':s.get('maneuver') or {},'stop':s.get('stopDiagnostics'),
        'performance':s['performance'],'contacts':s['collisionEvents'],'sensorErrors':s['sensorErrors'],
        'safety':s['safetySystem']}


def compact_forecast(p):
    return {k:p.get(k) for k in ('evaluation_frame','timestamp_s','published_wall_s','session_id','quality_metrics',
        'recovery_readiness','recovery_depth_channels','vehicle_geometry')}|{'tracks':[
            {k:t.get(k) for k in ('id','position_m','half_size_m','velocity_mps','confirmed','occlusion_s','uncertainty_m')}
            for t in p['tracks']]}


def main():
    import carla
    parser=argparse.ArgumentParser()
    parser.add_argument('--restart',action='store_true');parser.add_argument('--probe-only',action='store_true')
    parser.add_argument('--allowance',type=float,default=180.);parser.add_argument('--seconds',type=float,default=25.)
    parser.add_argument('--cases',default='blocked_reverse,blocked_rear,side_clear');parser.add_argument('--report',default='native-validation.json')
    args=parser.parse_args()
    if not 60<=args.allowance<=600 or not 1<=args.seconds<=60:parser.error('Native checks require 60–600 reserved seconds and 1–60 sample seconds')
    budget=RecoveryBudget();reservation=budget.reserve('validation',args.allowance)
    deadline=reservation[1]+args.allowance-15.
    gate=OUT/'validation-ticket.json'
    gate.write_text(json.dumps({'scope':'CONGESTION_RECOVERY_20261014','reservation_id':reservation[0],
        'started_monotonic_s':reservation[1],'expires_monotonic_s':deadline}))
    report={'source':'LIVE_NATIVE_CARLA','fixtures':[],'native_accepted':False,'learned_control_used':False}
    created=[];saved=None;session=None
    try:
        state=get('state')
        saved={'vehicle':state['vehicle'],'destination':state['route'].get('destination'),
            'population':state['population']['requested'],'preferences':(ROOT/'config/dashboard-preferences.json').read_text()}
        write('operator-before.json',saved)
        if args.restart:
            from .restart_backend import main as restart
            restart()
        with ObservationSession() as s:
            session=s
            # Keep every blocking diagnostic bounded by this reservation.
            original_wait=s.wait
            def bounded_wait(predicate,timeout=30):
                remaining=deadline-time.monotonic()
                if remaining<=0:raise TimeoutError('Recovery test deadline reached')
                return original_wait(predicate,timeout=min(timeout,remaining))
            s.wait=bounded_wait
            s.send('stop_driving')
            try:
                if args.probe_only:
                    s.action('settings',{'population':{**saved['population'],'vehicle_count':0,'pedestrian_count':0}})
                    place(s,saved['vehicle'])
                    end=min(deadline-10,time.monotonic()+args.seconds);rows=[];forecasts=[];next_forecast=0.
                    while time.monotonic()<end:
                        s.wait(lambda a:True);rows.append(row(s.state))
                        if time.monotonic()>=next_forecast:
                            forecast=get('prediction');next_forecast=time.monotonic()+.5
                            if forecast.get('status')=='RUNNING' and (not forecasts or forecasts[-1]['evaluation_frame']!=forecast['prediction']['evaluation_frame']):forecasts.append(compact_forecast(forecast['prediction']))
                    report['probe']={'telemetry':rows,'forecasts':forecasts,'summary':summary(rows),
                        'sensor_registry':s.state['sensorRegistry']}
                else:
                    s.action('settings',{'population':{**saved['population'],'vehicle_count':0,'pedestrian_count':0}})
                    world=s.world;roadmap=world.get_map();chosen=None
                    # Only fixture setup reads the map/target actors. Policy
                    # inputs remain onboard measurements plus road permissions.
                    for t in roadmap.get_spawn_points():
                        wp=roadmap.get_waypoint(t.location)
                        if wp.is_junction or not wp.next(20) or any(w.is_junction for w in wp.next(20)):continue
                        for side in ('left','right'):
                            other=getattr(wp,'get_'+side+'_lane')()
                            f=t.get_forward_vector()
                            if other is not None and str(other.lane_type)=='Driving':
                                d=other.transform.get_forward_vector()
                                if d.x*f.x+d.y*f.y>.9 and ('Both' in str(wp.lane_change) or side.title() in str(wp.lane_change)):
                                    chosen=(t,wp,side);break
                        if chosen:break
                    if chosen is None:raise RuntimeError('No native straight lane permission fixture was available')
                    start,wp,side=chosen;f=start.get_forward_vector();right=start.get_right_vector()
                    pose={'positionWorldM':[start.location.x,start.location.y,start.location.z],
                        'rotationDeg':{'roll':start.rotation.roll,'pitch':start.rotation.pitch,'yaw':start.rotation.yaw}}
                    report['fixture_road']={'pose':pose,'lane_width':wp.lane_width,'permitted_side':side}
                    blueprint=world.get_blueprint_library().find('vehicle.tesla.model3')
                    blueprint.set_attribute('role_name','ostorha_recovery_fixture')
                    def spawn(x,y):
                        t=carla.Transform(carla.Location(start.location.x+f.x*x+right.x*y,
                            start.location.y+f.y*x+right.y*y,start.location.z+.1),start.rotation)
                        a=world.try_spawn_actor(blueprint,t)
                        if a is None:raise RuntimeError('Recovery fixture pose occupied')
                        a.apply_control(carla.VehicleControl(brake=1.));created.append(a);return a
                    for case in args.cases.split(','):
                        if time.monotonic()>deadline-args.seconds-15:break
                        place(s,pose)
                        targets=[spawn(7.,0.)]
                        if case=='blocked_rear':targets.append(spawn(-6.,0.))
                        # Lateral clear fixture prevents the straight reverse
                        # with a physical rear obstacle, rather than a test flag.
                        if case=='side_clear':targets.append(spawn(-6.,0.))
                        if case not in ('blocked_reverse','blocked_rear','side_clear'):raise ValueError('Unknown native fixture')
                        end_wp=wp.next(50.)[0]
                        loc=end_wp.transform.location
                        s.action('destination',{'location':[loc.x,loc.y,loc.z],'name':'Recovery validation'})
                        # Route crowding is user functionality, unnecessary for
                        # these controlled physical actor fixtures.
                        s.action('settings',{'population':{**saved['population'],'vehicle_count':0,'pedestrian_count':0}})
                        first=s.state['vehicle']['frame']
                        s.wait(lambda a:a['vehicle']['frame']>first+25)
                        s.send('start_journey',speed_kmh=10,driving_mode='ROBOSPHERE')
                        rows=[];forecasts=[];end=min(deadline-12,time.monotonic()+args.seconds);next_forecast=0.
                        while time.monotonic()<end:
                            s.wait(lambda a:True);rows.append(row(s.state))
                            if time.monotonic()>=next_forecast:
                                forecast=get('prediction');next_forecast=time.monotonic()+.5
                                if forecast.get('status')=='RUNNING' and (not forecasts or forecasts[-1]['evaluation_frame']!=forecast['prediction']['evaluation_frame']):forecasts.append(compact_forecast(forecast['prediction']))
                            if s.state['journey']['status'] not in ('STARTING','RUNNING'):break
                        s.send('stop_driving');s.wait(lambda a:a['vehicle']['speedMagnitudeMps']<.15)
                        for a in created:
                            if a.is_alive:a.destroy()
                        created.clear()
                        item={'case':case,'summary':summary(rows),'rows':rows,'forecasts':forecasts}
                        report['fixtures'].append(item);write(args.report,report)
                report['complete']=True
            finally:
                # The ticket is removed before restoring user traffic/route.
                gate.unlink(missing_ok=True)
                s.send('stop_driving');s.wait(lambda a:a['vehicle']['speedMagnitudeMps']<.15)
                for a in created:
                    if a.is_alive:a.destroy()
                created.clear()
                place(s,saved['vehicle'])
                if saved['destination']:s.action('destination',{'location':saved['destination']['location'],'name':saved['destination']['name']})
                s.action('settings',{'population':saved['population']})
                (ROOT/'config/dashboard-preferences.json').write_text(saved['preferences'],encoding='utf8')
                write('operator-restored.json',{'vehicle':s.state['vehicle'],'mode':s.state['mode'],
                    'population':s.state['population']['requested'],'route':s.state['route']})
    except Exception as error:
        report.update(complete=False,error=str(error))
        raise
    finally:
        gate.unlink(missing_ok=True)
        for a in created:
            try:a.destroy()
            except RuntimeError:pass
        report['elapsed_s']=budget.finish(reservation);report['budget']=budget.status()
        write(args.report,report)
        print(json.dumps({k:v for k,v in report.items() if k not in ('fixtures','probe')}),flush=True)


if __name__=='__main__':main()
