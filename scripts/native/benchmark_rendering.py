"""Read-only wall-clock rendering measurements; never advances the CARLA world."""
import argparse
import json
from pathlib import Path
import statistics
import subprocess
import time
import urllib.request


def read_json(path):
    with urllib.request.urlopen('http://127.0.0.1:8000'+path, timeout=5) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--duration', type=float, default=60)
    parser.add_argument('--output', required=True)
    args = parser.parse_args()
    if args.duration <= 0:
        parser.error('Duration must be positive')
    directory = Path(args.output)
    directory.mkdir(parents=True, exist_ok=True)
    catalog = read_json('/api/simulation/catalog')
    rows = []
    started = time.monotonic()
    while time.monotonic()-started < args.duration:
        state = read_json('/api/simulation/state')
        if not state.get('connected') or state.get('sensorErrors'):
            raise RuntimeError('Native rendering unavailable: '+str(state.get('sensorErrors') or state.get('error')))
        gpu = subprocess.run(['nvidia-smi','--query-gpu=memory.used,memory.total,utilization.gpu',
                              '--format=csv,noheader,nounits'],capture_output=True,text=True,check=True,
                             creationflags=subprocess.CREATE_NO_WINDOW,timeout=5)
        used,total,utilization = map(int,gpu.stdout.strip().splitlines()[0].split(', '))
        rows.append({'elapsed_s':time.monotonic()-started,'frame':state['vehicle']['frame'],
                     'simulation_s':state['vehicle']['timestamp'],'mode':state['mode'],
                     'gpu_used_mib':used,'gpu_total_mib':total,'gpu_percent':utilization,
                     'performance':state['performance'],'population':state.get('population'),
                     'sensor_rates':state['sensorRatesHz']})
        time.sleep(1)
    elapsed = rows[-1]['elapsed_s']-rows[0]['elapsed_s']
    summary = {'duration_s':time.monotonic()-started,'active_launch':catalog['settings']['active_launch'],
               'camera_resolution':catalog['settings']['camera_resolution'],
               'actual_ticks_per_wall_second':(rows[-1]['frame']-rows[0]['frame'])/elapsed if elapsed else None,
               'vram_mib':{'median':statistics.median(r['gpu_used_mib'] for r in rows),
                           'peak':max(r['gpu_used_mib'] for r in rows),'total':rows[-1]['gpu_total_mib']},
               'gpu_utilization_median_percent':statistics.median(r['gpu_percent'] for r in rows),
               'population':rows[-1]['population'],'sensor_rates':rows[-1]['sensor_rates'],
               'sensor_errors':{},'samples':len(rows)}
    (directory/'samples.json').write_text(json.dumps(rows,indent=2),encoding='utf-8')
    (directory/'summary.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/camera.jpg',timeout=10) as response:
        (directory/'camera.jpg').write_bytes(response.read())
    print(json.dumps({k:v for k,v in summary.items() if k not in ('population','sensor_rates')}))


if __name__ == '__main__':
    main()
