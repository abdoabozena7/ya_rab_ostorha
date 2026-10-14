"""Short, operator-authorized NORMAL drive on the live native CARLA session.

Uses the dashboard's production WebSocket commands. It does not tick CARLA,
alter persistent preferences, or treat one collision-free interval as proof of
general safety. The ego car is stopped in the cleanup path.
"""

import argparse
from collections import Counter
import json
from pathlib import Path
import statistics
import time

from .evaluate_drive_experience import ObservationSession


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--duration', type=float, default=40)
    parser.add_argument('--speed', type=float, default=20)
    parser.add_argument('--mode', choices=('NORMAL', 'ROBOSPHERE'), default='NORMAL')
    parser.add_argument('--output', default='output/normal-navigation/native-smoke.json')
    args = parser.parse_args()
    output = Path(args.output)
    output.parent.mkdir(parents=True, exist_ok=True)
    rows = []
    contacts = {}
    started_wall = time.monotonic()
    with ObservationSession() as session:
        session.wait(lambda s: s['mode'] == 'PAUSED' and s['vehicle']['speedMagnitudeMps'] < .15)
        start_position = session.state['canonical']['vehicle']['transform']['position_m']
        # This point is ahead of the default Town10HD_Opt spawn, on its street.
        session.action('destination', {'location': [-36.883373, -68.379028, 0.],
                                       'name': 'NORMAL sensor drive check'})
        route = session.state.get('route') or {}
        if not route or route.get('remaining_m', 0) < 20:
            raise RuntimeError(f'Expected an established forward route; got {route!r}')
        initial_remaining = route['remaining_m']
        started_sim = session.state['vehicle']['timestamp']
        initial_interventions = session.state['safetySystem']['intervention_count']
        try:
            session.send('start_journey', speed_kmh=args.speed, driving_mode=args.mode)
            session.wait(lambda s: s['journey']['status'] in ('RUNNING', 'ARRIVED', 'FAILED'))
            deadline = time.monotonic() + args.duration
            while time.monotonic() < deadline:
                session.send('journey_heartbeat', session_id=session.state['sessionId'])
                s = session.state
                v = s['vehicle']
                safety = s['safetySystem']
                stop = s['stopDiagnostics']
                route = s.get('route') or {}
                rows.append({
                    'frame': v['frame'], 'timestamp_s': v['timestamp'],
                    'speed_kmh': v['speedKmh'], 'position_m': s['canonical']['vehicle']['transform']['position_m'],
                    'remaining_m': route.get('remaining_m'), 'journey_status': s['journey']['status'],
                    'brake': v['brake'], 'throttle': v['throttle'],
                    'decision_source': stop['decision_source'], 'stop_reason': stop['reason'],
                    'risk': safety['risk'], 'actual_generator': safety['actual_generator'],
                    'rear_assist': s.get('rearAssist'),
                    'forward_gap_m': (safety.get('nearest_object') or {}).get('distance_m'),
                    'sensor_wall_age_s': stop.get('sensor_wall_age_s'),
                    'sensor_ages_s': stop.get('sensor_ages_s'),
                    'road_coverage_m': safety.get('observed_road_range_m'),
                    'native_tick_hz': (s.get('performance') or {}).get('nativeTickRateHz'),
                })
                for event in s.get('collisionEvents') or []:
                    if event['timestamp_s'] >= started_sim:
                        contacts[(event['frame_id'], event['other_actor_id'])] = event
                if s['journey']['status'] not in ('STARTING', 'RUNNING'):
                    break
                time.sleep(.2)
        finally:
            final_journey = dict(session.state['journey'])
            final_remaining = (session.state.get('route') or {}).get('remaining_m')
            interventions = session.state['safetySystem']['intervention_count'] - initial_interventions
            session.send('stop_driving', reason='native_smoke_complete')
            session.wait(lambda s: s['vehicle']['speedMagnitudeMps'] < .15)
            result = {
                'source': 'LIVE_NATIVE_CARLA', 'scope': f'single short {args.mode} drive; not general collision-safety proof',
                'duration_wall_s': round(time.monotonic() - started_wall, 2),
                'target_speed_kmh': args.speed, 'initial_position_m': start_position,
                'initial_remaining_m': initial_remaining, 'final_remaining_m': final_remaining,
                'max_speed_kmh': max((r['speed_kmh'] for r in rows), default=0),
                'moving_samples': sum(r['speed_kmh'] > 1 for r in rows),
                'sample_count': len(rows),
                'actual_generators': dict(Counter(r['actual_generator'] for r in rows)),
                'braking_reasons': dict(Counter(r['stop_reason'] for r in rows if r['brake'] > .01)),
                'rear_assist_samples': sum(bool(r['rear_assist']) for r in rows),
                'collision_callback_count': len(contacts), 'collision_events': list(contacts.values()),
                'interventions': interventions, 'final_journey': final_journey,
                'final_mode': session.state['mode'], 'final_speed_kmh': session.state['vehicle']['speedKmh'],
                'sensor_errors': session.state.get('sensorErrors'), 'rows': rows,
                'median_native_tick_hz': statistics.median(
                    r['native_tick_hz'] for r in rows if isinstance(r['native_tick_hz'], (int, float))) if any(
                    isinstance(r['native_tick_hz'], (int, float)) for r in rows) else None,
            }
            output.write_text(json.dumps(result, indent=2), encoding='utf8')
            print(json.dumps({k: v for k, v in result.items() if k not in ('rows', 'collision_events')},
                             default=str), flush=True)


if __name__ == '__main__':
    main()
