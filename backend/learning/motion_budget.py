"""New explicitly authorized 40-minute motion-reliability experiment ledger.

Never opens, replaces or extends the historical predictive-v2 ledger.
Reservations survive crashes. Development and small unit/browser tests are free.
"""
import sqlite3
import time
import uuid
from contextlib import closing
from pathlib import Path

ROOT=Path(__file__).resolve().parents[2]


class MotionBudget:
    CAPS={'validation':1800.,'training':600.}

    def __init__(self,path=ROOT/'output/motion-reliability/budget.sqlite'):
        self.path=Path(path);self.path.parent.mkdir(parents=True,exist_ok=True)
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('CREATE TABLE IF NOT EXISTS phases (id TEXT PRIMARY KEY, phase TEXT, seconds REAL, finished INTEGER)')
            db.commit()

    def reserve(self,phase,seconds):
        if phase not in self.CAPS or not 0<seconds<=self.CAPS[phase]:raise ValueError('Invalid motion experiment reservation')
        with closing(sqlite3.connect(self.path,isolation_level=None)) as db:
            db.execute('BEGIN IMMEDIATE')
            used=db.execute('SELECT COALESCE(SUM(seconds),0) FROM phases WHERE phase=?',(phase,)).fetchone()[0]
            if used+seconds>self.CAPS[phase]:raise ValueError('Authorized motion experiment allowance exhausted')
            ident=uuid.uuid4().hex;db.execute('INSERT INTO phases VALUES (?,?,?,0)',(ident,phase,seconds));db.commit()
        return ident,time.monotonic(),seconds

    def finish(self,reservation):
        ident,began,allowance=reservation;elapsed=time.monotonic()-began
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('UPDATE phases SET seconds=?,finished=1 WHERE id=?',(max(elapsed,allowance) if elapsed>allowance else elapsed,ident))
            db.commit()
        if elapsed>allowance:raise TimeoutError('Motion experiment exceeded its reservation')
        return elapsed

    def status(self):
        with closing(sqlite3.connect(self.path)) as db:rows=db.execute('SELECT phase,seconds,finished FROM phases').fetchall()
        return {'scope':'MOTION_RELIABILITY_20261013','hard_cap_s':2400.,
            'phases':{phase:{'cap_s':cap,'charged_s':sum(r[1] for r in rows if r[0]==phase)} for phase,cap in self.CAPS.items()},
            'charged_s':sum(r[1] for r in rows),'old_ledger_unchanged':True}
