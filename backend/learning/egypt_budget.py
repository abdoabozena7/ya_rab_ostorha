"""Explicit Egypt-only allowance, crash charges and cross-process simulator lease."""
from contextlib import closing, contextmanager
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path
import sqlite3
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / 'output' / 'egypt-validation'
OWNERSHIP = DIRECTORY / 'simulator-owner.json'
PROGRESS = DIRECTORY / 'progress.json'
RELOCATION_LOCK = ROOT / 'output' / 'recording-relocations' / 'relocation.lock'
CAP_SECONDS = 14400.
PHASE_SECONDS = 7200.
SCOPE = 'EGYPT_NATIVE_VALIDATION_V1'
DEVELOPMENT_EXTENSION_ID = 'EGYPT_DEVELOPMENT_20261027'
DEVELOPMENT_EXTENSION_SECONDS = 7200.
DIAGNOSTIC_EXTENSION_ID = 'EGYPT_DIAGNOSTIC_20261029T091733Z_ef402517'
DIAGNOSTIC_EXTENSION_SECONDS = 3600.
DIAGNOSTIC_EXTENSIONS = {
    DIAGNOSTIC_EXTENSION_ID: DIAGNOSTIC_EXTENSION_SECONDS,
    'EGYPT_DIAGNOSTIC_20261030T182659Z_78014d28': 10800.,
}
BROWSER_SECONDS = 480.
DEVELOPMENT_RESERVE_SECONDS = PHASE_SECONDS + BROWSER_SECONDS


def effective_caps(extensions):
    """Only explicitly authorized, immutable extensions change the cap."""
    if not isinstance(extensions, list):
        raise ValueError('Egypt allowance extensions must be an explicit list')
    authorized = {DEVELOPMENT_EXTENSION_ID: ('DEVELOPMENT', DEVELOPMENT_EXTENSION_SECONDS),
                  **{key: ('DIAGNOSTIC', seconds) for key, seconds in DIAGNOSTIC_EXTENSIONS.items()}}
    seen = set()
    for entry in extensions:
        if (not isinstance(entry, dict) or not isinstance(entry.get('id'), str)
                or entry['id'] not in authorized or entry['id'] in seen
                or entry.get('phase') != authorized[entry['id']][0]
                or type(entry.get('seconds')) not in (int, float)
                or entry['seconds'] != authorized[entry['id']][1]):
            raise ValueError('Unknown, duplicate or invalid Egypt development authorization')
        seen.add(entry['id'])
    development = PHASE_SECONDS + sum(authorized[key][1] for key in seen)
    return {'cap_s': development + PHASE_SECONDS, 'development_cap_s': development,
            'acceptance_cap_s': PHASE_SECONDS}


def extension_schema(db):
    db.execute('CREATE TABLE IF NOT EXISTS extensions (id TEXT PRIMARY KEY, phase TEXT NOT NULL, '
               'seconds REAL NOT NULL, created_at_utc TEXT NOT NULL, prior_ledger_sha256 TEXT NOT NULL)')
    for operation in ('UPDATE', 'DELETE'):
        db.execute(f'CREATE TRIGGER IF NOT EXISTS immutable_extensions_{operation.lower()} '
                   f'BEFORE {operation} ON extensions BEGIN '
                   "SELECT RAISE(ABORT, 'Egypt authorization records are immutable'); END")


def save_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    temporary.write_text(json.dumps(value, indent=2, allow_nan=False), encoding='utf8')
    temporary.replace(path)


def process_alive(pid):
    if type(pid) is not int or pid <= 0:
        return False
    if os.name == 'nt':
        import ctypes
        kernel = ctypes.WinDLL('kernel32', use_last_error=True)
        kernel.OpenProcess.restype = ctypes.c_void_p
        kernel.GetExitCodeProcess.argtypes = (ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong))
        kernel.CloseHandle.argtypes = (ctypes.c_void_p,)
        handle = kernel.OpenProcess(0x1000, False, pid)
        if not handle:
            return False
        try:
            code = ctypes.c_ulong()
            return bool(kernel.GetExitCodeProcess(handle, ctypes.byref(code)) and code.value == 259)
        finally:
            kernel.CloseHandle(handle)
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False


