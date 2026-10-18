"""Explicit native smoke: one preloaded world, two selected vehicles, retained outcomes.

Starts/shortens real drives; use only against the authorized local native host.
Raw states and recordings stay in ignored output/. This is not driving acceptance.
"""
import argparse
import json
import time
import traceback
import uuid
import urllib.request
from pathlib import Path
from websockets.sync.client import connect


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--first',choices=['NORMAL','ROBOSPHERE'],default='ROBOSPHERE')
    parser.add_argument('--hold-seconds',type=float,default=10.)
    parser.add_argument('--output',default='output/preload-native-second')
    args=parser.parse_args();out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
    report={'scope':'NATIVE_PRELOAD_VEHICLE_HANDOFF_NOT_DRIVING_ACCEPTANCE','events':[],'arms':[],'errors':[]}
    sequence=0;started=time.monotonic();samples=[];last_frame=None
    def sample(s):
        nonlocal last_frame
        vehicle=s.get('vehicle') or {};frame=vehicle.get('frame_id',vehicle.get('frame'))
        if frame==last_frame:return
        last_frame=frame
        if s.get('presentation',{}).get('status')!='DRIVING':return
        samples.append({'elapsed_s':time.monotonic()-started,'arm':s['presentation'].get('arm'),
            'vehicle':vehicle,'performance':s.get('performance'),'controlScene':s.get('controlScene'),
            'safetySystem':s.get('safetySystem'),'stopDiagnostics':s.get('stopDiagnostics')})
    try:
        with connect('ws://127.0.0.1:8001',max_size=2**24,open_timeout=10) as ws:
            def send(operation,**value):
                nonlocal sequence
                sequence+=1;ws.send(json.dumps({'type':'presentation','sequence':sequence,'value':{'operation':operation,**value}}))
            def wait(statuses,*,arm=None,limit=240):
                deadline=time.monotonic()+limit;last=None
                while time.monotonic()<deadline:
                    s=json.loads(ws.recv(timeout=20))
                    if s.get('type')=='error':raise RuntimeError(s['error'])
                    sample(s);d=s.get('presentation',{});phase=d.get('status')
                    if phase!=last:
                        event={'phase':phase,'arm':d.get('arm'),'elapsed_s':round(time.monotonic()-started,2),'reason':d.get('reason')}
                        report['events'].append(event);print(json.dumps(event),flush=True);last=phase
                    if phase=='ERROR':
                        (out/'failure-state.json').write_text(json.dumps(s));raise RuntimeError(d.get('reason'))
                    if phase in statuses and (arm is None or d.get('arm')==arm):return s
                raise TimeoutError('Native phase did not arrive: '+str(statuses))
            page_id=uuid.uuid4().hex
            ws.recv(timeout=10);send('PRELOAD',page_id=page_id);s=wait(['CHOOSING'])
            report['prepared']={k:s['presentation'].get(k) for k in ('id','seed','setup','prepared_condition_id','population_audit')}
            (out/'prepared-state.json').write_text(json.dumps(s))
            identity=s['presentation']['id'];send('START_GUIDED',prepared_id=identity,first_mode=args.first,page_id=page_id)
            for arm in range(2):
                s=wait(['DRIVING','AWAITING_NEXT','RESULTS'],arm=arm)
                deadline=time.monotonic()+args.hold_seconds
                while s['presentation']['status']=='DRIVING' and time.monotonic()<deadline:
                    s=json.loads(ws.recv(timeout=20))
                    if s.get('type')=='error':raise RuntimeError(s['error'])
                    sample(s)
                mode=s['presentation']['modes'][arm]
                report['arms'].append({'mode':mode,'comparison':s.get('journeyComparison'),'presentation':s['presentation']})
                (out/f'arm-{arm}-state.json').write_text(json.dumps(s))
                try:
                    with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/camera.jpg?view=driving',timeout=5) as response:
                        (out/f'arm-{arm}.jpg').write_bytes(response.read())
                except OSError as error:report.setdefault('camera_errors',[]).append(str(error))
                phase=s['presentation']['status']
                if phase=='FINALIZING':
                    s=wait(['AWAITING_NEXT','RESULTS'],arm=arm)
                    phase=s['presentation']['status']
                if phase in ('DRIVING','AWAITING_NEXT'):
                    send('NEXT',id=identity,expected_arm=arm,expected_phase=phase)
                if arm==1:s=wait(['RESULTS'])
            report['results']=s['journeyComparison'];send('FINISH',id=identity);wait(['COMPLETE'])
    except (Exception,KeyboardInterrupt) as error:
        report['errors'].append({'type':type(error).__name__,'message':str(error),'traceback':traceback.format_exc()})
        print(type(error).__name__,str(error),flush=True)
    finally:
        (out/'driving-samples.json').write_text(json.dumps(samples))
        (out/'report.json').write_text(json.dumps(report,indent=2))
    return int(bool(report['errors']))


if __name__=='__main__':raise SystemExit(main())
