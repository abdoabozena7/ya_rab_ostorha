"""Explicit, expiring RULE integration validation; never writes the research ledger."""
import json
from pathlib import Path
import time
import uuid


class NativeValidationBudget:
    scope = 'NATIVE_RULE_VALIDATION'

    def __init__(self, path, *, now=time.time):
        self.path = Path(path)
        self.now = now
        self.ticket = json.loads(self.path.read_text(encoding='utf8'))
        ticket = self.ticket
        if (ticket.get('scope') != self.scope or not 0 < ticket['allowance_s'] <= 1200 or
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

    def status(self):
        used = max(0., self.now() - self.ticket['started_at'])
        return {'scope': self.scope, 'hard_cap_s': self.ticket['allowance_s'],
            'charged_s': min(used, self.ticket['allowance_s']),
            'remaining_s': max(0., self.ticket['expires_at'] - self.now()),
            'expires_at': self.ticket['expires_at'], 'ticket': str(self.path)}

    def reserve(self, name, seconds):
        remaining = self.status()['remaining_s']
        if name != 'comparison_v2_run' or not 0 < seconds <= remaining + .1 or remaining <= 0:
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