def ownership_status():
    if not OWNERSHIP.exists():
        return {'reserved': False, 'active': False}
    try:
        ticket = json.loads(OWNERSHIP.read_text(encoding='utf8'))
        active = process_alive(ticket['owner_pid']) and time.monotonic() < ticket['expires_monotonic_s']
        return {'reserved': True, 'active': active, 'stage': ticket['stage'],
                'phase': ticket['phase'], 'reservation_id': ticket['reservation_id'],
                'reason': 'Egypt native cleanup is incomplete; its ownership lock and evidence are retained'
                    if ticket['stage'] == 'CLEANUP_REQUIRED' else 'Egypt native validation exclusively owns CARLA' if active else
                    'Interrupted Egypt reservation retained; inspect its evidence and native cleanup before recovery'}
    except (OSError, ValueError, KeyError, TypeError) as error:
        return {'reserved': True, 'active': False, 'reason': 'Cannot verify Egypt simulator ownership: ' + str(error)}


def active_ticket():
    """Only the reserving process and explicitly delegated workers may use it."""
    if not os.environ.get('OSTORHA_EGYPT_RESERVATION'):
        return None
    try:
        ticket = json.loads(OWNERSHIP.read_text(encoding='utf8'))
        if (ticket['reservation_id'] != os.environ['OSTORHA_EGYPT_RESERVATION']
                or str(Path(ticket['budget']).resolve()) != os.environ.get('OSTORHA_EGYPT_BUDGET')
                or not process_alive(ticket['owner_pid']) or time.monotonic() >= ticket['expires_monotonic_s']):
            return None
        delegated = float(os.environ.get('OSTORHA_EGYPT_DEADLINE', ticket['expires_monotonic_s']))
        if not time.monotonic() < delegated <= ticket['expires_monotonic_s']:
            return None
        budget = EgyptBudget(ticket['budget'])
        with closing(budget.connect()) as db:
            row = db.execute('SELECT outcome FROM reservations WHERE id=?', (ticket['reservation_id'],)).fetchone()
        return {**ticket, 'expires_monotonic_s': delegated} if row == ('RUNNING',) else None
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
        return None


def require_simulator_access(*, shutdown=False):
    if not shutdown and RELOCATION_LOCK.exists():
        raise RuntimeError('Closed-recording relocation exclusively owns storage; native start is blocked')
    state = ownership_status()
    if state['reserved'] and active_ticket() is None:
        if shutdown and state.get('active') and state.get('stage') == 'HANDOFF':
            return
        if shutdown and state.get('reservation_id') and not state.get('active'):
            return
        if shutdown and state.get('reservation_id') == os.environ.get('OSTORHA_EGYPT_RESERVATION'):
            return
        raise RuntimeError(state['reason'])


def inherited_session_duration(requested=None):
    if not os.environ.get('OSTORHA_EGYPT_RESERVATION'):
        return requested
    ticket = active_ticket()
    if ticket is None:
        raise ValueError('The inherited Egypt reservation is expired or cannot be verified')
    remaining = ticket['expires_monotonic_s'] - time.monotonic()
    return min(requested, remaining) if requested is not None else remaining


def require_stopped_storage_access():
    from ..carla.runtime import native_processes
    if native_processes() or ownership_status()['reserved'] and active_ticket() is None:
        raise RuntimeError('Lossless recording compression requires CARLA stopped and no foreign native reservation')


def remaining_seconds(deadline, maximum):
    remaining = min(maximum, deadline - time.monotonic())
    if remaining <= 0:
        raise TimeoutError('Egypt native worker deadline expired')
    return remaining


