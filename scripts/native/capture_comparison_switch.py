"""Read-only proof of a real dashboard switch; never changes CARLA or owns ticks."""
import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
EVIDENCE = ROOT/'docs/evidence/urban_chaos'


def main():
    deadline = time.monotonic()+30
    while time.monotonic() < deadline:
        with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/state', timeout=10) as response:
            state = json.load(response)
        demo = state['comparisonDemo']
        if demo['mode'] == 'WITH' and demo['phase'] in ('RUNNING', 'FINISHED') and demo['metrics']['elapsed_simulation_s'] > 1:
            break
        time.sleep(.2)
    else:
        raise TimeoutError('Switch did not start fresh WITH run')
    before = json.loads((EVIDENCE/'switch-before.json').read_text(encoding='utf8'))
    prior = next(row for row in reversed(demo['archive']) if row['mode'] == 'WITHOUT')
    full = json.loads((Path(prior['recording'])/'comparison-result.json').read_text(encoding='utf8'))
    admitted = json.loads((Path(demo['recording'])/'metadata.json').read_text(encoding='utf8'))
    new_run = admitted['config']['environment']['run']
    new_initial = new_run['initial_states']['actors']
    initial_counts = {kind: sum(row['blueprint'].startswith(prefix) for row in new_initial)
                      for kind, prefix in (('vehicles', 'vehicle.'), ('walkers', 'walker.pedestrian.'))}
    import carla
    client = carla.Client('127.0.0.1', 2000)
    client.set_timeout(10)
    world = client.get_world()
    world.wait_for_tick(10)
    actors = world.get_actors()
    alive = {actor.id for actor in actors}
    initial = full['run']['initial_states']
    old_ids = {actor['actor_id'] for actor in initial['actors']} | {sensor['actorId'] for sensor in initial['sensor_registry'].values()}
    counts = {name: len(actors.filter(pattern)) for name, pattern in (
        ('vehicles', 'vehicle.*'), ('walkers', 'walker.pedestrian.*'),
        ('controllers', 'controller.ai.walker'), ('sensors', 'sensor.*'))}
    report = {'source': 'FINAL_REAL_DASHBOARD_SWITCH_DURING_RUNNING_WITHOUT',
              'before_phase': before['phase'], 'before_timer_s': before['metrics']['elapsed_simulation_s'],
              'prior_end_reason': full['outcome']['reason'],
              'prior_duration_s': full['outcome']['metrics']['elapsed_simulation_s'],
              'prior_completed': full['completed'], 'after_phase': demo['phase'], 'after_mode': demo['mode'],
              'after_timer_s': demo['metrics']['elapsed_simulation_s'],
              'after_interventions': demo['metrics']['safety_intervention_count'],
              'safety': state['safetySystem'], 'native_inventory': counts,
              'admitted_initial_actor_counts': initial_counts,
              'initial_intervention_count': admitted['config']['ya_rab_ostorha']['status']['intervention_count'],
              'initial_manifest_matches': new_run['comparison_initial_condition_id'] == full['run']['comparison_initial_condition_id'],
              'remaining_previous_actor_or_sensor_ids': sorted(old_ids & alive),
              'previous_recording': prior['recording'], 'new_recording': demo['recording']}
    assert before['phase'] == 'RUNNING' and full['outcome']['reason'] == 'switched' and not full['completed']
    assert not old_ids & alive and counts['vehicles'] <= 41 and counts['walkers'] <= 30 and counts['controllers'] <= 30 and counts['sensors'] == 7
    assert initial_counts == {'vehicles': 41, 'walkers': 30} and report['initial_intervention_count'] == 0 and report['initial_manifest_matches']
    assert state['safetySystem']['enabled'] and state['safetySystem']['controller'] == 'RULE'
    report['status'] = 'PASS'
    (EVIDENCE/'switching-final.json').write_text(json.dumps(report, indent=2), encoding='utf8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
