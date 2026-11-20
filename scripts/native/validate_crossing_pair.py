"""Complete production guided pair. No shortening, actor labels or future intent enter control."""
import argparse
from collections.abc import Mapping
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import traceback
import uuid
from scripts.validate_hybrid_native import ROOT,source_hashes,archive_sources
from backend.core.contracts import finite, freeze_json, to_dict
from backend.learning.egypt_budget import EgyptBudget, remaining_seconds, save_json


DIAGNOSTIC_TARGETS = {(2707, 'ROBOSPHERE'): (50., 30.),
                      (1703, 'NORMAL'): (157.3512154797993, 0.),
                      (3709, 'NORMAL'): (111.24587573731478, 0.)}
GIL_PROFILER_ENV = 'OSTORHA_DIAGNOSTIC_GIL_PROFILER'
GIL_PROFILER_SHA256 = 'ae893db8c26730a8158cfefde9a65833c137eee8fe72b56aee061b318aa8effe'
NATIVE_CRASH_TOOL_ENV = 'OSTORHA_DIAGNOSTIC_NATIVE_CRASH_TOOL'
NATIVE_CRASH_TOOL_SHA256 = '22c2a2b09ade73a342a18dab838354385f73fc98e324b9903fd61fff949c5124'
ENGINE_PROFILE_ENV = 'OSTORHA_DIAGNOSTIC_ENGINE_SNAPSHOTS'


def diagnostic_tool_ticket(args):
    if (getattr(args, 'scenario', None) != 'EGYPT_URBAN_CHAOS_V1'
            or not getattr(args, 'diagnostic', False)
            or (args.seed, args.first) not in DIAGNOSTIC_TARGETS):
        raise ValueError('Native profiling requires an explicit Egypt development diagnostic target')
    ticket = validate_egypt_worker(args)
    if ticket['phase'] != 'DEVELOPMENT' or ticket.get('purpose') != 'DIAGNOSTIC':
        raise ValueError('Native profiling requires a live DEVELOPMENT/DIAGNOSTIC Egypt ticket')
    return ticket


def diagnostic_gil_request(args):
    requested = os.environ.get(GIL_PROFILER_ENV)
    if requested is None:
        return None
    ticket = diagnostic_tool_ticket(args)
    candidate = Path(requested)
    if not candidate.is_absolute():
        candidate = ROOT / candidate
    local = ROOT / 'tmp'
    if not candidate.is_relative_to(local):
        raise ValueError('GIL profiler must resolve inside the project tmp directory')
    executable = candidate.resolve(strict=True)
    if (not executable.is_relative_to(local.resolve()) or executable.name.lower() != 'py-spy.exe'
            or not executable.is_file()):
        raise ValueError('GIL profiler must be a project-local tmp py-spy.exe')
    digest = hashlib.sha256(executable.read_bytes()).hexdigest()
    if digest != GIL_PROFILER_SHA256:
        raise ValueError('GIL profiler binary SHA-256 differs from the verified py-spy 0.4.1: ' + digest)
    result = subprocess.run([str(executable), '--version'], capture_output=True, text=True,
        timeout=remaining_seconds(ticket['expires_monotonic_s'], 5.),
        creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
    if result.returncode != 0 or result.stdout.strip() != 'py-spy 0.4.1':
        raise ValueError(f'GIL profiler version check failed ({result.returncode}): '
                         f'{result.stdout!r}; stderr={result.stderr!r}')
    return {'requested': True, 'status': 'REQUESTED', 'binary': {
        'requested_path': requested, 'executable': str(executable), 'sha256': digest,
        'version': result.stdout.strip(), 'version_stdout': result.stdout,
        'version_stderr': result.stderr, 'version_returncode': result.returncode}}


def diagnostic_native_crash_request(args):
    requested = os.environ.get(NATIVE_CRASH_TOOL_ENV)
    if requested is None:
        return None
    diagnostic_tool_ticket(args)
    candidate = Path(requested)
    if not candidate.is_absolute():
        candidate = ROOT / candidate
    local = ROOT / 'tmp'
    if not candidate.is_relative_to(local):
        raise ValueError('Native crash tool must resolve inside the project tmp directory')
    executable = candidate.resolve(strict=True)
    if (not executable.is_relative_to(local.resolve()) or executable.name.lower() != 'procdump64.exe'
            or not executable.is_file()):
        raise ValueError('Native crash tool must be a project-local tmp procdump64.exe')
    digest = hashlib.sha256(executable.read_bytes()).hexdigest()
    if digest != NATIVE_CRASH_TOOL_SHA256:
        raise ValueError('Native crash tool differs from the verified Microsoft binary: ' + digest)
    return {'requested': True, 'status': 'REQUESTED',
            'binary': {'executable': str(executable), 'sha256': digest, 'product_version': '12.02'}}


def native_crash_capture_verified(capture):
    return (isinstance(capture, Mapping) and capture.get('requested') is True
            and capture.get('attached') is True and capture.get('cleanup_confirmed') is True
            and capture.get('status') in ('NO_EXCEPTION', 'CAPTURED_EXCEPTION')
            and ((capture['status'] == 'NO_EXCEPTION' and capture.get('worker_exit_code') in (0, 1))
                 or (capture['status'] == 'CAPTURED_EXCEPTION'
                     and type(capture.get('worker_exit_code')) is int
                     and capture['worker_exit_code'] not in (0, 1)))
            and not capture.get('error'))


def diagnostic_engine_request(args):
    enabled = os.environ.get(ENGINE_PROFILE_ENV)
    if enabled is None:
        return None
    if enabled != '1':
        raise ValueError('Owned engine snapshots require the explicit value1')
    request = diagnostic_native_crash_request(args)
    if request is None:
        raise ValueError('Engine snapshots require the same verified diagnostic tool and ticket')
    return {**request,'scope':'OWNED_ENGINE_SNAPSHOTS_NOT_PRODUCTION_TIMING'}


def start_native_teardown_capture(args, folder, service, deadline):
    request = diagnostic_native_crash_request(args)
    if request is None:
        return None
    if service is not None and service.after_control is not None:
        raise RuntimeError('Native crash capture cannot attach while the driving hook is installed')
    if not (folder / 'report.json').is_file():
        raise RuntimeError('Save original driving evidence before attaching the teardown debugger')
    from scripts.native.native_crash_capture import start_capture
    capture = start_capture(folder / 'native-crash-capture',
        executable=request['binary']['executable'],
        deadline=min(deadline, time.monotonic() + 15., args.egypt_deadline - 90.))
    return {**capture, 'capture_scope': 'NATIVE_TEARDOWN_ONLY_AFTER_DRIVING_EVIDENCE'}


def gil_profiler_job(child):
    """Close-on-worker-exit ownership also covers abrupt native worker death."""
    if sys.platform != 'win32':
        return None
    import ctypes
    from ctypes import wintypes
    class BasicLimits(ctypes.Structure):
        _fields_ = [('process_time', ctypes.c_longlong), ('job_time', ctypes.c_longlong),
                    ('flags', wintypes.DWORD), ('minimum_working_set', ctypes.c_size_t),
                    ('maximum_working_set', ctypes.c_size_t), ('active_processes', wintypes.DWORD),
                    ('affinity', ctypes.c_size_t), ('priority', wintypes.DWORD),
                    ('scheduling', wintypes.DWORD)]
    class ExtendedLimits(ctypes.Structure):
        _fields_ = [('basic', BasicLimits), ('io', ctypes.c_ulonglong * 6),
                    ('process_memory', ctypes.c_size_t), ('job_memory', ctypes.c_size_t),
                    ('peak_process_memory', ctypes.c_size_t), ('peak_job_memory', ctypes.c_size_t)]
    kernel = ctypes.WinDLL('kernel32', use_last_error=True)
    kernel.CreateJobObjectW.argtypes = (ctypes.c_void_p, wintypes.LPCWSTR)
    kernel.CreateJobObjectW.restype = wintypes.HANDLE
    kernel.SetInformationJobObject.argtypes = (wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD)
    kernel.AssignProcessToJobObject.argtypes = (wintypes.HANDLE, wintypes.HANDLE)
    kernel.CloseHandle.argtypes = (wintypes.HANDLE,)
    job = kernel.CreateJobObjectW(None, None)
    if not job:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        limits = ExtendedLimits()
        limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        if not kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)):
            raise ctypes.WinError(ctypes.get_last_error())
        if not kernel.AssignProcessToJobObject(job, int(child._handle)):
            raise ctypes.WinError(ctypes.get_last_error())
    except BaseException:
        kernel.CloseHandle(job)
        raise
    def close():
        if not kernel.CloseHandle(job):
            raise ctypes.WinError(ctypes.get_last_error())
    return close


