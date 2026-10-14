"""Persistent shared experiment budget. Crashed reservations remain charged."""
import sqlite3
from contextlib import closing
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


class ExperimentBudget:
    def __init__(self, path=ROOT/'output/predictive-v2/budget.sqlite'):
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        with closing(sqlite3.connect(path)) as db:
            db.execute('CREATE TABLE IF NOT EXISTS phases (id TEXT PRIMARY KEY, name TEXT, seconds REAL, finished INTEGER)')
            db.commit()

    def reserve(self, name, seconds):
        if not 0 < seconds <= (900 if name == 'training' else 5400): raise ValueError('Invalid phase budget')
        with closing(sqlite3.connect(self.path, isolation_level=None)) as db:
            db.execute('BEGIN IMMEDIATE')
            used = db.execute('SELECT COALESCE(SUM(seconds),0) FROM phases').fetchone()[0]
            if used+seconds > 5400: raise ValueError('90-minute experiment hard cap reached')
            key = uuid.uuid4().hex
            db.execute('INSERT INTO phases VALUES (?,?,?,0)', (key,name,seconds)); db.commit()
        return key, time.monotonic(), seconds

    def finish(self, reservation):
        key, began, allowance = reservation
        elapsed = time.monotonic()-began
        with closing(sqlite3.connect(self.path)) as db:
            db.execute('UPDATE phases SET seconds=?,finished=1 WHERE id=?', (max(elapsed, allowance) if elapsed>allowance else elapsed,key))
            db.commit()
        if elapsed > allowance: raise TimeoutError('Experiment phase exceeded its reservation')
        return elapsed

    def status(self):
        with closing(sqlite3.connect(self.path)) as db:
            rows = list(db.execute('SELECT name,seconds,finished FROM phases'))
        return {'target_s':1800,'hard_cap_s':5400,'charged_s':sum(r[1] for r in rows), 'phases':rows}
