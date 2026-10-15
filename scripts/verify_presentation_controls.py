"""Explicit native control rehearsal: cancel preparation and check emergency latch."""
import json
from pathlib import Path
import time
from websockets.sync.client import connect


def main():
    checks=[];sequence=0;latest={}
    with connect('ws://127.0.0.1:8001',max_size=2**23) as socket:
        def wait(predicate,seconds=8):
            nonlocal latest
            deadline=time.monotonic()+seconds
            while time.monotonic()<deadline:
                message=json.loads(socket.recv(timeout=2))
                if message.get('type')=='error':raise RuntimeError(message['error'])
                if message.get('type')!='snapshot':continue
                latest=message
                if predicate(message):return message
            raise TimeoutError('Native control condition did not occur')
        def send(kind,**values):
            nonlocal sequence
            sequence+=1;socket.send(json.dumps({'type':kind,'sequence':sequence,**values}))
        try:
            wait(lambda s:s.get('connected'));send('take_control')
            wait(lambda s:s.get('acknowledged')==sequence)
            pair=(latest.get('journeyComparison') or {}).get('pair_id')
            for command,reason in [('stop_driving','operator_stop'),('emergency_stop','emergency_stop')]:
                send('presentation',value={'operation':'RESTART','speed_kmh':50})
                wait(lambda s:(s.get('presentation') or {}).get('status')=='PREPARING')
                phase=latest['presentation']['status'];pid=latest['presentation']['id']
                send(command,**({'reason':reason} if command=='stop_driving' else {}))
                wait(lambda s:(s.get('presentation') or {}).get('status')=='CANCELLED' and s['presentation'].get('reason')==reason)
                frame=latest['vehicle']['frame']
                wait(lambda s:s.get('vehicle') and s['vehicle']['frame']>=frame+15 and s['vehicle']['speedKmh']<.54)
                assert latest['presentation']['status']=='CANCELLED','Preparation revived a cancelled presentation'
                assert not latest['recording'],'A cancelled preparation started a recording'
                assert latest['journeyComparison']['pair_id']==pair,'Cancellation replaced the completed comparison'
                expected='EMERGENCY_STOP' if command=='emergency_stop' else 'PAUSED'
                assert latest['mode']==expected,(expected,latest['mode'])
                assert latest['vehicle']['brake']>=.999 and latest['vehicle']['throttle']==0
                checks.append({'command':command,'phase':phase,'presentation_id':pid,
                    'status':latest['presentation']['status'],'mode':latest['mode'],
                    'speed_kmh':latest['vehicle']['speedKmh'],'brake':latest['vehicle']['brake'],
                    'throttle':latest['vehicle']['throttle'],'pair_preserved':True,'frames_after_stop':15})
                if command=='emergency_stop':
                    send('acknowledge_stop');wait(lambda s:s.get('mode')=='PAUSED')
                    assert latest['vehicle']['speedKmh']<.54 and latest['presentation']['status']=='CANCELLED'
                    assert latest['journey']['reason']=='emergency_stop_released'
                    checks.append({'command':'acknowledge_stop','mode':latest['mode'],
                        'reason':latest['journey']['reason'],'automatic_resume':False})
        finally:
            send('stop_driving',reason='operator_stop')
    target=Path('output/presentation-native-controls.json')
    target.write_text(json.dumps({'source':'LIVE_NATIVE_CARLA_WEBSOCKET','checks':checks},indent=2),encoding='utf8')
    print(json.dumps({'checks':len(checks),'output':str(target)}))


if __name__=='__main__':main()