def gil_profile_sample_count(data):
    if not isinstance(data, dict) or data.get('$schema') != 'https://www.speedscope.app/file-format-schema.json':
        raise ValueError('Expected speedscope JSON schema')
    frames = data.get('shared', {}).get('frames')
    profiles = data.get('profiles')
    if (not isinstance(frames, list) or not frames or not isinstance(profiles, list) or not profiles
            or any(not isinstance(frame, dict) or not isinstance(frame.get('name'), str) for frame in frames)):
        raise ValueError('Speedscope frames/profiles are missing or invalid')
    count = 0
    for profile in profiles:
        if not isinstance(profile, dict) or profile.get('type') != 'sampled' or not isinstance(profile.get('samples'), list):
            raise ValueError('Expected sampled speedscope profiles')
        start, end = (finite(profile.get(key), key) for key in ('startValue', 'endValue'))
        if end < start or profile.get('unit') != 'seconds':
            raise ValueError('Invalid speedscope sample clock')
        samples, weights = profile['samples'], profile.get('weights')
        if weights is not None and (not isinstance(weights, list) or len(weights) != len(samples)
                or any(finite(weight, 'weight') <= 0 for weight in weights)):
            raise ValueError('Invalid speedscope sample weights')
        for stack in samples:
            if not isinstance(stack, list) or any(type(index) is not int or not 0 <= index < len(frames) for index in stack):
                raise ValueError('Invalid speedscope sample stack')
            count += bool(stack)
    if not count:
        raise ValueError('Speedscope profile has no nonempty stack samples')
    return count


def gil_profile_captured(profile):
    if not isinstance(profile, Mapping):
        return False
    output = profile.get('output')
    return (profile.get('requested') is True and isinstance(output, Mapping)
            and profile.get('status') == 'CAPTURED' and profile.get('returncode') == 0
            and profile.get('cleanup_confirmed') is True and not profile.get('error')
            and not profile.get('cleanup_error') and type(output.get('sample_count')) is int
            and output['sample_count'] > 0 and type(output.get('size_bytes')) is int
            and output['size_bytes'] > 0 and isinstance(output.get('sha256'), str)
            and len(output['sha256']) == 64)


