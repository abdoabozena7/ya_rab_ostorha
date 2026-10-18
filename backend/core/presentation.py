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

    def transition(self, status, *, expected=None, expected_id=None, **values):
        with self.service.lock:
            if expected_id is not None and self.data.get('id')!=expected_id:return False
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

    def start(self, speed=50, *, seed=None, guided=False, first_mode='NORMAL', scene='BUSY_ROUTE'):
        s = self.service
        if type(speed) not in (int, float) or not 5 <= speed <= 50:
            raise ValueError('Presentation speed must be 5–50 km/h')
        if seed is not None and (type(seed) is not int or not 0<=seed<2147483648):raise ValueError('Invalid presentation seed')
        if first_mode not in self.MODES or scene not in ('BUSY_ROUTE','DENSE_CHAOS'):
            raise ValueError('Choose a supported first drive and scene')
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
            'outcome':'PENDING','failures':[],'recovery':None,
            'guided':bool(guided), 'scene':scene, 'next_requests':{},
            'seed': secrets.randbelow(2147483648) if seed is None else seed,
            'modes': [first_mode, next(m for m in self.MODES if m!=first_mode)] if guided else list(self.MODES), 'arm': 0,
            'pair_id': None, 'events': [], 'source': 'LIVE_NATIVE_CARLA',
            'comparison_note': 'Normal follows the route and signals with obstacle protection off. Traffic can react differently after release.'}
        self.transition('STOPPING')

    def request_next(self, presentation_id, expected_arm, expected_phase):
        """Consume a user's intent once, including a contact racing that intent."""
        with self.service.lock:
            d=self.data
            if not d.get('guided') or presentation_id!=d.get('id') or type(expected_arm) is not int or expected_arm!=d.get('arm'):
                raise ValueError('This action belongs to another drive')
            allowed=('DRIVING','FINALIZING','AWAITING_NEXT')
            if d['status'] in self.TERMINAL or d['status']=='RESULTS':
                raise ValueError('This session no longer accepts a transition')
            if d.setdefault('next_requests',{}).get(str(expected_arm)):return
            if expected_phase not in allowed or d['status'] not in allowed:
                raise ValueError('Wait for this drive to be ready')
            if allowed.index(expected_phase)>allowed.index(d['status']):
                raise ValueError('The expected drive phase has not been reached')
            d['next_requests'][str(expected_arm)]=True
            if d['status']=='DRIVING':
                # A terminal contact/arrival already delivered by the worker wins.
                if self.service.journey.get('status') in ('STARTING','RUNNING'):
                    self.service.stop_driving('guided_shortened',cancel_presentation=False)
                self.transition('FINALIZING',expected='DRIVING')
            elif d['status']=='AWAITING_NEXT':self._queue_other_arm()
            self.save()

    def _queue_other_arm(self):
        with self.service.lock:
            if self.data['status'] not in ('FINALIZING','AWAITING_NEXT'):return
            self.service.dashboard_result=None
            self.service.queue_dashboard_action('prepare_journey_mode',{
                'mode':self.data['modes'][1], 'pair_id':self.data['pair_id']})
            self.transition('RESTORING')

    def retry_step(self, presentation_id):
        with self.service.lock:
            if presentation_id!=self.data.get('id') or not self.data.get('guided') or self.data['status']!='ERROR':
                raise ValueError('The failed step has changed')
            self.service.require_connected()
            if self.service.arbiter.safety.emergency:raise ValueError('Release emergency stop first')
            failed=self.data.get('failed_phase')
            if failed not in ('STOPPING','PREPARING','READY','RESTORING','RECOVERING'):
                raise ValueError('This drive is saved. Free GPU to close this session')
            self.data.setdefault('step_failures',[]).append({'phase':failed,'reason':self.data.get('reason')})
            self.data.pop('reason',None)
            if self.data.get('pair_id'):
                self.data['arm']=0
                self.transition('AWAITING_NEXT')
                self._queue_other_arm()
            else:
                self.data.pop('setup',None)
                self.transition('STOPPING')

    def finish(self, presentation_id):
        with self.service.lock:
            if presentation_id!=self.data.get('id') or self.data['status']!='RESULTS':
                raise ValueError('Results belong to another session or phase')
            self.transition('COMPLETE')

    def cancel(self, reason):
        if self.busy:
            self.transition('CANCELLED', reason=reason,outcome='INCOMPLETE')

    def inject_validation_timeout(self):
        budget=self.service.native_validation_budget
        if (not budget or budget.ticket.get('scope')!='NATIVE_RULE_REPAIR' or
                budget.status()['remaining_s']<30 or self.data.get('status')!='DRIVING' or self.data.get('arm')!=0):
            raise ValueError('Timeout injection requires a live repair window and the Robosphere presentation arm')
        if self.data.get('injected_fault'):raise ValueError('This presentation already contains an injected fault')
        self.data['injected_fault']={'kind':'CONTROL_APPLICATION_TIMEOUT','driving_acceptance_excluded':True,
            'frame_id':self.service.observation.frame_id}
        self.service.validation_timeout_until=self.service.now()+1.5
        self.save()

    def fail(self, reason):
        if not self.busy:return
        self.transition('ERROR', failed_phase=self.data['status'],reason=str(reason),outcome='INCOMPLETE')
        # Failure handling also runs after telemetry/transport loss. An explicit
        # stop must not depend on require_connected() succeeding at that point.
        with self.service.lock:
            self.service._stop_navigation('presentation_failed', status='ERROR')
            self.service.release_controls()

    def playback_finished(self, presentation_id):
        if presentation_id != self.data.get('id') or self.data['status'] != 'PLAYBACK':
            raise ValueError('Playback completion belongs to another presentation or phase')
        runs=self.data.get('runs',{})
        outcome='BOTH_ARRIVED' if all(runs.get(m,{}).get('status')=='ARRIVED' for m in self.MODES) else 'FAILED_ARMS'
        self.transition('COMPLETE',outcome=outcome)

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
        identity=self.data.get('id')
        try:
            if self.data.get('storage_error') or s.journey_comparison.data.get('storage_error'):
                self.fail('Comparison storage failed; recording retained where available. Free disk space before Restart.')
                return
            phase = self.data['status']
            def advance(status, **values):
                return self.transition(status, expected=phase, expected_id=identity, **values)
            # A lost dashboard must never leave a self-running experiment.
            if not s._navigation_connection_alive() and s.now()-self.phase_at > 2:
                self.fail('dashboard_disconnected')
                return
            if phase not in ('AWAITING_NEXT','RESULTS') and s.now()-self.phase_at > (600 if phase in ('DRIVING', 'STARTING', 'PLAYBACK') else 180):
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
                setup=self.data.get('setup')
                if setup and setup.get('population_pending'):
                    if s.observation.frame_id<self.ready_frame:return
                    setup=s.provider.finish_presentation_setup(self.data['seed'],setup)
                    if identity!=self.data.get('id') or self.data['status']!=phase:return
                else:
                    if self.data.get('guided'):
                        setup=s.provider.prepare_presentation(self.data['seed'],self.data['speed_kmh'],scene=self.data['scene'],guided=True)
                    else:setup = s.provider.prepare_presentation(self.data['seed'], self.data['speed_kmh'])
                    if identity!=self.data.get('id') or self.data['status']!=phase:return
                    if setup.get('population_pending'):
                        self.data['setup']=setup;self.ready_frame=s.observation.frame_id+1;self.save();return
                self.ready_frame = s.observation.frame_id + 10
                advance('READY', setup=setup)
            elif phase == 'READY' and stopped and closed and s.observation.frame_id >= getattr(self,'ready_frame',0):
                population=getattr(s.provider,'population_state',lambda:{})()
                crowding=population.get('route_crowding')
                traffic_ready=not crowding or crowding.get('status')=='READY'
                # The restored arm intentionally freezes walker controllers
                # until its first admitted control frame. Initial setup waits
                # for genuine native controller readiness instead.
                walkers_ready=self.data['arm']>0 or population.get('walker_controllers_ready',True)
                if traffic_ready and walkers_ready:
                    audit=getattr(s.provider,'presentation_population_audit',None)
                    if callable(audit) and self.data['arm']==0:
                        measured=audit()
                        if identity!=self.data.get('id') or self.data['status']!=phase:return
                        self.data['population_audit']=measured
                        if self.data['population_audit'].get('pending'):return
                        if not self.data['population_audit']['passed']:
                            self.fail('Dense setup below required population: '+str(self.data['population_audit']['counts']));return
                    self._start_arm(expected_id=identity)
            elif phase == 'STARTING':
                if s.journey['status'] == 'RUNNING':
                    advance('DRIVING', pair_id=s.journey_comparison.data['pair_id'])
                elif s.journey['status'] in ('PAUSED', 'ERROR'):
                    if self.data.get('guided'):
                        advance('FINALIZING')
                    else:self.fail(s.journey.get('reason') or 'Journey start failed')
            elif phase == 'DRIVING':
                run = s.journey_comparison.active
                if run and run['duration_s'] > 180:
                    s.stop_driving('presentation_route_timeout', cancel_presentation=False)
                if s.journey['status'] in ('ARRIVED', 'ERROR', 'PAUSED'):
                    fault=getattr(s,'runtime_fault',None)
                    recoverable=s.journey.get('reason')=='runtime_failure' and fault and fault.get('exception_type')=='ControlSceneTimeout'
                    if recoverable:
                        self.data.setdefault('failures',[]).append({'mode':self.data['modes'][self.data['arm']],
                            'fault':copy.deepcopy(fault),'reason':s.journey['reason']})
                        self.data['outcome']='FAILED_ARMS'
                        if self.data['arm']==0:self.data['recovery']={'status':'PENDING','attempts':1,'fresh_frames':0}
                        advance('FINALIZING')
                    elif self.data.get('guided'):
                        if fault:self.data.setdefault('failures',[]).append({'mode':self.data['modes'][self.data['arm']], 'fault':copy.deepcopy(fault),'reason':s.journey.get('reason')})
                        advance('FINALIZING')
                    elif s.journey.get('reason') not in ('destination_reached', 'collision',
                            'route_ended_before_destination', 'presentation_route_timeout'):
                        self.fail(s.journey.get('reason') or 'Journey interrupted')
                    else:
                        advance('FINALIZING')
            elif phase == 'FINALIZING' and stopped and closed:
                if not self.data.get('guided') and s.last_recording and s.last_recording.status().get('incomplete'):
                    self.fail('Recording incomplete; automatic continuation cancelled');return
                self.data['runs'] = {m: {k: r.get(k) for k in ('id', 'status', 'reason', 'recording','distance_m','collisions','duration_s')}
                    for m, r in s.journey_comparison.data['runs'].items()}
                if self.data.get('guided'):
                    if not self.data.get('pair_id'):self.fail('Drive could not start; no recording was created. Free GPU to close this session.');return
                    if self.data['arm']==0:
                        if self.data['next_requests'].get('0'):self._queue_other_arm()
                        else:advance('AWAITING_NEXT')
                    else:advance('RESULTS',conditions_match=s.journey_comparison.snapshot().get('conditions_match',False),
                        outcome='BOTH_ARRIVED' if all(r.get('status')=='ARRIVED' for r in self.data['runs'].values()) and len(self.data['runs'])==2 else 'RECORDED_OUTCOMES')
                    return
                if self.data['arm'] == 0:
                    s.queue_dashboard_action('prepare_journey_mode', {
                        'mode': self.data['modes'][1], 'pair_id': self.data['pair_id']})
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
                        advance('RECOVERING' if self.data.get('recovery') else 'READY')
            elif phase=='RECOVERING':
                recovery=self.data['recovery'];scene=s.control_scene
                if s.now()-self.phase_at>10.:
                    recovery.update(status='FAILED',reason='Fresh sensor recovery timed out')
                    self.fail(recovery['reason']);return
                valid=bool(scene and scene.session_id==s.session_id and scene.observation.frame_id==s.clock.frame_id
                    and scene.usable(s.clock.timestamp_s,s.now()) and s.observation.complete)
                frame=scene.observation.frame_id if scene else None
                if not valid:recovery['fresh_frames']=0
                elif frame!=recovery.get('last_frame'):recovery['fresh_frames']+=1
                recovery['last_frame']=frame
                if recovery['fresh_frames']>=20:
                    fixture=getattr(s.provider,'benchmark_fixture',None)
                    audit=fixture.verify() if fixture else {'passed':False,'failures':['Matched fixture missing']}
                    recovery['initial_condition_audit']=audit
                    if not audit['passed']:
                        recovery['status']='FAILED';self.fail('Recovery initial conditions did not match');return
                    recovery['status']='READY';advance('READY')
            elif phase == 'EXPORTING':
                states = self.video_states()
                if any(v.get('status') == 'ERROR' for v in states.values()):
                    self.fail('video_export_failed: ' + str(states))
                elif all(states.get(m, {}).get('status') == 'READY' for m in self.MODES):
                    advance('PLAYBACK', conditions_match=s.journey_comparison.snapshot().get('conditions_match', False))
            # PLAYBACK completion is acknowledged by the actual longer video.
        except Exception as error:
            if identity!=self.data.get('id') or not self.busy:return
            self.data['failure']={'exception_type':type(error).__name__, 'message':str(error),
                'traceback':traceback.format_exc(),'phase':self.data['status'],
                'frame_id':s.observation.frame_id if s.observation else None}
            self.fail(str(error))

    def _start_arm(self, *, expected_id=None):
        with self.service.lock:
            if self.data['status']!='READY' or expected_id is not None and self.data.get('id')!=expected_id:return
            self.service.start_journey(self.data['speed_kmh'],
                driving_mode=self.data['modes'][self.data['arm']], pair_id=self.data['pair_id'],
                benchmark=True, presentation_id=self.data['id'])
            self.transition('STARTING',expected='READY')

    def snapshot(self):
        return copy.deepcopy(self.data)
