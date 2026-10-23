"""Measure the existing tick owner; never advance CARLA from an observer."""
import argparse
import json
import math
import os
from pathlib import Path
import statistics
import subprocess
import time

from websockets.sync.client import connect
from .stability_run import backend_pid, memory


def distribution(values):
    values = sorted(v for v in values if type(v) in (float, int) and math.isfinite(v))
    if not values:
        return None
    return {'samples': len(values), 'median': statistics.median(values),
            'p95': values[math.ceil(.95*len(values))-1],
            'minimum': values[0], 'maximum': values[-1]}


def export_states(comparison):
    allowed = (Path(__file__).resolve().parents[2]/'runs'/'normal_city').resolve()
    result = {}
    for mode,run in (comparison or {}).get('runs',{}).items():
        if not run.get('recording'):
            continue
        folder = Path(run['recording']).resolve()
        if not folder.is_relative_to(allowed):
            raise ValueError('Native recording escaped the measured project')
        try:
            result[mode] = json.loads((folder/'video-status.json').read_text(encoding='utf8'))
        except FileNotFoundError:
            result[mode] = {'status':'PENDING'}
        except PermissionError as error:
            result[mode] = {'status':'READ_RETRY','error':str(error)}
            print(json.dumps({'video_status_read_retry':mode,'error':str(error)}),flush=True)
    return result