class DiagnosticGILProfiler:
    def __init__(self, args, folder, request):
        folder = Path(folder).resolve()
        if folder.parent != (ROOT / 'output' / 'egypt-urban-pairs').resolve() or not folder.is_dir():
            raise ValueError('GIL profile requires its owned Egypt pair folder')
        self.args, self.folder = args, folder
        self.child = self.log = self.close_job = None
        self.finished = False
        self.evidence = {**request, 'schema': 1, 'command': None, 'worker_identity': None,
            'profiler_pid': None, 'start_clocks': None, 'end_clocks': None, 'returncode': None,
            'output': {'path': str(folder / 'gil-profile.speedscope.json'), 'sha256': None,
                       'size_bytes': 0, 'sample_count': 0},
            'log': {'path': str(folder / 'gil-profile.log'), 'sha256': None, 'size_bytes': 0},
            'cleanup_confirmed': False, 'error': None}

    @staticmethod
    def clocks():
        return {'monotonic_s': time.monotonic(), 'unix_time_s': time.time()}

    def after_control(self, service):
        if self.evidence['status'] != 'REQUESTED' or service.presentation.data.get('status') != 'DRIVING':
            return
        try:
            diagnostic_tool_ticket(self.args)
            executable = self.evidence['binary']['executable']
            if hashlib.sha256(Path(executable).read_bytes()).hexdigest() != self.evidence['binary']['sha256']:
                raise ValueError('Verified GIL profiler binary changed before DRIVING')
            if any(Path(self.evidence[key]['path']).exists() for key in ('output', 'log')):
                raise ValueError('GIL profiler destination already exists; refusing to overwrite retained evidence')
            self.evidence['worker_identity'] = {'pid': os.getpid(), 'parent_pid': os.getppid(),
                'python_executable': sys.executable, 'python_version': sys.version, 'argv': list(sys.argv),
                'cwd': str(Path.cwd()), 'session_id': service.session_id,
                'frame_id': service.observation.frame_id, 'timestamp_s': service.observation.timestamp_s}
            command = [executable, 'record', '--pid', str(os.getpid()), '--duration', '60', '--rate', '100',
                '--threads', '--gil', '--nonblocking', '--format', 'speedscope',
                '--output', self.evidence['output']['path']]
            self.evidence.update(command=command, start_clocks=self.clocks())
            self.log = Path(self.evidence['log']['path']).open('wb')
            self.child = subprocess.Popen(command, cwd=ROOT, stdout=self.log, stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
            self.evidence['profiler_pid'] = self.child.pid
            self.close_job = gil_profiler_job(self.child)
            self.evidence.update(status='RUNNING', kill_on_worker_exit=self.close_job is not None)
            save_json(self.folder / 'gil-profile-status.json', self.evidence)
        except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
            self.evidence.update(status='ERROR', error=str(error), error_type=type(error).__name__)
            self.finish(time.monotonic())

    def finish(self, deadline):
        if self.finished:
            return
        self.finished = True
        try:
            if self.child is None:
                if self.evidence['status'] == 'REQUESTED':
                    self.evidence.update(status='INCOMPLETE', error='DRIVING was not observed; profiler never started')
            elif self.evidence['status'] == 'RUNNING':
                self.child.wait(timeout=remaining_seconds(deadline, 65.))
                if self.child.returncode != 0:
                    raise RuntimeError(f'py-spy exited with return code {self.child.returncode}; see retained profiler log')
        except (TimeoutError, subprocess.TimeoutExpired) as error:
            self.evidence.update(status='INCOMPLETE', error=str(error), error_type=type(error).__name__)
        except (OSError, ValueError, TypeError, AttributeError, RuntimeError) as error:
            self.evidence.update(status='ERROR', error=str(error), error_type=type(error).__name__)
        finally:
            cleanup_errors = []
            try:
                if self.child is not None and self.child.poll() is None:
                    self.child.terminate()
                    try:
                        self.child.wait(timeout=2.)
                    except subprocess.TimeoutExpired:
                        self.child.kill()
                        self.child.wait(timeout=2.)
            except (OSError, subprocess.SubprocessError) as error:
                cleanup_errors.append(str(error))
            if self.close_job is not None:
                try:
                    self.close_job()
                except OSError as error:
                    cleanup_errors.append(str(error))
            if self.child is not None:
                try:
                    self.child.wait(timeout=2.)
                except (OSError, subprocess.SubprocessError) as error:
                    cleanup_errors.append(str(error))
                self.evidence['returncode'] = self.child.returncode
            self.evidence['cleanup_confirmed'] = self.child is None or self.child.poll() is not None
            if not self.evidence['cleanup_confirmed']:
                cleanup_errors.append('Owned profiler process exit could not be confirmed')
            if cleanup_errors:
                self.evidence.update(status='ERROR', cleanup_error='; '.join(cleanup_errors),
                                     cleanup_errors=cleanup_errors)
                self.evidence['error'] = self.evidence['error'] or self.evidence['cleanup_error']
            try:
                if self.log is not None:
                    self.log.close()
                    raw = Path(self.evidence['log']['path']).read_bytes()
                    self.evidence['log'].update(sha256=hashlib.sha256(raw).hexdigest(), size_bytes=len(raw))
                path = Path(self.evidence['output']['path'])
                if self.child is not None or path.is_file():
                    raw = path.read_bytes()
                    self.evidence['output'].update(sha256=hashlib.sha256(raw).hexdigest(), size_bytes=len(raw))
                    data = json.loads(raw, parse_constant=lambda value: finite(float(value), value))
                    self.evidence['output']['sample_count'] = gil_profile_sample_count(data)
            except (OSError, ValueError, TypeError, AttributeError) as error:
                self.evidence['output_error'] = str(error)
                if self.evidence['status'] == 'RUNNING':
                    self.evidence.update(status='ERROR', error=str(error), error_type=type(error).__name__)
            if self.evidence['status'] == 'RUNNING':
                self.evidence['status'] = 'CAPTURED'
            self.evidence['end_clocks'] = self.clocks()
            save_json(self.folder / 'gil-profile-status.json', self.evidence)


def diagnostic_goal(seed, mode, run):
    distance, duration = DIAGNOSTIC_TARGETS[(seed, mode)]
    terminal = run.get('status') == 'ARRIVED' or (
        run.get('status') == 'COLLISION' and run.get('contact_callbacks', 0) > 0)
    return ((mode == 'NORMAL' and terminal) or
            run.get('distance_m', 0.) >= distance and run.get('duration_s', 0.) >= duration)


def native_timing_counters(service, provider):
    observation = service.observation
    clock = service.clock
    current = {'session_id': service.session_id, 'frame_id': clock.frame_id,
               'timestamp_s': clock.timestamp_s}
    sample = {'frame_id': observation.frame_id, 'timestamp_s': observation.timestamp_s}
    common_issues = ['CURRENT_BINDING_NOT_CAPTURED:' + key
                     for key, value in current.items() if value is None]
    common_issues.extend('SAMPLE_BINDING_MISMATCH:' + key for key, value in sample.items()
                         if value != current[key])

    def snapshot(source, values, binding, required):
        issues = list(common_issues)
        for key, value in binding.items():
            expected = current['frame_id' if key == 'source_frame' else key]
            if value is None or expected is None:
                issues.append('BINDING_NOT_CAPTURED:' + key)
            elif value != expected:
                issues.append('STALE_BINDING:' + key)
        copied = None
        if not isinstance(values, Mapping) or not values:
            issues.append('COUNTERS_NOT_CAPTURED')
        else:
            try:
                for key, value in values.items():
                    if value is not None:
                        finite(value, key)
                copied = freeze_json(values)
            except ValueError as error:
                issues.append('INVALID_COUNTERS:' + str(error))
        if issues:
            return {'source': source, 'binding': binding, 'status': 'UNAVAILABLE',
                    'values_ms': None, 'unavailable_reasons': issues}
        missing = ['COUNTER_NOT_CAPTURED:' + key for key in required if values.get(key) is None]
        return {'source': source, 'binding': binding, 'status': 'PARTIAL' if missing else 'AVAILABLE',
                'values_ms': copied, 'unavailable_reasons': missing}

    world = getattr(provider, 'last_world', None)
    world = world if isinstance(world, Mapping) else {}
    application = getattr(service, 'application_timing', None)
    application = application if isinstance(application, Mapping) else {}
    scene = getattr(service, 'control_scene', None)
    measured = getattr(scene, 'observation', None)
    # These are producer identities at the hook, before the next native step.
    # In particular, ControlScene's counter field is timings_ms.
    return freeze_json({
        'version': 1, 'capture_point': 'AFTER_CONTROL_BEFORE_NATIVE_STEP',
        'current': current, 'sample': sample,
        'provider': snapshot('provider.step_timing_ms', getattr(provider, 'step_timing_ms', None),
            {'frame_id': world.get('frame'), 'timestamp_s': world.get('timestamp')},
            ('before_native', 'native_tick', 'scenario_audit', 'population', 'telemetry_and_spectator')),
        'control': snapshot('service.control_timing_ms', getattr(service, 'control_timing_ms', None),
            {key: application.get(key) for key in ('session_id', 'frame_id', 'source_frame')},
            ('behavior_thread_cpu',)),
        'scene': snapshot('service.control_scene.timings_ms', getattr(scene, 'timings_ms', None),
            {'session_id': getattr(scene, 'session_id', None),
             'frame_id': getattr(measured, 'frame_id', None),
             'timestamp_s': getattr(measured, 'timestamp_s', None)}, ('thread_cpu',)),
    })


def native_driving_sample(service, provider):
    d = service.presentation.data
    v = service.observation.vehicle
    return {'frame': service.observation.frame_id, 'timestamp_s': service.observation.timestamp_s,
        'arm': d['arm'], 'mode': service.journey.get('driving_mode'), 'speed_kmh': v.speed_mps*3.6,
        'yaw_rad': v.transform.rotation_rad.yaw,
        'position_m': list(v.transform.position_m), 'stop': service._public_stop_diagnostics(),
        'scenario': getattr(provider, 'dense_chaos', None).run_evidence(), 'performance': service.backend_step_ms,
        'application_timing': dict(service.application_timing),
        'timing_counters': native_timing_counters(service, provider)}


class EvidenceFiles:
    def __init__(self, root):
        self.root, self.metadata = root, None
        self.streams = {}

    def record_trace(self, row):
        name = row['file']
        if name not in ('checkpoint.json', 'samples.jsonl', 'progress.jsonl'):
            raise ValueError('Unexpected native evidence destination')
        if name.endswith('.json'):
            save_json(self.root / name, row['data'])
        else:
            if name not in self.streams:
                self.streams[name] = (self.root / name).open('a', encoding='utf8')
            self.streams[name].write(json.dumps(row['data'], separators=(',', ':'), default=to_dict) + '\n')
            self.streams[name].flush()

    def close(self):
        for stream in self.streams.values():
            stream.flush()
            os.fsync(stream.fileno())
            stream.close()


def diagnostic_assessment(report):
    from backend.core.egypt_urban import control_latency_passed
    mode = report['first_mode']
    run = report.get('pair', {}).get('runs', {}).get(mode, {})
    latency = run.get('control_latency', {})
    gates = {
        'measured_diagnostic_goal': diagnostic_goal(report['seed'], mode, run),
        'protected_without_contact': mode == 'NORMAL' or run.get('collisions') == 0,
        'no_control_timeout': not report.get('error') and (
            run.get('reason') == 'diagnostic_goal_reached' or run.get('status') in ('ARRIVED', 'COLLISION')),
        'sensor_latency_targets': control_latency_passed(latency),
        'clean_worker_exit': report.get('native_worker_exit_code') in (0, 1) and report.get('cleanup_stage') == 'COMPLETE'
            and report.get('cleanup_confirmed') is True and not report.get('cleanup_error'),
        'exports_closed': report.get('exports_closed') is True,
        'saved_video_playback': report.get('video_playback_after_exit', {}).get('passed') is True,
        'independent_cleanup': report.get('independent_cleanup_probe', {}).get('passed') is True,
        'engine_exited': report.get('simulator_exit_confirmed') is True,
        'source_unchanged': report.get('source_unchanged') is True and report.get('attempts_retained') is True,
    }
    profile = report.get('diagnostic_gil_profile') or {}
    if profile.get('requested') is True:
        gates['requested_profile_captured'] = gil_profile_captured(profile)
    capture = report.get('diagnostic_native_crash_capture') or {}
    if capture.get('requested') is True:
        gates['requested_native_crash_capture_verified'] = native_crash_capture_verified(capture)
    engine_profile = report.get('diagnostic_engine_profile') or {}
    if engine_profile.get('requested') is True:
        from scripts.native.engine_profile import captured
        gates['requested_engine_snapshots_captured'] = captured(engine_profile)
    return {'passed': all(gates.values()), 'gates': gates, 'native_acceptance': False}


def diagnostic_worker_passed(args, report):
    run = report.get('pair', {}).get('runs', {}).get(args.first, {})
    profile = report.get('diagnostic_gil_profile') or {}
    return bool(diagnostic_goal(args.seed, args.first, run) and report.get('cleanup_confirmed')
        and report.get('exports_closed') and not report.get('cleanup_error') and not report.get('error')
        and (profile.get('requested') is not True or gil_profile_captured(profile)))


def cleanup_probe(deadline=None):
    code=('import carla,json; c=carla.Client("127.0.0.1",2000);c.set_timeout(8);w=c.get_world(); '
        'sync=w.get_settings().synchronous_mode; '
        'w.wait_for_tick(5) if not sync else None; '
        'owned=[a.id for a in w.get_actors() if a.attributes.get("role_name","").startswith("ostorha_") or a.type_id=="controller.ai.walker"]; '
        'print("CLEANUP_PROBE "+json.dumps({"synchronous":sync,"remaining_project_actors":owned,"passed":not sync and not owned}))')
    try:
        result=subprocess.run([sys.executable,'-c',code],capture_output=True,text=True,
            timeout=remaining_seconds(deadline,20) if deadline is not None else 20,
            creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        return next(json.loads(line.removeprefix('CLEANUP_PROBE ')) for line in result.stdout.splitlines() if line.startswith('CLEANUP_PROBE '))
    except (OSError,ValueError,StopIteration,subprocess.TimeoutExpired) as error:return {'passed':False,'error':str(error)}


def verify_videos(report, deadline=None, *, diagnostic=False):
    import hashlib
    from backend.core.recording_locations import recording_location
    from imageio_ffmpeg import get_ffmpeg_exe
    files={}
    try:
        for mode in (report['first_mode'],) if diagnostic else ('NORMAL','ROBOSPHERE'):
            root=recording_location(report['pair']['runs'][mode]['recording'],ROOT/'runs/normal_city')
            state=json.loads((root/'video-status.json').read_text(encoding='utf8'));name=state.get('preferred_video','driving.mp4')
            if name not in ('driving.mp4','driving-annotated.mp4'):raise ValueError('Unexpected video variant')
            variant=state.get('variants',{}).get('annotated' if 'annotated' in name else 'raw',state)
            files[mode]=(root/name,state,variant)
        if not diagnostic:
            common=report['shared_perception'];root=Path(common['recording']).resolve()
            if root!=Path(report['pair']['runs']['NORMAL']['recording']).resolve():raise ValueError('Unexpected shared root')
            files['shared']=(root/'shared-perception.mp4',common,common)
        checks={}
        for label,(path,state,variant) in files.items():
            valid=variant['status']=='READY' and hashlib.sha256(path.read_bytes()).hexdigest()==variant['sha256']
            probes=[]
            for stamp in (0.,max(0.,state.get('duration_s',0)-.15)):
                command=[get_ffmpeg_exe(),'-hide_banner','-loglevel','error','-ss',str(stamp),'-i',str(path),'-frames:v','1','-f','null','-']
                probes.append(subprocess.run(command,capture_output=True,
                    timeout=remaining_seconds(deadline,30) if deadline is not None else 30,
                    creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0)).returncode==0)
            checks[label]={'sha256_verified':valid,'first_and_last_decode':probes,'duration_s':state.get('duration_s')}
        return {'passed':all(c['sha256_verified'] and all(c['first_and_last_decode']) for c in checks.values()),'checks':checks,'clock':'AFTER_VERIFIED_ENGINE_EXIT'}
    except (OSError,ValueError,KeyError,TypeError,subprocess.TimeoutExpired) as error:return {'passed':False,'error':str(error)}


def progress_pair(comparison):
    """Small, explicitly incomplete checkpoint; full evidence stays in final report."""
    data = comparison.data
    fields = ('id', 'mode', 'status', 'reason', 'recording', 'duration_s', 'distance_m',
              'route_completion_percent', 'collisions', 'destination_reached')
    return {'version': data.get('version'), 'pair_id': data.get('pair_id'),
            'progress_only': True, 'conditions_match': False,
            'manifest': {'comparison_scenario': {key: value for key, value in
                ((data.get('manifest') or {}).get('comparison_scenario') or {}).items()
                if key in ('id', 'version', 'seed')}},
            'runs': {mode: {key: run.get(key) for key in fields}
                     for mode, run in data.get('runs', {}).items()}}


def worker_execution_window(args, began):
    seconds = args.seconds
    if type(seconds) not in (int, float) or not 0 < seconds < float('inf'):
        raise ValueError('Native execution duration must be positive and finite')
    egypt = getattr(args, 'scenario', None) == 'EGYPT_URBAN_CHAOS_V1'
    parent = getattr(args, 'egypt_deadline', None)
    if egypt and getattr(args, 'diagnostic', False):
        if type(parent) not in (int, float) or not began < parent < float('inf'):
            raise ValueError('Egypt diagnosis requires its live finite parent deadline')
        finalization = min(began + seconds + 75., parent - 90.)
        execution = min(began + seconds, finalization - 75.)
        if execution <= began:
            raise TimeoutError('No diagnostic execution window remains before cleanup reserves')
        return execution, finalization
    finalization = min(began + seconds, parent - 120.) if egypt else began + seconds
    return finalization - 75., finalization


def drive_validation(service, folder, report, *, deadline, first_mode, diagnostic):
    while time.monotonic() < deadline:
        if (folder / 'abort.json').exists():
            report['calibration_aborted'] = json.loads((folder / 'abort.json').read_text())
            service.stop_driving('calibration_aborted')
            for _ in range(6):
                service.step_once()
            return
        service.journey_heartbeat(service.session_id)
        service.step_once()
        data = service.presentation.data
        if data['status'] == 'CHOOSING':
            service.presentation.choose_preloaded(data['id'], first_mode)
        if data['status'] in ('RESULTS', 'ERROR', 'CANCELLED'):
            return
        if diagnostic and report.get('diagnostic_goal_reached') and not service.journey_recording_stop_pending:
            return
    if diagnostic:
        report['diagnostic_execution_window_expired'] = True
        service.stop_driving('diagnostic_execution_window_expired',
                             cancel_comparison=False, cancel_presentation=False)


def worker(args):
    import faulthandler
    faulthandler.enable()
    # Keep this owned validation process responsive while unrelated normal-
    # priority background jobs run. Safety and command deadlines stay intact.
    if sys.platform=='win32':
        import ctypes
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.GetCurrentProcess.restype=ctypes.c_void_p
        kernel.SetPriorityClass.argtypes=(ctypes.c_void_p,ctypes.c_uint)
        kernel.SetPriorityClass(kernel.GetCurrentProcess(),0x8000)
    folder=Path(args.folder);report=json.loads((folder/'initial.json').read_text());service=provider=http=perception=evidence=None
    gil_profiler = None
    crash_request = None
    engine_profiler = None
    began=time.monotonic();last=None;last_progress=-1;heartbeat_stop=threading.Event()
    worker_deadline = min(began + args.seconds, args.egypt_deadline - 120.) if getattr(args, 'egypt_deadline', None) else began + args.seconds
    try:
        egypt = getattr(args, 'scenario', None) == 'EGYPT_URBAN_CHAOS_V1'
        crash_request = diagnostic_native_crash_request(args)
        engine_request = diagnostic_engine_request(args)
        if engine_request is not None:
            from scripts.native.engine_profile import EngineSnapshots
            from backend.carla.runtime import native_processes
            engine_profiler = EngineSnapshots(args,folder,engine_request['binary']['executable'],
                diagnostic_tool_ticket,native_processes,gil_profiler_job)
            report['diagnostic_engine_profile'] = engine_profiler.evidence
        import carla
        from backend.carla.runtime import get_runtime
        from backend.carla.provider import CarlaProvider
        from backend.core.service import SimulationService
        from backend.core.journey_comparison import JourneyComparison
        from backend.server import DashboardHTTPServer,Handler
        from backend.computer_vision.service import PerceptionService,ControlPerceptionCache
        request = diagnostic_gil_request(args)
        if request is not None:
            gil_profiler = DiagnosticGILProfiler(args, folder, request)
            report['diagnostic_gil_profile'] = gil_profiler.evidence
        if egypt:
            from backend.core.egypt_urban import admission
            validate_egypt_worker(args)
            os.environ['OSTORHA_EGYPT_DEADLINE'] = str(args.egypt_deadline)
            admission('Town10HD_Opt', 60.)
        drive_deadline, worker_deadline = worker_execution_window(args, began)
        if egypt and getattr(args, 'diagnostic', False):
            report['execution_window'] = {'requested_execution_s': args.seconds,
                'began_monotonic_s': began, 'execution_deadline_monotonic_s': drive_deadline,
                'worker_finalization_deadline_monotonic_s': worker_deadline,
                'reservation_deadline_monotonic_s': args.egypt_deadline,
                'worker_finalization_reserve_s': 75., 'independent_cleanup_reserve_s': 90.}
        runtime=get_runtime()
        from backend.graphics import launch
        settings = {**launch(args.render_profile),'offscreen':True}
        if egypt:
            from backend.core.egypt_urban import configuration
            settings['renderer'] = configuration()['native_renderer']
        if not runtime.active:runtime.launch(settings,'127.0.0.1',2000,carla)
        report['render_profile']=runtime.active
        if sys.platform=='win32':
            from backend.carla.runtime import native_processes
            identities=[int(p['ProcessId']) for p in native_processes()]
            for pid in identities:
                subprocess.run(['powershell','-NoProfile','-Command',f'(Get-Process -Id {pid}).PriorityClass="AboveNormal"'],capture_output=True,timeout=10,creationflags=subprocess.CREATE_NO_WINDOW)
            report['validation_priority']='ABOVE_NORMAL_OWNED_WORKER_AND_VERIFIED_ENGINE'
        provider=CarlaProvider(blueprint='vehicle.mercedes.coupe_2020',spawn_index=152,sensor_suite=True,collision_sensor=True,
            fresh_start=True,traffic_manager_port=8052, **({'map_name':'Town10HD_Opt'} if egypt else {}))
        provider.retain_client_until_exit=True
        provider.camera_settings['_comparison_rig']=True
        provider.connect();provider._ensure_dashboard_tools()
        service=SimulationService(provider,required_sensors=provider.required_sensors)
        from threadpoolctl import threadpool_info
        report['numeric_runtime'] = threadpool_info()
        service.journey_comparison=JourneyComparison(folder/'comparisons');service.presentation.directory=folder/'presentations'
        service.pause_on_first_observation=True;service.start(threaded=False)
        def heartbeat():
            while not heartbeat_stop.wait(.1):service.navigation_transport_heartbeat(service.session_id)
        threading.Thread(target=heartbeat,daemon=True).start()
        http=DashboardHTTPServer(('127.0.0.1',8011),Handler);http.simulation_service=service
        perception=PerceptionService(8011);http.perception=perception;service.control_perception=ControlPerceptionCache()
        threading.Thread(target=http.serve_forever,daemon=True).start()
        for _ in range(20):service.step_once()
        service.presentation.start(60 if egypt else 120,guided=True,seed=args.seed,first_mode=args.first,scene='DENSE_CHAOS',
            **({'scenario_id':'EGYPT_URBAN_CHAOS_V1','holdout_acceptance':getattr(args,'holdout_acceptance',False)} if egypt else
               {'scenario_id':'SUDDEN_PEDESTRIAN_COMPARISON_V1'}))
        service.presentation.data.update(preloaded=True,awaiting_choice=True,vehicle_variants=True)
        from backend.core.recording import BufferedRunRecorder
        evidence = BufferedRunRecorder(EvidenceFiles(folder), capacity=32, maximum_bytes=32*1024*1024)
        service.evidence_recorder = evidence
        report.update(samples=[], phases=[], full_samples='samples.jsonl', samples_summary_period_s=1, sample_count=0)
        def write_evidence(name, data):
            if not evidence.record_trace({'file': name, 'data': data}):
                raise RuntimeError('Native evidence queue exhausted; its saved prefix is retained')
        def capture_after_control():
            nonlocal last, last_progress
            d=service.presentation.data
            if d['status']!=last:
                last=d['status'];event={'phase':last,'arm':d.get('arm'),'reason':d.get('reason'),'wall_s':time.monotonic()-began}
                report['phases'].append(event);print(json.dumps(event),flush=True)
                checkpoint={k:v for k,v in report.items() if k!='samples'}
                checkpoint['pair']=progress_pair(service.journey_comparison)
                write_evidence('checkpoint.json',checkpoint)
            if last!='DRIVING':
                return
            if gil_profiler is not None:
                gil_profiler.after_control(service)
            if engine_profiler is not None:
                engine_profiler.after_control(service)
            row=native_driving_sample(service,provider)
            write_evidence('samples.jsonl',row)
            report['sample_count']+=1
            second=int(service.observation.timestamp_s)
            if second!=last_progress:
                last_progress=second
                report['samples'].append(to_dict(row))
                write_evidence('progress.jsonl',{k:row[k] for k in ('frame','timestamp_s','arm','mode','speed_kmh','position_m','scenario')})
            run=service.journey_comparison.active
            if getattr(args,'diagnostic',False) and run and diagnostic_goal(args.seed,args.first,run):
                report['diagnostic_goal_reached']=True
                service.stop_driving('diagnostic_goal_reached',cancel_comparison=False,cancel_presentation=False)
        service.after_control=capture_after_control
        drive_validation(service, folder, report, deadline=drive_deadline,
                         first_mode=args.first, diagnostic=getattr(args, 'diagnostic', False))
        report['presentation']=service.presentation.snapshot();report['pair']=service.journey_comparison.snapshot()
        report['journey']=service.journey;report['last_drive_stop']=service.last_drive_stop;report['dashboard_result']=service.dashboard_result
        report['completed_without_shortening']=service.presentation.data['status']=='RESULTS' and len(report['pair']['runs'])==2 and all(r['status'] in ('ARRIVED','COLLISION') for r in report['pair']['runs'].values())
        if service.presentation.data['status']=='RESULTS' and len(report['pair']['runs'])==2:
            stopped=threading.Event()
            def dispatch(status):
                report['shutdown_dispatch']=status;stopped.set()
            provider.shutdown_handler=dispatch
            report['exports_at_finish_request']=service.presentation.video_states()
            service.presentation.finish(service.presentation.data['id'])
            service.presentation.finish(service.presentation.data['id'])
            while service.presentation.data['status']=='FINISHING' and time.monotonic()<worker_deadline-45:
                service.navigation_transport_heartbeat(service.session_id);service.step_once()
            if service.presentation.data['status']=='COMPLETE':stopped.wait(max(0.,min(20.,worker_deadline-time.monotonic())))
            report['finish_completed']=stopped.is_set() and service.presentation.data['status']=='COMPLETE'
            report['presentation']=service.presentation.snapshot();report['pair']=service.journey_comparison.snapshot()
            report['video_states']=service.presentation.video_states()
            report['shared_perception']=service.presentation.data.get('shared_perception')
    except BaseException as error:report.update(error=str(error),traceback=traceback.format_exc())
    finally:
        if engine_profiler is not None:
            try:
                engine_profiler.finish(worker_deadline - 45.)
            except (OSError,ValueError,RuntimeError) as error:
                engine_profiler.evidence.update(status='ERROR',error=str(error),error_type=type(error).__name__)
        if gil_profiler is not None:
            try:
                gil_profiler.finish(worker_deadline - 45.)
            except (OSError, ValueError, RuntimeError) as error:
                gil_profiler.evidence.update(status='ERROR', error=str(error), error_type=type(error).__name__)
        # Save actual measurements before entering native destruction. A C++
        # exception during cleanup must not erase the failed attempt.
        report['source_unchanged']=source_hashes()==report['source_hashes'];report['wall_s']=time.monotonic()-began
        save_json(folder/'report.json',report)
        def cleanup_stage(name):
            report['cleanup_stage'] = name
            report.setdefault('shutdown_stages', []).append({'stage':name,'monotonic_s':time.monotonic()})
            save_json(folder/'cleanup-stage.json', {'stage':name,'stages':report['shutdown_stages']})
        heartbeat_stop.set()
        if service:
            service.after_control = None
        if crash_request is not None:
            try:
                report['diagnostic_native_crash_capture'] = start_native_teardown_capture(
                    args, folder, service, worker_deadline - 15.)
            except (OSError, ValueError, RuntimeError) as error:
                report['diagnostic_native_crash_capture'] = {
                    **crash_request, 'status': 'ERROR', 'cleanup_confirmed': False,
                    'capture_scope': 'NATIVE_TEARDOWN_ONLY_AFTER_DRIVING_EVIDENCE',
                    'error': str(error), 'error_type': type(error).__name__}
            save_json(folder / 'report.json', report)
        if service:
            try:
                service.shutdown_observer=cleanup_stage
                if service.journey_comparison.active:report['incomplete_pair']=service.journey_comparison.snapshot()
                cleanup_stage('SIMULATION_SERVICE_CLOSE')
                service.close(deadline=args.egypt_deadline-90. if egypt else worker_deadline)
                report['cleanup_confirmed']=not provider.cleanup_errors and service.shutdown_error is None
                report['pair']=service.journey_comparison.snapshot()
                from backend.core.driving_video import wait_for_exports
                cleanup_stage('RECORDING_EXPORTS_CLOSE')
                report['exports_closed']=wait_for_exports(0.)
            except BaseException as error:report['cleanup_error']=str(error)
        elif provider:
            cleanup_stage('PROVIDER_CLOSE')
            try:provider.close()
            except BaseException as error:report['cleanup_error']=str(error)
        cleanup_stage('HTTP_SERVER_CLOSE')
        if http:http.shutdown();http.server_close()
        cleanup_stage('PERCEPTION_CLOSE')
        if perception:perception.close()
        if evidence and not evidence.closed:
            cleanup_stage('EVIDENCE_WRITER_CLOSE_FALLBACK')
            try:evidence.close()
            except RuntimeError as error:report['cleanup_error']=str(error)
        report['source_unchanged']=source_hashes()==report['source_hashes'];report['wall_s']=time.monotonic()-began
        report['cleanup_stage'] = 'ERROR' if report.get('cleanup_error') else 'COMPLETE'
        save_json(folder/'report.json',report)
    print(json.dumps({'report':str(folder/'report.json'),'passed':report.get('pair',{}).get('scenario_validation',{}).get('passed',False),'error':report.get('error')}),flush=True)
    if getattr(args,'diagnostic',False):
        return 0 if diagnostic_worker_passed(args, report) else 1
    return 0 if report.get('pair',{}).get('scenario_validation',{}).get('passed') else 1


def validate_egypt_worker(args):
    if getattr(args,'rule_ticket',None) or args.render_profile != 'LOW':
        raise ValueError('Egypt validation requires its separate allowance and LOW rendering')
    if not all(getattr(args,name,None) is not None for name in ('egypt_budget','egypt_reservation','egypt_deadline')):
        raise ValueError('Egypt worker requires --egypt-budget, reservation and deadline from its parent')
    ticket = EgyptBudget(args.egypt_budget).worker_ticket(
        args.egypt_reservation,args.egypt_deadline,args.seed,args.first)
    if (ticket['phase']=='ACCEPTANCE') != bool(getattr(args,'holdout_acceptance',False)):
        raise ValueError('Egypt worker partition differs from its parent reservation')
    if bool(getattr(args, 'diagnostic', False)) != (ticket.get('purpose') == 'DIAGNOSTIC'):
        raise ValueError('Egypt worker diagnostic scope differs from its reservation')
    return ticket


def run(args):
    gil_request = diagnostic_gil_request(args)
    crash_request = diagnostic_native_crash_request(args)
    engine_request = diagnostic_engine_request(args)
    from scripts.final_runtime import state
    s=state()
    if s and s.get('connected'):raise RuntimeError('Stop the ordinary dashboard before isolated native validation')
    from backend.carla.runtime import NativeRuntime
    runtime=NativeRuntime(monitor=False);was_running=runtime.active is not None
    egypt = getattr(args, 'scenario', None) == 'EGYPT_URBAN_CHAOS_V1'
    if egypt:
        from backend.core.egypt_urban import admission, configuration, source_fingerprint
        egypt_ticket=validate_egypt_worker(args)
        if was_running:
            raise RuntimeError('Egypt validation requires an unowned stopped simulator; the active engine is not touched')
        if args.seed in configuration()['holdout_seeds'] and not getattr(args, 'holdout_acceptance', False):
            raise ValueError('Reserved seeds require the frozen one-shot Egypt acceptance matrix')
        admission('Town10HD_Opt', 60.)
        if getattr(args,'diagnostic',False) and (egypt_ticket.get('purpose')!='DIAGNOSTIC' or (args.seed,args.first) not in DIAGNOSTIC_TARGETS):
            raise ValueError('Diagnostic workers require a development diagnostic reservation and declared target')
    folder=ROOT/'output'/('egypt-urban-pairs' if egypt else 'crossing-pairs')/uuid.uuid4().hex;folder.mkdir(parents=True)
    args.report_folder = folder
    if egypt:
        EgyptBudget(args.egypt_budget).record_attempt_report(egypt_ticket,args.seed,args.first,folder/'report.json')
    report={'source':'LIVE_NATIVE_CARLA','seed':args.seed,'first_mode':args.first,'source_hashes':source_hashes()}
    if gil_request is not None:
        report['diagnostic_gil_profile'] = gil_request
    if crash_request is not None:
        report['diagnostic_native_crash_capture'] = crash_request
    if engine_request is not None:
        report['diagnostic_engine_profile'] = engine_request
    if egypt:
        report.update(scenario_id='EGYPT_URBAN_CHAOS_V1', source_sha256=source_fingerprint())
        if getattr(args,'diagnostic',False):
            report.update(diagnostic=True, scope='DEVELOPMENT_DIAGNOSTIC', native_acceptance=False)
    report['source_archive']=archive_sources(folder,report['source_hashes'])
    if egypt:
        report['egypt_reservation']={'id':args.egypt_reservation,'deadline':args.egypt_deadline,'budget':args.egypt_budget}
    save_json(folder/'initial.json',report);print(str(folder),flush=True)
    child=None
    try:
        with (folder/'worker.log').open('w',encoding='utf8') as log:
            child=subprocess.Popen([sys.executable,'-m','scripts.native.validate_crossing_pair','--worker','--folder',str(folder),
                '--seed',str(args.seed),'--first',args.first,'--seconds',str(args.seconds),'--render-profile',args.render_profile,
                *(['--scenario','EGYPT_URBAN_CHAOS_V1'] if egypt else []),
                *(['--holdout-acceptance'] if egypt and getattr(args,'holdout_acceptance',False) else []),
                *(['--diagnostic'] if getattr(args,'diagnostic',False) else []),
                *(['--egypt-budget',str(args.egypt_budget),'--egypt-reservation',args.egypt_reservation,
                   '--egypt-deadline',str(args.egypt_deadline)] if egypt else []),
                *(['--rule-ticket',str(args.rule_ticket)] if getattr(args,'rule_ticket',None) else [])],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
            deadline=min(time.monotonic()+args.seconds+180.,args.egypt_deadline-90.) if egypt else time.monotonic()+args.seconds
            while child.poll() is None:
                try:
                    child.wait(timeout=remaining_seconds(deadline,1.))
                except subprocess.TimeoutExpired:
                    callback=getattr(args,'on_progress',None);checkpoint=folder/'checkpoint.json'
                    if callback and checkpoint.is_file():
                        callback(json.loads(checkpoint.read_text(encoding='utf8')).get('pair',{}))
                except TimeoutError:
                    child.kill();child.wait(timeout=10)
                    report['worker_deadline_expired']=True
                    break
        if not (folder/'report.json').exists():
            partial=json.loads((folder/'checkpoint.json').read_text()) if (folder/'checkpoint.json').exists() else report
            partial.update(error='Native worker exited before finalization; original logs and checkpoints retained',native_worker_exit_code=child.returncode,
                cleanup_confirmed=False,completed_without_shortening=False)
            save_json(folder/'report.json',partial)
        print(json.dumps({'report':str(folder/'report.json'),'exit_code':child.returncode}),flush=True)
    finally:
        if child is not None and child.poll() is None:
            child.kill();child.wait(timeout=10)
        if not was_running:
            path=folder/'report.json'
            saved=json.loads(path.read_text(encoding='utf8')) if path.exists() else {**report,'error':'Worker failed before reporting'}
            saved['native_worker_exit_code'] = child.returncode if child is not None else None
            if engine_request is not None:
                marker = folder/'engine-profile-status.json'
                try:
                    profile = json.loads(marker.read_text(encoding='utf8')) if marker.is_file() else engine_request
                    if not isinstance(profile,dict):
                        raise ValueError('Invalid owned engine profile evidence')
                    if profile.get('status') in ('REQUESTED','RUNNING'):
                        profile = {**profile,'status':'INCOMPLETE','error':'Worker exited before engine profiling finalized'}
                except (OSError,ValueError) as error:
                    profile = {**engine_request,'status':'ERROR','error':str(error)}
                saved['diagnostic_engine_profile'] = profile
            if crash_request is not None:
                try:
                    from scripts.native.native_crash_capture import finish_capture
                    saved['diagnostic_native_crash_capture'] = finish_capture(
                        folder / 'native-crash-capture',
                        deadline=min(time.monotonic() + 15., args.egypt_deadline - 90.),
                        worker_exit_code=saved['native_worker_exit_code'])
                    saved['diagnostic_native_crash_capture']['capture_scope'] = (
                        'NATIVE_TEARDOWN_ONLY_AFTER_DRIVING_EVIDENCE')
                except (OSError, ValueError, RuntimeError) as error:
                    saved['diagnostic_native_crash_capture'] = {
                        **crash_request, 'status': 'ERROR', 'cleanup_confirmed': False,
                        'error': str(error), 'error_type': type(error).__name__}
            if gil_request is not None:
                marker = folder / 'gil-profile-status.json'
                profile = saved.get('diagnostic_gil_profile') or gil_request
                try:
                    if marker.is_file():
                        profile = json.loads(marker.read_text(encoding='utf8'))
                    if not isinstance(profile, dict) or profile.get('requested') is not True:
                        raise ValueError('Native worker omitted requested GIL profiler evidence')
                    if profile.get('status') in ('REQUESTED', 'RUNNING'):
                        profile = {**profile, 'status': 'INCOMPLETE',
                                   'error': 'Native worker exited without finalizing requested GIL profiling'}
                except (OSError, ValueError) as error:
                    profile = {**gil_request, 'status': 'ERROR', 'error': str(error)}
                saved['diagnostic_gil_profile'] = profile
            cleanup_marker=folder/'cleanup-stage.json'
            if cleanup_marker.is_file() and child is not None and child.returncode not in (0,1):
                marker=json.loads(cleanup_marker.read_text(encoding='utf8'))
                saved.update(cleanup_stage=marker['stage'],shutdown_stages=marker['stages'])
            saved['native_acceptance']=False
            try:
                deadline=args.egypt_deadline if egypt else None
                probe=cleanup_probe(deadline)
                runtime.stop(**({'port':2000,'deadline':deadline} if egypt else {}))
                saved['independent_cleanup_probe']=probe
                if egypt:
                    from backend.carla.runtime import native_processes
                    saved['simulator_exit_confirmed']=not native_processes(timeout=remaining_seconds(deadline,15))
                else:
                    saved['simulator_exit_confirmed']=runtime.inspect() is None
                saved['video_playback_after_exit']=(verify_videos(saved,deadline,diagnostic=True) if saved['simulator_exit_confirmed'] and getattr(args,'diagnostic',False) else
                    verify_videos(saved,deadline) if saved['simulator_exit_confirmed'] else
                    {'passed':False,'error':'CARLA process exit was not verified; playback was not attempted'})
                if not egypt:
                    from .crossing_causality import critical_prediction_evidence
                    saved['critical_prediction_evidence']=critical_prediction_evidence(saved)
                saved['native_acceptance']=bool(saved.get('pair',{}).get('scenario_validation',{}).get('passed')
                    and saved['pair'].get('conditions_match') and (egypt or saved['critical_prediction_evidence']['passed'])
                    and saved.get('source_unchanged') and saved.get('completed_without_shortening') and saved.get('finish_completed')
                    and saved.get('exports_closed') and saved.get('cleanup_confirmed') and probe['passed']
                    and saved['video_playback_after_exit']['passed'] and child is not None and child.returncode==0
                    and saved['simulator_exit_confirmed'])
            except (OSError,ValueError,RuntimeError,subprocess.SubprocessError) as error:
                saved['finalization_error']=str(error)
            if egypt:
                saved['source_unchanged'] = saved.get('source_unchanged') and source_fingerprint() == saved['source_sha256']
                saved['native_acceptance'] = saved['native_acceptance'] and saved['source_unchanged']
                saved['attempts_retained'] = all((folder/name).is_file() for name in ('initial.json','worker.log','source.zip'))
                saved['worker_deadline_expired']=report.get('worker_deadline_expired',False)
                saved['native_acceptance']=saved['native_acceptance'] and not saved['worker_deadline_expired']
                if getattr(args,'diagnostic',False):
                    saved['native_acceptance']=False
                    saved['diagnostic_assessment']=diagnostic_assessment(saved)
                    saved['diagnostic_passed']=saved['diagnostic_assessment']['passed']
            save_json(path,saved)
    return 0 if json.loads((folder/'report.json').read_text(encoding='utf8')).get(
        'diagnostic_passed' if getattr(args,'diagnostic',False) else 'native_acceptance') else 1


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--seed',type=int,default=1701);p.add_argument('--first',choices=('NORMAL','ROBOSPHERE'),default='NORMAL')
    p.add_argument('--render-profile',choices=('LOW','BALANCED','HIGH'),default='LOW')
    p.add_argument('--seconds',type=float,default=900.);p.add_argument('--worker',action='store_true');p.add_argument('--folder')
    p.add_argument('--scenario',choices=('EGYPT_URBAN_CHAOS_V1',));p.add_argument('--rule-ticket')
    p.add_argument('--egypt-budget');p.add_argument('--egypt-reservation');p.add_argument('--egypt-deadline',type=float)
    p.add_argument('--holdout-acceptance',action='store_true')
    p.add_argument('--diagnostic',action='store_true')
    a=p.parse_args()
    if not 180<=a.seconds<=1800:p.error('Use a bounded 180–1800 second validation')
    if a.worker:
        result=worker(a)
        # All recording/actor cleanup results are saved above. Retire the SDK
        # process before the parent stops UE, as the production stop helper
        # does; Windows libcarla destructor unwinding is not reliable.
        import os
        sys.stdout.flush();sys.stderr.flush();os._exit(result)
    raise SystemExit(run(a))
