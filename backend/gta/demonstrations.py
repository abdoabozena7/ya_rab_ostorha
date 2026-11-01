"""Bounded local demonstration storage and non-authoritative example memory.

Learning here means retaining qualified examples for nearest-example proposals,
not PPO optimizer updates. Current execution must independently admit a proposal.
"""
import hashlib
import json
from pathlib import Path
import queue
import threading
import numpy as np


def features(points, speed, goal_angle, detections):
    p = np.asarray(points, float)
    ranges = np.full(12, -1., dtype=float)  # Unobserved remains explicit unknown.
    if len(p):
        use = p[(p[:, 2] > .15) & (p[:, 2] < 2.5)]
        for xyz in use:
            a = int((np.arctan2(xyz[1], xyz[0])+np.pi)/(2*np.pi)*12) % 12
            d = min(1., float(np.linalg.norm(xyz[:2]))/20)
            ranges[a] = d if ranges[a] < 0 else min(ranges[a], d)
    counts = [min(1., sum(d.get('class') == name for d in detections)/10)
              for name in ('person', 'car', 'motorcycle', 'truck')]
    return np.r_[ranges, np.clip(speed/2.5, 0, 1), np.sin(goal_angle), np.cos(goal_angle), counts].astype(np.float32)


def eligible(row):
    return bool(row.get('native_acknowledged') and row.get('guard_admitted')
                and row.get('execution_matches_guard') and not row.get('future_coverage_gap')
                and not row.get('diagnostic') and not row.get('contact')
                and row.get('split') == 'TRAIN' and row.get('future_contact_free')
                and max(row.get('source_ages_ms', {}).values(), default=1e9) <= 350
                and min(row.get('source_ages_ms', {}).values(), default=-1) >= 0)


class DemoMemory:
    """Small deterministic proposal memory; never an actuator owner."""
    def __init__(self):self.examples = []

    def observe(self, row, vector, command):
        if not eligible(row):return False
        if command['throttle'] <= .01:return False
        self.examples.append((np.asarray(vector, np.float32).copy(), dict(command)))
        self.examples = self.examples[-512:]
        return True

    def propose(self, vector):
        if len(self.examples) < 3:return None
        scores = np.array([np.sqrt(np.mean((a-vector)**2)) for a, _ in self.examples])
        selected = np.argsort(scores)[:3]
        if max(scores[selected]) > .08:return None
        directions = {self.examples[i][1]['reverse'] for i in selected}
        if len(directions) != 1:return None
        command = {k: float(np.median([self.examples[i][1][k] for i in selected]))
                   for k in ('steering', 'throttle', 'brake')}
        return {**command, 'reverse': directions.pop(), 'source': 'QUALIFIED_HUMAN_EXAMPLE_MEMORY',
                'authority': False, 'requires_current_execution_shield': True, 'neighbors': 3}


