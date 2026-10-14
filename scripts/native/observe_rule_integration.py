"""Read-only observer for a journey started by the actual dashboard. Never ticks."""
import json
import argparse
import math
from pathlib import Path
import time
import urllib.request


def main():
    root = Path(__file__).resolve().parents[2]
    parser=argparse.ArgumentParser()
    parser.add_argument('--output',type=Path,default=root/'docs/evidence/native_rule_integration_20261012')
    args=parser.parse_args();output=args.output;output.mkdir(parents=True,exist_ok=True)
    began = time.monotonic(); seen = False; samples = []; last = -30.
    while time.monotonic() - began < 600:
        with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/state', timeout=5) as response:
            state = json.load(response)
        comparison = state.get('comparisonV2') or {}
        seen |= comparison.get('phase') == 'RUNNING'
        if time.monotonic() - last >= 20:
            last = time.monotonic()
            row = {'observer_wall_s': round(last-began,2), 'phase': comparison.get('phase'),
                'mode': state['mode'], 'speed_kmh': state['vehicle']['speedKmh'],
                'recording': state['recording'], 'reason': state['safetySystem'].get('reason'),
                'remaining_s': comparison['budget']['remaining_s']}
            samples.append(row); print(json.dumps(row), flush=True)
        if seen and comparison.get('phase') == 'FINISHED':
            import carla
            client=carla.Client('127.0.0.1',2000); client.set_timeout(10)
            world=client.get_world(); world.wait_for_tick(10)  # populate this observer's SDK cache; never world.tick()
            actor=world.get_actor(state['vehicle']['actorId'])
            if actor is None: raise RuntimeError('Actual native ego unavailable')
            snapshot=world.get_snapshot()
            if snapshot.frame <= 0 or world.get_actor(actor.id) is None:
                raise RuntimeError('Native SDK returned no valid world snapshot; arrival remains unverified')
            position=actor.get_location(); velocity=actor.get_velocity()
            pair=json.loads((root/'output/comparison_v2/active-pair.json').read_text())
            distance=math.dist((position.x,position.y,position.z),pair['destination']['location'])
            speed=math.sqrt(velocity.x**2+velocity.y**2+velocity.z**2)
            pose={'source':'independent CARLA SDK observer; never ticks', 'actor_id':actor.id,
                'world_frame':snapshot.frame, 'position_m':[position.x,position.y,position.z],
                'speed_mps':speed,'destination_distance_m':distance,
                'arrival_verified':bool(distance<=5. and speed<.15),
                'control':{'throttle':actor.get_control().throttle,'brake':actor.get_control().brake}}
            (output/'native-terminal-state.json').write_text(json.dumps(state,indent=2),encoding='utf8')
            (output/'independent-arrival.json').write_text(json.dumps(pose,indent=2),encoding='utf8')
            (output/'observer-samples.json').write_text(json.dumps(samples,indent=2),encoding='utf8')
            print(json.dumps({'status':comparison['latest_attempt']['status'],**pose}),flush=True)
            return
        time.sleep(1)
    raise TimeoutError('Native journey did not finish within the observer window')


if __name__=='__main__': main()
