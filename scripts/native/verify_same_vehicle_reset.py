"""Verify fresh, identical native Mercedes and sensors at each held arm start."""
import hashlib
import json
from pathlib import Path
import time
from backend.carla.runtime import NativeRuntime
from backend.carla.provider import CarlaProvider
from backend.carla.comparison_vehicle import physical_configuration

ROOT=Path(__file__).resolve().parents[2]


def main():
    runtime=NativeRuntime()
    if runtime.active:raise RuntimeError('The held reset probe requires the native engine to be stopped')
    report={'source':'LIVE_NATIVE_CARLA','scope':'Held same-vehicle lifecycle and initial-condition audit; not a driving trial',
            'arms':[],'passed':False}
    provider=None;started=time.monotonic()
    try:
        import carla
        runtime.launch({'quality':'Epic','resolution':'1280x720','render_profile':'HIGH','offscreen':True},'127.0.0.1',2000,carla)
        provider=CarlaProvider(blueprint='vehicle.mercedes.coupe_2020',spawn_index=152,
            sensor_suite=True,collision_sensor=True,fresh_start=True,traffic_manager_port=8052)
        provider.connect();provider._ensure_dashboard_tools()
        provider.population.apply({**provider.population.config,'vehicle_count':0,'pedestrian_count':0})
        waypoint=provider.dashboard_tools.map.get_waypoint(provider.ego.actor.get_location())
        for _ in range(20):
            choices=waypoint.next(2.)
            waypoint=min(choices,key=lambda point:abs((point.transform.rotation.yaw-waypoint.transform.rotation.yaw+180)%360-180))
        location=waypoint.transform.location
        provider.dashboard_tools.set_destination({'location':[location.x,location.y,location.z],'name':'Held reset audit'})
        provider.set_controls(brake=1)
        for _ in range(20):provider.step()
        provider.hold_prepared_presentation()
        previous_actor=provider.ego.actor.id
        for mode in ('NORMAL','ROBOSPHERE'):
            provider.select_presentation_vehicle(mode);provider.benchmark_fixture.restore()
            for _ in range(10):provider.step()
            actor=provider.ego.actor
            audit=provider.benchmark_fixture.verify()
            registry=provider.sensor_registry()
            physical=physical_configuration(actor)
            report['arms'].append({'mode':mode,'actor_id':actor.id,'previous_actor_id':previous_actor,
                'fresh_actor':actor.id!=previous_actor,'blueprint':actor.type_id,'color':actor.attributes.get('color'),
                'initial_condition_audit':audit,'physical_configuration':physical,
                'sensors':{key:{field:value for field,value in config.items() if field in (
                    'blueprint','attributes','mountTransform','sensorTickSeconds','requestedRateHz')}
                    for key,config in registry.items()}})
            previous_actor=actor.id
        first,second=report['arms']
        report['passed']=all(arm['fresh_actor'] and arm['initial_condition_audit']['passed'] for arm in report['arms']) and all(
            first[key]==second[key] for key in ('blueprint','color','physical_configuration','sensors'))
    except Exception as error:
        import traceback
        report.update(error=str(error),traceback=traceback.format_exc())
    finally:
        if provider:
            try:provider.close();report['native_cleanup_confirmed']=not provider.cleanup_errors
            except Exception as error:report['cleanup_error']=str(error)
        runtime.stop();report['runtime_returned_to_stopped']=runtime.active is None
        report['wall_s']=time.monotonic()-started
        report['source_sha256']={str(path.relative_to(ROOT)):hashlib.sha256(path.read_bytes()).hexdigest() for path in (
            Path(__file__),ROOT/'backend/carla/provider.py',ROOT/'backend/carla/comparison_vehicle.py')}
        path=ROOT/'docs/evidence/sensor-comparison-20261019/same-vehicle-reset.json';path.parent.mkdir(parents=True,exist_ok=True)
        path.write_text(json.dumps(report,indent=2,allow_nan=False)+'\n',encoding='utf8')
        print(json.dumps({key:value for key,value in report.items() if key not in ('arms','source_sha256','traceback')},indent=2))
    return 0 if report['passed'] else 1


if __name__=='__main__':raise SystemExit(main())
