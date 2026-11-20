"""Independent physical goal scoring; safe standing never equals arrival."""
import argparse
import ctypes
import io
import json
import math
from pathlib import Path
import sys
import time
import unittest
import urllib.request
import urllib.error
import numpy as np
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from backend.gta.provider import TICK, latest_json


def rows(path):
    result = []
    try:
        with path.open() as f:
            for line in f:
                try:result.append(json.loads(line))
                except ValueError:pass
    except OSError:pass
    return result


def live(output, url):
    def get(path):
        with urllib.request.urlopen(url+path, timeout=4) as f:return json.load(f)
    deadline = time.monotonic()+430
    started = None
    observed = {'single_owner_conflict_rejected': False, 'real_http_images': False}
    while time.monotonic() < deadline:
        route = latest_json(output/'route-map.jsonl')
        if route and route.get('error'):
            observed['route_error'] = route['error'];(output/'cancel-sensor-probe').touch();break
        try:
            state = get('/api/gta/state')
            if not state['connected'] or not state.get('vision'):
                time.sleep(.1);continue
            if started is None:
                started = time.monotonic()
                observed['first_live_ms'] = TICK()
                for kind in ('rgb', 'depth'):
                    serial = state['image']['serial']
                    with urllib.request.urlopen(url+f'/api/gta/image?serial={serial}&kind={kind}', timeout=3) as f:
                        data = f.read();metadata = dict(f.headers)
                    image = Image.open(io.BytesIO(data));image.load()
                    if image.size != (640, 360):raise ValueError('Wrong live image')
                    if kind == 'rgb':
                        expected = np.fromfile(output/('capture-%06d.rgb'%serial), np.uint8).reshape(360, 640, 3)
                        if not np.array_equal(np.asarray(image), expected):raise ValueError('RGB byte mismatch')
                    (output/('http-'+kind+'.png')).write_bytes(data)
                observed['real_http_images'] = True
                req = urllib.request.Request(url+'/api/gta/acquire', data=b'{"client":"negative-second-owner"}', headers={'Content-Type': 'application/json'})
                try:urllib.request.urlopen(req, timeout=3)
                except urllib.error.HTTPError as e:observed['single_owner_conflict_rejected'] = e.code == 409
            elapsed = time.monotonic()-started
            if elapsed >= 35 and 'owner_loss_ms' not in observed:
                observed['owner_loss_ms'] = TICK();(output/'drop-goal-commands').touch();time.sleep(2)
                (output/'drop-goal-commands').unlink();observed['owner_restored_ms'] = TICK()
            if elapsed >= 42 and 'capture_loss_ms' not in observed:
                observed['capture_loss_ms'] = TICK();(output/'drop-capture').touch();time.sleep(2)
                try:urllib.request.urlopen(url+f"/api/gta/image?serial={state['image']['serial']}&kind=rgb", timeout=3)
                except urllib.error.HTTPError as e:observed['stale_image_rejected'] = e.code == 503
                (output/'drop-capture').unlink();observed['capture_restored_ms'] = TICK()
            if state.get('goal', {}).get('actual_command', {}).get('reason') == 'DESTINATION_REACHED':break
            (output/'goal-http-observed.json').write_text(json.dumps(observed, indent=2))
            time.sleep(.2)
        except (OSError, ValueError, KeyError):
            time.sleep(.1)
    (output/'goal-http-observed.json').write_text(json.dumps(observed, indent=2))


def finalize(output):
    native = [r for r in rows(output/'bridge.jsonl') if r.get('stage') in ('CITY_FLOW', 'CITY_LOCAL_JAM', 'DONE')]
    goals = rows(output/'goal-driver.jsonl');flow = rows(output/'flow-evaluation.jsonl')
    pop = rows(output/'urban.jsonl');captures = rows(output/'capture.jsonl');vision = rows(output/'live-vision.jsonl')
    obs = latest_json(output/'goal-http-observed.json') or {}
    reverse_distance = 0.
    for a, b in zip(native, native[1:]):
        signed = np.dot(b['velocity'], b['forward'])
        if signed < -.1 and b['host_ms']-a['host_ms'] < 500:
            reverse_distance += float(np.linalg.norm(np.asarray(b['position'])-a['position']))
    moving = [r for r in native if r['speed_mps'] > .5]
    displacement = max((float(np.linalg.norm(np.asarray(r['position'])-native[0]['position'])) for r in native), default=0.)
    new_contacts = sum(bool(r.get('contact')) for r in native if r['phase_s'] > 2)
    completed = any(g.get('actual_command', {}).get('reason') == 'DESTINATION_REACHED' for g in goals)
    aligned = sum(f['aligned'] for f in flow);total_moving = sum(f['moving'] for f in flow)
    finite = bool(flow and pop and total_moving >= 10 and aligned/total_moving >= .8
                  and any(f['blocker_released'] for f in flow)
                  and min(p['cars_alive'] for p in pop) == 60 and min(p['pedestrians_on_foot'] for p in pop) == 100)
    def stopped(key, field):
        t = obs.get(key)
        return bool(t and any(t+350 <= r['host_ms'] <= t+2000 and r['speed_mps'] <= .2
                             and r['brake'] >= .99 and r.get(field) for r in native))
    owner_stop = stopped('owner_loss_ms', 'lease_expired');capture_stop = stopped('capture_loss_ms', 'sensor_stale')
    left_escape = False
    for i, r in enumerate(native):
        if np.dot(r['velocity'], r['forward']) < -.1:
            delta = np.asarray(native[-1]['position'])-r['position']
            if np.dot(delta, -np.asarray(r['right'])) >= 1 and np.linalg.norm(delta) >= 15:left_escape = True
    result = {'finite_flow_observed': finite, 'reverse_escape_observed': bool(reverse_distance >= .75 and left_escape and new_contacts == 0),
              'destination_reached': bool(completed and new_contacts == 0), 'fault_stops_observed': owner_stop and capture_stop,
              'native_sensor_streams': len(captures) >= 100 and len(vision) >= 40,
              'real_http_images': bool(obs.get('real_http_images')), 'local_single_owner': bool(obs.get('single_owner_conflict_rejected')),
              'motion_observed': displacement >= 2 and bool(moving), 'deadline_stop_observed': owner_stop,
              'stale_sensor_stop_observed': capture_stop, 'reverse_distance_m': reverse_distance,
              'maximum_displacement_m': displacement, 'contact_flagged_samples': new_contacts,
              'local_forward_fraction': aligned/total_moving if total_moving else None,
              'progress_m': max((g.get('progress_m', 0) for g in goals), default=0),
              'last_driver': goals[-1] if goals else None, 'full_migration_accepted': False,
              'training_started': False, 'carla_retirement_admitted': False, 'mode': 'PROJECT_HYBRID_RULE_BASELINE'}
    (output/'goal-measurements.json').write_text(json.dumps(result, indent=2, allow_nan=False))
    return result


def main():
    p = argparse.ArgumentParser();p.add_argument('--output', type=Path, required=True);p.add_argument('--url');p.add_argument('--offline', action='store_true');a = p.parse_args()
    if a.offline:
        suite = unittest.TestLoader().discover(str(Path(__file__).parent), pattern='test_goal_driver.py')
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        (a.output/'boundary.json').write_text(json.dumps({'negative_controls_passed': result.wasSuccessful(), 'tests': result.testsRun}))
        return int(not result.wasSuccessful())
    live(a.output, a.url);return 0


if __name__ == '__main__':raise SystemExit(main())
