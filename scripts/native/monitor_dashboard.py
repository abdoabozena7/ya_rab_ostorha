"""Read-only evidence collector while the real browser drives through WebSocket."""
import argparse
import json
from pathlib import Path
import time
import urllib.request


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--duration','--seconds',dest='duration',type=float,default=60)
    parser.add_argument('--output',default='output/native-validation/browser-controls.jsonl')
    args=parser.parse_args(); rows=[]; end=time.monotonic()+args.duration
    path=Path(args.output); path.parent.mkdir(parents=True,exist_ok=True)
    stream=path.open('w',encoding='utf-8') if path.suffix=='.jsonl' else None
    while time.monotonic()<end:
        with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/state',timeout=3) as response:
            state=json.load(response)
        if state.get('vehicle'):
            rows.append({'wallTime':time.time(),'mode':state['mode'],'vehicle':state['vehicle'],
                         'source':state['controlSource'],'journey':state['journey'],
                         'performance':state['performance']})
        if stream:
            stream.write(json.dumps({'wall_time':time.monotonic(),**state})+'\n'); stream.flush()
        time.sleep(.05)
    if stream:
        stream.close(); print(str(path)); return
    proof={'source':'LIVE_NATIVE_BROWSER','samples':rows,'summary':{
        'peak_kmh':max(r['vehicle']['speedKmh'] for r in rows),
        'max_throttle':max(r['vehicle']['throttle'] for r in rows),
        'max_brake':max(r['vehicle']['brake'] for r in rows),
        'steer_range':[min(r['vehicle']['steeringInput'] for r in rows),max(r['vehicle']['steeringInput'] for r in rows)],
        'reverse':any(r['vehicle']['reverse'] for r in rows),
        'handbrake':any(r['vehicle']['handbrake'] for r in rows)}}
    path.write_text(json.dumps(proof,ensure_ascii=False),encoding='utf-8')
    print(json.dumps(proof['summary']))


if __name__=='__main__': main()
