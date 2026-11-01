"""Real HTTP/native observation and explicit negative controls, never synthetic native success."""
import argparse
import hashlib
import io
import json
import math
from pathlib import Path
import sys
import time
import unittest
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from backend.gta.provider import TICK


def rows(path):
    try:return [json.loads(line) for line in path.read_text().splitlines() if line]
    except (OSError, ValueError):return []


def api(base, path, data=None):
    request = urllib.request.Request(base+'/api/gta/'+path, data=json.dumps(data).encode() if data is not None else None,
                                     headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=3) as response:
        return json.load(response)


def image(base, state, kind, output):
    serial = state['image']['serial']
    with urllib.request.urlopen(base+f'/api/gta/image?serial={serial}&kind={kind}', timeout=3) as response:
        data = response.read();meta = {k: v for k, v in response.headers.items() if k.lower().startswith('x-gta-')}
    from PIL import Image
    im = Image.open(io.BytesIO(data));im.load()
    if im.size != (640, 360):raise ValueError('Actual HTTP native dimensions mismatch')
    if kind == 'rgb' and im.convert('RGB').tobytes() != (output/('capture-%06d.rgb' % serial)).read_bytes():
        raise ValueError('HTTP camera is not the actual matching native RGB')
    (output/('http-'+kind+'.png')).write_bytes(data)
    return {'serial': serial, 'kind': kind, 'sha256': hashlib.sha256(data).hexdigest(), 'headers': meta,
            'native_frame': state['image']['native_frame'], 'session': state['session_id']}


def live(output, base):
    deadline = time.monotonic()+410
    while time.monotonic() < deadline:
        try:
            s = api(base, 'state')
            if s['connected'] and s['image'] and s['vision']:break
        except (OSError, ValueError):pass
        time.sleep(.1)
    else:raise RuntimeError('No fresh actual HTTP/native/vision state')
    observed = [s];images = []
    for kind in ('rgb', 'depth'):
        s = api(base, 'state');images.append(image(base, s, kind, output))
    owner = api(base, 'acquire', {'client': 'native-acceptance'})
    conflict = False
    try:api(base, 'acquire', {'client': 'conflicting-client'})
    except urllib.error.HTTPError as e:conflict = e.code == 409
    sequence = 0
    def drive(seconds):
        nonlocal sequence
        end = time.monotonic()+seconds
        while time.monotonic() < end:
            s = api(base, 'state');observed.append(s)
            if not s['image'] or not s['connected']:
                time.sleep(.05);continue
            sequence += 1
            body = {'owner': owner['owner'], 'session_id': s['session_id'], 'sequence': sequence,
                    'source_frame': s['image']['native_frame'], 'steering': 0., 'throttle': .30, 'brake': 0.}
            try:api(base, 'control', body)
            except urllib.error.HTTPError as e:
                if e.code not in (400, 409):raise
            time.sleep(.07)
    started = TICK();drive(12);withdrawn = TICK()
    time.sleep(2)
    observed.append(api(base, 'state'))
    # Wait for browser-owner lease to expire; acquire a new owner explicitly.
    owner = api(base, 'acquire', {'client': 'capture-fault-acceptance'});sequence = 0
    second_start = TICK();drive(3)
    drop_at = TICK();(output/'drop-capture').touch()
    time.sleep(2)
    observed.append(api(base, 'state'))
    stale_image_rejected = False
    try:image(base, observed[-1], 'rgb', output)
    except (urllib.error.HTTPError, KeyError, TypeError):stale_image_rejected = True
    (output/'drop-capture').unlink()
    result = {'started_ms': started, 'client_withdrawn_ms': withdrawn, 'second_motion_ms': second_start,
              'capture_dropped_ms': drop_at, 'single_owner_conflict_rejected': conflict,
              'stale_image_rejected': stale_image_rejected, 'images': images, 'snapshots': observed}
    (output/'http-observed.json').write_text(json.dumps(result, indent=2))
    print(json.dumps({k: v for k, v in result.items() if k not in ('images', 'snapshots')}))


def finalize(output):
    recorded = json.loads((output/'http-observed.json').read_text())
    native = [r for r in rows(output/'bridge.jsonl') if r['frame']]
    captures = rows(output/'capture.jsonl');geom = rows(output/'geometry.jsonl');vision = rows(output/'live-vision.jsonl')
    motion = [r for r in native if recorded['started_ms'] <= r['host_ms'] <= recorded['client_withdrawn_ms']]
    origin = motion[0]['position'] if motion else None
    displacement = max((math.dist(origin, r['position']) for r in motion), default=0)
    peak = max((r['speed_mps'] for r in motion), default=0)
    def stopped_after(stamp, stale=False):
        group = [r for r in native if stamp+350 <= r['host_ms'] <= stamp+2000]
        return bool(group and any(r['speed_mps'] <= .2 and r['brake'] >= .99 and (not stale or r['sensor_stale']) for r in group))
    identity = bool(captures and native and all(c['run_id'] == native[0]['run_id'] and c['pid'] == native[0]['pid'] for c in captures))
    return {'motion_observed': bool(displacement >= 2 and peak >= .5 and peak <= 3.5 and any(r['throttle'] > .1 and r['sequence'] > 0 for r in motion)),
            'native_sensor_streams': bool(identity and len(captures) >= 100 and len(geom) >= 20 and len(vision) >= 40 and all(len(g['rays']) == 1080 for g in geom)),
            'deadline_stop_observed': stopped_after(recorded['client_withdrawn_ms']),
            'stale_sensor_stop_observed': stopped_after(recorded['capture_dropped_ms'], True) and recorded['stale_image_rejected'],
            'real_http_images': len(recorded['images']) == 2, 'local_single_owner': recorded['single_owner_conflict_rejected'],
            'maximum_displacement_m': displacement, 'motion_peak_speed_mps': peak,
            'moving_samples': len(motion), 'captured_frames': len(captures), 'vision_frames': len(vision),
            'mode': 'MANUAL_GUARDED_INSPECTION', 'full_migration_accepted': False, 'training_started': False,
            'carla_retirement_admitted': False}


def offline(output):
    suite = unittest.defaultTestLoader.discover(str(ROOT/'integrations/gta'), pattern='test_live_provider.py')
    result = unittest.TextTestRunner(verbosity=2).run(suite)
    summary = {'tests_run': result.testsRun, 'failures': len(result.failures), 'errors': len(result.errors),
               'negative_controls_passed': result.wasSuccessful() and result.testsRun >= 8, 'mode': 'OFFLINE_FIXTURES'}
    (output/'boundary.json').write_text(json.dumps(summary, indent=2))
    return int(not summary['negative_controls_passed'])


if __name__ == '__main__':
    parser = argparse.ArgumentParser();parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--offline', action='store_true');parser.add_argument('--url')
    args = parser.parse_args()
    if args.offline:raise SystemExit(offline(args.output))
    live(args.output, args.url)
