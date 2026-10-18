"""Native guided cancellation/lifecycle check. The running backend owns all ticks.

Run only against a stopped, explicitly authorized local simulator session.
Uses the production start endpoint and presentation protocol; retains failures.
"""
import hashlib
import argparse
import json
from pathlib import Path
import time
import urllib.request
from websockets.sync.client import connect

ROOT=Path(__file__).resolve().parents[1]


def state():
    try:
        with urllib.request.urlopen('http://127.0.0.1:8000/api/state',timeout=3) as r:return json.load(r)
    except OSError:return None


def run(output):
    OUT=Path(output).resolve();OUT.mkdir(parents=True,exist_ok=False)
    hashes={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest()
        for folder in ('backend/core','backend/carla') for p in (ROOT/folder).glob('*.py')}
    from scripts.validate_hybrid_native import archive_sources
    report={'scope':'LIVE_NATIVE_CARLA_GUIDED_NEXT_RACING_GPU_RELEASE','source_hashes':hashes,
        'source_archive':archive_sources(OUT,hashes),'phases':[],'errors':[]}
    started=time.monotonic();presentation_id=None;pair_id=None
    try:
        before=state()
        if not before or before.get('connected') or (before.get('simulatorStop') or {}).get('status')!='STOPPED':
            raise RuntimeError('Check requires the stopped local dashboard')
        report['before']=before['simulatorStop']
        request=urllib.request.Request('http://127.0.0.1:8000/api/simulation/start',data=b'{}',headers={'Content-Type':'application/json'},method='POST')
        with urllib.request.urlopen(request,timeout=10) as r:report['start_response']=json.load(r)
        deadline=time.monotonic()+150
        while time.monotonic()<deadline:
            current=state()
            if current and current.get('connected'):break
            time.sleep(.5)
        else:raise RuntimeError('Native startup timed out')
        report['native_session']=current.get('sessionId')
        with connect('ws://127.0.0.1:8001',open_timeout=10) as socket:
            seq=0;sent=False;driving_at=None;shutdown=False
            def send(kind,**values):
                nonlocal seq
                seq+=1;socket.send(json.dumps({'type':kind,'sequence':seq,**values}))
            deadline=time.monotonic()+180
            while time.monotonic()<deadline:
                message=json.loads(socket.recv(timeout=10))
                if message.get('type')=='error':raise RuntimeError(message['error'])
                if message.get('type')!='snapshot':continue
                current=message;d=message.get('presentation') or {}
                if not sent:
                    send('presentation',value={'operation':'START_GUIDED','first_mode':'NORMAL','scene':'BUSY_ROUTE','seed':2086914493,'speed_kmh':50})
                    sent=True
                phase=(d.get('status'),d.get('arm'))
                if not report['phases'] or phase!=tuple(report['phases'][-1]['phase']):report['phases'].append({'phase':phase,'elapsed_s':time.monotonic()-started})
                if d.get('guided'):
                    presentation_id=d['id'];pair_id=d.get('pair_id') or pair_id
                if d.get('status')=='ERROR':raise RuntimeError(d.get('reason','Guided setup failed'))
                if d.get('status')=='DRIVING':
                    if driving_at is None:driving_at=time.monotonic()
                    if time.monotonic()-driving_at>=1.:
                        report['before_race']={'presentation':d,'journey':message.get('journey'),'comparison':message.get('journeyComparison')}
                        send('presentation',value={'operation':'NEXT','id':d['id'],'expected_arm':0,'expected_phase':'DRIVING'})
                        send('stop_simulator')
                        # Keep the controlling connection open until shutdown
                        # is admitted. Closing immediately tests a lost client,
                        # which can prevent its unread stop message arriving.
                        stop_deadline=time.monotonic()+15
                        while time.monotonic()<stop_deadline:
                            reply=json.loads(socket.recv(timeout=10))
                            if reply.get('type')=='error':raise RuntimeError(reply['error'])
                            if (reply.get('simulatorStop') or {}).get('status')=='STOPPING':
                                report['shutdown_admitted']=True;shutdown=True;break
                        break
            if not shutdown:raise RuntimeError('Did not reach a recorded native drive')
        deadline=time.monotonic()+75
        while time.monotonic()<deadline:
            current=state()
            if current and (current.get('simulatorStop') or {}).get('status')=='STOPPED':break
            time.sleep(.5)
        else:raise RuntimeError('GPU release did not confirm process exit')
        report['after']=current['simulatorStop']
        from backend.carla.runtime import native_processes
        report['remaining_native_processes']=native_processes()
        saved=json.loads((ROOT/'output/presentations'/f'{presentation_id}.json').read_text())
        pair=json.loads((ROOT/'output/journey-comparisons'/f'{pair_id}.json').read_text())
        report['saved_presentation']=saved
        report['runs']={mode:{k:r.get(k) for k in ('id','status','reason','recording','distance_m','collisions','duration_s')} for mode,r in pair['runs'].items()}
        report['passed']=saved['status']=='CANCELLED' and saved.get('reason')=='simulator_shutdown' and set(pair['runs'])=={'NORMAL'} and not report['remaining_native_processes'] and report['after'].get('process_exited') is True
        if not report['passed']:raise RuntimeError('Late arm or unverified shutdown')
    except Exception as error:
        report['errors'].append(str(error));report['passed']=False
        current=state()
        if current and current.get('connected'):
            try:
                with connect('ws://127.0.0.1:8001') as socket:
                    socket.send(json.dumps({'type':'stop_simulator','sequence':999}))
                    while True:
                        reply=json.loads(socket.recv(timeout=10))
                        if (reply.get('simulatorStop') or {}).get('status')=='STOPPING':break
            except Exception as cleanup:report['errors'].append('Cleanup: '+str(cleanup))
    finally:
        report['elapsed_s']=time.monotonic()-started
        (OUT/'report.json').write_text(json.dumps(report,indent=2),encoding='utf8')
        print(json.dumps({'passed':report.get('passed'),'errors':report['errors'],'report':str(OUT/'report.json')}),flush=True)
    if not report.get('passed'):raise SystemExit(1)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',default='output/guided-native-20261018/final-race-verified')
    run(parser.parse_args().output)
