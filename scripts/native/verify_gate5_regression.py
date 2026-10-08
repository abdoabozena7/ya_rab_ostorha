"""Current native settings, manual motion and real recordings through production WS."""
import json
import math
from pathlib import Path
import time
from backend.carla.population import DEFAULT_POPULATION
from backend.core.replay import ReplayReader
from .verify_urban_world import Session


def main():
    proof={'source':'LIVE_NATIVE','checks':{},'recordings':[]}
    with Session() as s:
        s.action('settings',{'population':{**DEFAULT_POPULATION,'vehicle_count':10,'pedestrian_count':10}})
        old=s.inventory()
        s.action('settings',{'vehicle':'vehicle.toyota.prius','spawn_index':0})
        assert s.inventory()==dict(vehicles=1,walkers=0,controllers=0,sensors=7)
        assert s.world.get_actor(s.state['vehicle']['actorId']).type_id=='vehicle.toyota.prius'
        proof['checks']['vehicle_change_cleans_population']=True
        settled=s.state['vehicle']['frame']
        s.wait(lambda state:state['vehicle']['speedKmh']<.3 and state['vehicle']['frame']>settled+30)
        s.action('settings',{'vehicle':'vehicle.lincoln.mkz_2020','spawn_index':152})
        settled=s.state['vehicle']['frame']
        s.wait(lambda state:state['vehicle']['speedKmh']<.3 and state['vehicle']['frame']>settled+30)
        sensor_ids=set(a.id for a in s.world.get_actors().filter('sensor.*'))
        for view in ('hood','chase','rear','top','front'):
            s.action('settings',{'camera_view':view})
            assert sensor_ids==set(a.id for a in s.world.get_actors().filter('sensor.*'))
            cameras=list(s.world.get_actors().filter('sensor.camera.*'))
            assert cameras[0].get_transform().location.distance(cameras[1].get_transform().location)<.01
        proof['checks']['camera_views_aligned_without_actor_leaks']=True
        for weather in ('CloudyNoon','HardRainNoon','ClearNoon'):
            result=s.action('settings',{'weather_preset':weather})
            assert result['weather_preset']==weather
        for hz in (10,20):
            s.action('settings',{'simulation_hz':hz})
            assert abs(s.world.get_settings().fixed_delta_seconds-1/hz)<1e-6
            assert s.inventory()['sensors']==7
        proof['checks']['native_weather_and_fixed_delta']=True
        s.action('settings',{'population':{**DEFAULT_POPULATION,'vehicle_count':25,'pedestrian_count':20,
            'driver_behavior':'BUSY','light_compliance_percent':80}})
        s.wait(lambda state:state['population']['actual']['vehicles']==25 and state['population']['actual']['pedestrians']==20)
        s.action('recording',{'enabled':True})
        start=s.state['vehicle']['positionWorldM'];speeds=[];sources=set();began=time.monotonic()
        start_sim=s.state['vehicle']['timestamp']
        s.send('start_driving')
        while s.state['vehicle']['timestamp']-start_sim<3.5 and time.monotonic()-began<40:
            s.send('controls',frame_id=s.state['vehicle']['frame'],timestamp_s=s.state['vehicle']['timestamp'],
                controls={'throttle':.35,'brake':0,'steering':0,'parkingbrake':0,'gear':1})
            speeds.append(s.state['vehicle']['speedKmh']);sources.add(s.state['controlSource'])
        s.send('stop_driving');s.wait(lambda state:state['vehicle']['speedKmh']<.5)
        assert max(speeds)>2 and math.dist(start,s.state['vehicle']['positionWorldM'])>.5, {'maximum_kmh':max(speeds),'distance_m':math.dist(start,s.state['vehicle']['positionWorldM']), 'simulation_duration_s':s.state['vehicle']['timestamp']-start_sim}
        assert 'MANUAL' in sources
        recorded=s.action('recording',{'enabled':False})
        reader=ReplayReader(recorded['path'])
        frames=list(reader.frames());assert any(f.complete and len(f.sensors)==6 for f in frames)
        assert any(f.population and f.population.traffic_vehicles==25 for f in frames)
        proof['recordings'].append({'context':'LIVING_CITY','path':str(reader.root),'frames':len(frames)})
        proof['checks']['manual_real_motion_and_recorded_assets']=True
        ego=s.world.get_actor(s.state['vehicle']['actorId']);wp=s.world.get_map().get_waypoint(ego.get_location())
        target=wp.next(20.)[0].transform.location
        route=s.action('destination',{'location':[target.x,target.y,target.z],'name':'Gate 5 regression route'})
        assert route['source']=='CARLA_ROAD_GRAPH' and math.dist(route['points'][0],s.state['vehicle']['positionWorldM'])<5
        s.action('clear_route')
        proof['checks']['native_navigation_route']=True
        s.action('scenario',{'operation':'load','scenario_type':'SUDDEN_BRAKING','seed':1042,'split':'VALIDATION','difficulty':2})
        s.wait(lambda state:state['environment']['scenario_phase']=='READY')
        s.action('scenario',{'operation':'start'})
        s.action('recording',{'enabled':True});began=time.monotonic()
        while time.monotonic()-began<3:s.wait(lambda state:state['connected'])
        s.action('scenario',{'operation':'stop'})
        record=s.action('recording',{'enabled':False})
        reader=ReplayReader(record['path'])
        assert any('scenario_outcome' in e.payload for e in reader.events())
        assert reader.metadata.config['environment']['mode']=='TRAINING'
        proof['recordings'].append({'context':'TRAINING_VALIDATION','path':str(reader.root),'frames':len(reader.index)})
        proof['checks']['scenario_metadata_and_outcome_recorded']=True
        s.action('scenario',{'operation':'cleanup'})
        assert s.inventory()==dict(vehicles=1,walkers=0,controllers=0,sensors=7)
        proof['checks']['scenario_cleanup']=True
        proof['final_synchronization']=s.state['synchronization']
        proof['pass']=all(proof['checks'].values())
    Path('output/native-validation/gate5-regression.json').write_text(json.dumps(proof,indent=2),encoding='utf8')
    print(json.dumps(proof))


if __name__=='__main__':main()
