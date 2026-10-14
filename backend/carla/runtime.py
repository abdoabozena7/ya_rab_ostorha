"""Local, verified CARLA process lifecycle. Never changes the installed package."""
import json
import os
from pathlib import Path
import re
import socket
import subprocess
import sys
import threading
import time

INSTALL = Path('C:/CARLA/CARLA_0.9.16')
_runtime = None


def native_processes():
    script = ("Get-CimInstance Win32_Process -Filter \"Name LIKE 'CarlaUE4%'\" | "
              "Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress")
    result = subprocess.run(['powershell', '-NoProfile', '-Command', script],
                            capture_output=True, text=True, timeout=15,
                            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
    if result.returncode:
        raise RuntimeError('Cannot verify native CARLA process identity')
    entries = json.loads(result.stdout) if result.stdout.strip() else []
    entries = entries if isinstance(entries, list) else [entries]
    return [entry for entry in entries if entry.get('ExecutablePath') and
            Path(entry['ExecutablePath']).resolve().is_relative_to(INSTALL.resolve())]


class NativeRuntime:
    def __init__(self):
        self.gpu = None
        self.active = self.inspect()
        threading.Thread(target=self._monitor_gpu, name='gpu-observer', daemon=True).start()

    def inspect(self):
        processes = native_processes()
        if not processes:
            return None
        command = processes[-1]['CommandLine'] or ''
        quality = re.search(r'-quality-level=(Low|Epic)', command, re.I)
        x = re.search(r'-ResX=(\d+)', command, re.I)
        y = re.search(r'-ResY=(\d+)', command, re.I)
        profile = re.search(r'-ostorha-render-profile=(LOW|BALANCED|HIGH|ULTRA)\b', command, re.I)
        return {'quality': quality[1] if quality else None,
                'resolution': f'{x[1]}x{y[1]}' if x and y else None,
                'offscreen': '-renderoffscreen' in command.lower(),
                'renderer': next((name for name in ('D3D11','D3D12') if '-'+name.lower() in command.lower()), None),
                'render_profile': profile[1].upper() if profile else None,
                'source': 'VERIFIED_NATIVE_PROCESS'}

    def _monitor_gpu(self):
        while True:
            try:
                result = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.used,memory.total,utilization.gpu',
                                         '--format=csv,noheader,nounits'], capture_output=True, text=True,
                                        timeout=5, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                name, used, total, utilization = result.stdout.strip().splitlines()[0].split(', ')
                self.gpu = {'name': name, 'usedMiB': int(used), 'totalMiB': int(total),
                            'utilizationPercent': int(utilization), 'observedAtUnix': time.time()}
            except (OSError, ValueError, IndexError, subprocess.TimeoutExpired):
                self.gpu = None
            time.sleep(3)

    def stop(self, *, port=None):
        # Query identity immediately before using a PID; never match unrelated apps.
        def selected():
            entries=native_processes()
            if port is None:return entries
            result=[]
            for entry in entries:
                match=re.search(r'-carla-rpc-port[= ](\d+)\b',entry.get('CommandLine') or '',re.I)
                if (int(match[1]) if match else 2000)==port:result.append(entry)
            return result
        for entry in reversed(selected()):
            subprocess.run(['taskkill', '/PID', str(entry['ProcessId']), '/F'],
                           capture_output=True, timeout=10, creationflags=subprocess.CREATE_NO_WINDOW)
        deadline = time.monotonic()+15
        while selected() and time.monotonic()<deadline:
            time.sleep(.3)
        if selected():
            raise RuntimeError('Verified CARLA process did not exit')
        self.active=None

    def launch(self, settings, host, port, api):
        marker = json.loads((INSTALL/'.carla-install.json').read_text(encoding='utf-8-sig'))
        executable = Path(marker['executable']).resolve()
        if not executable.is_relative_to(INSTALL.resolve()) or not executable.is_file() or \
                marker.get('version') != '0.9.16' or not marker.get('packageVerified') or not marker.get('pythonApiValidated'):
            raise RuntimeError('Official CARLA installation verification failed')
        width, height = settings['resolution'].split('x')
        renderer = 'D3D12'
        from ..graphics import write_render_config
        profile = settings.get('render_profile') or ('HIGH' if settings['quality']=='Epic' else 'LOW')
        user_config = Path(os.environ['LOCALAPPDATA'])/'CarlaUE4/Saved/Config/WindowsNoEditor/Engine.ini'
        backup = Path(__file__).resolve().parents[2]/'output/native-runtime/user-engine-before-optimization.ini'
        if user_config.exists() and not backup.exists():
            backup.parent.mkdir(parents=True, exist_ok=True)
            backup.write_bytes(user_config.read_bytes())
        write_render_config(user_config, user_config, profile)
        args = [str(executable), '-quality-level='+settings['quality'], '-'+renderer,
                '-nosound', '-unattended',
                '-ostorha-render-profile='+profile,
                '-carla-rpc-port='+str(port), '-ResX='+width, '-ResY='+height]
        args.append('-RenderOffScreen' if settings.get('offscreen', True) else '-windowed')
        process = subprocess.Popen(args, cwd=executable.parent, creationflags=subprocess.CREATE_NO_WINDOW)
        deadline = time.monotonic()+90
        while time.monotonic()<deadline:
            if process.poll() is not None:
                raise RuntimeError(f'CARLA exited during startup (code {process.returncode}); previous graphics can be restored')
            try:
                with socket.create_connection((host, port), timeout=.5):
                    pass
                # UE opens its RPC port before the world is ready. In the Windows
                # SDK, a premature get_world() timeout can abort the interpreter,
                # rather than raise Python RuntimeError. Keep readiness probes in
                # disposable processes; the application connects only after one
                # confirms a real snapshot and exact API/server versions.
                probe = subprocess.run([sys.executable, '-c',
                    'import carla,sys; c=carla.Client(sys.argv[1],int(sys.argv[2])); '
                    'c.set_timeout(8); assert c.get_client_version()==c.get_server_version()=="0.9.16"; '
                    'w=c.get_world(); s=w.wait_for_tick(8); assert s.frame>0; '
                    'print("CARLA_WORLD_READY")', host, str(port)],
                    capture_output=True, text=True, timeout=20,
                    creationflags=subprocess.CREATE_NO_WINDOW)
                if probe.returncode or 'CARLA_WORLD_READY' not in probe.stdout:
                    raise RuntimeError('Native world readiness probe has not succeeded')
                self.active = {**settings, 'renderer':renderer, 'render_profile':profile, 'source':'VERIFIED_NATIVE_LAUNCH'}
                return
            except (OSError, RuntimeError, subprocess.TimeoutExpired):
                time.sleep(1)
        raise RuntimeError('CARLA launch did not return a real world within 90 seconds')



def get_runtime():
    global _runtime
    if _runtime is None:
        _runtime = NativeRuntime()
    return _runtime
