"""Standalone GTA inspection: launch, manual Story selection, automatic sensing.

No Codex, model client, UI robot, security change, or network download is used.
The existing owned native supervisor and its resource admission remain in force.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import shutil
import socket
import sys
import threading
import time
import unittest
from urllib.parse import urlsplit
import uuid
import webbrowser

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
for path in (PROJECT, HERE):
    if str(path) not in sys.path:
        sys.path.insert(0, str(path))
from backend.gta.provider import TICK, latest_json
import live_probe as live
import foundation_probe as foundation

BASE_BUDGET = live.boot.RuntimeBudget
PROJECT_GRANT_HASH = 'f8a94ad34a26f357425133cae44229840313b0e416138525a936bf126a2a69ea'


class ProjectValidationBudget:
    """Separate exact owner grant; never edits or resets the original GTA ledger."""
    def __init__(self, original_path):
        if original_path.resolve() != (HERE/'downloads/native-runtime-ledger.json').resolve():
            raise ValueError('Unexpected base ledger')
        grant_path = HERE/'downloads/project-runtime-authorization.json'
        data = grant_path.read_bytes()
        if hashlib.sha256(data).hexdigest() != PROJECT_GRANT_HASH:
            raise ValueError('The explicit project-validation authorization changed')
        grant = json.loads(data)
        if grant['limit_seconds'] != 600 or grant['scope'] != 'standalone Run-Project validation only':
            raise ValueError('Wrong scope or amount for project-validation authorization')
        self.path = HERE/'downloads/project-runtime-ledger.json'
        self.state = json.loads(self.path.read_text()) if self.path.exists() else dict(
            grant_id=grant['grant_id'], limit_seconds=600, charged_seconds=0., reservations=[])
        if self.state['grant_id'] != grant['grant_id'] or self.state['limit_seconds'] != 600:
            raise ValueError('Project-validation ledger changed grant identity')
        charges = sum(r['actual_seconds'] if r.get('finished') else r['reserved_seconds']
                      for r in self.state['reservations'])
        if not 0 <= self.state['charged_seconds'] <= 600 or abs(charges-self.state['charged_seconds']) > 1e-6:
            raise ValueError('Project-validation charges do not match retained reservations')

    def reserve(self, run_id):
        if any(r['id'] == run_id for r in self.state['reservations']):
            raise ValueError('Duplicate project-validation reservation')
        if self.state['charged_seconds']+live.boot.RESERVATION > self.state['limit_seconds']:
            raise ValueError('Insufficient separate project-validation allowance')
        item = dict(id=run_id, reserved_seconds=live.boot.RESERVATION, finished=False)
        self.state['reservations'].append(item)
        self.state['charged_seconds'] += live.boot.RESERVATION
        live.preflight.write_json(self.path, self.state)
        return item

    def finish(self, item, elapsed):
        if item['finished'] or not math.isfinite(elapsed) or not 0 <= elapsed <= item['reserved_seconds']:
            raise ValueError('Invalid project-validation close; full reservation retained')
        self.state['charged_seconds'] -= item['reserved_seconds']-elapsed
        item.update(finished=True, actual_seconds=elapsed)
        live.preflight.write_json(self.path, self.state)


def selected_budget():
    path = HERE/'downloads/native-runtime-ledger.json'
    base = BASE_BUDGET(path)
    if base.state['limit_seconds']-base.state['charged_seconds'] >= live.boot.RESERVATION:
        return BASE_BUDGET, base.state, 'original GTA allowance'
    if (HERE/'downloads/project-runtime-authorization.json').exists():
        extension = ProjectValidationBudget(path)
        return ProjectValidationBudget, extension.state, 'owner-approved standalone validation extension'
    return BASE_BUDGET, base.state, 'original GTA allowance'


def readiness(native, capture, geometry, run_id, now):
    """A menu, stale/foreign capture or partial scan is never a ready vehicle."""
    if not native or native.get('stage') != 'FOUNDATION_CALIBRATION':
        return False
    if not capture or not geometry or not native.get('ped_alive'):
        return False
    if not native.get('pid') or not native.get('frame') or not capture.get('serial'):
        return False
    if any(row.get('run_id') != run_id or row.get('pid') != native['pid'] for row in (native, capture, geometry)):
        return False
    clocks = (native.get('host_ms'), capture.get('native_host_ms'),
              capture.get('capture_end_ms'), geometry.get('host_ms'))
    if not all(type(t) in (int, float) and math.isfinite(t) and 0 <= now-t <= 350 for t in clocks):
        return False
    if not capture.get('rgb_ok') or not capture.get('depth_ok'):
        return False
    rays = geometry.get('rays', [])
    expected = {(a, e) for a in range(0, 360, 2) for e in (-6, -2, -.5, 0, 2, 6)}
    try:
        return (len(rays) == 1080 and {(r[0], r[1]) for r in rays} == expected and
                all(r[2] == 2 and r[3] in (0, 1) and math.isfinite(r[4]) and 0 <= r[4] <= 100 for r in rays))
    except (TypeError, IndexError, ValueError):
        return False


class ReadySequence:
    """Require three advancing native/camera/scan samples, not repeated polling."""
    def __init__(self):
        self.last = None
        self.count = 0

    def observe(self, native, capture, geometry, run_id, now):
        if not readiness(native, capture, geometry, run_id, now):
            self.last = None
            self.count = 0
            return False
        sample = (native['frame'], capture['serial'], geometry['frame'])
        if self.last is None:
            self.last, self.count = sample, 1
        elif all(a > b for a, b in zip(sample, self.last)):
            self.last = sample
            self.count += 1
        elif any(a < b for a, b in zip(sample, self.last)):
            self.last, self.count = sample, 1
        return self.count >= 3


def check():
    result = dict(check_completed=True, codex_required=False,
                  story_entry='MANUAL_STORY_SELECTION', native_started=False,
                  download_required=False, training_enabled=False, errors=[])
    try:
        _, budget, budget_source = selected_budget()
        remaining = budget['limit_seconds']-budget['charged_seconds']
        result.update(remaining_native_seconds=remaining, budget_source=budget_source,
                      required_reservation_seconds=live.boot.RESERVATION,
                      budget_admitted=remaining >= live.boot.RESERVATION)
        if not result['budget_admitted']:
            result['errors'].append('NATIVE_RUNTIME_ALLOWANCE_INSUFFICIENT')
        if foundation.elevated():
            result['errors'].append('ORDINARY_UNELEVATED_SESSION_REQUIRED')
        if live.boot.existing_native():
            result['errors'].append('NATIVE_HOST_ALREADY_OWNED')
        if not live.LAUNCHER.is_file():
            result['errors'].append('LOCAL_GAME_LAUNCHER_MISSING')
        live.assets()
        live.boot.inspect_candidate()
        result['game_version'] = live.preflight.file_version(live.preflight.GAME)
        if result['game_version'] != '1.0.1013.20':
            result['errors'].append('GAME_BUILD_NOT_QUALIFIED')
        required = math.ceil(1.5*640*360*7*10*120)+4*1024**3
        result['storage_required_bytes'] = required
        result['storage_free_bytes'] = shutil.disk_usage(PROJECT).free
        if result['storage_free_bytes'] < required:
            result['errors'].append('CAPTURE_STORAGE_INSUFFICIENT')
    except (OSError, ValueError, RuntimeError) as error:
        result['errors'].append(type(error).__name__+': '+str(error))
    result['launch_admitted'] = not result['errors']
    return result


def save(path, value):
    if path:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, indent=2), encoding='utf8')


def launch_status(directory, stop, state, *, calibrate, open_browser):
    tracker = ReadySequence()
    browser_opened = False
    try:
        while not stop.wait(.1):
            http = latest_json(directory/'http-ready.json')
            if http and not browser_opened:
                url = http.get('url', '')
                parsed = urlsplit(url)
                if parsed.scheme != 'http' or parsed.hostname != '127.0.0.1' or parsed.path != '/gta-live.html':
                    raise ValueError('Expected the owned loopback dashboard')
                print('Dashboard: '+url, flush=True)
                state['dashboard_url'] = url
                if open_browser:
                    state['browser_open_requested'] = bool(webbrowser.open_new_tab(url))
                browser_opened = True
            native = latest_json(directory/'bridge.jsonl')
            capture = latest_json(directory/'capture.jsonl')
            geometry = latest_json(directory/'geometry.jsonl')
            connected = tracker.observe(native, capture, geometry, state['run_id'], TICK())
            if connected and not state['native_connected']:
                state.update(native_connected=True, first_native_frame=native['frame'],
                             first_capture_serial=capture['serial'], phase='SENSORS_CONNECTED')
                if calibrate:
                    (directory/'foundation-startup-qualified').touch(exist_ok=False)
                    state['phase'] = 'CODE_CALIBRATION'
                print('Story detected. Live vehicle camera and geometric sensing connected.'+
                      (' Starting bounded code calibration.' if calibrate else ' Vehicle remains braked for inspection.'), flush=True)
                save(directory/'project-status.json', state)
    except Exception as error:
        state['monitor_error'] = type(error).__name__+': '+str(error)
        (directory/'cancel-sensor-probe').touch()


def run(args):
    preflight = check()
    if args.check:
        save(args.report, preflight)
        print(json.dumps(preflight, indent=2))
        return 0
    if not preflight['launch_admitted']:
        result = {**preflight, 'status': 'LAUNCH_BLOCKED', 'native_connected': False}
        save(args.report, result)
        print(json.dumps(result, indent=2))
        return 2
    directory = PROJECT/'.runtime-proof/gta-foundation-20261031/setup/project-sessions'/uuid.uuid4().hex
    directory.mkdir(parents=True)
    foundation.window_preferences(directory)
    live.build(directory, native_source='foundation_runtime.cpp', duration_ms=120000)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as choice:
        choice.bind(('127.0.0.1', 0))
        port = choice.getsockname()[1]
    request = dict(id=uuid.uuid4().hex, owner=uuid.uuid4().hex, port=port,
                   deadline=time.monotonic()+550, mode='FOUNDATION')
    save(directory/'sensor-request.json', request)
    state = dict(run_id=request['id'], runtime_directory=str(directory),
                 codex_required=False, story_entry='MANUAL_STORY_SELECTION',
                 native_connected=False, phase='WAITING_FOR_STORY',
                 training_enabled=False, calibration_requested=args.calibrate)
    print('Choose STORY, then Resume Story in GTA. The project connects automatically after real sensors appear.', flush=True)
    print('This is a bounded foundation session. Ctrl+C closes its owned game and server.', flush=True)
    save(directory/'project-status.json', state)
    stop = threading.Event()
    monitor = threading.Thread(target=launch_status, args=(directory, stop, state),
                               kwargs=dict(calibrate=args.calibrate, open_browser=not args.no_browser), daemon=True)
    original_job = live.boot.OwnedJob
    original_budget = live.boot.RuntimeBudget
    budget_factory, _, _ = selected_budget()

    class ObservedJob(original_job):
        def members(self):
            members = super().members()
            for pid in members:
                if pid not in live.GAME_TOKENS and live.boot.process_image(pid) == live.preflight.GAME.resolve():
                    live.GAME_TOKENS[pid] = foundation.token_elevation(pid)
                    if live.GAME_TOKENS[pid]:
                        raise RuntimeError('Unexpected elevated game')
            return members

    live.boot.OwnedJob = ObservedJob
    live.boot.RuntimeBudget = budget_factory
    monitor.start()
    interrupted = False
    try:
        native_result = live.native(directory, request)
    except KeyboardInterrupt:
        interrupted = True
        native_result = latest_json(directory/'live-result.json') or {}
    finally:
        stop.set()
        monitor.join(timeout=5)
        live.boot.OwnedJob = original_job
        live.boot.RuntimeBudget = original_budget
    result = {**state, **{k: native_result.get(k, False) for k in
              ('cleanup_confirmed', 'files_restored', 'protected_inputs_unchanged')}}
    result['error'] = native_result.get('error') or state.get('monitor_error')
    result['native_runtime_seconds'] = native_result.get('native_runtime_seconds')
    result['status'] = 'CANCELLED' if interrupted else 'SESSION_COMPLETE'
    result['passed'] = bool(state['native_connected'] and not result['error'] and
        all(result[k] for k in ('cleanup_confirmed', 'files_restored', 'protected_inputs_unchanged')))
    save(directory/'project-result.json', result)
    save(args.report, result)
    print(json.dumps(result, indent=2))
    return 130 if interrupted else int(not result['passed'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--calibrate', action='store_true')
    parser.add_argument('--no-browser', action='store_true')
    parser.add_argument('--report', type=Path)
    parser.add_argument('--test', action='store_true', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.test:
        suite = unittest.defaultTestLoader.loadTestsFromName('integrations.gta.test_project_runner')
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        save(args.report, {'passed': result.wasSuccessful(), 'tests': result.testsRun})
        return int(not result.wasSuccessful())
    return run(args)


if __name__ == '__main__':
    raise SystemExit(main())
