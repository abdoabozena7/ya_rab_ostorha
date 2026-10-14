"""Independent ten-minute native allowance authorized on 2026-10-14."""
import json
import sqlite3
import time
from contextlib import closing
from .motion_budget import MotionBudget, ROOT


class RecoveryBudget(MotionBudget):
    CAPS = {'validation': 600.}

    def __init__(self, path=ROOT/'output/congestion-recovery/budget.sqlite'):
        super().__init__(path)

    def status(self):
        result = super().status()
        return {**result, 'scope': 'CONGESTION_RECOVERY_20261014', 'hard_cap_s': 600.}


def active_ticket():
    from .pilot_budget import active_ticket as pilot_ticket
    pilot=pilot_ticket(root=ROOT/'output/core-repair-pilot')
    if pilot and pilot['phase'] in ('control','scenario_prediction','evaluation','rl'):
        return pilot
    """A file alone never authorizes motion: require an open ledger reservation."""
    gate = ROOT/'output/congestion-recovery/validation-ticket.json'
    ledger = gate.parent/'budget.sqlite'
    if not gate.is_file() or not ledger.is_file(): return None
    try:
        ticket = json.loads(gate.read_text())
        now = time.monotonic()
        if ticket.get('scope') != 'CONGESTION_RECOVERY_20261014': return None
        if not ticket['started_monotonic_s'] <= now < ticket['expires_monotonic_s']: return None
        with closing(sqlite3.connect(f'file:{ledger.as_posix()}?mode=ro', uri=True)) as db:
            row = db.execute('SELECT phase,seconds,finished FROM phases WHERE id=?', (ticket['reservation_id'],)).fetchone()
            charged = db.execute('SELECT COALESCE(SUM(seconds),0) FROM phases').fetchone()[0]
        if not row or row[0] != 'validation' or row[2] or charged > 600.: return None
        if ticket['expires_monotonic_s']-ticket['started_monotonic_s'] > row[1]+.001: return None
        return ticket
    except (ValueError, KeyError, TypeError, OSError, sqlite3.Error):
        return None
