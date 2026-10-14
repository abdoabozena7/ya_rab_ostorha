"""Retire Windows libcarla before UE; return an SDK-free stopped dashboard."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import uuid

ROOT=Path(__file__).resolve().parents[2]
DIRECTORY=ROOT/'output/native-runtime'


def stopped_service(ticket,dispatch,start_dispatch=None,reset_dispatch=None):
    from ..core.service import SimulationService
    class StoppedService(SimulationService):
        def __init__(self):
            super().__init__(None);self.simulator_stop=ticket['result']
            self.simulator_start=ticket.get('startup',{'status':'IDLE'})
        def can_stop_simulator(self):return True
        def can_start_simulation(self):return callable(start_dispatch)
        def can_reset_simulation(self):return callable(reset_dispatch)
        def reset_simulation(self):
            with self.lock:
                if self.simulator_stop['status']=='STOPPING':raise ValueError('CARLA is still stopping')
                if not self.can_reset_simulation():raise ValueError('Local simulation reset is unavailable')
                if self.simulator_start['status']=='STARTING':return dict(self.simulator_start)
                self.simulator_start={'status':'STARTING','operation':'RESET'}
                try:self.startup_ticket=reset_dispatch(self.simulator_stop)
                except Exception as error:self.simulator_start={'status':'FAILED','operation':'RESET','error':str(error)}
                return dict(self.simulator_start)
        def start_simulation(self):
            with self.lock:
                if self.simulator_stop['status']=='STOPPING':raise ValueError('CARLA is still stopping')
                if not self.can_start_simulation():raise ValueError('Local simulation startup is unavailable')
                if self.simulator_start['status']=='STARTING':return dict(self.simulator_start)
                self.simulator_start={'status':'STARTING'}
                try:self.startup_ticket=start_dispatch(self.simulator_stop)
                except Exception as error:self.simulator_start={'status':'FAILED','error':str(error)}
                return dict(self.simulator_start)
        def reconnect(self):
            raise ValueError('CARLA is stopped. Run Start-YA-RAB-OSTORHA.ps1 to start it again.')
        def stop_simulator(self):
            if self.simulator_stop['status'] in ('STOPPING','STOPPED'):return
            self.simulator_stop={**self.simulator_stop,'status':'STOPPING','error':None}
            dispatch(self.simulator_stop)
    return StoppedService()


def read_ticket(value):
    path=Path(value).resolve()
    if not path.is_relative_to(DIRECTORY.resolve()):raise ValueError('Stop ticket outside managed runtime directory')
    return path,json.loads(path.read_text(encoding='utf8'))


def save(path,ticket):
    temporary=path.with_suffix('.tmp');temporary.write_text(json.dumps(ticket,indent=2),encoding='utf8');temporary.replace(path)


def dispatch_stop(server,args,status):
    DIRECTORY.mkdir(parents=True,exist_ok=True);path=DIRECTORY/('stop-'+uuid.uuid4().hex+'.json')
    ticket={'previous_pid':os.getpid(),'host':args.host,'port':args.port,'websocket_port':args.websocket_port,
        'carla_host':args.carla_host,'carla_port':args.carla_port,'result':status,
        'configuration':{key:getattr(args,key) for key in ('vehicle','spawn_index','map','fixed_delta')}}
    save(path,ticket)
    with path.with_suffix('.log').open('a',encoding='utf8') as out:
        subprocess.Popen([sys.executable,'-m','backend.carla.stop_helper',str(path)],cwd=ROOT,stdout=out,stderr=out,
            creationflags=subprocess.CREATE_NO_WINDOW)
    threading.Thread(target=server.shutdown,daemon=True).start()


def retire_host(pid):
    from .restart_helper import process_exists
    deadline=time.monotonic()+15
    while process_exists(pid) and time.monotonic()<deadline:time.sleep(.2)
    if not process_exists(pid):return
    # This PID came from the dispatching host itself; reverify its command
    # identity before a bounded forced retirement in case PID reuse occurred.
    command=subprocess.run(['powershell','-NoProfile','-Command',
        f'(Get-CimInstance Win32_Process -Filter "ProcessId={int(pid)}").CommandLine'],capture_output=True,text=True,check=True,
        creationflags=subprocess.CREATE_NO_WINDOW)
    if 'backend.server' not in command.stdout:raise RuntimeError('Old SDK host identity could not be verified')
    subprocess.run(['taskkill','/PID',str(pid),'/F'],capture_output=True,check=True,timeout=10,creationflags=subprocess.CREATE_NO_WINDOW)
    deadline=time.monotonic()+5
    while process_exists(pid) and time.monotonic()<deadline:time.sleep(.1)
    if process_exists(pid):raise RuntimeError('Old SDK host did not exit')


def finish_stop(path,ticket):
    from .runtime import NativeRuntime
    try:
        retire_host(ticket['previous_pid'])
        NativeRuntime().stop(port=ticket['carla_port'])
    except Exception as error:ticket['result'].update(status='FAILED',error=str(error))
    else:ticket['result'].update(status='STOPPED',process_exited=True)
    save(path,ticket)
    # No --carla: this fresh dashboard never imports or connects libcarla.
    with path.with_suffix('.backend.log').open('a',encoding='utf8') as out:
        subprocess.Popen([sys.executable,'-m','backend.server','--host',ticket['host'],'--port',str(ticket['port']),
            '--websocket-port',str(ticket['websocket_port']),'--carla-port',str(ticket['carla_port']),'--stopped-ticket',str(path)],cwd=ROOT,stdout=out,stderr=out,
            creationflags=subprocess.CREATE_NO_WINDOW)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('ticket');args=parser.parse_args()
    path,ticket=read_ticket(args.ticket);finish_stop(path,ticket)


if __name__=='__main__':main()
