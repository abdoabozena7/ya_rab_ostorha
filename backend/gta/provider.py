"""Actual asynchronous GTA inspection provider. No route or learned policy admission."""
from collections import OrderedDict
import ctypes
import hashlib
import io
import json
import math
from pathlib import Path
import secrets
import socket
import struct
import threading
import time

import numpy as np
from PIL import Image

TICK = ctypes.windll.kernel32.GetTickCount64
TICK.restype = ctypes.c_ulonglong
COMMAND = struct.Struct('<IHHQQ33sfff')
GOAL_COMMAND = struct.Struct('<IHHQQ33sfffQQ')
FRESH_MS = 350


def latest_json(path):
    """Includes complete long geometry lines; ignores only incomplete last writes."""
    try:
        path = Path(path)
        if path.suffix == '.json':
            value = json.loads(path.read_bytes())
            return value if isinstance(value, dict) else None
        with path.open('rb') as f:
            f.seek(max(0, f.seek(0, 2)-524288))
            for line in reversed(f.read().splitlines()):
                try:
                    value = json.loads(line)
                    if isinstance(value, dict):return value
                except ValueError:
                    continue
    except (OSError, ValueError):
        pass
    return None


def forward_clearance(geometry):
    rays = (geometry or {}).get('rays', [])
    selected = [r for r in rays if min(r[0], 360-r[0]) <= 8]
    expected = {(a, e) for a in (0, 2, 4, 6, 8, 352, 354, 356, 358) for e in (-6, -2, -.5, 0, 2, 6)}
    goal_expected = {(a, e) for a in (0, 3, 6, 354, 357) for e in (-65, -45, -35, -25, -15, -8, -3, 0, 6)}
    pairs = {(r[0], r[1]) for r in selected}
    valid = ((len(selected) == 54 and pairs == expected or len(selected) == 45 and pairs == goal_expected)
             and all(r[2] == 2 and r[3] in (0, 1) and math.isfinite(r[4]) and 0 <= r[4] <= 100 for r in selected))
    return {'known': valid, 'distance_m': min((r[4] for r in selected), default=None) if valid else None,
            'sampled_beams': len(selected), 'between_beams': 'UNKNOWN', 'range_rate': 'UNAVAILABLE'}


def guarded_command(intent, observation, now):
    """Only current client intent + measured sources may authorize low-speed motion."""
    reason = 'READY'
    if intent is None or now > intent['expires_ms']:
        reason = 'CONTROL_LEASE_EXPIRED'
    elif not observation.get('connected'):
        reason = 'NATIVE_UNAVAILABLE'
    elif not math.isfinite(observation.get('speed_mps', float('nan'))) or observation['speed_mps'] < 0:
        reason = 'UNKNOWN_MEASUREMENTS'
    elif any(not 0 <= now-observation.get(k, -1000000) <= FRESH_MS
             for k in ('native_ms', 'capture_ms', 'geometry_ms')):
        reason = 'STALE_SENSORS'
    elif not 0 <= now-intent['source_host_ms'] <= FRESH_MS:
        reason = 'STALE_DISPLAYED_FRAME'
    elif not observation.get('depth_valid') or not observation['front']['known']:
        reason = 'UNKNOWN_MEASUREMENTS'
    elif observation['front']['distance_m'] < max(3., observation['speed_mps']*.8+observation['speed_mps']**2/5):
        reason = 'FRONT_OBSTRUCTION'
    elif observation['speed_mps'] > 2.5:
        reason = 'SPEED_LIMIT'
    if reason != 'READY':
        return {'steering': 0., 'throttle': 0., 'brake': 1., 'reason': reason}
    return {k: intent[k] for k in ('steering', 'throttle', 'brake')} | {'reason': reason}