def summarize(rows):
    groups = {}
    for row in rows:
        key = row.get('mode') or 'HELD'
        groups.setdefault(key, []).append(row)
    result = {}
    for mode, samples in groups.items():
        stages = {}
        for row in samples:
            for group in ('native_ms', 'control_ms', 'scene_ms'):
                for key, value in row[group].items():
                    stages.setdefault(group+'.'+key, []).append(value)
        clock_windows = []
        browser_windows = []
        seen_windows = set()
        detector_frames = set()
        detector_ms = []
        detector_runtimes = []
        image_latencies = []
        decode_times = []
        for row in samples:
            perf = row['performance']
            for client,value in (perf.get('display') or {}).items():
                if value.get('imageLatencyMs') is not None:image_latencies.append(value['imageLatencyMs'])
                if value.get('decodeMs') is not None:decode_times.append(value['decodeMs'])
                count = value.get('completedWindows',0)
                key = (row['round'],client,count)
                if count and key not in seen_windows:
                    seen_windows.add(key)
                    browser_windows.append({'round':row['round'], 'client':client, 'window_number':count,
                        'fps':value.get('displayFps'), 'p95_interval_ms':value.get('p95IntervalMs'),
                        'failed_windows_total':value.get('failedWindows'),
                        'source':'CLIENT_DISTINCT_RAF_PRESENTATIONS_ON_IMAGE_SOCKET'})
            detector = perf.get('perception') or {}
            key = (row['round'],detector.get('frame_id'))
            if detector.get('frame_id') is not None and key not in detector_frames:
                detector_frames.add(key)
                detector_ms.append(detector.get('detector_ms'))
                runtime = detector.get('detector_runtime')
                if runtime and runtime not in detector_runtimes:detector_runtimes.append(runtime)
        for round_id in sorted({r['round'] for r in samples}):
            sequence = [r for r in samples if r['round'] == round_id]
            start = sequence[0]['wall_s']
            while sequence[-1]['wall_s']-start >= 10:
                window = [r for r in sequence if start <= r['wall_s'] <= start+10]
                if len(window) > 1:
                    a,b = window[0],window[-1]
                    span = b['wall_s']-a['wall_s']
                    clock_windows.append({'round':round_id, 'start_wall_s':start, 'measured_wall_s':span,
                        'simulation_wall_ratio':(b['timestamp_s']-a['timestamp_s'])/span,
                        'physics_hz':(b['frame']-a['frame'])/span})
                start += 10
        result[mode] = {'samples': len(samples),
            'native_steps_per_second': distribution([r['performance'].get('nativeTickRateHz') for r in samples]),
            'simulation_wall_ratio': distribution([w['simulation_wall_ratio'] for w in clock_windows]),
            'clock_windows_10s':clock_windows,
            'browser_windows_10s':browser_windows,
            'browser_fps':distribution([w['fps'] for w in browser_windows]),
            'browser_p95_frame_interval_ms':distribution([w['p95_interval_ms'] for w in browser_windows]),
            'browser_image_latency_ms':distribution(image_latencies),
            'browser_decode_ms':distribution(decode_times),
            'detector_ms':distribution(detector_ms), 'detector_runtimes':detector_runtimes,
            'board_used_mib': distribution([(r['performance'].get('gpu') or {}).get('usedMiB') for r in samples]),
            'gpu_utilization_percent': distribution([(r['performance'].get('gpu') or {}).get('utilizationPercent') for r in samples]),
            'stages_ms': {k: distribution(v) for k, v in stages.items()},
            'incomplete_samples': sum(not r['complete'] for r in samples),
            'sensor_errors': [r['sensor_errors'] for r in samples if r['sensor_errors']]}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--http-port', type=int, default=8000)
    parser.add_argument('--ws-port', type=int, default=8001)
    parser.add_argument('--pairs', type=int, default=0)
    parser.add_argument('--seconds', type=float, default=60)
    parser.add_argument('--warmup', type=float, default=10)
    parser.add_argument('--seed', type=int, default=1702)
    parser.add_argument('--first', choices=('NORMAL','ROBOSPHERE'), default='NORMAL')
    parser.add_argument('--max-arm-seconds',type=float,default=0,
        help='Explicit bounded performance window; stopped runs are not route-completion evidence')
    parser.add_argument('--label', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    if args.pairs < 0 or args.seconds <= 0 or args.warmup < 0 or args.max_arm_seconds < 0 or 0 < args.max_arm_seconds < 10:
        parser.error('Positive duration and nonnegative pair count/warmup required')
    root = Path(args.out)
    root.mkdir(parents=True, exist_ok=True)
    from backend.carla.runtime import native_processes
    processes = native_processes()
    engine = next(p['ProcessId'] for p in processes if 'Shipping' in p['ExecutablePath'])
    pids = {'backend': backend_pid(args.http_port), 'engine': engine}
    report = {'label': args.label, 'seed': args.seed, 'requested_pairs': args.pairs,
        'probe_protocol':'MATCHED_V2_WAIT_FOR_EXPORTS_AND_QUIET_3S',
        'maximum_arm_wall_s':args.max_arm_seconds or None,
        'route_scope':'BOUNDED_PERFORMANCE_WINDOW_NOT_ROUTE_ACCEPTANCE' if args.max_arm_seconds else 'ARRIVAL_OR_CONTACT',
        'source': 'LIVE_NATIVE_EXISTING_OWNER', 'tick_owner': 'simulation-worker',
        'source_commit': subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip(),
        'native_processes': processes, 'pairs': [], 'resources': [], 'errors': [], 'observation_outages': [],
        'display_acceptance': 'REQUIRES_INDEPENDENT_VISIBLE_BROWSER_MEASUREMENT',
        'process_gpu_memory': {'value': None, 'reason': 'Not inferred from total board memory; inspect WDDM/NVML availability'},
        'logical_cpu_count': os.cpu_count(), 'warmup_s': args.warmup}
    rows = []
    began = time.monotonic()
    last_sample = last_resource = -float('inf')
    prior_resources = None
    round_index = 0
    expected_id = last_phase = None
    sequence = 0
    sent_at = None
    initial = True
    saved_result_id = None
    exports_ready_at = None
    arm_started = {}
    stopped_arms = set()
    with (root/(args.label+'-samples.jsonl')).open('w', encoding='utf8') as stream:
        try:
            with connect(f'ws://127.0.0.1:{args.ws_port}', max_size=2**24, compression=None) as socket:
                def send(kind, **data):
                    nonlocal sequence
                    sequence += 1
                    socket.send(json.dumps({'type': kind, 'sequence': sequence, **data}))
                while True:
                    now = time.monotonic()
                    if now-began > (args.pairs*900 if args.pairs else args.seconds+args.warmup):
                        if args.pairs:
                            raise TimeoutError('Matched comparison did not finish within the bounded wall time')
                        break
                    try:
                        state = json.loads(socket.recv(timeout=.2))
                    except TimeoutError:
                        continue
                    if state.get('type') == 'error':
                        raise RuntimeError(state['error'])
                    if state.get('type') != 'snapshot':
                        continue
                    if not state.get('connected'):
                        phase = (state.get('presentation') or {}).get('status')
                        outage = {'phase': phase, 'reason': state.get('error') or 'Native observations unavailable'}
                        if not report['observation_outages'] or any(report['observation_outages'][-1].get(k) != v for k, v in outage.items()):
                            report['observation_outages'].append({**outage, 'wall_s': now-began})
                        if state.get('controller'):
                            send('journey_heartbeat', session_id=state['sessionId'])
                        continue
                    if initial:
                        report['initial'] = {k: state.get(k) for k in ('sessionId', 'world', 'population', 'performance')}
                        initial = False
                        existing = state.get('presentation') or {}
                        if args.pairs and existing.get('status') not in ('IDLE', 'COMPLETE', 'CANCELLED', 'ERROR', None):
                            report['interrupted_before_measurement'] = existing
                            send('take_control')
                            continue
                    if state.get('controller'):
                        send('journey_heartbeat', session_id=state['sessionId'])
                    presentation = state.get('presentation') or {}
                    phase = presentation.get('status')
                    if args.pairs and expected_id is None:
                        if sent_at is None and phase not in ('IDLE', 'COMPLETE', 'CANCELLED', 'ERROR', None):
                            continue
                        if sent_at is None:
                            report['previous_presentation_id'] = presentation.get('id')
                            send('presentation', value={'operation': 'START_GUIDED', 'speed_kmh': 120,
                                'seed': args.seed, 'first_mode': args.first, 'scene': 'DENSE_CHAOS'})
                            sent_at = now
                        elif presentation.get('id') != report['previous_presentation_id']:
                            expected_id = presentation.get('id')
                            round_index += 1
                    if expected_id and presentation.get('id') == expected_id:
                        current_phase = (round_index, phase, presentation.get('arm'))
                        if current_phase != last_phase:
                            print(json.dumps({'round': round_index, 'phase': phase,
                                'arm': presentation.get('arm'), 'wall_s': now-began}), flush=True)
                            last_phase = current_phase
                        if phase == 'ERROR':
                            raise RuntimeError(presentation.get('reason') or 'Native comparison failed')
                        if phase == 'DRIVING' and args.max_arm_seconds:
                            key=(expected_id,presentation.get('arm'))
                            arm_started.setdefault(key,now)
                            if now-arm_started[key]>=args.max_arm_seconds and key not in stopped_arms:
                                stopped_arms.add(key)
                                send('stop_driving',reason='performance_measurement_window')
                        if phase in ('RESULTS','CANCELLED'):
                            if saved_result_id != expected_id:
                                report['pairs'].append({'round': round_index, 'presentation': presentation,
                                    'comparison': state.get('journeyComparison')})
                                saved_result_id = expected_id
                                exports_ready_at = None
                            videos = export_states(state.get('journeyComparison'))
                            report['pairs'][-1]['video_exports'] = videos
                            if not videos or any(v.get('status') not in ('READY','ERROR','UNAVAILABLE') for v in videos.values()):
                                continue
                            if exports_ready_at is None:
                                exports_ready_at = now
                            if now-exports_ready_at < 3:
                                continue
                            if round_index >= args.pairs:
                                break
                            send('take_control')
                            expected_id = sent_at = None
                            continue
                    if now-last_resource >= 3:
                        current = {name: memory(pid) for name, pid in pids.items()}
                        for name, value in current.items():
                            value['cpu_percent_one_core'] = (
                                100*(value['cpu_seconds']-prior_resources[1][name]['cpu_seconds'])/(now-prior_resources[0])
                                if prior_resources else None)
                        report['resources'].append({'wall_s': now-began, 'processes': current})
                        prior_resources = (now, current)
                        last_resource = now
                    measuring = (phase == 'DRIVING' and (state.get('journey') or {}).get('status')=='RUNNING') if args.pairs else now-began >= args.warmup
                    if not measuring or now-last_sample < .1:
                        continue
                    last_sample = now
                    stop = state.get('stopDiagnostics') or {}
                    vehicle = state['vehicle']
                    physics = (state.get('performance') or {}).get('physics') or {}
                    row = {'round': round_index, 'wall_s': now-began,
                        'mode': (state.get('journey') or {}).get('driving_mode')
                            if (state.get('journey') or {}).get('status')=='RUNNING' else None,
                        'frame': physics.get('frame', vehicle['frame']),
                        'timestamp_s': physics.get('timestamp_s', vehicle['timestamp']),
                        'performance': state.get('performance') or {},
                        'native_ms': (state.get('performance') or {}).get('nativeStepTimingMs') or {},
                        'control_ms': stop.get('control_timing_ms') or {},
                        'scene_ms': (state.get('controlScene') or {}).get('timings_ms') or {},
                        'complete': state.get('frameComplete', False),
                        'sensor_errors': state.get('sensorErrors') or {},
                        'synchronization': state.get('synchronization'),
                        'population': (state.get('population') or {}).get('actual'),
                        'journey': state.get('journey'), 'stop_reason': stop.get('reason')}
                    rows.append(row)
                    stream.write(json.dumps(row, allow_nan=False)+'\n')
                    stream.flush()
        except (OSError, RuntimeError, ValueError, TimeoutError) as error:
            report['errors'].append({'type': type(error).__name__, 'message': str(error)})
            raise
        finally:
            report['elapsed_wall_s'] = time.monotonic()-began
            report['measurements'] = summarize(rows)
            report['attempted_pairs'] = len(report['pairs'])
            report['completed_pairs'] = sum(all(mode in (p.get('comparison') or {}).get('runs',{})
                for mode in ('NORMAL','ROBOSPHERE')) for p in report['pairs'])
            (root/(args.label+'-summary.json')).write_text(json.dumps(report, indent=2, allow_nan=False), encoding='utf8')
    print(json.dumps({'label': args.label, 'pairs': len(report['pairs']),
        'measurements': report['measurements']}, indent=2), flush=True)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
