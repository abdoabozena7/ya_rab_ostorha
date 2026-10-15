"""Independent four-hour hybrid validation ledger; never resets old experiments."""
from contextlib import closing, contextmanager
import json
from pathlib import Path
import sqlite3
import time
import uuid
import os
import hashlib
from datetime import datetime
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
DIRECTORY = ROOT / 'output/hybrid-driving'
CAP_SECONDS = 14400.


def working_time():
    """Execution time excludes OS sleep; command expiry still uses monotonic."""
    if os.name!='nt':return time.monotonic()
    import ctypes
    value=ctypes.c_ulonglong()
    if not ctypes.windll.kernel32.QueryUnbiasedInterruptTime(ctypes.byref(value)):
        raise OSError('Windows working-state clock is unavailable')
    return value.value/10_000_000.


def active_ticket(directory=DIRECTORY):
    directory = Path(directory)
    try:
        ticket = json.loads((directory / 'active-ticket.json').read_text())
        if not isinstance(ticket,dict) or isinstance(ticket.get('owner_pid'),bool):return None
        if time.monotonic() >= ticket['expires_monotonic_s'] or ticket['owner_pid']<=0:
            return None
        if os.name=='nt':
            import ctypes
            handle=ctypes.windll.kernel32.OpenProcess(0x1000,False,ticket['owner_pid'])
            if not handle:return None
            try:
                code=ctypes.c_ulong()
                if not ctypes.windll.kernel32.GetExitCodeProcess(handle,ctypes.byref(code)) or code.value!=259:return None
            finally:ctypes.windll.kernel32.CloseHandle(handle)
        else:
            os.kill(ticket['owner_pid'],0)
        uri = (directory / 'budget.sqlite').resolve().as_uri() + '?mode=ro'
        with closing(sqlite3.connect(uri, uri=True)) as db:
            row = db.execute('SELECT finished FROM reservations WHERE id=?', (ticket['reservation_id'],)).fetchone()
        return ticket if row == (0,) else None
    except (OSError, ValueError, KeyError,TypeError,AttributeError,sqlite3.Error):
        return None


