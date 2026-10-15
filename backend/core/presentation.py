"""One explicit Restart runs a bounded, recorded RULE/Normal presentation.

The simulation worker owns transitions. Browser focus never advances the runs,
and a failed attempt is retained rather than retried until it looks successful.
"""
import copy
import json
import secrets
import uuid
import traceback
from pathlib import Path


class Presentation:
    MODES = ('ROBOSPHERE', 'NORMAL')
    TERMINAL = ('IDLE', 'COMPLETE', 'CANCELLED', 'ERROR')

    def __init__(self, service):
        self.service = service
        self.data = {'status': 'IDLE', 'id': None}
        self.directory = Path(__file__).resolve().parents[2] / 'output/presentations'
        self.phase_at = 0.

    @property
    def busy(self):
        return self.data['status'] not in self.TERMINAL

    def transition(self, status, *, expected=None, **values):
        with self.service.lock:
            if expected is not None and self.data['status'] != expected:
                return False
            self.data.update(status=status, **values)
            self.phase_at = self.service.now()
            self.data.setdefault('events', []).append({'status': status, 'wall_s': self.phase_at,
                'timestamp_s': self.service.clock.timestamp_s})
            self.save()
            return True

    def save(self):
        if not self.data.get('id'):
            return
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            path = self.directory / (self.data['id'] + '.json')
            temporary = path.with_suffix('.tmp')
            temporary.write_text(json.dumps(self.data, indent=2, allow_nan=False), encoding='utf8')
            temporary.replace(path)
        except OSError as error:
            self.data['storage_error'] = str(error)

    def start(self, speed=50):
        s = self.service
        if type(speed) not in (int, float) or not 5 <= speed <= 50:
            raise ValueError('Presentation speed must be 5–50 km/h')
        if not callable(getattr(s.provider, 'prepare_presentation', None)):
            raise ValueError('Restart requires the native CARLA presentation adapter')
        if s.arbiter.safety.emergency:
            raise ValueError('Release emergency stop before Restart')
        if self.busy:
            raise ValueError('A presentation is already running. Stop it before Restart')
        if s._comparison_busy():
            raise ValueError('Stop the current research comparison before Restart')
        s.stop_driving('presentation_restart')
        self.data = {'id': uuid.uuid4().hex, 'status': 'IDLE', 'speed_kmh': float(speed),
            'seed': secrets.randbelow(2147483648), 'modes': list(self.MODES), 'arm': 0,
            'pair_id': None, 'events': [], 'source': 'LIVE_NATIVE_CARLA',
            'comparison_note': 'Normal follows the route and signals with obstacle protection off. Traffic can react differently after release.'}
        self.transition('STOPPING')

    def cancel(self, reason):
        if self.busy:
            self.transition('CANCELLED', reason=reason)

    def fail(self, reason):
        if not self.busy:return
        self.transition('ERROR', reason=str(reason))
        # Failure handling also runs after telemetry/transport loss. An explicit
        # stop must not depend on require_connected() succeeding at that point.
        with self.service.lock:
            self.service._stop_navigation('presentation_failed', status='ERROR')
            self.service.release_controls()

    def playback_finished(self, presentation_id):
        if presentation_id != self.data.get('id') or self.data['status'] != 'PLAYBACK':
            raise ValueError('Playback completion belongs to another presentation or phase')
        self.transition('COMPLETE')

    def video_states(self):
        states = {}
        for mode, run in self.service.journey_comparison.data.get('runs', {}).items():
            if mode not in self.MODES or not run.get('recording'):
                continue
            path = Path(run['recording']) / 'video-status.json'
            try:
                states[mode] = json.loads(path.read_text(encoding='utf8'))
            except FileNotFoundError:
                states[mode] = {'status': 'PENDING'}
        return states

    def tick(self):
        if not self.busy:
            return
        s = self.service
        try:
            phase = self.data['status']
            def advance(status, **values):
                return self.transition(status, expected=phase, **values)
            # A lost dashboard must never leave a self-running experiment.
            if not s._navigation_connection_alive() and s.now()-self.phase_at > 2:
                self.fail('dashboard_disconnected')
                return
            if s.now()-self.phase_at > (600 if phase in ('DRIVING', 'STARTING', 'PLAYBACK') else 180):
                self.fail('presentation_phase_timeout: ' + phase)
                return
            closed = not s.recorder and (not s.last_recording or s.last_recording.closed)
            stopped = s.observation and abs(s.observation.vehicle.speed_mps) < .15
            if phase == 'STOPPING' and stopped and closed:
                advance('PREPARING')
            elif phase == 'PREPARING':
                # This changes a held ego/route/population, not the sensor rig.
                # Keep the owner socket and its stop controls live while the
                # sole tick worker prepares it. A stop must survive completion.
                setup = s.provider.prepare_presentation(self.data['seed'], self.data['speed_kmh'])
                self.ready_frame = s.observation.frame_id + 10
                advance('READY', setup=setup)
            elif phase == 'READY' and stopped and closed and s.observation.frame_id >= getattr(self,'ready_frame',0):
                self._start_arm()
            elif phase == 'STARTING':
                if s.journey['status'] == 'RUNNING':
                    advance('DRIVING', pair_id=s.journey_comparison.data['pair_id'])
                elif s.journey['status'] in ('PAUSED', 'ERROR'):
                    self.fail(s.journey.get('reason') or 'Journey start failed')
            elif phase == 'DRIVING':
                run = s.journey_comparison.active
                if run and run['duration_s'] > 180:
                    s.stop_driving('presentation_route_timeout', cancel_presentation=False)
                if s.journey['status'] in ('ARRIVED', 'ERROR', 'PAUSED'):
                    if s.journey.get('reason') not in ('destination_reached', 'collision',
                            'route_ended_before_destination', 'presentation_route_timeout'):
                        self.fail(s.journey.get('reason') or 'Journey interrupted')
                    else:
                        advance('FINALIZING')
            elif phase == 'FINALIZING' and stopped and closed:
                self.data['runs'] = {m: {k: r.get(k) for k in ('id', 'status', 'reason', 'recording')}
                    for m, r in s.journey_comparison.data['runs'].items()}
                if self.data['arm'] == 0:
                    s.queue_dashboard_action('prepare_journey_mode', {
                        'mode': self.MODES[1], 'pair_id': self.data['pair_id']})
                    advance('RESTORING')
                else:
                    advance('EXPORTING')
            elif phase == 'RESTORING':
                result = s.dashboard_result or {}
                if result.get('action') == 'prepare_journey_mode':
                    if result['status'] == 'REJECTED':
                        self.fail(result.get('error', 'Comparison restoration failed'))
                    elif result['status'] == 'APPLIED':
                        self.data['arm'] = 1
                        self.ready_frame = s.observation.frame_id + 10
                        advance('READY')
            elif phase == 'EXPORTING':
                states = self.video_states()
                if any(v.get('status') == 'ERROR' for v in states.values()):
                    self.fail('video_export_failed: ' + str(states))
                elif all(states.get(m, {}).get('status') == 'READY' for m in self.MODES):
                    advance('PLAYBACK', conditions_match=s.journey_comparison.snapshot().get('conditions_match', False))
            # PLAYBACK completion is acknowledged by the actual longer video.
        except Exception as error:
            self.data['failure']={'exception_type':type(error).__name__, 'message':str(error),
                'traceback':traceback.format_exc(),'phase':self.data['status'],
                'frame_id':s.observation.frame_id if s.observation else None}
            self.fail(str(error))

    def _start_arm(self):
        with self.service.lock:
            if self.data['status']!='READY':return
            self.service.start_journey(self.data['speed_kmh'],
                driving_mode=self.MODES[self.data['arm']], pair_id=self.data['pair_id'],
                benchmark=True, presentation_id=self.data['id'])
            self.transition('STARTING',expected='READY')

    def snapshot(self):
        return copy.deepcopy(self.data)
