"""Development restart with confirmed cleanup before terminating our backend."""
import json
import subprocess
import sys
import time
import urllib.request
from pathlib import Path
from websockets.sync.client import connect
from .stability_run import backend_pid


def main():
    import carla
    pid=backend_pid(8000)
    with connect('ws://127.0.0.1:8001',max_size=2**23) as socket:
        state=json.loads(socket.recv())
        if state.get('recording') or state.get('rlRuntime',{}).get('active'):
            raise RuntimeError('An active recording or external experiment owns this native session')
        socket.send(json.dumps({'type':'take_control','sequence':1}))
        while json.loads(socket.recv()).get('acknowledged')!=1: pass
        socket.send(json.dumps({'type':'disconnect','sequence':2}))
        while json.loads(socket.recv()).get('acknowledged')!=2: pass
    client=carla.Client('127.0.0.1',2000); client.set_timeout(10)
    world=client.get_world(); world.wait_for_tick(10)
    owned=[a.id for a in world.get_actors() if a.attributes.get('role_name','').startswith('ostorha_')]
    assert not owned, owned
    assert not world.get_settings().synchronous_mode
    subprocess.run(['taskkill','/PID',str(pid),'/F'],capture_output=True,check=True)
    time.sleep(1)
    root=Path(__file__).resolve().parents[2]
    output=root/'output/native-validation'; output.mkdir(parents=True,exist_ok=True)
    with (output/'gate5-backend.log').open('w') as out, (output/'gate5-backend-error.log').open('w') as err:
        process=subprocess.Popen([sys.executable,'-m','backend.server',
                                 '--carla','--sensors','--start-paused'],cwd=root,stdout=out,stderr=err,
                                 creationflags=subprocess.CREATE_NO_WINDOW)
    deadline=time.monotonic()+60
    while time.monotonic()<deadline:
        try:
            with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/state',timeout=2) as response:
                state=json.load(response)
            if state.get('connected'):break
        except OSError:pass
        time.sleep(.25)
    else:raise RuntimeError('Restarted backend did not publish a connected native state')
    print(json.dumps({'retired_pid':pid,'new_pid':process.pid,'cleanup_verified':True}))


if __name__=='__main__': main()
