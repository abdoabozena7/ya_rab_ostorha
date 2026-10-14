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


def preferred_launch():
    path=ROOT/'config/dashboard-preferences.json'
    if not path.exists():return None
    value=json.loads(path.read_text(encoding='utf8')).get('next_launch')
    if not isinstance(value,dict) or value.get('quality') not in ('Low','Epic') or value.get('resolution') not in ('1280x720','1600x900','1920x1080'):return None
    return {**value,'offscreen':True}


def state():
    try:
        with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/state',timeout=2) as r:return json.load(r)
    except OSError:return None


def verify_dashboard(current, *, require_default=False):
    """Read-only launch check; a connected SDK alone is not a usable dashboard."""
    if not current or not current.get('connected') or current.get('vehicle',{}).get('source') != 'carla':
        raise RuntimeError('Native CARLA telemetry is unavailable')
    for path, marker in (('/', b'/frontend/dashboard.bundle.js'),
                         ('/frontend/dashboard.bundle.js', b'comparison_v2')):
        with urllib.request.urlopen('http://127.0.0.1:8000'+path, timeout=5) as response:
            if response.status != 200 or marker not in response.read():
                raise RuntimeError('Dashboard asset verification failed: '+path)
    safety=current.get('safetySystem') or {}
    if require_default and (current.get('mode') != 'PAUSED' or safety.get('controller') != 'RULE' or safety.get('enabled') is not True):
        raise RuntimeError('Fresh startup must be paused with RULE safety enabled')
    return {'dashboard':'http://127.0.0.1:8000/', 'connected':True,
        'mode':current.get('mode'), 'controller':safety.get('controller'),
        'safety_enabled':safety.get('enabled'),
        'journey_interface_current': bool((current.get('comparisonV2') or {}).get('budget'))}


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


def preserve_preferences():
    """Reload the code without resetting the user's camera/city/timing choices."""
    current=state()
    if not current or not current.get('connected'):return
    with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/catalog',timeout=10) as response:
        settings=json.load(response)['settings']
    path=ROOT/'config/dashboard-preferences.json'
    preferences=json.loads(path.read_text(encoding='utf8')) if path.exists() else {}
    keys=('camera_view','camera_resolution','camera_fov','camera_postprocess','camera_motion_blur','camera_bloom','simulation_hz','weather')
    preferences['view']={k:settings[k] for k in keys if k in settings}
    if (current.get('environment') or {}).get('mode')=='LIVING_CITY':
        preferences['population']=current['population']['requested']
    path.write_text(json.dumps(preferences,indent=2),encoding='utf8')


def restore_operator(saved):
    """An explicit code reload preserves the stopped operator's pose and route."""
    if not saved or not saved.get('connected'):return
    import carla
    from scripts.native.evaluate_drive_experience import ObservationSession
    from scripts.native.validate_motion_reliability import place
    with ObservationSession() as session:
        place(session,saved['vehicle'])
        destination=(saved.get('route') or {}).get('destination')
        if destination:session.action('destination',{'location':destination['location'],'name':destination['name']})
        session.send('stop_driving')


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--release-gpu',action='store_true');parser.add_argument('--reload',action='store_true');parser.add_argument('--validation-host',action='store_true');parser.add_argument('--check',action='store_true',help='Read-only dashboard/telemetry check; never starts or stops processes')
    parser.add_argument('--native-validation-seconds',type=float,help='Start a separately authorized RULE-only native validation session, at most 1200 seconds')
    parser.add_argument('--validation-ticket',help='Reuse the remaining time of an existing native validation session')
    args=parser.parse_args();OUT.mkdir(parents=True,exist_ok=True)
    if args.check and (args.native_validation_seconds or args.validation_ticket): parser.error('Check cannot start validation')
    if args.native_validation_seconds and args.validation_ticket: parser.error('Choose a new authorization or an existing ticket')
    validation = None
    if args.native_validation_seconds or args.validation_ticket:
        from backend.learning.native_validation_budget import NativeValidationBudget
        validation = (NativeValidationBudget(args.validation_ticket) if args.validation_ticket else
            NativeValidationBudget.create(ROOT/'output/native-rule-validation',args.native_validation_seconds))
        if validation.status()['remaining_s'] <= 0: raise RuntimeError('Native RULE validation authorization expired')
        print(json.dumps({'native_validation':validation.status()}), flush=True)
    if args.check:
        print(json.dumps(verify_dashboard(state()))); return
    runtime=NativeRuntime()
    if args.release_gpu:
        settings=runtime.active or {'quality':'Low','resolution':'1280x720','offscreen':True}
        (OUT/'graphics-before-training.json').write_text(json.dumps(settings,indent=2))
        disconnect_backend();runtime.stop();print('Project owner cleaned; CARLA GPU resources released.');return
    if args.reload:
        operator_before=state()
        preserve_preferences()
        disconnect_backend()
    else:operator_before=None
    current=state()
    if current and current.get('connected'):
        if validation and (current.get('comparisonV2') or {}).get('budget',{}).get('ticket') != str(validation.path):
            raise RuntimeError('Reload is required to activate the separately authorized validation session; reuse its ticket')
        report=verify_dashboard(current)
        if not report['journey_interface_current']:
            raise RuntimeError('Running backend predates journey integration. Stop the drive, then run Start-YA-RAB-OSTORHA.ps1 -Reload. Saved recordings are retained.')
        print(json.dumps(report));return
    if current:
        # Explicit startup repairs a disconnected, identified project host.
        # A connected/manual/autonomous host above is reused without disruption.
        settings=preferred_launch() or (current.get('simulatorStop') or {}).get('launch') or runtime.active or {'quality':'Low','resolution':'1280x720','offscreen':True}
        disconnect_backend();runtime.stop();current=None
        (OUT/'graphics-before-training.json').write_text(json.dumps(settings,indent=2))
    if not native_processes():
        saved=OUT/'graphics-before-training.json'
        settings=preferred_launch() or (json.loads(saved.read_text()) if saved.exists() else {'quality':'Low','resolution':'1280x720','offscreen':True})
        import carla
        runtime.launch(settings,'127.0.0.1',2000,carla)
    module='scripts.native.experiment2c_backend' if args.validation_host else 'backend.server'
    with (OUT/'backend.log').open('a') as out,(OUT/'backend-error.log').open('a') as err:
        command=[str(ROOT/'.venv-carla/Scripts/python.exe'),'-m',module,'--carla','--sensors','--spawn-index','152','--start-paused']
        if validation: command += ['--validation-ticket',str(validation.path)]
        proc=subprocess.Popen(command,cwd=ROOT,stdout=out,stderr=err,creationflags=subprocess.CREATE_NO_WINDOW)
    deadline=time.monotonic()+75
    while time.monotonic()<deadline:
        current=state()
        if current and current.get('connected'):
            report=verify_dashboard(current, require_default=True)
            restore_operator(operator_before)
            print(json.dumps({'pid':proc.pid,**report}));return
        if proc.poll() is not None:raise RuntimeError('Backend exited; see output/final-delivery/backend-error.log')
        time.sleep(.5)
    raise RuntimeError('Backend failed to connect within startup budget')

if __name__=='__main__':main()
