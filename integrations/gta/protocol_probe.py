"""Qualify the unchanged native bridge using stationary, brake-only fault packets.

The isolated probe server wraps the real provider's transport; the production
server, native command parser, sensor writer and watchdogs are not replaced.
All generated packets request zero throttle and full brake, including invalid
ones. This is a qualification runner, never a driving or training controller.
"""
import argparse
import hashlib
import json
import math
from pathlib import Path
import socket
import subprocess
import sys
import time
import unittest
import uuid

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parents[1]
TASK = PROJECT / '.runtime-proof/gta-foundation-20261031/setup/native-protocol-20261101'
if str(PROJECT) not in sys.path:
    sys.path.insert(0, str(PROJECT))
from backend.gta.provider import COMMAND, TICK

FAULTS = {
    'REPLAY': (3, 5, 'rejected_replay'),
    'WRONG_NONCE': (6, 8, 'rejected_owner'),
    'WRONG_PORT': (9, 11, 'rejected_owner'),
    'EXPIRED': (12, 14, 'rejected_stale'),
    'FUTURE': (15, 17, 'rejected_stale'),
    'NONFINITE': (18, 20, 'rejected_owner'),
    'TRUNCATED': (21, 23, 'rejected_owner'),
    'WRONG_VERSION': (24, 26, 'rejected_owner'),
}
GAPS = {'LEASE_GAP': (27, 30, 'lease_expired'),
        'CAPTURE_GAP': (34, 37, 'sensor_stale')}


def read_rows(path):
    """Read completed JSONL rows; a partial last write is not an observation."""
    if not path.exists():
        return []
    rows = []
    for line in path.read_bytes().splitlines():
        try:
            value = json.loads(line)
        except ValueError:
            continue
        if isinstance(value, dict):
            rows.append(value)
    return rows


def phase_at(seconds):
    for name, (start, end, _) in {**FAULTS, **GAPS}.items():
        if start <= seconds < end:
            return name
    return 'HOLD'


class FaultTransport:
    """Real UDP sockets with explicit, logged fault injection in this probe only."""
    def __init__(self, provider):
        self.provider = provider
        self.actual = provider.socket
        self.other = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.other.bind(('127.0.0.1', 0))
        self.started = None
        self.log = (provider.directory/'protocol-injections.jsonl').open('a', encoding='utf8')
        self.capture_gap = provider.directory/'drop-capture'
        self.owns_capture_gap = False

    def record(self, value):
        self.log.write(json.dumps(value, allow_nan=False)+'\n')
        self.log.flush()

    def sendto(self, raw, destination):
        if destination != ('127.0.0.1', self.provider.request['port']):
            raise ValueError('Probe is restricted to its owned loopback bridge')
        fields = list(COMMAND.unpack(raw))
        if fields[7:] != [0., 1.] or fields[6] != 0.:
            raise ValueError('Only stationary brake packets are authorized')
        now = TICK()
        native = self.provider.last_native or {}
        if self.started is None and native.get('frame') and (self.provider.capture or {}).get('serial', 0) >= 10:
            self.started = now
        elapsed = (now-self.started)/1000 if self.started is not None else -1
        phase = phase_at(elapsed)
        if phase == 'CAPTURE_GAP' and not self.owns_capture_gap:
            self.capture_gap.touch(exist_ok=False)
            self.owns_capture_gap = True
        elif phase != 'CAPTURE_GAP' and self.owns_capture_gap:
            self.capture_gap.unlink()
            self.owns_capture_gap = False
        common = {'host_ms': now, 'elapsed_s': elapsed, 'phase': phase,
                  'valid_sequence': fields[3], 'native_sequence': native.get('sequence'),
                  'run_id': self.provider.session_id}
        if phase == 'LEASE_GAP':
            self.record({**common, 'event': 'withheld'})
            return len(raw)
        sent = self.actual.sendto(raw, destination)
        self.record({**common, 'event': 'valid_sent'})
        if phase not in FAULTS:
            return sent
        counter = FAULTS[phase][2]
        bad = fields.copy()
        bad[2] = 11  # Rejection must also leave the mounted camera facing forward.
        bad[3] += 1_000_000
        sender = self.actual
        if phase == 'REPLAY':
            bad[3] = fields[3]
        elif phase == 'WRONG_NONCE':
            bad[5] = (b'1' if fields[5][:1] != b'1' else b'2') + fields[5][1:]
        elif phase == 'WRONG_PORT':
            sender = self.other
        elif phase == 'EXPIRED':
            bad[4] = now-1
        elif phase == 'FUTURE':
            bad[4] = now+10_000
        elif phase == 'NONFINITE':
            bad[6] = float('nan')
        elif phase == 'WRONG_VERSION':
            bad[1] = 2
        invalid = COMMAND.pack(*bad)
        if phase == 'TRUNCATED':
            invalid = invalid[:-1]
        sender.sendto(invalid, destination)
        self.record({**common, 'event': 'fault_sent', 'counter': counter,
                     'baseline': native.get(counter, 0), 'invalid_sequence': bad[3],
                     'alternate_port': sender is self.other, 'bytes': len(invalid),
                     'packet_sha256': hashlib.sha256(invalid).hexdigest()})
        return sent

    def close(self):
        if self.owns_capture_gap:
            self.capture_gap.unlink(missing_ok=True)
        self.other.close()
        self.actual.close()
        self.log.close()


