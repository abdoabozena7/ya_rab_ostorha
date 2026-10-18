"""Summarize retained native speed attempts; never starts, retries or edits runs."""
import hashlib
import json
import shutil
import statistics
import time
import urllib.request
from collections import Counter
from pathlib import Path

ROOT=Path(__file__).resolve().parents[1]
ATTEMPTS=(
    ('previous_operator_session','eaad7f40c14a47a1b38befaf85f1062e',None),
    ('intermediate_launch_feedback','c7423b53ae4d4ff1856549ed278dff77','speed-profile-before-render'),
    ('profiled_incomplete_attempt','29e0d4cbb8ba4435a29fade8f662f4be',None),
    ('native_route_controller','f6496d22b9924e6ca9ebf716b5378de3','speed-profile-final'),
    ('delivery_configuration','64e9847c648f4f0b8b90434a4d72e051','speed-profile-delivery'))


def distribution(values):
    values=sorted(v for v in values if v is not None)
    return {'samples':len(values),'median':statistics.median(values),'maximum':max(values)} if values else None


def main():
    destination=ROOT/'docs/evidence/drive-speed-20261018';destination.mkdir(parents=True,exist_ok=True)
    report={'scope':'NATIVE_SPEED_AND_RESOURCE_REPAIR_NOT_DRIVING_ACCEPTANCE','attempts':[],
        'limitations':['Seeds differ across attempts; this is not a controlled performance comparison.',
            '80 km/h is a requested stress target, not a measured minimum or demonstrated sustained speed.',
            'No completed protected route or 20 Hz wall throughput acceptance is established.',
            'The profiled attempt ended with observation_receipt_timeout; its second arm did not run.',
            'A subsequent warm backend reload timed out connecting to CARLA; a full owned-engine restart recovered it.'],
        'software_checks':{'javascript_pass':163,'python_discovered':638,'python_pass':636,'python_optional_skips':2,
            'dashboard_build':'PASS','execution':'Recorded delivery checks; not executed by this collector'}}
    for label,identity,folder in ATTEMPTS:
        pair=json.loads((ROOT/f'output/journey-comparisons/{identity}.json').read_text())
        item={'label':label,'pair_id':identity,'requested_speed_kmh':pair['manifest'].get('speed_kmh'),
            'speed_policy':pair['manifest'].get('speed_policy'),'runs':{}}
        if folder:
            prepared=json.loads((ROOT/f'output/{folder}/prepared-state.json').read_text())
            item['native_setup']={k:prepared['presentation'].get(k) for k in ('seed','setup','population_audit')}
            samples=json.loads((ROOT/f'output/{folder}/driving-samples.json').read_text())
        else:samples=[]
        for mode,run in pair['runs'].items():
            out={k:run.get(k) for k in ('id','status','reason','duration_s','distance_m','collisions',
                'mean_speed_kmh','maximum_speed_kmh','safety_interventions','recording')}
            audit=run.get('initial_condition_audit') or {}
            out['initial_condition_audit']={k:audit.get(k) for k in ('passed','failures')}
            path=Path(run['recording'])
            rows=[json.loads(line) for line in (path/'telemetry/safety-v2.jsonl').read_text().splitlines()]
            reasons=Counter(r['reason'] for r in rows)
            out['recorded_control_decisions']=len(rows)
            out['processing_deadline_brakes']=reasons['CONTROL_PROCESSING_DEADLINE']
            out['stop_reasons']=dict(reasons)
            frames=(json.loads(line) for line in (path/'telemetry/frames.jsonl').open())
            first=None;crossings={str(k):None for k in (1,20,50,80)}
            for frame in frames:
                if first is None:first=frame['timestamp_s']
                for threshold in crossings:
                    if crossings[threshold] is None and abs(frame['vehicle']['speed_mps'])*3.6>=int(threshold):
                        crossings[threshold]=frame['timestamp_s']-first
            out['simulation_seconds_to_speed_kmh']=crossings
            out['recording_status']=json.loads((path/'recording-status.json').read_text())
            modes=prepared['presentation']['modes'] if folder else pair.get('driver_modes',())
            arm=next((i for i,m in enumerate(modes) if m==mode),None)
            selected=[s for s in samples if s['arm']==arm]
            out['wall_tick_rate_hz']=distribution(s['performance']['nativeTickRateHz'] for s in selected)
            out['observation_pipeline_median_ms']=distribution(
                s['performance']['observationPipelineLatencyMs']['median'] for s in selected)
            item['runs'][mode]=out
        report['attempts'].append(item)
    report['source_sha256']={name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in (
        'backend/core/service.py','backend/carla/provider.py','backend/carla/population.py','backend/server.py',
        'backend/graphics.py','backend/core/surface_registration.py')}
    def fetch(path):
        with urllib.request.urlopen('http://127.0.0.1:8000'+path,timeout=15) as response:
            data=response.read();return data
    latency={}
    for endpoint,count in (('/api/simulation/state',5),('/api/simulation/status',20)):
        values=[];size=None
        for _ in range(count):
            began=time.perf_counter();payload=fetch(endpoint);values.append((time.perf_counter()-began)*1000);size=len(payload)
        latency[endpoint]={'latency_ms':distribution(values),'response_bytes':size}
    report['idle_http_resource_probe']=latency
    settings=json.loads(fetch('/api/simulation/catalog'))['settings']
    report['effective_settings']={k:settings.get(k) for k in ('map','simulation_hz','camera_view','camera_resolution',
        'camera_fov','camera_postprocess','camera_motion_blur','camera_bloom','weather','next_launch','active_launch','camera_effects')}
    for arm,mode in ((0,'protected'),(1,'normal')):
        shutil.copyfile(ROOT/f'output/speed-profile-delivery/arm-{arm}.jpg',destination/f'native-{mode}.jpg')
    (destination/'summary.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    print(json.dumps({'output':str(destination),'http_probe':latency}))


if __name__=='__main__':main()
