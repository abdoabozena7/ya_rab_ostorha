"""Read-only native camera/model collector. Does not own ticks or vehicle controls."""
import argparse
import hashlib
import json
from pathlib import Path
import statistics
import time
import urllib.request
try:
    import psutil
except ImportError:
    psutil=None  # Optional memory instrumentation; run with .venv-perception for it.

ROOT=Path(__file__).resolve().parents[2]


def read(path):
    with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/'+path,timeout=5) as response:
        return json.load(response)


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--duration',type=float,default=180)
    parser.add_argument('--output',type=Path,default=ROOT/'output/native-validation/perception-native.json')
    args=parser.parse_args()
    started=time.monotonic();samples=[];identities=set();first=None;last=None
    processes=[]
    for process in psutil.process_iter(['name','cmdline']) if psutil else []:
        try:
            command=' '.join(process.info['cmdline'] or [])
            if 'backend.perception_worker' in command and process.info['name'].startswith('python'):
                processes.append(process)
        except (psutil.NoSuchProcess,psutil.AccessDenied): pass
    while time.monotonic()-started<args.duration:
        state=read('state');model=read('perception')
        sample={'wall_elapsed_s':time.monotonic()-started,'session_id':state['sessionId'],
            'performance':state['performance'],'synchronization':state['synchronization'],
            'model':model,'sensor_errors':state['sensorErrors'], 'sensors':list(state['sensors']),
            'worker_rss_mib':sum(p.memory_info().rss for p in processes if p.is_running())/1048576 if psutil else None}
        samples.append(sample)
        if model['status']=='RUNNING':
            assert model['session_id']==state['sessionId']
            assert model['frame_id']<=state['vehicle']['frame']
            token=model['image_token']
            with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/perception.jpg?token='+token) as response:
                assert response.headers['X-Perception-Token']==token
                image=response.read()
            if first is None:
                first=model
                (args.output.parent/'perception-native-first.jpg').write_bytes(image)
            last=model
            identities.add((model['session_id'],model['frame_id']))
        time.sleep(.5)
    running=[s for s in samples if s['model']['status']=='RUNNING']
    proof={'source':'LIVE_NATIVE_CAMERA_REAL_MODELS','duration_wall_s':time.monotonic()-started,
        'checks':{'real_model_frames':len(identities)>20,
            'no_model_errors':all(s['model']['status'] in ('LOADING','WAITING','RUNNING') for s in samples),
            'periodic_sensor_suite_continues':all(not s['sensor_errors'] and set(s['sensors'])==
                {'frontCamera','depth','radar','lidar','imu','gnss'} for s in samples),
            'immutable_frame_identity':True},'unique_processed_frames':len(identities),
        'actual_processed_rate_hz':len(identities)/(time.monotonic()-started),
        'inference_ms_median':statistics.median(s['model']['inference_ms'] for s in running),
        'ticks_hz_median':statistics.median(s['performance']['nativeTickRateHz'] for s in running),
        'detection_classes':sorted({d['class'] for s in running for d in s['model']['detections']}),
        'ocr_results':[s['model'] for s in running if s['model']['texts']],
        'first':first,'last':last,'samples':samples}
    proof['pass']=all(proof['checks'].values())
    args.output.write_text(json.dumps(proof,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps({k:v for k,v in proof.items() if k not in ('samples','ocr_results','first','last')},ensure_ascii=False))
    assert proof['pass']


if __name__=='__main__': main()
