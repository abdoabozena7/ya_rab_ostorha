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
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', default='docs/evidence/presentation_demo/native.json')
    parser.add_argument('--source', default='REAL_CARLA_DASHBOARD_BUTTONS')
    args = parser.parse_args()
    with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/state', timeout=10) as response:
        state = json.load(response)
    demo = state['comparisonDemo']
    if set(demo['results']) != {'WITHOUT', 'WITH'}:
        raise RuntimeError('Finish both real dashboard runs before auditing recordings')
    report = {'source': args.source, 'tick_owner': 'simulation-worker',
              'initial_conditions_match': demo['initial_conditions_match'], 'runs': {}}
    full_results = []
    for mode, summary in demo['results'].items():
        root = Path(summary['recording'])
        full = json.loads((root/'comparison-result.json').read_text())
        full_results.append(full)
        reader = ReplayReader(root)
        trace = [json.loads(row) for row in (root/'telemetry/comparison-controls.jsonl').read_text().splitlines()]
        frames = list(reader.frames())
        assert [row['frame_id'] for row in trace] == [frame.frame_id for frame in frames]
        assets = 0
        applied_safety = 0
        mismatches = []
        resumed = False
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
            if (frame.timestamp_s-full['run']['start_states']['timestamp_s'] > 7 and
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
        report['runs'][mode] = {'recording': str(root), 'frames': len(frames), 'checked_assets': assets,
            'collision_events': len(collisions), 'collision_impulses_ns': [math.hypot(*c['impulse_ns']) for c in collisions],
            'metrics': metrics, 'outcome': full['status'], 'completed': full['completed'],
            'applied_safety_frames': applied_safety, 'command_application_mismatches': mismatches,
            'resumed_after_hazard': resumed, 'replay_camera': 'PASS',
            'initial_condition_id': full['run']['comparison_initial_condition_id']}
    assert full_results[0]['run']['comparison_configuration'] == full_results[1]['run']['comparison_configuration']
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
    assert report['actor_inventory'] == {'vehicles': 2, 'sensors': 7, 'walkers': 0, 'walker_controllers': 0}
    report['recording'] = 'PASS'
    target = ROOT/args.output
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(report, indent=2), encoding='utf8')
    print(json.dumps(report, indent=2))


if __name__ == '__main__': main()