class GtaProvider:
    """One local UDP owner; independent browser leases expire without automatic renewal."""
    def __init__(self, run_directory, *, clock=TICK, start=True):
        self.directory = Path(run_directory).resolve()
        self.clock = clock
        self.request = json.loads((self.directory/'sensor-request.json').read_text())
        self.session_id = self.request['id']
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.frames = OrderedDict()
        self.owner = None
        self.owner_until = 0
        self.client_sequence = 0
        self.intent = None
        self.sequence = 0
        self.last_command = {'steering': 0., 'throttle': 0., 'brake': 1., 'reason': 'NOT_STARTED'}
        self.last_native = None
        self.capture = None
        self.geometry = None
        self.vision = None
        self.socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self.socket.bind(('127.0.0.1', 0))
        self.goal = None
        self.driving_input = None
        self.mode_epoch = -1
        self.demonstrations = None
        self.foundation = None
        if self.request.get('mode') == 'FOUNDATION':
            from .foundation import FoundationCalibration
            self.foundation = FoundationCalibration()
        if self.request.get('mode') == 'GOAL':
            from .goal import GoalDriver
            self.goal = GoalDriver(self.directory, self.session_id)
            if self.request.get('demonstration_enabled'):
                from .demonstrations import Demonstrations
                self.demonstrations = Demonstrations(self.directory, self.request)
        self.thread = threading.Thread(target=self._pump, name='gta-control-lease', daemon=True)
        if start:
            self.thread.start()

    def _refresh(self):
        r = latest_json(self.directory/'bridge.jsonl')
        c = latest_json(self.directory/'capture.jsonl')
        g = latest_json(self.directory/'geometry.jsonl')
        v = latest_json(self.directory/'live-vision.jsonl')
        if r and r.get('run_id') == self.session_id:
            self.last_native = r
        elif r is not None:
            self.last_native = None
        # Secure native writers can briefly deny reads while appending a scan.
        # Preserve the last complete measurement with its ORIGINAL clock. The
        # 350ms watchdog still expires it; a read retry never renews freshness.
        r = self.last_native
        if c is not None:
            self.capture = c if c.get('run_id') == self.session_id and r and c['pid'] == r['pid'] else None
        if g is not None:
            self.geometry = g if g.get('run_id') == self.session_id and r and g['pid'] == r['pid'] else None
        self.vision = v
        if self.capture and self.capture['serial'] not in self.frames:
            c = self.capture
            try:
                rgb = (self.directory/('capture-%06d.rgb' % c['serial'])).read_bytes()
                raw_depth = np.fromfile(self.directory/('capture-%06d.depth' % c['serial']), np.float32).reshape(360, 640)
                if len(rgb) != 640*360*3 or not c['rgb_ok'] or not c['depth_ok']:
                    return
                valid = np.isfinite(raw_depth) & (raw_depth > 1e-8) & (raw_depth < 1-1e-8)
                near, far = c['near'], c['far']
                depth = near*far/(near+raw_depth*(far-near))
                depth[~valid] = np.nan
                self.frames[c['serial']] = {'capture': c, 'rgb': rgb, 'depth': depth,
                                           'valid_fraction': float(np.mean(valid)), 'images': {}}
                while len(self.frames) > 16:
                    self.frames.popitem(last=False)
            except (OSError, ValueError):
                pass

    def _observation(self, now):
        r, c, g = self.last_native or {}, self.capture or {}, self.geometry or {}
        frame = self.frames.get(c.get('serial'), {})
        return {'connected': bool(r.get('frame') and r.get('ped_alive') and r.get('stage') != 'DONE'
                                  and r.get('run_id') == self.session_id),
                'native_ms': r.get('host_ms', -1000000), 'capture_ms': c.get('native_host_ms', -1000000),
                'geometry_ms': g.get('host_ms', -1000000), 'speed_mps': r.get('speed_mps', 0),
                'depth_valid': frame.get('valid_fraction', 0) > .1, 'front': forward_clearance(g)}

    def _pump(self):
        with (self.directory/'control-submitted.jsonl').open('a', encoding='utf8') as log:
            while not self.stop.is_set():
                with self.lock:
                    self._refresh()
                    now = self.clock()
                    observation = self._observation(now)
                    if self.goal:
                        human, admitted, vector = False, False, None
                        try:
                            incoming = latest_json(self.directory/'driving-input.jsonl')
                            if incoming is not None:
                                self.driving_input = incoming
                            human = bool((self.driving_input or {}).get('human'))
                            epoch = (self.driving_input or {}).get('mode_epoch', -1)
                            if epoch != self.mode_epoch:
                                self.mode_epoch = epoch
                                self.goal.active = True
                                if self.goal.driver:
                                    self.goal.driver.phase = 'SETTLE'
                            command = self.goal.step(self.geometry, self.last_native, self.capture, self.vision, human=human)
                            admitted = False
                            if human:
                                command, admitted = self.goal.manual(self.driving_input, now)
                            if self.demonstrations:
                                from .demonstrations import features
                                self.demonstrations.acknowledge(latest_json(self.directory/'applied-controls.jsonl'), self.last_native)
                                if self.goal.scene:
                                    line = np.asarray(self.goal.road['centerline'])
                                    target = line[min(2, len(line)-1)]
                                    vector = features(self.goal.scene.points, self.goal.scene.observation.ego.speed_mps,
                                                      math.atan2(target[1], target[0]), (self.vision or {}).get('detections', []))
                                    if not human and command['throttle'] <= .01:
                                        example = self.demonstrations.memory.propose(vector)
                                        accepted_example = self.goal.example_proposal(example) if example else None
                                        if accepted_example:command = accepted_example
                        except Exception as exc:
                            import traceback
                            (self.directory/'goal-error.log').write_text(traceback.format_exc())
                            self.goal.stop()
                            command = self.goal.hold('PLANNER_EXCEPTION:'+type(exc).__name__)
                    elif self.foundation:
                        if (self.directory/'foundation-startup-qualified').exists():
                            command = self.foundation.step(observation, self.geometry, now)
                        else:
                            command = {'steering':0.,'throttle':0.,'brake':1.,'reason':'STARTUP_GATE_PENDING'}
                            self.foundation.latest = {'phase':'STARTUP_GATE_PENDING','training':False,'human_recording':False}
                        with (self.directory/'foundation-control.jsonl').open('a', encoding='utf8') as foundation_log:
                            foundation_log.write(json.dumps({'host_ms':now,'native_sequence':self.sequence+1,**self.foundation.latest})+'\n')
                    else:
                        command = guarded_command(self.intent, observation, now)
                    self.sequence += 1
                    # A single socket, nonce and monotonically increasing sequence own native control.
                    if self.goal:
                        mode = 3 if human else 1
                        raw = GOAL_COMMAND.pack(0x4f475431, 2, mode+int(bool(command.get('reverse'))),
                            self.sequence, TICK()+100, self.request['owner'].encode()+b'\0',
                            command['steering'], command['throttle'], command['brake'],
                            (self.driving_input or {}).get('sequence', 0) if human else 0,
                            (self.geometry or {}).get('frame', 0))
                        if human:
                            with (self.directory/'human-control-submitted.jsonl').open('a', encoding='utf8') as human_log:
                                human_log.write(json.dumps({'host_ms': now, 'native_sequence': self.sequence,
                                    'input': self.driving_input, 'guard_admitted': admitted, 'command': command})+'\n')
                            if self.demonstrations and self.goal.scene and vector is not None:
                                frame = self.frames.get((self.capture or {}).get('serial'))
                                self.demonstrations.offer(self.sequence, self.driving_input, command, admitted,
                                                          frame, self.geometry, self.goal.latest, vector)
                    else:
                        raw = COMMAND.pack(0x4f475431, 1, command.get('packet_type',2 if command.get('reverse') else 1), self.sequence, now+180,
                                           self.request['owner'].encode()+b'\0', command['steering'], command['throttle'], command['brake'])
                    if not ((self.goal or self.foundation) and (self.directory/'drop-goal-commands').exists()):
                        self.socket.sendto(raw, ('127.0.0.1', self.request['port']))
                    self.last_command = command
                    log.write(json.dumps({'host_ms': now, 'native_sequence': self.sequence,
                                          'source_frame': self.intent.get('source_frame') if self.intent else None,
                                          'source_host_ms': self.intent.get('source_host_ms') if self.intent else None,
                                          'client_sequence': self.client_sequence, **command})+'\n')
                    log.flush()
                self.stop.wait(.05)

    def acquire(self, client):
        if not isinstance(client, str) or not 1 <= len(client) <= 64:
            raise ValueError('Bounded client identifier required')
        with self.lock:
            if self.foundation:
                raise RuntimeError('Code calibration owns controls')
            if self.goal and self.goal.active:
                raise RuntimeError('Project goal driver owns control; brake stops it')
            now = self.clock()
            if self.owner and now <= self.owner_until:
                raise RuntimeError('Another local client owns control')
            self.owner = secrets.token_hex(24)
            self.owner_until = now+1000
            self.client_sequence = 0
            self.intent = None
            return {'owner': self.owner, 'session_id': self.session_id, 'lease_ms': 220}

    def control(self, data):
        with self.lock:
            self._refresh()
            now = self.clock()
            if data.get('owner') != self.owner or not self.owner or now > self.owner_until:
                raise RuntimeError('Control owner missing or expired')
            if data.get('session_id') != self.session_id:
                raise ValueError('Wrong native session')
            seq = data.get('sequence')
            if type(seq) is not int or seq <= self.client_sequence:
                raise ValueError('Duplicate or invalid client sequence')
            controls = [data.get(k) for k in ('steering', 'throttle', 'brake')]
            if any(type(v) not in (int, float) or not math.isfinite(v) for v in controls):
                raise ValueError('Finite controls required')
            steering, throttle, brake = controls
            if abs(steering) > .35 or not 0 <= throttle <= .35 or not 0 <= brake <= 1:
                raise ValueError('Inspection control range exceeded')
            source = next((f['capture'] for f in self.frames.values() if f['capture']['native_frame'] == data.get('source_frame')), None)
            if not source or not 0 <= now-source['native_host_ms'] <= FRESH_MS:
                self.intent = None
                raise ValueError('Source frame missing, future or stale')
            self.client_sequence = seq
            self.owner_until = now+1000
            self.intent = {'steering': steering, 'throttle': throttle, 'brake': brake,
                           'expires_ms': now+220, 'source_host_ms': source['native_host_ms'],
                           'source_frame': source['native_frame']}
            return {'queued': True, 'client_sequence': seq, 'native_ack_sequence': (self.last_native or {}).get('sequence'),
                    'applied': False, 'note': 'Native acknowledgement and physical response are reported separately'}

    def snapshot(self):
        with self.lock:
            self._refresh()
            now = self.clock()
            r, c, g = self.last_native or {}, self.capture or {}, self.geometry or {}
            observation = self._observation(now)
            fresh = observation['connected'] and all(0 <= now-observation[k] <= FRESH_MS for k in ('native_ms', 'capture_ms', 'geometry_ms'))
            selected = self.frames.get((self.vision or {}).get('serial'))
            if not selected or not 0 <= now-selected['capture']['native_host_ms'] <= FRESH_MS:
                selected = self.frames.get(c.get('serial'))
            image = dict(selected['capture']) if selected else None
            detections = self.vision if selected and self.vision and self.vision['native_frame'] == image['native_frame'] else None
            rays = [x[:5] for x in g.get('rays', [])]  # Never expose actor IDs to decision inputs.
            decision = latest_json(self.directory/'decision-live.jsonl')
            return {'provider': 'gta', 'mode': 'LIVE_INSPECTION' if fresh else 'STALE_OR_DISCONNECTED',
                    'connected': fresh, 'session_id': self.session_id, 'pid': r.get('pid'),
                    'vehicle': {'position_m': r.get('position'), 'speed_mps': r.get('speed_mps'),
                                'heading_deg': r.get('heading_deg'), 'body_health': r.get('body_health'),
                                'contact': r.get('contact'), 'native_sequence': r.get('sequence')},
                    'native_frame': r.get('frame'), 'game_ms': r.get('game_ms'), 'host_ms': now,
                    'ages_ms': {'native': now-observation['native_ms'], 'camera': now-observation['capture_ms'],
                                'rays': now-observation['geometry_ms']}, 'image': image,
                    'depth_valid_fraction': selected.get('valid_fraction') if selected else None,
                    'front': observation['front'], 'rays': rays, 'vision': detections,
                    'control': dict(self.last_command), 'decision': decision,
                    'goal': dict(self.goal.latest) if self.goal else None,
                    'foundation': dict(self.foundation.latest) if self.foundation else None,
                    'camera_view': latest_json(self.directory/'camera-views.jsonl'),
                    'driving_input': dict(self.driving_input) if self.driving_input else None,
                    'demonstrations': self.demonstrations.status() if self.demonstrations else None,
                    'capabilities': {'rgb': 'NATIVE_RENDER', 'depth': 'NATIVE_REVERSE_Z_CENTER_CALIBRATED',
                        'rays': 'NATIVE_GEOMETRIC_1080_BEAMS_100M', 'synchronous_step': False,
                        'radar_doppler': False, 'between_beams': 'UNKNOWN', 'depth_edge_qualified': False,
                        'policy_training_admitted': False, 'carla_retirement_admitted': False}}

    def image(self, serial, kind):
        if kind not in ('rgb', 'depth'):
            raise ValueError('Unknown camera kind')
        with self.lock:
            self._refresh()
            f = self.frames.get(serial)
            if not f or not 0 <= self.clock()-f['capture']['native_host_ms'] <= FRESH_MS:
                raise RuntimeError('Native camera image expired')
            if kind not in f['images']:
                if kind == 'rgb':
                    im = Image.frombytes('RGB', (640, 360), f['rgb'])
                else:
                    d = f['depth'];valid = np.isfinite(d)
                    scale = np.clip(np.log1p(np.nan_to_num(d, nan=0))/math.log(81), 0, 1)
                    colors = np.stack((255*(1-scale), 200*(1-np.abs(scale-.5)*2), 255*scale), axis=2).astype(np.uint8)
                    colors[~valid] = 0
                    im = Image.fromarray(colors)
                output = io.BytesIO();im.save(output, format='PNG')
                f['images'][kind] = output.getvalue()
            data = f['images'][kind]
            return data, {'native_frame': f['capture']['native_frame'], 'serial': serial,
                          'capture_end_ms': f['capture']['capture_end_ms'], 'sha256': hashlib.sha256(data).hexdigest(),
                          'session_id': self.session_id, 'kind': kind}

    def close(self):
        self.stop.set()
        if self.thread.is_alive():
            self.thread.join(timeout=2)
        if self.demonstrations:self.demonstrations.close()
        self.socket.close()
