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
        self.resources = {'status':'STARTING'}
        self.gpu_error = None
        self.process_ids = {}
        self.engine_log = None
        self.active = self.inspect()
        threading.Thread(target=self._monitor_gpu, name='gpu-observer', daemon=True).start()

    def inspect(self):
        processes = native_processes()
        self.process_ids = {'backend':os.getpid(), **{
            'engine':int(p['ProcessId']) for p in processes if 'Shipping' in p['ExecutablePath']}}
        if not processes:
            return None
        command = processes[-1]['CommandLine'] or ''
        log_path = re.search(r'-abslog=(?:"([^"]+)"|(\S+))',command,re.I)
        if log_path:
            self.engine_log = Path(log_path[1] or log_path[2])
        quality = re.search(r'-quality-level=(Low|Epic)', command, re.I)
        x = re.search(r'-ResX=(\d+)', command, re.I)
        y = re.search(r'-ResY=(\d+)', command, re.I)
        profile = re.search(r'-ostorha-render-profile=(LOW|BALANCED|HIGH|ULTRA|PERFORMANCE_60)\b', command, re.I)
        return {'quality': quality[1] if quality else None,
                'resolution': f'{x[1]}x{y[1]}' if x and y else None,
                'offscreen': '-renderoffscreen' in command.lower(),
                'renderer': next((name for name in ('D3D11','D3D12') if '-'+name.lower() in command.lower()), None),
                'render_profile': profile[1].upper() if profile else None,
                'source': 'VERIFIED_NATIVE_PROCESS'}

    def _monitor_gpu(self):
        previous = None
        from ..core.resources import process_resources, system_cpu_times, wddm_process_memory
        while True:
            try:
                result = subprocess.run(['nvidia-smi', '--query-gpu=name,memory.used,memory.total,utilization.gpu',
                                         '--format=csv,noheader,nounits'], capture_output=True, text=True,
                                        timeout=5, creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                name, used, total, utilization = result.stdout.strip().splitlines()[0].split(', ')
                gpu = {'name': name, 'usedMiB': int(used), 'totalMiB': int(total),
                            'boardUsedMiB':int(used), 'scope':'TOTAL_DEVICE_ALL_PROCESSES',
                            'utilizationPercent': int(utilization), 'observedAtUnix': time.time()}
                self.gpu_error = None
                process_result = subprocess.run(['nvidia-smi', '--query-compute-apps=pid,used_memory',
                    '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=5,
                    creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
                entries = []
                if process_result.returncode == 0:
                    for line in process_result.stdout.strip().splitlines():
                        pid, memory = (v.strip() for v in line.split(',', 1))
                        available = memory.isdigit()
                        entries.append({'pid':int(pid), 'usedMiB':int(memory) if available else None,
                            'status':'MEASURED' if available else 'UNAVAILABLE',
                            'reason':None if available else 'NVML process memory unavailable (WDDM)',
                            'source':'NVIDIA_SMI_PROCESS_QUERY'})
                gpu['processMemory'] = {'status':'OBSERVED' if process_result.returncode == 0 else 'UNAVAILABLE',
                    'processes':entries, 'error':process_result.stderr.strip()[:300] or None}
                try:
                    gpu['wddmProcessMemory'] = wddm_process_memory(tuple(self.process_ids.values()))
                except (OSError, ValueError, KeyError, subprocess.TimeoutExpired) as error:
                    gpu['wddmProcessMemory'] = {'status':'UNAVAILABLE','error':str(error)}
                self.gpu = gpu
            except (OSError, ValueError, IndexError, subprocess.TimeoutExpired) as error:
                self.gpu = None
                self.gpu_error = str(error)
            try:
                now = time.monotonic()
                processes = {name:process_resources(pid) for name,pid in self.process_ids.items()}
                system = system_cpu_times()
                cpu = None
                if previous:
                    elapsed = now-previous[0]
                    for name,value in processes.items():
                        prior = previous[1].get(name)
                        if prior and prior['pid'] == value['pid']:
                            value['cpuPercentOneCore'] = 100*(value['cpu_seconds']-prior['cpu_seconds'])/elapsed
                            value['cpuPercentMachine'] = value['cpuPercentOneCore']/(os.cpu_count() or 1)
                    total = system[1]-previous[2][1]
                    cpu = 100*(1-(system[0]-previous[2][0])/total) if total > 0 else None
                previous = (now, processes, system)
                self.resources = {'status':'MEASURED', 'observedAtUnix':time.time(),
                    'systemCpuPercent':cpu, 'logicalCpuCount':os.cpu_count(), 'processes':processes,
                    'source':'WINDOWS_PROCESS_MEMORY_AND_CPU_TIMES'}
            except OSError as error:
                self.resources = {'status':'UNAVAILABLE', 'error':str(error), 'observedAtUnix':time.time()}
            if self.engine_log and self.active:
                active = self.active
                audit = self.render_audit(self.engine_log, active['render_profile'])
                if self.active is active:
                    self.active = {**active,'renderAudit':audit}
            time.sleep(3)

    @staticmethod
    def render_audit(path, profile):
        from ..graphics import render_settings
        expected = render_settings(profile)
        try:
            with Path(path).open('r',encoding='utf8',errors='replace') as stream:
                stream.seek(0,2)
                size = stream.tell()
                stream.seek(max(0,size-1_048_576))
                lines = stream.read().splitlines()
        except OSError as error:
            return {'verified':False, 'source':'ENGINE_CONSOLE_RESPONSE', 'error':str(error),
                'log':str(path), 'requested':expected, 'applied':{}, 'missing':sorted(expected)}
        actual = {}
        for line in lines:
            if 'LogConsoleResponse' not in line:
                continue
            for key in expected:
                match = re.search(re.escape(key)+r'\s*=\s*"?([-+]?\d+(?:\.\d+)?)',line)
                if match:
                    actual[key] = float(match[1])
        missing = sorted(set(expected)-set(actual))
        mismatches = {k:{'requested':v,'applied':actual[k]} for k,v in expected.items()
            if k in actual and abs(float(v)-actual[k]) > 1e-6}
        return {'verified':not missing and not mismatches, 'source':'ENGINE_CONSOLE_RESPONSE',
            'log':str(path), 'observedAtUnix':time.time(), 'requested':expected, 'applied':actual,
            'missing':missing, 'mismatches':mismatches,
            'scope':'STARTUP_CONSOLE_QUERY_NOT_TEXTURE_POOL_AS_TOTAL_VRAM'}

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
        self.engine_log=None
        self.process_ids={'backend':os.getpid()}

    def launch(self, settings, host, port, api):
        marker = json.loads((INSTALL/'.carla-install.json').read_text(encoding='utf-8-sig'))
        executable = Path(marker['executable']).resolve()
        if not executable.is_relative_to(INSTALL.resolve()) or not executable.is_file() or \
                marker.get('version') != '0.9.16' or not marker.get('packageVerified') or not marker.get('pythonApiValidated'):
            raise RuntimeError('Official CARLA installation verification failed')
        width, height = settings['resolution'].split('x')
        renderer = settings.get('renderer') or 'D3D12'
        if renderer not in ('D3D11','D3D12'):raise ValueError('Unsupported verified native renderer')
        from ..graphics import write_render_config
        profile = settings.get('render_profile') or ('HIGH' if settings['quality']=='Epic' else 'LOW')
        self.engine_log = None
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
        if profile == 'PERFORMANCE_60':
            import uuid
            from ..graphics import render_settings
            self.engine_log = Path(__file__).resolve().parents[2]/'output/native-runtime'/('engine-'+uuid.uuid4().hex+'.log')
            self.engine_log.parent.mkdir(parents=True,exist_ok=True)
            args += ['-abslog='+str(self.engine_log), '-ExecCmds='+','.join(render_settings(profile))]
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
                self.inspect()
                self.active = {**settings, 'renderer':renderer, 'render_profile':profile, 'source':'VERIFIED_NATIVE_LAUNCH'}
                if self.engine_log:
                    self.active['renderAudit'] = self.render_audit(self.engine_log, profile)
                return
            except (OSError, RuntimeError, subprocess.TimeoutExpired):
                time.sleep(1)
        raise RuntimeError('CARLA launch did not return a real world within 90 seconds')



def get_runtime():
    global _runtime
    if _runtime is None:
        _runtime = NativeRuntime()
    return _runtime
