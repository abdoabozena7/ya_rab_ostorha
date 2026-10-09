"""Active safety integration host reload, with separate logs and normal-host restoration."""
import argparse
import json
import subprocess
import time
import urllib.request
from websockets.sync.client import connect
from .stability_run import backend_pid
from .experiment2b_common import ROOT, write


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--restore-normal', action='store_true')
    args = parser.parse_args()
    began = time.monotonic()
    with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/state', timeout=5) as response:
        state = json.load(response)
    assert state['connected'] and state['mode'] == 'PAUSED' and not state['rlRuntime']['active']
    pid = backend_pid(8000)
    with connect('ws://127.0.0.1:8001', max_size=2**23, open_timeout=10) as socket:
        socket.recv()
        socket.send(json.dumps({'type': 'take_control', 'sequence': 1}))
        while json.loads(socket.recv()).get('acknowledged') != 1:
            pass
        socket.send(json.dumps({'type': 'disconnect', 'sequence': 2}))
        while json.loads(socket.recv()).get('acknowledged') != 2:
            pass
    # Inspect only after the old owner disconnected. This client never ticks.
    import carla
    client = carla.Client('127.0.0.1', 2000)
    client.set_timeout(10)
    world = client.get_world()
    world.wait_for_tick(10)
    assert not world.get_settings().synchronous_mode
    assert not [a for a in world.get_actors() if a.attributes.get('role_name', '').startswith('ostorha_')]
    subprocess.run(['taskkill', '/PID', str(pid), '/F'], capture_output=True, check=True)
    time.sleep(1)
    # Reuse the existing temporary display-inference suppression. All native
    # physics, sensors, feasibility and command arbitration remain unchanged.
    module = 'backend.server' if args.restore_normal else 'scripts.native.experiment2c_backend'
    prefix = 'active-safety-restored-backend' if args.restore_normal else 'active-safety-backend'
    output = ROOT / 'output/native-validation'
    output.mkdir(parents=True, exist_ok=True)
    with (output / (prefix + '.log')).open('w') as out, (output / (prefix + '-error.log')).open('w') as err:
        process = subprocess.Popen([str(ROOT / '.venv-carla/Scripts/python.exe'), '-m', module,
            '--carla', '--sensors', '--start-paused'], cwd=ROOT, stdout=out, stderr=err,
            creationflags=subprocess.CREATE_NO_WINDOW)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen('http://127.0.0.1:8000/api/simulation/state', timeout=2) as response:
                state = json.load(response)
            if state.get('connected'):
                break
        except OSError:
            pass
        time.sleep(.25)
    else:
        raise RuntimeError('Reloaded host did not reconnect')
    result = {'old_pid': pid, 'new_pid': process.pid, 'module': module,
              'old_actors_cleaned': True, 'old_world_settings_restored': True,
              'new_mode': state['mode'], 'wall_s': time.monotonic() - began}
    write(output / (prefix + '-restart.json'), result)
    print(json.dumps(result), flush=True)


if __name__ == '__main__':
    main()
