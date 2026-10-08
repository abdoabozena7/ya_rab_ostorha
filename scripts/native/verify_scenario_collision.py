"""Native outcome acceptance with a controlled stationary vehicle impact."""
import json
from pathlib import Path
import time
from backend.carla.scenarios import canonical_transform, native_transform
from backend.core.contracts import from_dict, Transform, to_dict
from .verify_urban_world import Session


def main():
    import carla
    proof={'source':'LIVE_NATIVE','checks':{}}
    with Session() as s:
        s.action('scenario',{'operation':'load','scenario_type':'FRONT_OBSTACLE','seed':2042,'split':'TEST','difficulty':1})
        s.wait(lambda state:state['environment']['scenario_phase']=='READY')
        spec=s.state['environment']['scenario']
        ego=s.world.get_map().get_spawn_points()[spec['ego_spawn']]
        wp=s.world.get_map().get_waypoint(ego.location)
        obstacle=wp.next(8.)[0].transform;obstacle.location.z+=.3
        spec['scenario_id']='front_obstacle_collision_regression'
        spec['other_actor_definitions'][0]['transform']=to_dict(canonical_transform(obstacle))
        s.action('scenario',{'operation':'load','spec':spec})
        s.wait(lambda state:state['environment']['scenario_phase']=='READY')
        s.action('recording',{'enabled':True})
        s.action('scenario',{'operation':'start'})
        s.send('start_driving');began=time.monotonic()
        while s.state['environment']['scenario_phase']=='RUNNING' and time.monotonic()-began<60:
            s.send('controls',frame_id=s.state['vehicle']['frame'],timestamp_s=s.state['vehicle']['timestamp'],
                controls={'throttle':.4,'brake':0,'steering':0,'parkingbrake':0,'gear':1})
        s.send('stop_driving')
        outcome=s.state['environment']['outcome']
        assert outcome is not None,outcome
        assert outcome['reason']=='failure_condition',outcome
        assert outcome['metrics']['collision_count']>=1,outcome
        assert outcome['metrics']['collision_callback_count']>=1,outcome
        assert outcome['metrics']['collision_peak_impulse_ns']>0,outcome
        assert not outcome['scenario_success'] and not outcome['safety_policy_enabled']
        record=s.action('recording',{'enabled':False})
        from backend.core.replay import ReplayReader
        reader=ReplayReader(record['path']);events=list(reader.events())
        assert any('scenario_outcome' in event.payload for event in events)
        assert any(event.event_type.value=='CollisionDetected' for event in events)
        proof['outcome']=outcome;proof['recording']=record['path']
        proof['checks'].update(real_collision_callback=True,scenario_collision_count=True,
            native_impulse_recorded=True,failure_condition=True,recorded_outcome=True,no_policy=True)
        s.action('scenario',{'operation':'cleanup'})
        assert s.inventory()==dict(vehicles=1,walkers=0,controllers=0,sensors=7)
        proof['checks']['cleanup']=True;proof['pass']=True
    Path('output/native-validation/gate5-scenario-collision.json').write_text(json.dumps(proof,indent=2),encoding='utf8')
    print(json.dumps(proof))


if __name__=='__main__':main()
