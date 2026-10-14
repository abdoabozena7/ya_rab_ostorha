"""Three independent frozen TEST pairs through the sole existing native owner."""
import argparse
import hashlib
import json
from pathlib import Path
import time
import threading
from websockets.sync.client import connect
from backend.learning.experiment_budget import ExperimentBudget

ROOT=Path(__file__).resolve().parents[2]


def main():
    p=argparse.ArgumentParser();p.add_argument('--pairs',type=int,default=3);p.add_argument('--wall-cap',type=int,default=1500)
    p.add_argument('--resume',action='store_true');args=p.parse_args()
    if not 1<=args.pairs<=3 or not 10<=args.wall_cap<=5400:raise ValueError('Bounded one-to-three TEST pairs required')
    # Server reserves and charges each run. Observer time must not double-charge
    # overlapping wall time; its own deadline still bounds the whole matrix.
    budget=ExperimentBudget(); reservation=(None,time.monotonic(),args.wall_cap)
    path=ROOT/'output/predictive-v2/native-test.json'; path.parent.mkdir(parents=True,exist_ok=True)
    weights=ROOT/'artifacts/learned_safety/predictive_v2/heads.npz';checksum=hashlib.sha256(weights.read_bytes()).hexdigest()
    report={'weights_sha256':checksum,'frozen_before_test':True,'pairs':[],'completed':False,'failures':[]}
    if args.resume:
        report=json.loads(path.read_text())
        if report['weights_sha256']!=checksum:raise ValueError('Cannot resume TEST with different frozen weights')
    def complete_pairs():
        groups={}
        for row in report['pairs']:
            if (row.get('results') or {}).get('completed'):
                groups.setdefault(row['pair_id'],set()).add(row['side'])
        return {key for key,sides in groups.items() if sides=={'RULE','MODEL'}}
    seq=0;state=None
    def save():path.write_text(json.dumps(report,indent=2),encoding='utf8')
    with connect('ws://127.0.0.1:8001',max_size=2**24) as ws:
        send_lock=threading.Lock(); heartbeat_stop=threading.Event()
        def send(kind,**payload):
            nonlocal seq
            with send_lock:
                seq+=1;ws.send(json.dumps({'type':kind,'sequence':seq,**payload}));return seq
        def receive():
            nonlocal state
            message=json.loads(ws.recv(timeout=3))
            if message.get('type')=='error':raise RuntimeError(message['error'])
            if message.get('type')=='snapshot': state=message
            if message.get('error'): raise RuntimeError(message['error'])
            return message
        while state is None:receive()
        send('take_control')
        def heartbeat():
            while not heartbeat_stop.wait(.1):
                current=state
                if current and current.get('journey',{}).get('status') in ('STARTING','RUNNING'):
                    try:send('journey_heartbeat',session_id=current['sessionId'])
                    except Exception:break
        heartbeat_thread=threading.Thread(target=heartbeat,daemon=True);heartbeat_thread.start()
        try:
            while len(complete_pairs())<args.pairs:
                current=state.get('comparisonV2') or {}; saved=current.get('results',{})
                # A bounded interrupted matrix can repeat only its missing side.
                sides=[side for side in ('RULE','MODEL') if side not in saved] if saved and len(saved)<2 else ['RULE','MODEL']
                pair_rows=[]
                for side in sides:
                    initial=state.get('comparisonV2',{});old_id=initial.get('pair_id')
                    send('comparison_v2',value={'operation':'RUN','side':side})
                    began=time.monotonic();seen_running=False;last_log=0.;samples=[]
                    while time.monotonic()-reservation[1] < args.wall_cap-5:
                        receive();v2=state.get('comparisonV2') or {}
                        if v2.get('phase')=='RUNNING' and v2.get('side')==side: seen_running=True
                        if v2.get('error'):raise RuntimeError(v2['error'])
                        if time.monotonic()-last_log>=5:
                            last_log=time.monotonic()
                            sample={'side':side,'phase':v2.get('phase'),'speed':(state.get('vehicle') or {}).get('speedKmh'),
                                'safety':state.get('safetySystem'),'native_tick_hz':state.get('performance',{}).get('nativeTickRateHz')}
                            samples.append(sample)
                            print(json.dumps({k:v for k,v in sample.items() if k!='safety'}),flush=True)
                        if seen_running and v2.get('phase') in ('FINISHED','ERROR'):
                            result=v2.get('latest_attempt') or v2['results'].get(side)
                            if result and result.get('recording'):
                                saved_result=Path(result['recording'])/'comparison-v2-result.json'
                                if saved_result.exists():result=json.loads(saved_result.read_text())
                            row={'pair_id':v2['pair_id'],'side':side,'results':result,
                                'wall_s':time.monotonic()-began,'samples':samples}
                            if not row['results'] or not row['results'].get('completed'):
                                raise RuntimeError('Run interrupted before a terminal result')
                            pair_rows.append(row);report['pairs'].append(row);save();break
                        if time.monotonic()-began>75 and not seen_running:raise TimeoutError('Pair setup failed to reach RUNNING')
                    else: raise TimeoutError('Native TEST budget reached')
                if len(pair_rows)==2 and pair_rows[0]['pair_id']!=pair_rows[1]['pair_id']:
                    raise ValueError('Independent pair did not preserve its pair_id')
            report['completed']=len(complete_pairs())==args.pairs
        except Exception as error:
            report['failures'].append(str(error));print(json.dumps({'failure':str(error)}),flush=True)
        finally:
            heartbeat_stop.set();heartbeat_thread.join(timeout=1)
            try:
                send('comparison_v2',value={'operation':'STOP'});send('stop_driving',reason='test_complete')
            except Exception: pass
            if hashlib.sha256(weights.read_bytes()).hexdigest()!=checksum:raise ValueError('Frozen weights changed during TEST')
            report['budget']=budget.status();save()
    print(json.dumps({'completed':report['completed'],'runs':len(report['pairs']),'failures':report['failures'],'report':str(path)}))

if __name__=='__main__':main()