def serve(directory, port):
    from backend.gta import server
    factory = server.create_provider

    def probe_factory(name, **options):
        provider = factory(name, **options, start=False)
        if not provider.foundation or (directory/'foundation-startup-qualified').exists():
            provider.close()
            raise ValueError('Stationary foundation only; driving calibration is forbidden')
        provider.socket = FaultTransport(provider)
        provider.thread.start()
        return provider

    server.create_provider = probe_factory
    try:
        server.serve(directory, port=port, duration=470)
    finally:
        server.create_provider = factory


def assess(trace, captures, views, events, run_id, pids):
    native = [r for r in trace if r.get('stage') == 'FOUNDATION_CALIBRATION']
    identity = bool(len(native) >= 100 and len(captures) >= 100 and pids and
                    all(r.get('run_id') == run_id and r.get('pid') in pids for r in trace+captures) and
                    all(e.get('run_id') == run_id for e in events) and
                    len({r['frame'] for r in native}) >= 100 and
                    len({r['serial'] for r in captures}) >= 100)
    faults = {}
    for phase, (_, _, counter) in FAULTS.items():
        sent = [e for e in events if e.get('event') == 'fault_sent' and e.get('phase') == phase]
        observed = [r for r in native if sent and sent[0]['host_ms'] <= r['host_ms'] <= sent[-1]['host_ms']+500]
        faults[phase] = bool(sent and observed and
                             max(r[counter] for r in observed) > sent[0]['baseline'])
    # A sentinel sequence is always above ordinary commands in this bounded run.
    ordinary = [e['valid_sequence'] for e in events if e.get('event') == 'valid_sent']
    invalid_high = [e['invalid_sequence'] for e in events if e.get('event') == 'fault_sent' and e.get('phase') != 'REPLAY']
    sequence_ok = bool(ordinary and invalid_high and native and
                       max(r['sequence'] for r in native) < min(invalid_high) and
                       max(r['sequence'] for r in native) <= max(ordinary))
    camera_ok = bool(len(views) >= 100 and all(v['yaw_offset_deg'] == 0 for v in views))
    watchdogs = {}
    for phase, (_, _, flag) in GAPS.items():
        gap = [e for e in events if e.get('phase') == phase]
        start = gap[0]['host_ms'] if gap else -1
        end = gap[-1]['host_ms'] if gap else -1
        during = [r for r in native if start+700 <= r['host_ms'] <= end]
        recovered = [r for r in native if end+700 <= r['host_ms'] <= end+2500]
        watchdogs[phase] = bool(gap and len(during) >= 5 and len(recovered) >= 5 and
            all(r[flag] and r['throttle'] == 0 and r['brake'] >= .99 and r['speed_mps'] < .15 for r in during) and
            any(not r[flag] and not r['lease_expired'] and not r['sensor_stale'] for r in recovered) and
            max(r['sequence'] for r in recovered) > max(r['sequence'] for r in during))
        if phase == 'CAPTURE_GAP':
            watchdogs[phase] &= bool(recovered and during and
                max(r['capture_ms'] for r in recovered) > max(r['capture_ms'] for r in during))
    settled = [e['host_ms'] for e in events if e.get('elapsed_s', -1) >= 3]
    active = [r for r in native if settled and r['host_ms'] >= settled[0]]
    stationary = bool(active and all(math.isfinite(r['speed_mps']) and r['speed_mps'] < .15 and
        r['throttle'] == 0 and r['brake'] >= .99 for r in active))
    result = dict(protocol_rejections=all(faults.values()) and sequence_ok and camera_ok,
                  watchdogs_and_recovery=all(watchdogs.values()), live_identity=identity,
                  stationary=stationary, faults=faults, watchdogs=watchdogs,
                  no_sentinel_acknowledgment=sequence_ok, camera_unchanged=camera_ok,
                  native_observations=len(native), captured_frames=len(captures),
                  max_speed_mps=max((r['speed_mps'] for r in active), default=None))
    result['passed'] = all(result[k] for k in ('protocol_rejections', 'watchdogs_and_recovery', 'live_identity', 'stationary'))
    return result


