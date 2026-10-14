"""Bounded live route check after processing-latency repair; production commands."""
import argparse
import json
import math
from pathlib import Path
import time
from websockets.sync.client import connect


def run(mode, seconds, output):
    rows=[];sequence=0;report={'source':'LIVE_NATIVE_CARLA','mode':mode,'requested_wall_s':seconds}
    socket=connect('ws://127.0.0.1:8001',max_size=2**23,open_timeout=10)
    state=None
    def read(timeout=5):
        nonlocal state
        message=json.loads(socket.recv(timeout=timeout))
        if message['type']=='error':raise RuntimeError(message['error'])
        if message['type']=='snapshot':
            state=message
            if state.get('error'):raise RuntimeError(state['error'])
        return state
    def send(kind,**payload):
        nonlocal sequence
        sequence+=1;socket.send(json.dumps({'type':kind,'sequence':sequence,**payload}))
    def wait_ack():
        deadline=time.monotonic()+20
        while time.monotonic()<deadline:
            current=read()
            if current and current.get('acknowledged')==sequence:return current
        raise TimeoutError('Native command acknowledgement missing')
    began=time.monotonic();last_heartbeat=began;last_sample=0.
    try:
        while state is None:read()
        if state['mode']!='PAUSED' or state['vehicle']['speedMagnitudeMps']>=.15 or state.get('recording'):
            raise RuntimeError('The live check starts only from a stopped, finalized session')
        if not state.get('route'):raise RuntimeError('Choose a route before checking live recovery')
        report['session_id']=state['sessionId'];report['initial_remaining_m']=state['route']['remaining_m']
        report['start_position']=state['canonical']['vehicle']['transform']['position_m']
        send('take_control');wait_ack()
        send('start_journey',speed_kmh=30,driving_mode=mode)
        began=time.monotonic();last_heartbeat=0.
        while time.monotonic()-began<seconds:
            wall=time.monotonic()
            if wall-last_heartbeat>=.08:
                send('journey_heartbeat',session_id=state['sessionId']);last_heartbeat=wall
            current=read(timeout=1)
            if not current:continue
            if wall-last_sample>=.15:
                vehicle=current['vehicle'];decision=current.get('stopDiagnostics') or {}
                safety=current.get('safetySystem') or {}
                rows.append({'wall_elapsed_s':wall-began,'frame':vehicle['frame'],
                    'timestamp_s':vehicle['timestamp'],'mode':current['mode'],
                    'journey_status':current['journey']['status'],'journey_reason':current['journey'].get('reason'),
                    'speed_kmh':vehicle['speedKmh'],'brake':vehicle['brake'],'throttle':vehicle['throttle'],
                    'remaining_m':(current.get('route') or {}).get('remaining_m'),
                    'safety_status':safety.get('status'),'risk':safety.get('risk'),
                    'base_command':decision.get('base_command'),'applied_command':decision.get('applied_command'),
                    'decision_source':decision.get('decision_source'),'reason':decision.get('reason'),
                    'sensor_wall_age_s':decision.get('sensor_wall_age_s'),
                    'control_timing_ms':decision.get('control_timing_ms'),
                    'position_m':current['canonical']['vehicle']['transform']['position_m']})
                last_sample=wall
            status=current['journey']['status']
            if status=='ARRIVED':break
            if status=='ERROR' or status=='PAUSED':
                raise RuntimeError('Journey stopped: '+str(current.get('lastDriveStop') or current['journey']))
        report.update(final_journey=dict(state['journey']),final_remaining_m=(state.get('route') or {}).get('remaining_m'))
    except Exception as error:
        report['error']=str(error)
        raise
    finally:
        if state is not None:
            try:
                if state['journey']['status']!='ARRIVED':
                    send('stop_driving',reason='operator_stop');wait_ack()
                deadline=time.monotonic()+12
                while time.monotonic()<deadline and (state['vehicle']['speedMagnitudeMps']>=.15 or state.get('recording')):read()
                report['cleanup']={'mode':state['mode'],'speed_mps':state['vehicle']['speedMagnitudeMps'],'recording':state.get('recording')}
            except Exception as error:report['cleanup_error']=str(error)
        socket.close()
        report['samples']=rows
        report['maximum_speed_kmh']=max((r['speed_kmh'] for r in rows),default=0.)
        report['distance_m']=sum(math.dist(a['position_m'],b['position_m']) for a,b in zip(rows,rows[1:]))
        report['processing_hold_samples']=sum(r['safety_status']=='SENSOR_DELAY_HOLD' for r in rows)
        report['native_collisions']=len([e for e in (state or {}).get('collisionEvents',[]) if rows and e['timestamp_s']>=rows[0]['timestamp_s']])
        output.parent.mkdir(parents=True,exist_ok=True);output.write_text(json.dumps(report,indent=2),encoding='utf8')
        print(json.dumps({k:v for k,v in report.items() if k!='samples'}),flush=True)
    if report['distance_m']<5:raise RuntimeError('Live motion was not established')


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--mode',choices=('NORMAL','ROBOSPHERE'),default='ROBOSPHERE')
    parser.add_argument('--seconds',type=float,default=35);parser.add_argument('--output',type=Path,required=True)
    args=parser.parse_args()
    if not 5<=args.seconds<=60:parser.error('Live check must be bounded to 5–60 seconds')
    run(args.mode,args.seconds,args.output)
