"""Bounded production Restart observer; the backend alone owns native ticks."""
import argparse
import hashlib
import json
from pathlib import Path
import time
import urllib.request
from websockets.sync.client import connect
from backend.learning.native_validation_budget import NativeValidationBudget


ROOT=Path(__file__).resolve().parents[1]


def observe_browser(ticket,seed,seconds,output):
    budget=NativeValidationBudget(ticket)
    if budget.status()['remaining_s']<seconds+30:raise ValueError('Insufficient remaining native batch')
    output=Path(output);output.mkdir(parents=True,exist_ok=True)
    hashes={str(path.relative_to(ROOT)):hashlib.sha256(path.read_bytes()).hexdigest()
        for folder in ('backend/core','backend/carla','backend/computer_vision') for path in (ROOT/folder).glob('*.py')}
    from scripts.validate_hybrid_native import archive_sources
    report={'source':'LIVE_NATIVE_CARLA_BROWSER_OWNED','seed':seed,'source_hashes':hashes,
        'source_archive':archive_sources(output,hashes),'ticket':budget.status(),
        'started_at_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'samples':0}
    started=time.monotonic();state={};previous=None
    try:
        with (output/f'{seed}-samples.jsonl').open('x',encoding='utf8') as stream:
            while time.monotonic()-started<seconds and budget.status()['remaining_s']>30:
                with urllib.request.urlopen('http://127.0.0.1:8000/api/state',timeout=10) as response:state=json.load(response)
                presentation=state.get('presentation') or {}
                if presentation.get('seed')==seed:
                    phase=(presentation.get('status'),(state.get('journey') or {}).get('status'))
                    if phase!=previous:
                        print(json.dumps({'seed':seed,'status':phase,'elapsed_s':round(time.monotonic()-started,1)}),flush=True);previous=phase
                    sample={key:state.get(key) for key in ('vehicle','journey','presentation','stopDiagnostics','error','connected','recordingStatus','performance')}
                    sample['wall_s']=time.monotonic()-started;stream.write(json.dumps(sample)+'\n');stream.flush();report['samples']+=1
                    if phase[0] in ('ERROR','CANCELLED','COMPLETE'):
                        report['terminal_presentation']=presentation;break
                time.sleep(.5)
            else:report['observer_timeout']=True
    except (OSError,ValueError,TimeoutError) as error:report['observer_error']=str(error)
    finally:
        report.update(final_journey=state.get('journey'),elapsed_wall_s=time.monotonic()-started,
            remaining_budget=budget.status(),pair=state.get('journeyComparison'),final_presentation=state.get('presentation'))
        report['source_unchanged']=all(hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==digest for name,digest in hashes.items())
        (output/f'{seed}-report.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    return report


def run(ticket,seed,seconds,output):
    budget=NativeValidationBudget(ticket)
    if budget.status()['remaining_s']<seconds+30:raise ValueError('Insufficient remaining native window')
    output=Path(output);output.mkdir(parents=True,exist_ok=True)
    hashes={str(path.relative_to(ROOT)):hashlib.sha256(path.read_bytes()).hexdigest()
        for folder in ('backend/core','backend/carla','backend/computer_vision') for path in (ROOT/folder).glob('*.py')}
    from scripts.validate_hybrid_native import archive_sources
    archive=archive_sources(output,hashes)
    report={'source':'LIVE_NATIVE_CARLA','seed':seed,'source_hashes':hashes,'source_archive':archive,'ticket':budget.status(),
        'started_at_utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'samples':0}
    sequence=0;state={};started=time.monotonic();last_status=None;last_sample=0.
    with connect('ws://127.0.0.1:8001',max_size=2**24,open_timeout=10) as socket:
        def send(kind,**payload):
            nonlocal sequence
            sequence+=1;socket.send(json.dumps({'type':kind,'sequence':sequence,**payload}))
            return sequence
        try:
            while True:
                state=json.loads(socket.recv(timeout=10))
                if state.get('type')=='snapshot' and state.get('connected'):break
            acknowledgement=send('take_control')
            while state.get('acknowledged')!=acknowledgement:
                state=json.loads(socket.recv(timeout=10))
                if state.get('type')=='error':raise RuntimeError(state['error'])
            send('presentation',value={'operation':'RESTART','speed_kmh':50,'seed':seed})
            last_heartbeat=0.
            with (output/f'{seed}-samples.jsonl').open('x',encoding='utf8') as stream:
                while time.monotonic()-started<seconds and budget.status()['remaining_s']>30:
                    now=time.monotonic()
                    if now-last_heartbeat>=.25 and state.get('sessionId'):
                        send('journey_heartbeat',session_id=state['sessionId']);last_heartbeat=now
                    try:message=json.loads(socket.recv(timeout=2))
                    except TimeoutError:continue
                    if message.get('type')=='error':raise RuntimeError(message['error'])
                    if message.get('type')!='snapshot':continue
                    state=message;presentation=state.get('presentation') or {}
                    if presentation.get('seed')!=seed:continue
                    status=(presentation.get('status'),(state.get('journey') or {}).get('status'))
                    if status!=last_status:
                        print(json.dumps({'seed':seed,'status':status,'elapsed_s':round(now-started,1)}),flush=True);last_status=status
                    if now-last_sample>=.5:
                        sample={key:state.get(key) for key in ('vehicle','journey','presentation','stopDiagnostics','error','connected','recordingStatus','performance')}
                        sample['wall_s']=now-started;stream.write(json.dumps(sample)+'\n');stream.flush()
                        report['samples']+=1;last_sample=now
                    if presentation.get('status') in ('ERROR','CANCELLED','PLAYBACK','COMPLETE'):
                        report['terminal_presentation']=presentation;break
                else:report['observer_timeout']=True
        except Exception as error:
            report['observer_error']=str(error)
        finally:
            if (state.get('presentation') or {}).get('status') not in ('ERROR','CANCELLED','PLAYBACK','COMPLETE'):
                try:send('stop_driving',reason='operator_stop')
                except Exception as error:report['stop_error']=str(error)
            report['final_journey']=state.get('journey');report['elapsed_wall_s']=time.monotonic()-started
            report['remaining_budget']=budget.status()
            report['source_unchanged']=all(hashlib.sha256((ROOT/name).read_bytes()).hexdigest()==digest for name,digest in hashes.items())
            try:
                with urllib.request.urlopen('http://127.0.0.1:8000/api/state',timeout=10) as response:
                    final=json.load(response)
                report['pair']=final.get('journeyComparison');report['final_presentation']=final.get('presentation')
            except OSError as error:report['final_read_error']=str(error)
            (output/f'{seed}-report.json').write_text(json.dumps(report,indent=2),encoding='utf8')
    return report


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ticket',required=True);parser.add_argument('--seed',type=int,required=True)
    parser.add_argument('--seconds',type=float,default=600);parser.add_argument('--output',required=True)
    parser.add_argument('--browser-owned',action='store_true',help='Read-only observer; the real browser starts and owns the presentation')
    args=parser.parse_args();runner=observe_browser if args.browser_owned else run
    result=runner(args.ticket,args.seed,args.seconds,args.output)
    print(json.dumps({key:result.get(key) for key in ('seed','observer_error','observer_timeout','final_journey','elapsed_wall_s')}))
    if (result.get('observer_error') or result.get('observer_timeout') or
            (result.get('terminal_presentation') or {}).get('status') in ('ERROR','CANCELLED')):raise SystemExit(1)
