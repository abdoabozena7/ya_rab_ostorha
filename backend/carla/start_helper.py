"""Start CARLA outside the retiring SDK host, with visible retryable failures."""
import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
import re
from .stop_helper import ROOT, DIRECTORY, read_ticket, save, retire_host


def launch_settings(status):
    path=ROOT/'config/dashboard-preferences.json'
    preferences=json.loads(path.read_text(encoding='utf8')) if path.exists() else {}
    value=preferences.get('next_launch') or status.get('launch') or {'quality':'Low','resolution':'1280x720'}
    from .dashboard_tools import validate_settings
    # Select only validated launch fields; native status includes observation metadata.
    value={key:value[key] for key in ('quality','resolution','render_profile') if value.get(key) is not None}
    return {**validate_settings({'next_launch':value})['next_launch'],'offscreen':True}


def fresh_configuration():
    return {'vehicle':'vehicle.lincoln.mkz_2020','spawn_index':152,'map':'Town10HD_Opt','fixed_delta':.05}


def reset_preferences():
    """Persist an empty session; retain graphics, saved places and recordings."""
    from .population import DEFAULT_POPULATION
    from .dashboard_tools import write_json
    path=ROOT/'config/dashboard-preferences.json'
    preferences=json.loads(path.read_text(encoding='utf8')) if path.exists() else {}
    preferences.update(view={},population=dict(DEFAULT_POPULATION))
    write_json(path,preferences)


def dispatch_start(server,args,status,configuration=None,*,fresh=False):
    from ..learning.egypt_budget import require_simulator_access
    require_simulator_access()
    if args.carla_host not in ('127.0.0.1','localhost','::1'):
        raise ValueError('Only the local CARLA runtime can be started')
    launch=launch_settings(status)
    DIRECTORY.mkdir(parents=True,exist_ok=True)
    import uuid
    path=DIRECTORY/('start-'+uuid.uuid4().hex+'.json')
    ticket={'previous_pid':os.getpid(),'host':args.host,'port':args.port,'websocket_port':args.websocket_port,
        'carla_host':args.carla_host,'carla_port':args.carla_port,'launch':launch,
        'configuration':fresh_configuration() if fresh else configuration or {key:getattr(args,key) for key in ('vehicle','spawn_index','map','fixed_delta')},
        'fresh_start':fresh,
        'result':{'status':'STOPPED','launch':launch},'startup':{'status':'STARTING',**({'operation':'RESET'} if fresh else {})}}
    save(path,ticket)
    with path.with_suffix('.log').open('a',encoding='utf8') as out:
        subprocess.Popen([sys.executable,'-m','backend.carla.start_helper',str(path)],cwd=ROOT,stdout=out,stderr=out,
            creationflags=subprocess.CREATE_NO_WINDOW)
    # Let the explicit HTTP request return its acceptance before closing ports.
    timer=threading.Timer(.5,server.shutdown);timer.daemon=True;timer.start()
    return str(path)


def backend_command(ticket, *, stopped=False, path=None):
    args=[sys.executable,'-m','backend.server','--host',ticket['host'],'--port',str(ticket['port']),
        '--websocket-port',str(ticket['websocket_port']),'--carla-host',ticket['carla_host'],
        '--carla-port',str(ticket['carla_port'])]
    if stopped:return args+['--stopped-ticket',str(path)]
    config=ticket['configuration']
    args+=['--carla','--sensors','--start-paused','--vehicle',config['vehicle'],
        '--spawn-index',str(config['spawn_index']),'--fixed-delta',str(config['fixed_delta'])]
    if path:args+=['--startup-ticket',str(path)]
    if ticket.get('fresh_start'):args+=['--fresh-start']
    if config.get('map'):args+=['--map',config['map']]
    if config.get('run_profile'):args+=['--run-profile',config['run_profile']]
    return args


def start_backend(path,ticket, *, stopped=False):
    with path.with_suffix('.backend.log').open('a',encoding='utf8') as out:
        return subprocess.Popen(backend_command(ticket,stopped=stopped,path=path),cwd=ROOT,stdout=out,stderr=out,
            creationflags=subprocess.CREATE_NO_WINDOW)


def finish_start(path,ticket):
    from .runtime import NativeRuntime,native_processes
    runtime=None;backend=None
    try:
        # No UE process is killed while the previous libcarla host still lives.
        retire_host(ticket['previous_pid'])
        if ticket.get('fresh_start'):reset_preferences()
        runtime=NativeRuntime()
        existing=[p for p in native_processes() if int((re.search(r'-carla-rpc-port[= ](\d+)\b',
            p.get('CommandLine') or '',re.I) or [None,2000])[1])==ticket['carla_port']]
        if existing:
            # A disconnected native session may have left synchronous UE idle.
            # Rebuild only this port's engine after the old SDK owner has retired.
            runtime.stop(port=ticket['carla_port'])
        runtime.launch(ticket['launch'],ticket['carla_host'],ticket['carla_port'],None)
        backend=start_backend(path,ticket)
        url=f"http://{ticket['host']}:{ticket['port']}/api/simulation/state"
        deadline=time.monotonic()+75
        while time.monotonic()<deadline:
            # The native host acknowledges readiness before accepting browser
            # actions. An immediate Stop after a successful start is not a
            # startup failure and must not launch a second fallback dashboard.
            if json.loads(path.read_text(encoding='utf8')).get('startup',{}).get('status')=='READY':return
            if backend.poll() is not None:raise RuntimeError('Native backend exited; see '+str(path.with_suffix('.backend.log')))
            try:
                with urllib.request.urlopen(url,timeout=3) as response:state=json.load(response)
                if state.get('connected') and state.get('mode')=='PAUSED' and state.get('sensorRegistry'):
                    ticket['startup']={'status':'READY','session_id':state.get('sessionId')};save(path,ticket);return
            except OSError:pass
            time.sleep(.5)
        raise RuntimeError('Native camera and sensor session did not become ready')
    except Exception as error:
        ticket['startup']={'status':'FAILED','error':str(error)}
        if backend and backend.poll() is None:
            # Retire the exact newly spawned SDK host before stopping its UE.
            backend.terminate();backend.wait(timeout=15)
        if runtime:
            try:
                runtime.stop(port=ticket['carla_port'])
                ticket['result'].update(status='STOPPED',process_exited=True)
            except Exception as cleanup:
                ticket['startup']['error']+='; cleanup: '+str(cleanup)
                ticket['result'].update(status='FAILED',error=str(cleanup))
        save(path,ticket)
        start_backend(path,ticket,stopped=True)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('ticket');args=parser.parse_args()
    path,ticket=read_ticket(args.ticket);finish_start(path,ticket)


if __name__=='__main__':main()
