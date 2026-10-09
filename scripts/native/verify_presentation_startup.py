"""Read-only clean-start audit; never owns ticks, spawns actors or changes controls."""
import json
import math
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read(endpoint):
    with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/'+endpoint, timeout=10) as response:
        return json.load(response)


def main():
    import carla
    state = read('state')
    catalog = read('catalog')['settings']
    client = carla.Client('127.0.0.1', 2000)
    client.set_timeout(10)
    world = client.get_world()
    first = world.wait_for_tick(10)
    actors = world.get_actors()
    groups = {name: list(actors.filter(pattern)) for name, pattern in (
        ('vehicles', 'vehicle.*'), ('walkers', 'walker.pedestrian.*'),
        ('controllers', 'controller.ai.walker'), ('sensors', 'sensor.*'))}
    ego_id = state['vehicle']['actorId']
    initial = {a.id: first.find(a.id).get_transform().location for group in ('vehicles', 'walkers')
               for a in groups[group] if first.find(a.id)}
    deadline = time.monotonic()+5
    last = first
    while time.monotonic() < deadline:
        last = world.wait_for_tick(10)
    moved = {name: sum(last.find(a.id) is not None and a.id in initial and
                      last.find(a.id).get_transform().location.distance(initial[a.id]) > .5
                      for a in groups[name] if a.id != ego_id) for name in ('vehicles', 'walkers')}
    ego = initial[ego_id]
    nearby = {name: sum(a.id in initial and initial[a.id].distance(ego) <= 120
                       for a in groups[name] if a.id != ego_id) for name in ('vehicles', 'walkers')}
    report = {'source': 'CLEAN_START_POWERSHELL_AND_REAL_NATIVE_SNAPSHOTS',
              'versions': [client.get_client_version(), client.get_server_version()],
              'map': world.get_map().name, 'fixed_delta_seconds': world.get_settings().fixed_delta_seconds,
              'tick_owner': 'simulation-worker', 'mode': state['mode'], 'safety': state['safetySystem'],
              'catalog': catalog, 'initial_inventory': {k: len(v) for k, v in groups.items()},
              'population_admission': state['population'], 'moved_over_half_meter': moved,
              'within_120m_of_ego': nearby,
              'ego_distance_m': last.find(ego_id).get_transform().location.distance(ego),
              'observed_simulation_duration_s': last.timestamp.elapsed_seconds-first.timestamp.elapsed_seconds,
              'sensor_registry': state['sensorRegistry']}
    assert report['versions'] == ['0.9.16', '0.9.16']
    assert state['mode'] == 'PAUSED' and state['safetySystem']['controller'] == 'RULE' and state['safetySystem']['enabled']
    assert catalog['weather_preset'] == 'ClearNoon' and catalog['active_launch']['quality'] == 'Low'
    assert report['initial_inventory'] == {'vehicles': 41, 'walkers': 30, 'controllers': 30, 'sensors': 7}
    assert moved['vehicles'] > 0 and moved['walkers'] > 0 and nearby['vehicles'] > 0 and nearby['walkers'] > 0
    assert report['ego_distance_m'] < .1 and math.isclose(report['fixed_delta_seconds'], .05)
    report['status'] = 'PASS'
    (ROOT/'docs/evidence/urban_chaos/startup.json').write_text(json.dumps(report, indent=2), encoding='utf8')
    print(json.dumps({k: report[k] for k in ('status', 'initial_inventory', 'moved_over_half_meter', 'within_120m_of_ego', 'ego_distance_m')}, indent=2))


if __name__ == '__main__':
    main()
