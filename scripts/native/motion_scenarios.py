"""Repeated real sensor fixtures; only the fixture/evaluator accesses targets."""
import argparse
import json
import math
from pathlib import Path
import time
import urllib.request
from .validate_motion_reliability import ObservationSession,OUT,ROOT,preserved,place,write,summary
from backend.learning.motion_budget import MotionBudget

CASES=('clear','parked_side','parallel_person','crossing_person','cut_in','sudden_brake','rear_approach','adjacent_occupied','pass_return')

def main():
    import carla
    parser=argparse.ArgumentParser();parser.add_argument('--cases',default=','.join(CASES));parser.add_argument('--allowance',type=float,default=450.)
    parser.add_argument('--report',default='native-scenarios.json');parser.add_argument('--prefix',default='fixture')
    args=parser.parse_args();cases=args.cases.split(',')
    if any(c not in CASES for c in cases) or not 60<=args.allowance<=450:parser.error('Unknown case or invalid allowance')
    budget=MotionBudget();ticket=budget.reserve('validation',args.allowance);deadline=time.monotonic()+args.allowance-20.
    report={'source':'LIVE_NATIVE_CARLA','scope':'Two repeated sensor fixtures per case, TRAIN and VALIDATION. Independent actor truth is evaluation-only.',
        'fixtures':[],'lateral_native_accepted':False,'learned_control_accepted':False}
    gate=OUT/'lateral-validation.json';created=[]
    gate.write_text(json.dumps({'reservation_id':ticket[0],'expires_monotonic_s':deadline}))
    try:
        with ObservationSession() as s,preserved(s) as saved:
            old_camera=(s.state.get('displayCamera') or {}).get('mountTransform')
            front=s.state['sensors']['frontCamera'].get('mountTransform');depth=s.state['sensors']['depth'].get('mountTransform')
            s.action('settings',{'camera_view':'rear'})
            report['camera_separation']={'front_unchanged':front==s.state['sensors']['frontCamera'].get('mountTransform'),
                'depth_unchanged':depth==s.state['sensors']['depth'].get('mountTransform'),
                'display_changed':old_camera!=(s.state.get('displayCamera') or {}).get('mountTransform')}
            camera=json.loads(saved['preferences']).get('view',{}).get('camera_view','chase')
            s.action('settings',{'camera_view':camera})
            start=s.world.get_map().get_spawn_points()[152];f=start.get_forward_vector();right=start.get_right_vector()
            pose={'positionWorldM':[start.location.x,start.location.y,start.location.z],
                  'rotationDeg':{'roll':start.rotation.roll,'pitch':start.rotation.pitch,'yaw':start.rotation.yaw}}
            library=s.world.get_blueprint_library();car=library.find('vehicle.tesla.model3');ped=library.filter('walker.pedestrian.*')[0]
            def spawn(x,y,person=False):
                blueprint=ped if person else car
                if blueprint.has_attribute('role_name'):blueprint.set_attribute('role_name','ostorha_motion_fixture')
                for yy in ([y,-y] if y else [0.]):
                    for dx in (0.,-3.,3.):
                        t=carla.Transform(carla.Location(start.location.x+f.x*(x+dx)+right.x*yy,start.location.y+f.y*(x+dx)+right.y*yy,start.location.z+.2),start.rotation)
                        actor=s.world.try_spawn_actor(blueprint,t)
                        if actor is not None:created.append(actor);return actor
                raise RuntimeError('Fixture spawn obstructed on both sides; case not evaluated')
            for split,seed in (('TRAIN',9101),('VALIDATION',9102)):
                for case in cases:
                    if time.monotonic()>deadline-25:raise TimeoutError('Native fixture deadline; remaining cases incomplete')
                    s.action('settings',{'population':{**saved['population'],'vehicle_count':0,'pedestrian_count':0,'seed':seed}})
                    place(s,pose);targets=[]
                    if case=='parked_side':targets=[(spawn(18,3.5),0,0)]
                    elif case=='parallel_person':targets=[(spawn(12,3.5,True),1.3,0)]
                    elif case=='crossing_person':targets=[(spawn(15,4,True),0,-1.5)]
                    elif case=='cut_in':targets=[(spawn(22,3.5),3,-1.2)]
                    elif case=='sudden_brake':targets=[(spawn(17,0),4,0)]
                    elif case=='rear_approach':targets=[(spawn(-16,0),7,0)]
                    elif case=='adjacent_occupied':targets=[(spawn(20,0),0,0),(spawn(3,-3.5),4,0)]
                    elif case=='pass_return':targets=[(spawn(22,0),0,0)]
                    targets=[(a,vx,-math.copysign(abs(vy),(a.get_location().x-start.location.x)*right.x+(a.get_location().y-start.location.y)*right.y) if vy else 0.) for a,vx,vy in targets]
                    s.action('destination',{'location':[-36.883373,-68.379028,0.],'name':'Motion fixture destination'})
                    initial=s.state['vehicle'];started=initial['timestamp'];s.send('start_journey',speed_kmh=30)
                    s.wait(lambda state:state['mode']=='AUTOMATIC' or state['journey']['status']=='ERROR',timeout=10)
                    rows=[];forecasts=[];began=time.monotonic()
                    try:
                        duration=25. if case=='pass_return' else 10.
                        while time.monotonic()-began<duration:
                            elapsed=time.monotonic()-began
                            for actor,vx,vy in targets:
                                if case=='sudden_brake' and elapsed>=2.:vx=0.
                                direction=carla.Vector3D(f.x*vx+right.x*vy,f.y*vx+right.y*vy,0)
                                if actor.type_id.startswith('walker.'):
                                    speed=math.hypot(vx,vy);actor.apply_control(carla.WalkerControl(direction=direction/speed if speed else direction,speed=speed))
                                else:
                                    actor.set_target_velocity(direction)
                                    actor.apply_control(carla.VehicleControl(brake=1. if vx==vy==0 else 0.))
                            s.send('journey_heartbeat',session_id=s.state['sessionId']);state=s.state;v=state['vehicle']
                            with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/prediction',timeout=2) as response:value=json.load(response)
                            if value.get('status')=='RUNNING':forecasts.append(value['prediction'])
                            rows.append({'wall':time.monotonic(),'frame':v['frame'],'timestamp':v['timestamp'],'speed':v['speedKmh'],
                                'acceleration':v['accelerationMps2'],'steering':v['steeringInput'],'brake':v['brake'],'position':v['positionWorldM'],
                                'journey':state['journey'],'remaining':state['route'].get('remaining_m'),'mode':state['mode'],
                                'maneuver':state.get('maneuver') or {},'performance':state['performance'],'contacts':state['collisionEvents'],'sensorErrors':state['sensorErrors'],
                                'evaluation_targets':[{'id':a.id,'type':a.type_id,'position':[a.get_location().x,a.get_location().y]} for a,_,_ in targets]})
                            if state['mode']!='AUTOMATIC':break
                            time.sleep(.1)
                    finally:
                        s.send('stop_driving');s.wait(lambda state:state['vehicle']['speedMagnitudeMps']<.15)
                        for actor in created:
                            if actor.is_alive:actor.destroy()
                        created.clear()
                    name=f'{args.prefix}-{split}-{case}';write(name+'.json',{'split':split,'seed':seed,'case':case,'initial':initial,'rows':rows,'forecasts':forecasts})
                    report['fixtures'].append({'split':split,'seed':seed,'case':case,**summary(rows)})
                    write(args.report,report)
            report['complete']=True
    except Exception as error:report.update(complete=False,error=str(error))
    finally:
        for actor in created:
            try:actor.destroy()
            except RuntimeError:pass
        if gate.exists():gate.unlink()
        budget.finish(ticket);report['budget']=budget.status();write(args.report,report)
    print(json.dumps({'complete':report.get('complete'),'error':report.get('error'),'fixtures':len(report['fixtures'])}),flush=True)

if __name__=='__main__':main()
