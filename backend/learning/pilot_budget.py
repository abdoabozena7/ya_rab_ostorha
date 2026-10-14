"""Independent, crash-charged four-hour combined pilot experiment ledger."""
from contextlib import closing, contextmanager
import json
from pathlib import Path
import sqlite3
import time
import uuid

ROOT=Path(__file__).resolve().parents[2]
LIMITS={'control':2700.,'scenario_prediction':2700.,'rl':5400.,'evaluation':3600.}
CAP_SECONDS=14400.
DEFAULT_ROOT=ROOT/'output/core-repair-pilot'


class PilotBudget:
    def __init__(self,root=DEFAULT_ROOT):
        self.root=Path(root);self.root.mkdir(parents=True,exist_ok=True)
        self.path=self.root/'budget.sqlite'
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('CREATE TABLE IF NOT EXISTS phases (id TEXT PRIMARY KEY, phase TEXT NOT NULL, '
                       'seconds REAL NOT NULL, finished INTEGER NOT NULL, started REAL NOT NULL)')
            db.execute('CREATE TABLE IF NOT EXISTS allocations (phase TEXT PRIMARY KEY, seconds REAL NOT NULL)')
            db.executemany('INSERT OR IGNORE INTO allocations VALUES (?,?)',LIMITS.items())
            db.execute('CREATE TABLE IF NOT EXISTS reallocations (id TEXT PRIMARY KEY, source TEXT NOT NULL, '
                       'destination TEXT NOT NULL, seconds REAL NOT NULL, authorization TEXT NOT NULL)')
            db.commit()

    def reallocate(self,source,destination,seconds,authorization):
        if source not in LIMITS or destination not in LIMITS or source==destination or not 0<float(seconds) or not authorization:
            raise ValueError('Explicit authorized phase transfer required')
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('BEGIN IMMEDIATE')
            if db.execute('SELECT COUNT(*) FROM phases WHERE finished=0').fetchone()[0]:
                raise ValueError('Cannot reallocate an active reservation')
            available=db.execute('SELECT seconds FROM allocations WHERE phase=?',(source,)).fetchone()[0]
            used=db.execute('SELECT COALESCE(SUM(seconds),0) FROM phases WHERE phase=?',(source,)).fetchone()[0]
            if available-float(seconds)<used:raise ValueError('Transfer would revoke already charged time')
            db.execute('UPDATE allocations SET seconds=seconds-? WHERE phase=?',(seconds,source))
            db.execute('UPDATE allocations SET seconds=seconds+? WHERE phase=?',(seconds,destination))
            db.execute('INSERT INTO reallocations VALUES (?,?,?,?,?)',(uuid.uuid4().hex,source,destination,seconds,authorization))
            db.commit()
        return self.status()

    def reserve(self,phase,seconds):
        if phase not in LIMITS or isinstance(seconds,bool) or not 0<float(seconds):
            raise ValueError('Invalid pilot phase/reservation')
        seconds=float(seconds)
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('BEGIN IMMEDIATE')
            total=db.execute('SELECT COALESCE(SUM(seconds),0) FROM phases').fetchone()[0]
            used=db.execute('SELECT COALESCE(SUM(seconds),0) FROM phases WHERE phase=?',(phase,)).fetchone()[0]
            limit=db.execute('SELECT seconds FROM allocations WHERE phase=?',(phase,)).fetchone()[0]
            if total+seconds>CAP_SECONDS or used+seconds>limit:
                raise ValueError('Four-hour pilot or phase cap exhausted')
            key=uuid.uuid4().hex;began=time.monotonic()
            db.execute('INSERT INTO phases VALUES (?,?,?,0,?)',(key,phase,seconds,began));db.commit()
        return key,began,seconds

    def finish(self,reservation):
        key,began,allowance=reservation;elapsed=max(0.,time.monotonic()-began)
        with closing(sqlite3.connect(self.path)) as db:
            row=db.execute('SELECT started,seconds,finished FROM phases WHERE id=?',(key,)).fetchone()
            if row is None or row[2] or row[0]!=began or row[1]!=allowance:
                raise ValueError('Invalid or already finished reservation')
            db.execute('UPDATE phases SET seconds=?,finished=1 WHERE id=?',(elapsed,key));db.commit()
        if elapsed>allowance:raise TimeoutError('Pilot experiment exceeded reserved allowance')
        return elapsed

    @contextmanager
    def experiment(self,phase,seconds):
        reservation=self.reserve(phase,seconds)
        try:yield reservation
        finally:self.finish(reservation)

    def status(self):
        with closing(sqlite3.connect(self.path)) as db:
            rows=[dict(zip(('id','phase','charged_s','finished','started_monotonic_s'),r))
                  for r in db.execute('SELECT * FROM phases ORDER BY started')]
            limits=dict(db.execute('SELECT phase,seconds FROM allocations'))
            transfers=[dict(zip(('id','source','destination','seconds','authorization'),row))
                       for row in db.execute('SELECT * FROM reallocations')]
        used={p:sum(r['charged_s'] for r in rows if r['phase']==p) for p in LIMITS}
        return {'scope':'CORE_REPAIR_PREDICTIVE_RL_V1','combined_cap_s':CAP_SECONDS,
                'charged_s':sum(used.values()),'phase_caps_s':limits,'phase_charged_s':used,'phases':rows,'reallocations':transfers}

    def publish_ticket(self,reservation):
        key,began,seconds=reservation
        with closing(sqlite3.connect(self.path)) as db:
            row=db.execute('SELECT phase,seconds,finished,started FROM phases WHERE id=?',(key,)).fetchone()
        if not row or row[2] or row[1]!=seconds or row[3]!=began:
            raise ValueError('Ticket requires an unfinished reservation')
        value={'scope':'CORE_REPAIR_PREDICTIVE_RL_V1','reservation_id':key,'phase':row[0],
               'started_monotonic_s':began,'expires_monotonic_s':began+seconds}
        path=self.root/'active-ticket.json';path.write_text(json.dumps(value,indent=2),encoding='utf8')
        return value


def active_ticket(*,phase=None,root=DEFAULT_ROOT):
    """Read only; never initializes/resets a ledger or grants a new reservation."""
    try:
        root=Path(root);value=json.loads((root/'active-ticket.json').read_text())
        if value['scope']!='CORE_REPAIR_PREDICTIVE_RL_V1' or not value['started_monotonic_s']<=time.monotonic()<value['expires_monotonic_s']:
            return None
        with closing(sqlite3.connect(f'file:{(root/"budget.sqlite").as_posix()}?mode=ro',uri=True)) as db:
            row=db.execute('SELECT phase,seconds,finished,started FROM phases WHERE id=?',(value['reservation_id'],)).fetchone()
            total=db.execute('SELECT SUM(seconds) FROM phases').fetchone()[0]
            used=db.execute('SELECT SUM(seconds) FROM phases WHERE phase=?',(value['phase'],)).fetchone()[0]
            limits=dict(db.execute('SELECT phase,seconds FROM allocations')) if db.execute("SELECT name FROM sqlite_master WHERE name='allocations'").fetchone() else LIMITS
        if not row or row[2] or row[0]!=value['phase'] or row[3]!=value['started_monotonic_s']:
            return None
        if row[0] not in limits or used>limits[row[0]] or total>CAP_SECONDS:
            return None
        if value['expires_monotonic_s']>row[3]+row[1] or phase and row[0]!=phase:
            return None
        return value
    except (OSError,ValueError,KeyError,TypeError,sqlite3.Error):return None
