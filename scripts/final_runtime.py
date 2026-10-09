"""One-command native startup; verified cleanup for offline GPU training.

Only an identified project backend and official CARLA processes are stopped.
The normal simulator is always restored with RULE as its default controller.
"""
import argparse
import json
from pathlib import Path
import subprocess
import time
import urllib.request
from websockets.sync.client import connect
from backend.carla.runtime import NativeRuntime, native_processes

ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'output/final-delivery'


def state():
    try:
        with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/state',timeout=2) as r:return json.load(r)
    except OSError:return None


def disconnect_backend():
    current=state()
    if current is None:return
    from scripts.native.stability_run import backend_pid
    pid=backend_pid(8000)
    # Confirm listener command identity before terminating it.
    check=subprocess.run(['powershell','-NoProfile','-Command',f'(Get-CimInstance Win32_Process -Filter "ProcessId={pid}").CommandLine'],capture_output=True,text=True,check=True)
    if 'backend.server' not in check.stdout and 'scripts.native.' not in check.stdout:
        raise RuntimeError('Port 8000 is not an identified project backend')
    if current.get('connected'):
        with connect('ws://127.0.0.1:8001',max_size=2**23,open_timeout=10) as ws:
            ws.recv()
            for seq,kind in enumerate(('take_control','stop_driving','disconnect'),1):
                ws.send(json.dumps({'type':kind,'sequence':seq}))
                deadline=time.monotonic()+20
                while time.monotonic()<deadline:
                    message=json.loads(ws.recv(timeout=5))
                    if message.get('type')=='error':raise RuntimeError(message['error'])
                    if message.get('acknowledged')==seq:break
                else:raise TimeoutError('Native cleanup acknowledgement missing')
        import carla
        client=carla.Client('127.0.0.1',2000);client.set_timeout(10);world=client.get_world();world.wait_for_tick(10)
        if world.get_settings().synchronous_mode or any(a.attributes.get('role_name','').startswith('ostorha_') for a in world.get_actors()):
            raise RuntimeError('Old owner did not restore world/clean actors')
    subprocess.run(['taskkill','/PID',str(pid),'/F'],capture_output=True,check=True)


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--release-gpu',action='store_true');parser.add_argument('--reload',action='store_true');parser.add_argument('--validation-host',action='store_true')
    args=parser.parse_args();OUT.mkdir(parents=True,exist_ok=True)
    runtime=NativeRuntime()
    if args.release_gpu:
        settings=runtime.active or {'quality':'Low','resolution':'1280x720','offscreen':True}
        (OUT/'graphics-before-training.json').write_text(json.dumps(settings,indent=2))
        disconnect_backend();runtime.stop();print('Project owner cleaned; CARLA GPU resources released.');return
    if args.reload:disconnect_backend()
    current=state()
    if current and current.get('connected'):
        print('YA RAB OSTORHA already running: http://127.0.0.1:8000/');return
    if current:
        # Explicit startup repairs a disconnected, identified project host.
        # A connected/manual/autonomous host above is reused without disruption.
        settings=runtime.active or {'quality':'Low','resolution':'1280x720','offscreen':True}
        disconnect_backend();runtime.stop();current=None
        (OUT/'graphics-before-training.json').write_text(json.dumps(settings,indent=2))
    if not native_processes():
        saved=OUT/'graphics-before-training.json'
        settings=json.loads(saved.read_text()) if saved.exists() else {'quality':'Low','resolution':'1280x720','offscreen':True}
        import carla
        runtime.launch(settings,'127.0.0.1',2000,carla)
    module='scripts.native.experiment2c_backend' if args.validation_host else 'backend.server'
    with (OUT/'backend.log').open('a') as out,(OUT/'backend-error.log').open('a') as err:
        proc=subprocess.Popen([str(ROOT/'.venv-carla/Scripts/python.exe'),'-m',module,'--carla','--sensors','--spawn-index','152','--start-paused'],cwd=ROOT,stdout=out,stderr=err,creationflags=subprocess.CREATE_NO_WINDOW)
    deadline=time.monotonic()+75
    while time.monotonic()<deadline:
        current=state()
        if current and current.get('connected'):
            print(json.dumps({'pid':proc.pid,'dashboard':'http://127.0.0.1:8000/','mode':current['mode'],'safety':current.get('safetySystem')}));return
        if proc.poll() is not None:raise RuntimeError('Backend exited; see output/final-delivery/backend-error.log')
        time.sleep(.5)
    raise RuntimeError('Backend failed to connect within startup budget')

if __name__=='__main__':main()
