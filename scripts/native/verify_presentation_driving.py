"""Production manual/ordinary journey acceptance; the backend remains tick owner."""
import json,math,time
from pathlib import Path
from .verify_urban_world import Session
ROOT=Path(__file__).resolve().parents[2]
def position(state):return state['canonical']['vehicle']['transform']['position_m']
def main():
    report={'source':'REAL_NATIVE_PRODUCTION_CONTROL_REQUESTS','tick_owner':'simulation-worker'}
    with Session() as s:
        s.send('comparison',value={'mode':'STOP','scenario':'URBAN_CHAOS','seed':2589});s.wait(lambda st:st['comparisonDemo']['phase']=='IDLE' and st['vehicle']['speedKmh']<.3)
        reset_frame=s.state['vehicle']['frame']
        s.wait(lambda st:st['vehicle']['frame']>reset_frame+10 and st['frameComplete'])
        start=position(s.state);begin=s.state['vehicle']['timestamp'];speeds=[];sources=[]
        s.send('start_driving')
        s.wait(lambda st:st['mode']=='MANUAL')
        while s.state['vehicle']['timestamp']-begin<5:
            s.send('controls',frame_id=s.state['vehicle']['frame'],timestamp_s=s.state['vehicle']['timestamp'],controls={'throttle':.4,'brake':0.,'steering':0.,'parkingbrake':0,'gear':1})
            speeds.append(s.state['vehicle']['speedKmh']);sources.append(s.state['controlSource'])
        report['manual']={'distance_m':math.dist(start,position(s.state)),'maximum_speed_kmh':max(speeds),'control_sources':sorted(set(sources))}
        s.send('stop_driving');s.wait(lambda st:st['vehicle']['speedKmh']<.3)
        import carla
        m=s.world.get_map();current=m.get_waypoint(carla.Location(*position(s.state)));choices=current.next(30);target=min(choices,key=lambda q:abs((q.transform.rotation.yaw-current.transform.rotation.yaw+180)%360-180)).transform.location
        s.action('destination',{'location':[target.x,target.y,target.z],'name':'Native ordinary journey rehearsal'})
        start=position(s.state);begin=s.state['vehicle']['timestamp'];s.send('start_journey',speed_kmh=15);s.wait(lambda st:st['journey']['status']=='RUNNING');speeds=[];sources=[]
        while s.state['vehicle']['timestamp']-begin<10 and s.state['journey']['status']=='RUNNING':
            s.send('journey_heartbeat',session_id=s.state['sessionId']);speeds.append(s.state['vehicle']['speedKmh']);sources.append(s.state['controlSource'])
        report['ordinary_journey']={'distance_m':math.dist(start,position(s.state)),'maximum_speed_kmh':max(speeds),'control_sources':sorted(set(sources)),'status':s.state['journey']}
        s.send('stop_driving');s.wait(lambda st:st['vehicle']['speedKmh']<.3)
        report['safety']=s.state['safetySystem'];report['inventory']=s.inventory()
        assert report['manual']['distance_m']>1 and report['ordinary_journey']['distance_m']>1
        assert report['safety']['enabled'] and report['safety']['controller']=='RULE' and report['inventory']['sensors']==7
        report['status']='PASS'
    (ROOT/'docs/evidence/urban_chaos/driving.json').write_text(json.dumps(report,indent=2),encoding='utf8');print(json.dumps(report,indent=2))
if __name__=='__main__':main()