def native(output):
    import live_probe as live
    import foundation_probe as foundation
    directory = output/'native'
    directory.mkdir()
    foundation.window_preferences(directory)
    live.build(directory, native_source='foundation_runtime.cpp', duration_ms=45000)
    with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as choice:
        choice.bind(('127.0.0.1', 0))
        port = choice.getsockname()[1]
    request = dict(id=uuid.uuid4().hex, owner=uuid.uuid4().hex, port=port,
                   deadline=time.monotonic()+550, mode='FOUNDATION')
    live.preflight.write_json(directory/'sensor-request.json', request)
    original_popen, original_job = subprocess.Popen, live.boot.OwnedJob

    def launch(argv, *args, **kwargs):
        if isinstance(argv, list) and '-m' in argv and 'backend.server' in argv:
            http_port = argv[argv.index('--port')+1]
            argv = [sys.executable, '-B', str(Path(__file__).resolve()), '--serve', str(directory), '--port', http_port]
        return original_popen(argv, *args, **kwargs)

    class ObservedJob(original_job):
        def members(self):
            members = super().members()
            for pid in members:
                if pid not in live.GAME_TOKENS and live.boot.process_image(pid) == live.preflight.GAME.resolve():
                    live.GAME_TOKENS[pid] = foundation.token_elevation(pid)
                    if live.GAME_TOKENS[pid]:
                        raise RuntimeError('Unexpected elevated native game')
            return members

    subprocess.Popen, live.boot.OwnedJob = launch, ObservedJob
    try:
        supervisor = live.native(directory, request)
    finally:
        subprocess.Popen, live.boot.OwnedJob = original_popen, original_job
    result = assess(read_rows(directory/'bridge.jsonl'), read_rows(directory/'capture.jsonl'),
                    read_rows(directory/'camera-views.jsonl'), read_rows(directory/'protocol-injections.jsonl'),
                    request['id'], supervisor.get('owned_game_pids', []))
    for field in ('cleanup_confirmed', 'files_restored', 'protected_inputs_unchanged'):
        result[field] = bool(supervisor.get(field))
    result['normal_token'] = bool(supervisor.get('owned_game_pids') and
        all(live.GAME_TOKENS.get(p) is False for p in supervisor['owned_game_pids']))
    ledger = live.boot.RuntimeBudget(HERE/'downloads/native-runtime-ledger.json').state
    result['budget_respected'] = not supervisor.get('budget_error') and ledger['charged_seconds'] <= 10800
    result['remaining_native_seconds'] = 10800-ledger['charged_seconds']
    result['native_runtime_seconds'] = supervisor['native_runtime_seconds']
    result['supervisor_error'] = supervisor.get('error')
    result['passed'] &= all(result[k] for k in ('cleanup_confirmed', 'files_restored',
        'protected_inputs_unchanged', 'normal_token', 'budget_respected')) and not result['supervisor_error']
    result.update(training_started=False, human_recording=False, full_migration_accepted=False,
                  scope='STATIONARY_NATIVE_PROTOCOL_ONLY')
    live.preflight.write_json(output/'protocol-result.json', result)
    print(json.dumps(result, indent=2))
    return int(not result['passed'])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path)
    parser.add_argument('--offline', action='store_true')
    parser.add_argument('--serve', type=Path)
    parser.add_argument('--port', type=int)
    args = parser.parse_args()
    if args.serve:
        directory = args.serve.resolve()
        if not directory.is_relative_to(TASK/'runs/native-protocol'):
            raise ValueError('Explicit owned protocol runtime only')
        serve(directory, args.port)
        return 0
    if not args.output:
        parser.error('--output required')
    output = args.output.resolve()
    for parent in (args.output, *args.output.parents):
        if parent.exists() and getattr(parent.stat(), 'st_file_attributes', 0) & 0x400:
            raise ValueError('Reparse proof path refused')
    if args.offline:
        suite = unittest.defaultTestLoader.loadTestsFromName('integrations.gta.test_protocol_probe')
        result = unittest.TextTestRunner(verbosity=2).run(suite)
        (output/'negative-results.json').write_text(json.dumps({'passed': result.wasSuccessful(), 'tests': result.testsRun}))
        return int(not result.wasSuccessful())
    if output.parent != TASK/'runs/native-protocol':
        raise ValueError('Native proof collector run path required')
    return native(output)


if __name__ == '__main__':
    raise SystemExit(main())
