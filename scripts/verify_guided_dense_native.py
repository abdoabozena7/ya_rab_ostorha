"""Bounded native Dense Chaos pair via the existing worker and protocol.

Requires explicit native-test authorization and a stopped local dashboard.
Retains both arm outcomes, actual counts and measurement failures.
"""
import json
import argparse
from pathlib import Path
import time
import urllib.request
from websockets.sync.client import connect
from scripts.verify_guided_native_lifecycle import state,ROOT

OUT=ROOT/'output/guided-native-20261018/dense-final'


def run():
    OUT.mkdir(parents=True,exist_ok=False)
    import hashlib
    hashes={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest()
        for folder in ('backend/core','backend/carla') for p in (ROOT/folder).glob('*.py')}
    from scripts.validate_hybrid_native import archive_sources
    report={'source':'LIVE_NATIVE_CARLA_DENSE_GUIDED_PAIR','phases':[],'errors':[],
        'source_hashes':hashes,'source_archive':archive_sources(OUT,hashes)}
    pair_id=None;started=time.monotonic();latest=None
    try:
        s=state()
        if not s or s.get('connected') or s.get('simulatorStop',{}).get('status')!='STOPPED':raise RuntimeError('Stopped local dashboard required')
        request=urllib.request.Request('http://127.0.0.1:8000/api/simulation/start',data=b'{}',headers={'Content-Type':'application/json'},method='POST')
        with urllib.request.urlopen(request,timeout=10) as r:report['launch']=json.load(r)
        deadline=time.monotonic()+150
        while time.monotonic()<deadline:
            s=state()
            if s and s.get('connected'):break
            time.sleep(.5)
        else:raise RuntimeError('Native startup timed out')
        with connect('ws://127.0.0.1:8001',open_timeout=10) as socket:
            sequence=0;sent=False;consumed=set();stop_sent=False
            def send(kind,**values):
                nonlocal sequence
                sequence+=1;socket.send(json.dumps({'type':kind,'sequence':sequence,**values}))
            deadline=time.monotonic()+240
            while time.monotonic()<deadline:
                s=json.loads(socket.recv(timeout=10))
                if s.get('type')=='error':raise RuntimeError(s['error'])
                if s.get('type')!='snapshot':continue
                latest=s;d=s.get('presentation') or {};pair=s.get('journeyComparison') or {}
                if not sent:
                    send('presentation',value={'operation':'START_GUIDED','first_mode':'ROBOSPHERE','scene':'DENSE_CHAOS','seed':2086914493,'speed_kmh':50});sent=True
                phase=[d.get('status'),d.get('arm')]
                if not report['phases'] or report['phases'][-1]['phase']!=phase:report['phases'].append({'phase':phase,'wall_s':time.monotonic()-started})
                if d.get('guided'):pair_id=d.get('pair_id') or pair_id
                if d.get('status')=='ERROR':raise RuntimeError(d.get('reason','Dense setup failed'))
                if d.get('status') in ('DRIVING','AWAITING_NEXT'):
                    arm=d['arm'];mode=d['modes'][arm];run=pair.get('runs',{}).get(mode,{})
                    if arm not in consumed and (d['status']=='AWAITING_NEXT' or run.get('duration_s',0)>=12):
                        send('presentation',value={'operation':'NEXT','id':d['id'],'expected_arm':arm,'expected_phase':d['status']});consumed.add(arm)
                if d.get('status')=='RESULTS' and not stop_sent:
                    report['terminal']=s
                    (OUT/'pair-state.json').write_text(json.dumps(s),encoding='utf8')
                    send('stop_simulator');stop_sent=True
                if s.get('simulatorStop',{}).get('status')=='STOPPING':break
            if not stop_sent:raise RuntimeError('Dense pair did not reach results within its bound')
        report['conditions_match']=report['terminal']['journeyComparison'].get('conditions_match')
        report['motion_audits_measured']=all(r.get('stress_audit',{}).get('counts',{}).get('pedestrians',{}).get('moving_near',0)>0
            for r in report['terminal']['journeyComparison']['runs'].values())
        report['protocol_passed']=bool(report['conditions_match']) and report['motion_audits_measured']
    except Exception as error:
        report['errors'].append(str(error));report['protocol_passed']=False
        s=state()
        if s and s.get('connected'):
            try:
                with connect('ws://127.0.0.1:8001') as socket:
                    socket.send(json.dumps({'type':'stop_simulator','sequence':999}))
                    while True:
                        s=json.loads(socket.recv(timeout=10))
                        if s.get('simulatorStop',{}).get('status')=='STOPPING':break
            except Exception as cleanup:report['errors'].append('Cleanup: '+str(cleanup))
    finally:
        deadline=time.monotonic()+60
        while time.monotonic()<deadline:
            s=state()
            if s and s.get('simulatorStop',{}).get('status')=='STOPPED':report['shutdown']=s['simulatorStop'];break
            time.sleep(.5)
        report['wall_s']=time.monotonic()-started
        (OUT/'report.json').write_text(json.dumps(report,indent=2),encoding='utf8')
        print(json.dumps({k:report.get(k) for k in ('protocol_passed','motion_audits_measured','conditions_match','errors','wall_s')}),flush=True)
    if not report.get('protocol_passed'):raise SystemExit(1)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--output',default=str(OUT))
    OUT=Path(parser.parse_args().output).resolve();run()
