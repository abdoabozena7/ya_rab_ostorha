"""Bounded, owned native dashboard for repeatable performance measurements."""
import argparse
import os
from pathlib import Path
import subprocess
import sys


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port',type=int,default=8030)
    parser.add_argument('--ws-port',type=int,default=8031)
    parser.add_argument('--seconds',type=float,default=3600)
    parser.add_argument('--run-profile',choices=('LEGACY','PERFORMANCE_60'),default='PERFORMANCE_60')
    parser.add_argument('--render-profile',choices=('LOW','BALANCED','HIGH','ULTRA','PERFORMANCE_60'),default='PERFORMANCE_60')
    parser.add_argument('--detector',choices=('CPU','DML'),default='CPU')
    parser.add_argument('--renderer',choices=('D3D11','D3D12'))
    args=parser.parse_args()
    if args.seconds<=0:
        parser.error('A positive bounded session duration is required')
    root=Path(__file__).resolve().parents[2]
    if args.detector=='DML' and not (root/'.venv-perception-dml'/'Scripts'/'python.exe').is_file():
        raise RuntimeError('DirectML validation requires scripts/setup_perception_directml.ps1')
    os.environ['YRO_DETECTOR_EXECUTION_PROVIDER']=args.detector
    from backend.carla.runtime import get_runtime
    from backend.graphics import launch
    runtime=get_runtime()
    if runtime.active:
        raise RuntimeError('Stop the existing native owner explicitly before this measurement')
    process=None
    try:
        settings={**launch(args.render_profile),'offscreen':True}
        if args.renderer:settings['renderer']=args.renderer
        runtime.launch(settings,'127.0.0.1',2000,None)
        command=[sys.executable,'-m','backend.server','--carla','--sensors','--start-paused','--fresh-start',
            '--vehicle','vehicle.mercedes.coupe_2020','--spawn-index','152',
            '--port',str(args.port),'--websocket-port',str(args.ws_port),
            '--run-profile',args.run_profile,'--session-duration',str(args.seconds)]
        # The launcher never imports the SDK. Retire its child SDK host before
        # stopping UE; Windows streaming handles outlive provider.disconnect().
        process=subprocess.Popen(command,cwd=root)
        code=process.wait()
        if code:
            raise RuntimeError(f'Owned dashboard exited with code {code}')
    finally:
        if process is not None and process.poll() is None:
            process.terminate()
            try:process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
        runtime.stop(port=2000)
    return 0


if __name__=='__main__':
    raise SystemExit(main())
