"""Read-only audit of the two dashboard runs; never owns CARLA ticks.

Click the comparison buttons first, then run this compact recording/replay audit.
"""
import json
import math
from pathlib import Path
import urllib.request
from backend.core.replay import ReplayReader
from backend.replay_service import ReplayService
from backend.core.recording import resolve_asset
from backend.core.events import EventType

ROOT = Path(__file__).resolve().parents[2]


def main():
    with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/state', timeout=10) as response:
        state = json.load(response)
    demo = state['comparisonDemo']
    if set(demo['results']) != {'WITHOUT', 'WITH'}:
        raise RuntimeError('Finish both real dashboard runs before auditing recordings')
    report = {'source': 'REAL_CARLA_DASHBOARD_BUTTONS', 'tick_owner': 'simulation-worker',
              'initial_conditions_match': demo['initial_conditions_match'], 'runs': {}}
    full_results = []
    for mode, summary in demo['results'].items():
        root = Path(summary['recording'])
        full = json.loads((root/'comparison-result.json').read_text())
        metadata = json.loads((root/'metadata.json').read_text())
        recorded_manifest = metadata['config']['environment']['run']
        assert metadata['data_origin'] == 'REAL_SIMULATION' and metadata['seed'] == 2589
        assert recorded_manifest['comparison_initial_condition_id'] == full['run']['comparison_initial_condition_id']
        assert recorded_manifest['comparison_mode'] == mode and recorded_manifest['safety_policy_enabled'] == (mode == 'WITH')
        assert metadata['config']['ya_rab_ostorha']['status']['controller'] == 'RULE'
        full_results.append(full)
        reader = ReplayReader(root)
        trace = [json.loads(row) for row in (root/'telemetry/comparison-controls.jsonl').read_text().splitlines()]
        frames = list(reader.frames())
        assert full['completed'] and abs(full['outcome']['metrics']['elapsed_simulation_s']-60)<.051
        assert full['run']['spec']['random_seed']==2589
        assert len(full['run']['spec']['other_actor_definitions'])==40 and len(full['run']['spec']['pedestrian_definitions'])==30
        assert [row['frame_id'] for row in trace] == [frame.frame_id for frame in frames]
        assets = 0
        applied_safety = 0
        mismatches = []
        resumed = False
        first_hazard_release_s = full['run']['spec']['metadata']['vehicle_plans']['sudden_brake']['release_s']
        for frame in frames:
            for sensor in frame.sensors:
                if sensor.asset:
                    resolve_asset(root, sensor.asset)
                    assets += 1
            command = frame.control
            if command and command.source.value == 'SAFETY' and command.gear == 1:
                applied_safety += 1
                if max(abs(getattr(command, k)-getattr(frame.vehicle, k)) for k in ('throttle','brake','steering')) > 1e-5:
                    mismatches.append(frame.frame_id)
            if (frame.timestamp_s-full['run']['start_states']['timestamp_s'] > first_hazard_release_s and
                    frame.vehicle.speed_mps > 1 and command and command.source.value == 'NAVIGATION' and frame.vehicle.brake == 0):
                resumed = True
        events = list(reader.events())
        collisions = [event.payload['collision'] for event in events if event.event_type == EventType.CollisionDetected]
        metrics = full['outcome']['metrics']
        replay = ReplayService(reader)
        replay.set_paused(True)
        replay.seek(frames[len(frames)//2].timestamp_s)
        image, metadata = replay.get_camera_frame()
        assert image and metadata and replay.snapshot()['mode'] == 'REPLAY'
        replay.close()
        assert bool(collisions) == full['collision']
        assert not mismatches
        assert all(frame.complete for frame in frames)
        assert bool(full['run']['safety_policy_enabled']) == (mode == 'WITH')
        observed=full['run']['hazard_observations']
        statuses={name:sorted({row.get('hazard_actors',{}).get(name,{}).get('status','UNOBSERVED') for row in trace}) for name in observed}
        assert all(row['safety']['controller'] == 'RULE' and row['safety']['enabled'] == (mode == 'WITH')
                   and row['safety']['source_counts']['LEARNED_BC'] == 0 for row in trace)
        assert 'BRAKING' in statuses['sudden_brake'] and 'MOVING' in statuses['cut_in']
        assert any('road_observed_at_s' in observed[n] for n in ('crossing_0','crossing_1'))
        assert observed['curb_up'].get('sidewalk_observed_at_s') is not None
        report['runs'][mode] = {'recording': str(root), 'frames': len(frames), 'checked_assets': assets,
            'collision_events': len(collisions), 'collision_impulses_ns': [math.hypot(*c['impulse_ns']) for c in collisions],
            'metrics': metrics, 'outcome': full['status'], 'completed': full['completed'],
            'applied_safety_frames': applied_safety, 'command_application_mismatches': mismatches,
            'resumed_after_hazard': resumed, 'replay_camera': 'PASS',
            'hazard_observations':observed,'hazard_statuses':statuses,
            'initial_condition_id': full['run']['comparison_initial_condition_id'], 'recording_metadata': 'PASS'}
    configs=[{k:v for k,v in r['run']['comparison_configuration'].items() if k!='actual_initial_states'} for r in full_results]
    assert configs[0]==configs[1]
    assert any(r['run']['hazard_observations']['curb_return'].get('road_reentry_observed_at_s') is not None for r in full_results)
    report['native_pose_audit']=demo['native_pose_audit']
    report['manifest']=configs[0]
    report['trajectory_matching']='Identical starts and hazard plan; NPC trajectories can diverge after ego intervention.'
    assert report['initial_conditions_match']
    import carla
    client = carla.Client('127.0.0.1', 2000)
    client.set_timeout(10)
    world = client.get_world()
    world.wait_for_tick(10)  # Receive the existing owner's snapshot; never tick.
    actors = world.get_actors()
    report['versions'] = [client.get_server_version(), client.get_client_version()]
    report['actor_inventory'] = {'vehicles': len(actors.filter('vehicle.*')), 'sensors': len(actors.filter('sensor.*')),
        'walkers': len(actors.filter('walker.pedestrian.*')), 'walker_controllers': len(actors.filter('controller.ai.walker'))}
    counts=report['actor_inventory']
    assert counts['vehicles']<=41 and counts['sensors']==7 and counts['walkers']<=30 and counts['walker_controllers']<=30
    report['native_actor_losses']={name:row for name,row in demo['hazards'].items() if row.get('status')=='NATIVE_ACTOR_LOST'}
    report['recording'] = 'PASS'
    target = ROOT/'docs/evidence/urban_chaos'
    target.mkdir(parents=True, exist_ok=True)
    (target/'native.json').write_text(json.dumps(report, indent=2), encoding='utf8')
    print(json.dumps({k:v for k,v in report.items() if k!='manifest'}, indent=2))


if __name__ == '__main__': main()