class Demonstrations:
    def __init__(self, directory, request):
        self.root = Path(directory)/'human-demonstrations';self.root.mkdir(exist_ok=True)
        self.request = request;self.pending = {};self.quarantine = []
        self.memory = DemoMemory();self.jobs = queue.Queue(maxsize=8)
        self.saved = self.dropped = self.acknowledged = 0
        self.errors = []
        self.last_native_ms = None
        self.worker = threading.Thread(target=self._write, name='gta-demo-writer', daemon=True);self.worker.start()

    def offer(self, sequence, raw, command, admitted, frame, scan, goal, vector):
        if not frame or not scan:return
        row = {'schema': 1, 'run_id': self.request['id'], 'pid': scan['pid'], 'native_sequence': sequence,
               'input_sequence': raw['sequence'], 'mode_epoch': raw['mode_epoch'],
               'input_host_ms': raw['host_ms'], 'source_native_frame': scan['frame'],
               'capture_serial': frame['capture']['serial'], 'capture_native_frame': frame['capture']['native_frame'],
               'capture_host_ms': frame['capture']['native_host_ms'], 'scan_host_ms': scan['host_ms'],
               'requested': {k: raw[k] for k in ('steering', 'forward', 'brake_reverse', 'handbrake')},
               'guarded': dict(command), 'guard_admitted': bool(admitted), 'native_acknowledged': False,
               'diagnostic': bool(self.request.get('diagnostic', True)), 'split': 'TRAIN',
               'synchronous_step': False, 'learning_kind': 'EXAMPLE_PROPOSALS_NOT_PPO_UPDATES',
               'destination_m': goal.get('destination_m'), 'intervention': not admitted}
        self.pending[sequence] = (row, frame, np.asarray(scan['rays'], np.float32)[:, :8].copy(), np.asarray(vector, np.float32).copy())
        while len(self.pending) > 32:self.pending.pop(next(iter(self.pending)));self.dropped += 1

    def acknowledge(self, applied, native):
        if not applied or applied.get('run_id') != self.request['id']:return
        pending = self.pending.pop(applied.get('sequence'), None)
        if pending:
            row, frame, rays, vector = pending
            if applied.get('input_sequence') == row['input_sequence'] and applied.get('mode_epoch') == row['mode_epoch'] and applied.get('human'):
                row.update(native_acknowledged=True, native_applied=dict(applied), contact=bool(applied.get('contact')),
                           source_ages_ms={'input': applied['host_ms']-row['input_host_ms'],
                                           'camera': applied['host_ms']-row['capture_host_ms'],
                                           'rays': applied['host_ms']-row['scan_host_ms']})
                row['execution_matches_guard'] = all(abs(applied[k]-row['guarded'][k]) < 1e-4 for k in ('steering', 'throttle', 'brake')) and applied['reverse'] == row['guarded']['reverse']
                self.acknowledged += 1
                self.quarantine.append((row, frame, rays, vector))
        now = native.get('host_ms', 0) if native else 0
        gap = self.last_native_ms is not None and now-self.last_native_ms > 350
        if now:self.last_native_ms = now
        retained = []
        for item in self.quarantine:
            row, frame, rays, vector = item
            if native and native.get('contact'):row['contact'] = True
            if gap:row['future_coverage_gap'] = True
            if now-row['native_applied']['host_ms'] < 2000:
                retained.append(item);continue
            row['future_contact_free'] = not row['contact']
            row['eligible_for_imitation'] = eligible(row)
            self.memory.observe(row, vector, row['guarded'])
            try:self.jobs.put_nowait(item)
            except queue.Full:self.dropped += 1
        self.quarantine = retained

    def _write(self):
        while True:
            item = self.jobs.get()
            if item is None:self.jobs.task_done();return
            try:
                row, frame, rays, vector = item
                path = self.root/('%010d.npz'%row['native_sequence']);temporary = path.with_suffix('.partial')
                row['rgb_sha256'] = hashlib.sha256(frame['rgb']).hexdigest()
                with temporary.open('wb') as stream:
                    np.savez_compressed(stream, rgb=np.frombuffer(frame['rgb'], np.uint8).reshape(360,640,3),
                                        depth_m=frame['depth'], rays=rays, features=vector,
                                        metadata=np.frombuffer(json.dumps(row, allow_nan=False).encode('utf8'), np.uint8))
                temporary.replace(path)
                with (self.root/'index.jsonl').open('a', encoding='utf8') as index:
                    index.write(json.dumps({'file': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                                            'native_sequence': row['native_sequence'], 'eligible_for_imitation': row['eligible_for_imitation']})+'\n')
                self.saved += 1
            except Exception as exc:self.errors.append(str(exc))
            finally:self.jobs.task_done()

    def status(self):
        return {'saved_samples': self.saved, 'native_acknowledged': self.acknowledged, 'dropped': self.dropped,
                'memory_examples': len(self.memory.examples), 'diagnostic': bool(self.request.get('diagnostic', True)),
                'errors': self.errors[-3:], 'ppo_updates': 0, 'authority': False}

    def close(self):
        self.jobs.put(None);self.worker.join(timeout=10)
