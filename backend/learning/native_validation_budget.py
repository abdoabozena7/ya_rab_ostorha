"""Explicit, expiring RULE integration validation; never writes the research ledger."""
import json
from pathlib import Path
import time
import uuid
from contextlib import contextmanager

_active_rule_budget=None


def active_rule_ticket():
    budget=_active_rule_budget
    if budget is None or budget.status()['remaining_s']<=0:return None
    return {'expires_monotonic_s':time.monotonic()+budget.status()['remaining_s'],'scope':budget.ticket['scope']}


class NativeValidationBudget:
    scope = 'NATIVE_RULE_VALIDATION'

    def __init__(self, path, *, now=time.time):
        self.path = Path(path)
        self.now = now
        self.ticket = json.loads(self.path.read_text(encoding='utf8'))
        ticket = self.ticket
        repair=ticket.get('version')==2 and ticket.get('scope')=='NATIVE_RULE_REPAIR'
        if (not (repair or ticket.get('scope')==self.scope) or not 0 < ticket['allowance_s'] <= (3600 if repair else 1200) or
                ticket['expires_at'] != ticket['started_at'] + ticket['allowance_s']):
            raise ValueError('Invalid native validation authorization')

    @classmethod
    def create(cls, directory, seconds):
        if not 0 < seconds <= 1200:
            raise ValueError('Native RULE validation requires an explicitly authorized allowance of at most 1200 seconds')
        directory = Path(directory); directory.mkdir(parents=True, exist_ok=True)
        started = time.time()
        path = directory / ('validation-' + uuid.uuid4().hex + '.json')
        path.write_text(json.dumps({'scope': cls.scope, 'allowance_s': seconds,
            'started_at': started, 'expires_at': started + seconds,
            'authorization': 'Explicit user authorization for native RULE integration validation only'}, indent=2), encoding='utf8')
        return cls(path)

    @classmethod
    def create_repair(cls,directory,seconds=3600):
        if not 0<seconds<=3600:raise ValueError('RULE repair allowance must be at most 3600 seconds')
        directory=Path(directory);directory.mkdir(parents=True,exist_ok=True)
        started=time.time();path=directory/('repair-'+uuid.uuid4().hex+'.json')
        path.write_text(json.dumps({'version':2,'scope':'NATIVE_RULE_REPAIR','allowance_s':seconds,
            'started_at':started,'expires_at':started+seconds,
            'authorization':'User approved separate 60-minute reliable-driving validation; no hybrid admission'},indent=2),encoding='utf8')
        return cls(path)

    def activate_rule(self):
        global _active_rule_budget
        if self.ticket.get('scope')!='NATIVE_RULE_REPAIR' or self.status()['remaining_s']<=0:
            raise ValueError('A live RULE repair authorization is required')
        _active_rule_budget=self

    @contextmanager
    def experiment(self,name,seconds):
        reservation=self.reserve(name,seconds)
        try:yield reservation
        finally:self.finish(reservation)

    def status(self):
        used = max(0., self.now() - self.ticket['started_at'])
        return {'scope': self.ticket['scope'], 'hard_cap_s': self.ticket['allowance_s'],
            'charged_s': min(used, self.ticket['allowance_s']),
            'remaining_s': max(0., self.ticket['expires_at'] - self.now()),
            'expires_at': self.ticket['expires_at'], 'ticket': str(self.path)}

    def reserve(self, name, seconds):
        remaining = self.status()['remaining_s']
        allowed=('comparison_v2_run','physical-diagnostic') if self.ticket.get('scope')=='NATIVE_RULE_REPAIR' else ('comparison_v2_run',)
        if name not in allowed or not 0 < seconds <= remaining + .1 or remaining <= 0:
            raise ValueError('Native RULE validation allowance exhausted')
        return uuid.uuid4().hex, time.monotonic(), min(seconds, remaining)

    def finish(self, reservation):
        key, began, allowance = reservation
        elapsed = time.monotonic() - began
        with self.path.with_suffix('.jsonl').open('a', encoding='utf8') as stream:
            stream.write(json.dumps({'id': key, 'phase': 'RULE integration validation',
                'elapsed_s': elapsed, 'allowance_s': allowance, 'finished_at': self.now()}) + '\n')
        return elapsed

    def wait_for_expiry(self, *, deadline=None, wait=time.sleep):
        deadline = min(deadline or self.ticket['expires_at'], self.ticket['expires_at'])
        while (remaining := deadline - self.now()) > 0:
            wait(min(1., remaining))