class HybridBudget:
    def __init__(self, directory=DIRECTORY):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / 'budget.sqlite'
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('CREATE TABLE IF NOT EXISTS reservations (id TEXT PRIMARY KEY, phase TEXT NOT NULL, seconds REAL NOT NULL, finished INTEGER NOT NULL, started REAL NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS sleep_adjustments (reservation_id TEXT PRIMARY KEY, excluded_s REAL NOT NULL, evidence_sha256 TEXT UNIQUE NOT NULL, evidence_path TEXT NOT NULL, report_path TEXT NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS measurements (reservation_id TEXT PRIMARY KEY, reserved_s REAL NOT NULL, wall_elapsed_s REAL NOT NULL, working_elapsed_s REAL NOT NULL)')
            db.commit()

    def status(self):
        with closing(sqlite3.connect(self.path)) as db:
            rows = [dict(zip(('id', 'phase', 'charged_s', 'finished', 'started'), r))
                    for r in db.execute('SELECT * FROM reservations ORDER BY started')]
            adjustments=[dict(zip(('reservation_id','excluded_s','evidence_sha256','evidence_path','report_path'),r))
                         for r in db.execute('SELECT * FROM sleep_adjustments')]
        gross=sum(r['charged_s'] for r in rows);excluded=sum(r['excluded_s'] for r in adjustments);used=gross-excluded
        return {'cap_s': CAP_SECONDS, 'used_s': used, 'remaining_s': max(0., CAP_SECONDS-used),
                'gross_recorded_s':gross,'excluded_verified_sleep_s':excluded,
                'reservations': rows,'sleep_adjustments':adjustments}

    def reconcile_sleep(self,reservation_id,event_path,report_path):
        """Append a proven OS-suspend exclusion; never rewrite the original charge."""
        event_path=Path(event_path).resolve();report_path=Path(report_path).resolve()
        if not event_path.is_relative_to(self.directory.resolve()) or not report_path.is_relative_to(self.directory.resolve()):
            raise ValueError('Sleep reconciliation requires retained local evidence')
        raw=event_path.read_bytes();event=ET.fromstring(raw)
        ns={'e':'http://schemas.microsoft.com/win/2004/08/events/event'}
        if (event.find('e:System/e:Provider',ns).get('Name')!='Microsoft-Windows-Power-Troubleshooter'
                or event.findtext('e:System/e:EventID',namespaces=ns)!='1'):
            raise ValueError('Expected a Windows resume event')
        values={v.get('Name'):v.text for v in event.findall('e:EventData/e:Data',ns)}
        sleep=datetime.fromisoformat(values['SleepTime'].replace('Z','+00:00')).timestamp()
        wake=datetime.fromisoformat(values['WakeTime'].replace('Z','+00:00')).timestamp()
        created=(report_path.parent/'initial-report.json').stat()
        start=getattr(created,'st_birthtime',created.st_ctime)
        if not start<=sleep<wake<=report_path.stat().st_mtime:
            raise ValueError('Resume event is not contained within this diagnostic')
        report=json.loads(report_path.read_text(encoding='utf8'));excluded=wake-sleep
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('BEGIN IMMEDIATE')
            row=db.execute('SELECT seconds,finished FROM reservations WHERE id=?',(reservation_id,)).fetchone()
            if db.execute('SELECT 1 FROM measurements WHERE reservation_id=?',(reservation_id,)).fetchone():
                raise ValueError('Working-clock reservations already exclude OS sleep')
            if (row is None or row[1]!=1 or excluded>=row[0]
                    or abs(report.get('reservation_wall_s',-1)-row[0])>2.
                    or report.get('source')!='LIVE_NATIVE_CARLA'):
                raise ValueError('Diagnostic identity/duration cannot prove this exclusion')
            db.execute('INSERT INTO sleep_adjustments VALUES (?,?,?,?,?)',(reservation_id,excluded,
                hashlib.sha256(raw).hexdigest(),str(event_path),str(report_path)))
            db.commit()
        return self.status()

    @contextmanager
    def experiment(self, phase, seconds):
        if not isinstance(phase, str) or not phase or isinstance(seconds, bool) or not 0 < seconds <= CAP_SECONDS:
            raise ValueError('Identified bounded validation reservation required')
        key, started,active_started = uuid.uuid4().hex, time.monotonic(),working_time()
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT COUNT(*) FROM reservations WHERE finished=0').fetchone()[0]:
                raise ValueError('Another hybrid reservation is unfinished; it remains crash-charged')
            used = (db.execute('SELECT COALESCE(SUM(seconds),0) FROM reservations').fetchone()[0]
                    -db.execute('SELECT COALESCE(SUM(excluded_s),0) FROM sleep_adjustments').fetchone()[0])
            if used+seconds > CAP_SECONDS:
                raise ValueError('Independent hybrid four-hour allowance exhausted')
            db.execute('INSERT INTO reservations VALUES (?,?,?,0,?)', (key, phase, seconds, started)); db.commit()
        ticket = {'reservation_id': key, 'phase': phase, 'owner_pid':os.getpid(), 'expires_monotonic_s': started+seconds}
        target = self.directory / 'active-ticket.json'
        target.write_text(json.dumps(ticket), encoding='utf8')
        try:
            yield ticket
        finally:
            wall_elapsed=time.monotonic()-started;elapsed=working_time()-active_started
            with closing(sqlite3.connect(self.path)) as db:
                db.execute('UPDATE reservations SET seconds=?,finished=1 WHERE id=?', (elapsed, key)); db.commit()
                db.execute('INSERT INTO measurements VALUES (?,?,?,?)',(key,seconds,wall_elapsed,elapsed));db.commit()
            if target.exists(): target.unlink()
            if elapsed > seconds: raise TimeoutError('Hybrid reservation exceeded its authorized duration')
