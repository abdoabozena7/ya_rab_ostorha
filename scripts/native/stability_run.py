"""Read-only native endurance/performance evidence; never ticks or controls CARLA."""
import argparse
import json
import os
from pathlib import Path
import statistics
import subprocess
import time

from websockets.sync.client import connect


from backend.core.resources import process_resources as memory


def backend_pid(port):
    result = subprocess.run(['powershell', '-NoProfile', '-Command',
        f'Get-NetTCPConnection -LocalPort {port} -State Listen | Select-Object -ExpandProperty OwningProcess -Unique'],
        capture_output=True, text=True, check=True)
    ids = result.stdout.strip().splitlines()
    if len(ids) != 1:
        raise RuntimeError('Ambiguous backend listener identity')
    return int(ids[0])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--duration', type=float, default=1200)
    parser.add_argument('--output', default='output/native-validation/gate4-stability')
    parser.add_argument('--http-port', type=int, default=8000)
    parser.add_argument('--ws-port', type=int, default=8001)
    parser.add_argument('--recording', action='store_true')
    args = parser.parse_args()
    if args.duration <= 0: raise ValueError('Positive duration required')
    import carla
    from backend.carla.runtime import native_processes
    client = carla.Client('localhost', 2000); client.set_timeout(8)
    assert client.get_client_version() == client.get_server_version() == '0.9.16'
    world = client.get_world(); world.wait_for_tick(8)
    processes = native_processes()
    engine = next(p for p in processes if 'Shipping' in p['ExecutablePath'])['ProcessId']
    backend = backend_pid(args.http_port)
    root = Path(args.output); root.parent.mkdir(parents=True, exist_ok=True)
    rows, errors = [], []
    ws_messages = 0; max_gap = 0.; latest = None; previous_frame = None
    started = last_message = time.monotonic(); sampled = -10.; actors_sampled = -30.; counts = None
    initial_sync = None; controller_present = False
    with root.with_suffix('.jsonl').open('w', encoding='utf8') as file:
        try:
            with connect(f'ws://127.0.0.1:{args.ws_port}', max_size=2**22) as socket:
                while time.monotonic()-started < args.duration:
                    message = json.loads(socket.recv(timeout=3))
                    if message.get('type') != 'snapshot': continue
                    now = time.monotonic(); max_gap = max(max_gap, now-last_message); last_message = now
                    ws_messages += 1; latest = message
                    if not message['connected']: raise RuntimeError(message.get('error') or 'Native disconnected')
                    if message['recording'] != args.recording: raise RuntimeError('Unexpected recording state')
                    if message['sensorErrors']: raise RuntimeError(str(message['sensorErrors']))
                    if len(message['sensorRegistry']) != 7: raise RuntimeError('Seven sensors required')
                    if message['controller']: raise RuntimeError('No dashboard owns the native session')
                    controller_present = True
                    frame = message['vehicle']['frame']
                    if previous_frame is not None and frame < previous_frame: raise RuntimeError('WS native frame regressed')
                    previous_frame = frame
                    if initial_sync is None: initial_sync = message['synchronization']
                    elapsed = now-started
                    if elapsed-actors_sampled >= 30:
                        actors = world.get_actors()
                        counts = {'vehicle':len(actors.filter('vehicle.*')),
                                  'walker':len(actors.filter('walker.pedestrian.*')),
                                  'controller':len(actors.filter('controller.ai.walker')),
                                  'sensor':len(actors.filter('sensor.*'))}
                        actors_sampled = elapsed
                    if elapsed-sampled < 2: continue
                    row = {'elapsed_s':elapsed,'unix':time.time(),'frame':frame,
                           'simulation_timestamp_s':message['vehicle']['timestamp'],
                           'performance':message['performance'],'sync':message['synchronization'],
                           'sensor_rates_sim_hz':message['sensorRatesHz'], 'actors':counts,
                           'backend_memory':memory(backend),'carla_memory':memory(engine),
                           'backend_step_ms':message['backendStepMs'], 'mode':message['mode'],
                           'control':{k:message['vehicle'][k] for k in ('speedKmh','throttle','brake')},
                           'population':message.get('population'),
                           'ws_messages':ws_messages,'ws_max_gap_s':max_gap}
                    rows.append(row); file.write(json.dumps(row)+'\n');file.flush(); sampled=elapsed
                    root.with_suffix('.progress.json').write_text(json.dumps(row),encoding='utf8')
        except Exception as error:
            errors.append(str(error))
    duration = time.monotonic()-started
    tail = rows[-1] if rows else {}
    sync_delta = {k:latest['synchronization'][k]-initial_sync[k] for k in ('completeFrames','incompleteFrames')} if latest else {}
    issue_delta = {k:latest['synchronization']['issues'][k]-initial_sync['issues'][k] for k in initial_sync['issues']} if latest else {}
    summary = {'source':'LIVE_NATIVE','duration_wall_s':duration,'recording':args.recording,
               'versions':[client.get_server_version(),client.get_client_version()],
               'samples':len(rows),'websocket_messages':ws_messages,'ws_max_gap_s':max_gap,
               'dashboard_connected':controller_present,'errors':errors,'sync_delta':sync_delta,
               'sync_issue_delta':issue_delta,'render_fps':None,'final':tail}
    if rows:
        warm = [r for r in rows if r['elapsed_s']>=min(120,args.duration*.2)]
        summary['native_tick_hz_median'] = statistics.median(r['performance']['nativeTickRateHz'] for r in warm)
        summary['sensor_wall_hz_medians'] = {k:statistics.median(r['performance']['sensorWallRatesHz'][k] for r in warm) for k in ('frontCamera','depth','radar','lidar','imu','gnss')}
        summary['actor_counts_minmax'] = {k:[min(r['actors'][k] for r in rows),max(r['actors'][k] for r in rows)] for k in counts}
        window = max(1,len(warm)//5)
        summary['memory'] = {who:{'initial_median_private_mib':statistics.median(r[who]['private_mib'] for r in warm[:window]),
            'final_median_private_mib':statistics.median(r[who]['private_mib'] for r in warm[-window:]),
            'peak_private_mib':max(r[who]['private_mib'] for r in rows)} for who in ('backend_memory','carla_memory')}
        span = warm[-1]['elapsed_s']-warm[0]['elapsed_s']
        summary['cpu_percent_total_machine'] = {who:100*(warm[-1][who]['cpu_seconds']-warm[0][who]['cpu_seconds'])/span/(os.cpu_count() or 1)
            for who in ('backend_memory','carla_memory')} if span else {}
        summary['vram_mib_minmax'] = [min(r['performance']['gpu']['usedMiB'] for r in rows if r['performance']['gpu']),max(r['performance']['gpu']['usedMiB'] for r in rows if r['performance']['gpu'])]
    summary['transport_and_sensors_pass'] = not errors and duration>=args.duration and max_gap<3 and sync_delta.get('incompleteFrames',0)==0 and not any(issue_delta.values())
    root.with_suffix('.json').write_text(json.dumps(summary,indent=2),encoding='utf8')
    print(json.dumps(summary,indent=2))
    if errors: raise SystemExit(1)


if __name__ == '__main__': main()