class EgyptBudget:
    def __init__(self, directory=DIRECTORY):
        self.directory = Path(directory).resolve()
        self.path = self.directory / 'budget.sqlite'
        self.authorization = self.directory / 'allowance.json'
        ticket = json.loads(self.authorization.read_text(encoding='utf8'))
        if (ticket.get('scope') != SCOPE or ticket.get('cap_s') != CAP_SECONDS
                or ticket.get('development_cap_s') != PHASE_SECONDS or ticket.get('acceptance_cap_s') != PHASE_SECONDS
                or not self.path.is_file()):
            raise ValueError('Invalid base Egypt allowance; extensions require a separate authorization record')

    def connect(self):
        return sqlite3.connect(self.path.as_uri() + '?mode=rw', uri=True)

    @classmethod
    def create(cls, directory=DIRECTORY):
        directory = Path(directory).resolve()
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / 'allowance.json'
        database = directory / 'budget.sqlite'
        if database.exists():
            raise ValueError('An existing Egypt ledger cannot be reset')
        # Exclusive creation deliberately refuses to reset an existing authorization.
        with path.open('x', encoding='utf8') as stream:
            json.dump({'scope': SCOPE, 'cap_s': CAP_SECONDS, 'development_cap_s': PHASE_SECONDS,
                       'acceptance_cap_s': PHASE_SECONDS, 'created_at_utc': datetime.now(timezone.utc).isoformat(),
                       'authorization': 'Separate four-hour Egypt allowance; no research or RULE extension'}, stream, indent=2)
        with closing(sqlite3.connect(database)) as db:
            db.execute('CREATE TABLE reservations (id TEXT PRIMARY KEY, phase TEXT NOT NULL, reserved_s REAL NOT NULL, '
                       'charged_s REAL NOT NULL, started REAL NOT NULL, deadline REAL NOT NULL, owner_pid INTEGER NOT NULL, '
                       'outcome TEXT NOT NULL, elapsed_s REAL, report TEXT NOT NULL)')
            db.execute('CREATE TABLE attempts (reservation_id TEXT NOT NULL, seed INTEGER NOT NULL, first_mode TEXT NOT NULL, '
                       'source_sha256 TEXT NOT NULL, outcome TEXT NOT NULL, report TEXT, '
                       'PRIMARY KEY (reservation_id,seed,first_mode))')
            db.commit()
        return cls(directory)

    def status(self):
        with closing(self.connect()) as db:
            db.row_factory = sqlite3.Row
            rows = [dict(row) for row in db.execute('SELECT * FROM reservations ORDER BY started')]
            exists = db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='extensions'").fetchone()
            extensions = [dict(row) for row in db.execute('SELECT * FROM extensions ORDER BY created_at_utc')] if exists else []
            diagnostic = [row for row in extensions if row['phase'] == 'DIAGNOSTIC']
            usage = []
            if diagnostic:
                for entry in diagnostic:
                    provenance = db.execute('SELECT provenance_json,provenance_sha256 FROM diagnostic_authorizations '
                                            'WHERE id=?', (entry['id'],)).fetchone()
                    if (provenance is None or hashlib.sha256(provenance['provenance_json'].encode('utf8')).hexdigest()
                            != provenance['provenance_sha256']):
                        raise ValueError('Diagnostic authorization provenance is missing or changed')
                usage = [dict(row) for row in db.execute('SELECT * FROM diagnostic_usage')]
        caps = effective_caps(extensions)
        reservations = {row['id']: row for row in rows}
        for item in usage:
            reservation = reservations.get(item['reservation_id'])
            if (reservation is None or reservation['phase'] != 'DEVELOPMENT'
                    or any(type(item[key]) not in (int, float) or not math.isfinite(item[key]) or item[key] < 0
                           for key in ('original_headroom_s', 'charged_s'))
                    or not math.isclose(item['charged_s'], max(0., reservation['charged_s'] - item['original_headroom_s']),
                                        rel_tol=0., abs_tol=1e-8)):
                raise ValueError('Diagnostic-only funding does not match its reservation charge')
        charged = {phase: sum(row['charged_s'] for row in rows if row['phase'] == phase)
                   for phase in ('DEVELOPMENT', 'ACCEPTANCE')}
        development_remaining = max(0., caps['development_cap_s'] - charged['DEVELOPMENT'])
        diagnostic_used = sum(row['charged_s'] for row in usage)
        diagnostic_extension_remaining = max(0., sum(row['seconds'] for row in diagnostic) - diagnostic_used)
        return {'kind': SCOPE, 'authorized': True, 'path': str(self.directory), **caps,
                'base_cap_s': CAP_SECONDS, 'extensions': extensions,
                'charged_s': sum(charged.values()), 'remaining_s': max(0., caps['cap_s'] - sum(charged.values())),
                'development_remaining_s': development_remaining,
                'diagnostic_remaining_s': max(0., development_remaining - DEVELOPMENT_RESERVE_SECONDS),
                'diagnostic_extension_remaining_s': diagnostic_extension_remaining,
                'diagnostic_extension_charged_s': diagnostic_used,
                'non_diagnostic_development_remaining_s': max(0., development_remaining - diagnostic_extension_remaining),
                'protected_development_matrix_s': PHASE_SECONDS, 'protected_browser_s': BROWSER_SECONDS,
                'acceptance_remaining_s': max(0., PHASE_SECONDS - charged['ACCEPTANCE']),
                'unfinished': sum(row['outcome'] == 'RUNNING' for row in rows),
                'acceptance_attempted': any(row['phase'] == 'ACCEPTANCE' for row in rows),
                'reservations': rows,
                'sha256': hashlib.sha256(self.path.read_bytes()).hexdigest()}

    def extend_development(self, authorization_id):
        effective_caps([{'id': authorization_id, 'phase': 'DEVELOPMENT',
                         'seconds': DEVELOPMENT_EXTENSION_SECONDS}])
        before = self.status()
        if before['unfinished'] or ownership_status()['reserved']:
            raise ValueError('Finalize native ownership before recording the development extension')
        with closing(self.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            extension_schema(db)
            if db.execute('SELECT 1 FROM extensions WHERE id=?', (authorization_id,)).fetchone():
                return False
            db.execute('INSERT INTO extensions VALUES (?,?,?,?,?)', (authorization_id, 'DEVELOPMENT',
                       DEVELOPMENT_EXTENSION_SECONDS, datetime.now(timezone.utc).isoformat(), before['sha256']))
            db.commit()
        return True

    def extend_diagnostic(self, authorization_id, authorization_file):
        seconds = DIAGNOSTIC_EXTENSIONS.get(authorization_id)
        effective_caps([{'id': authorization_id, 'phase': 'DIAGNOSTIC',
                         'seconds': seconds}])
        raw = Path(authorization_file).read_bytes()
        provenance = raw.decode('utf8')
        data = json.loads(provenance)
        if (not isinstance(data, dict) or data.get('authorization_id') != authorization_id
                or type(data.get('maximum_additional_diagnostic_seconds')) not in (int, float)
                or data['maximum_additional_diagnostic_seconds'] != seconds
                or data.get('protected_development_matrix_seconds') != PHASE_SECONDS
                or data.get('protected_browser_seconds') != BROWSER_SECONDS
                or data.get('protected_one_shot_acceptance_seconds') != PHASE_SECONDS
                or not isinstance(data.get('exact_authorization_text'), str)
                or not data['exact_authorization_text'].strip()
                or not isinstance(data.get('message_timestamp'), str) or not data['message_timestamp'].strip()
                or data.get('origin') != 'USER_STATED_CURRENT_MESSAGE'):
            raise ValueError('Exact diagnostic authorization, message provenance and protected windows are required')
        digest = hashlib.sha256(raw).hexdigest()
        before = self.status()
        if before['unfinished'] or ownership_status()['reserved']:
            raise ValueError('Finalize native ownership before recording the diagnostic extension')
        with closing(self.connect()) as db:
            db.execute('BEGIN IMMEDIATE')
            extension_schema(db)
            db.execute('CREATE TABLE IF NOT EXISTS diagnostic_authorizations '
                       '(id TEXT PRIMARY KEY, provenance_json TEXT NOT NULL, provenance_sha256 TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS diagnostic_usage (reservation_id TEXT PRIMARY KEY, '
                       'original_headroom_s REAL NOT NULL, charged_s REAL NOT NULL)')
            for operation in ('UPDATE', 'DELETE'):
                db.execute(f'CREATE TRIGGER IF NOT EXISTS immutable_diagnostic_authorizations_{operation.lower()} '
                           f'BEFORE {operation} ON diagnostic_authorizations BEGIN '
                           "SELECT RAISE(ABORT, 'Egypt diagnostic provenance is immutable'); END")
            stored = db.execute('SELECT provenance_json,provenance_sha256 FROM diagnostic_authorizations '
                                'WHERE id=?', (authorization_id,)).fetchone()
            if stored is not None:
                if stored != (provenance, digest):
                    raise ValueError('Existing diagnostic authorization provenance cannot be changed')
                return False
            db.execute('INSERT INTO extensions VALUES (?,?,?,?,?)', (authorization_id, 'DIAGNOSTIC',
                       seconds, datetime.now(timezone.utc).isoformat(), before['sha256']))
            db.execute('INSERT INTO diagnostic_authorizations VALUES (?,?,?)',
                       (authorization_id, provenance, digest))
            db.commit()
        return True

    @contextmanager
    def experiment(self, phase, seconds, report, *, purpose=None):
        if RELOCATION_LOCK.exists():
            raise RuntimeError('Finalize closed-recording relocation before reserving native work')
        if (phase not in ('DEVELOPMENT', 'ACCEPTANCE') or type(seconds) not in (float, int)
                or not math.isfinite(seconds) or not 0 < seconds <= PHASE_SECONDS
                or phase == 'ACCEPTANCE' and seconds != PHASE_SECONDS):
            raise ValueError('Each Egypt reservation is at most 7200 seconds; acceptance reserves exactly 7200 seconds')
        if (purpose not in (None, 'DIAGNOSTIC', 'MATRIX', 'BROWSER')
                or purpose in ('DIAGNOSTIC', 'BROWSER') and phase != 'DEVELOPMENT'
                or purpose == 'BROWSER' and seconds != BROWSER_SECONDS
                or purpose == 'MATRIX' and seconds != PHASE_SECONDS):
            raise ValueError('Invalid Egypt reservation purpose or protected window duration')
        key, started = uuid.uuid4().hex, time.monotonic()
        ticket = {'budget': str(self.directory), 'reservation_id': key, 'phase': phase, 'stage': 'HANDOFF',
                  'purpose': purpose, 'owner_pid': os.getpid(), 'expires_monotonic_s': started + seconds}
        OWNERSHIP.parent.mkdir(parents=True, exist_ok=True)
        with OWNERSHIP.open('x', encoding='utf8') as stream:
            json.dump(ticket, stream)
        reserved = False
        diagnostic_headroom = None
        old_environment = {key: os.environ.get(key) for key in ('OSTORHA_EGYPT_BUDGET', 'OSTORHA_EGYPT_RESERVATION')}
        try:
            with closing(self.connect()) as db:
                db.execute('BEGIN IMMEDIATE')
                status = self.status()
                if status['unfinished']:
                    raise ValueError('Interrupted Egypt reservation remains fully crash-charged; no automatic recovery or extension')
                if phase == 'ACCEPTANCE' and status['acceptance_attempted']:
                    raise ValueError('Frozen Egypt acceptance is one-shot; retries are prohibited')
                if seconds > min(status['remaining_s'], status[phase.lower() + '_remaining_s']):
                    raise ValueError('Egypt ' + phase.lower() + ' allowance exhausted; the acceptance window is protected')
                if (phase == 'DEVELOPMENT' and purpose != 'DIAGNOSTIC'
                        and seconds > status['non_diagnostic_development_remaining_s']):
                    raise ValueError('Diagnostic-only extension cannot fund matrix, browser or generic development work')
                protected = (DEVELOPMENT_RESERVE_SECONDS if purpose == 'DIAGNOSTIC' else
                             BROWSER_SECONDS if purpose == 'MATRIX' and phase == 'DEVELOPMENT' else 0.)
                if protected and status['development_remaining_s'] - seconds < protected:
                    raise ValueError('Development diagnosis must preserve the 7200-second matrix and 480-second browser windows')
                db.execute('INSERT INTO reservations VALUES (?,?,?,?,?,?,?,?,?,?)',
                           (key, phase, seconds, seconds, started, started + seconds, os.getpid(), 'RUNNING', None, str(report)))
                if purpose == 'DIAGNOSTIC' and any(row['phase'] == 'DIAGNOSTIC' for row in status['extensions']):
                    diagnostic_headroom = max(0., status['diagnostic_remaining_s'] - status['diagnostic_extension_remaining_s'])
                    db.execute('INSERT INTO diagnostic_usage VALUES (?,?,?)',
                               (key, diagnostic_headroom, max(0., seconds - diagnostic_headroom)))
                db.commit()
            reserved = True
            os.environ.update(OSTORHA_EGYPT_BUDGET=str(self.directory), OSTORHA_EGYPT_RESERVATION=key)
            yield ticket
        finally:
            try:
                if reserved:
                    elapsed = max(0., time.monotonic() - started)
                    failure = sys.exc_info()[1]
                    outcome = ('EXPIRED' if elapsed > seconds else 'INTERRUPTED' if isinstance(failure, KeyboardInterrupt)
                               else 'FAILED' if failure is not None else 'FINISHED')
                    with closing(self.connect()) as db:
                        db.execute('UPDATE reservations SET charged_s=?,elapsed_s=?,outcome=? WHERE id=?',
                                   (elapsed, elapsed, outcome, key))
                        if diagnostic_headroom is not None:
                            db.execute('UPDATE diagnostic_usage SET charged_s=? WHERE reservation_id=?',
                                       (max(0., elapsed - diagnostic_headroom), key))
                        db.commit()
            finally:
                for name, value in old_environment.items():
                    if value is None:
                        os.environ.pop(name, None)
                    else:
                        os.environ[name] = value
                if ticket.get('cleanup_verified', True):
                    OWNERSHIP.unlink()
                else:
                    save_json(OWNERSHIP, {**ticket, 'stage': 'CLEANUP_REQUIRED'})
            if reserved and elapsed > seconds:
                raise TimeoutError('Egypt reservation expired; all native work including cleanup must fit its deadline')

    def activate(self, ticket):
        remaining_seconds(ticket['expires_monotonic_s'], PHASE_SECONDS)
        ticket['stage'] = 'VALIDATING'
        save_json(OWNERSHIP, ticket)

    def claim_attempt(self, ticket, seed, first_mode, fingerprint):
        from ..core.egypt_urban import configuration
        seeds = configuration()['holdout_seeds' if ticket['phase'] == 'ACCEPTANCE' else 'development_seeds']
        if seed not in seeds or first_mode not in ('NORMAL', 'ROBOSPHERE') or active_ticket() is None:
            raise ValueError('Worker seed/order requires its live Egypt reservation and declared partition')
        with closing(self.connect()) as db:
            try:
                db.execute('INSERT INTO attempts VALUES (?,?,?,?,?,NULL)',
                           (ticket['reservation_id'], seed, first_mode, fingerprint, 'STARTED'))
                db.commit()
            except sqlite3.IntegrityError as error:
                raise ValueError('Duplicate Egypt seed/order attempt; selective retries are prohibited') from error

    def finish_attempt(self, ticket, seed, first_mode, passed, report):
        with closing(self.connect()) as db:
            db.execute('UPDATE attempts SET outcome=?,report=? WHERE reservation_id=? AND seed=? AND first_mode=?',
                       ('PASSED' if passed else 'FAILED', str(report), ticket['reservation_id'], seed, first_mode))
            db.commit()

    def record_attempt_report(self, ticket, seed, first_mode, report):
        with closing(self.connect()) as db:
            db.execute('UPDATE attempts SET report=? WHERE reservation_id=? AND seed=? AND first_mode=?',
                       (str(report), ticket['reservation_id'], seed, first_mode))
            db.commit()

    def worker_ticket(self, reservation, deadline, seed, first_mode):
        ticket = active_ticket()
        if (ticket is None or ticket['budget'] != str(self.directory) or ticket['reservation_id'] != reservation
                or type(deadline) not in (float, int) or not math.isfinite(deadline)
                or not time.monotonic() < deadline <= ticket['expires_monotonic_s']):
            raise ValueError('Egypt worker requires the exact parent reservation and a bounded delegated deadline')
        with closing(self.connect()) as db:
            row = db.execute('SELECT outcome FROM attempts WHERE reservation_id=? AND seed=? AND first_mode=?',
                             (reservation, seed, first_mode)).fetchone()
        if row != ('STARTED',):
            raise ValueError('Egypt worker seed/order was not claimed by the parent')
        return {**ticket, 'expires_monotonic_s': deadline}
