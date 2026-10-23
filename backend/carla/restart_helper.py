"""Restart UE only after the old SDK process has exited (Windows libcarla)."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parents[2]


def write_ticket(path, ticket):
    ticket['result']['operation'] = ticket['configuration'].get('restart_operation','GRAPHICS')
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(ticket, ensure_ascii=False), encoding='utf-8')
    temporary.replace(path)


def dispatch_restart(server, args, launch, previous, configuration):
    directory = ROOT/'output'/'native-runtime'
    directory.mkdir(parents=True, exist_ok=True)
    path = directory/(uuid.uuid4().hex+'.json')
    ticket = {'previous_pid':os.getpid(), 'configuration':configuration,
              'launch':{**launch,'offscreen':True}, 'previous':previous,
              'host':args.host, 'port':args.port, 'websocket_port':args.websocket_port,
              'carla_host':args.carla_host, 'carla_port':args.carla_port,
              'result':{'status':'STOPPING','requested':launch}}
    write_ticket(path,ticket)
    with path.with_suffix('.log').open('a',encoding='utf-8') as log:
        subprocess.Popen([sys.executable,'-m','backend.carla.restart_helper',str(path)],
                         cwd=ROOT, stdout=log, stderr=log,
                         creationflags=subprocess.CREATE_NO_WINDOW)
    threading.Thread(target=server.shutdown,daemon=True).start()


def process_exists(pid):
    import ctypes
    kernel = ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.OpenProcess.restype = ctypes.c_void_p
    handle = kernel.OpenProcess(0x1000,False,pid)
    if not handle: return False
    code = ctypes.c_ulong()
    try:
        return bool(kernel.GetExitCodeProcess(ctypes.c_void_p(handle),ctypes.byref(code))) and code.value==259
    finally:
        kernel.CloseHandle(ctypes.c_void_p(handle))


def main():
    parser=argparse.ArgumentParser(); parser.add_argument('ticket'); args=parser.parse_args()
    path=Path(args.ticket).resolve()
    if not path.is_relative_to(ROOT/'output'/'native-runtime'):
        raise ValueError('Restart ticket outside managed runtime directory')
    ticket=json.loads(path.read_text(encoding='utf-8'))
    deadline=time.monotonic()+30
    while process_exists(ticket['previous_pid']) and time.monotonic()<deadline: time.sleep(.2)
    if process_exists(ticket['previous_pid']):
        ticket['result']={'status':'FAILED','error':'Previous SDK process did not exit; engine was not stopped'}
        write_ticket(path,ticket); return
    from .runtime import NativeRuntime
    runtime=NativeRuntime()
    first_error=None
    for attempt,launch in enumerate((ticket['launch'],ticket['previous'])):
        backend=None
        try:
            ticket['result']={'status':'LAUNCHING' if not attempt else 'ROLLING_BACK',
                              'requested':ticket['launch'],'error':first_error}
            write_ticket(path,ticket)
            runtime.stop()
            runtime.launch(launch,ticket['carla_host'],ticket['carla_port'],None)
            config=ticket['configuration']
            if attempt:
                config['camera']=config.get('previous_camera',config['camera'])
                if 'previous_run_profile' in config:config['run_profile']=config['previous_run_profile']
                if 'previous_fixed_delta' in config:config['fixed_delta']=config['previous_fixed_delta']
                write_ticket(path,ticket)
            command=[sys.executable,'-X','faulthandler','-m','backend.server','--carla','--sensors','--start-paused',
                     '--host',ticket['host'],'--port',str(ticket['port']),
                     '--websocket-port',str(ticket['websocket_port']),
                     '--carla-host',ticket['carla_host'],'--carla-port',str(ticket['carla_port']),
                     '--vehicle',config['vehicle'],'--spawn-index',str(config['spawn_index']),
                     '--fixed-delta',str(config['fixed_delta']),'--map',config['map'],'--restart-ticket',str(path)]
            if config.get('run_profile'):command+=['--run-profile',config['run_profile']]
            with path.with_suffix('.backend.log').open('a',encoding='utf-8') as log:
                backend=subprocess.Popen(command,cwd=ROOT,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
            url=f"http://{ticket['host']}:{ticket['port']}/api/simulation/state"
            deadline=time.monotonic()+60
            while time.monotonic()<deadline:
                if backend.poll() is not None: raise RuntimeError('New SDK/backend exited during startup')
                try:
                    with urllib.request.urlopen(url,timeout=3) as response: state=json.load(response)
                    if state['connected'] and len(state['sensors'])==6 and not state['sensorErrors']: break
                except OSError: pass
                time.sleep(.5)
            else: raise RuntimeError('New native session did not become ready')
            seconds=60 if launch['quality']=='Epic' else 5
            ticket['result']={'status':'VERIFYING','requested':ticket['launch'],'active':runtime.active,'error':first_error}
            write_ticket(path,ticket)
            measurements=[]; start=time.monotonic(); frame=state['vehicle']['frame']
            while time.monotonic()-start<seconds:
                time.sleep(.5)
                with urllib.request.urlopen(url,timeout=3) as response: state=json.load(response)
                if not state['connected'] or state['sensorErrors'] or len(state['sensors'])!=6:
                    raise RuntimeError('Native camera/sensor verification failed')
                if state['mode']!='PAUSED': raise RuntimeError('Restart must remain stopped')
                measurements.append(state['performance'])
            if state['vehicle']['frame']<=frame: raise RuntimeError('Native simulation stopped ticking')
            rates=[m['nativeTickRateHz'] for m in measurements if m.get('nativeTickRateHz') is not None]
            ticket['verificationMeasurements']=measurements
            ticket['result']={'status':'APPLIED' if not attempt else 'ROLLED_BACK','requested':ticket['launch'],
                              'active':runtime.active,'error':first_error,'verificationSeconds':seconds,
                              'tickRateRangeHz':[min(rates),max(rates)] if rates else None,
                              'sensorRatesHz':state['sensorRatesHz'],
                              'sessionId':state['sessionId']}
            write_ticket(path,ticket); return
        except Exception as error:
            first_error=str(error) if first_error is None else first_error+'; rollback: '+str(error)
            if backend and backend.poll() is None:
                # Tell the live worker to destroy actors and restore world settings,
                # then retire this exact child before terminating the engine.
                try:
                    ticket['result']={'status':'FAILED','error':first_error}
                    write_ticket(path,ticket)
                    from websockets.sync.client import connect
                    with connect(f"ws://{ticket['host']}:{ticket['websocket_port']}",
                                 origin=f"http://{ticket['host']}:{ticket['port']}") as ws:
                        for sequence,kind in enumerate(('take_control','disconnect'),1):
                            ws.send(json.dumps({'type':kind,'sequence':sequence}))
                            cleanup_deadline=time.monotonic()+5
                            while json.loads(ws.recv(timeout=5)).get('acknowledged')!=sequence:
                                if time.monotonic()>cleanup_deadline: raise TimeoutError('Cleanup acknowledgement missing')
                except Exception: pass
                backend.terminate(); backend.wait(timeout=15)
    ticket['result']={'status':'FAILED','requested':ticket['launch'],'error':first_error}
    write_ticket(path,ticket)


if __name__=='__main__': main()
