"""Isolated, read-only camera analysis. Never participates in command arbitration."""
import json
import os
from pathlib import Path
import subprocess
import time
import threading

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / 'output' / 'perception'


class PerceptionService:
    def request_ocr(self):
        """Only an open sign-reading panel requests the optional text model."""
        if time.time()-getattr(self,'ocr_requested_at',0.)<1.:return
        self.ocr_requested_at=time.time();OUTPUT.mkdir(parents=True,exist_ok=True)
        temporary=OUTPUT/'ocr-request.tmp'
        temporary.write_text(json.dumps({'parent':os.getpid(),'requested_at':self.ocr_requested_at}),encoding='utf8')
        temporary.replace(OUTPUT/'ocr-request.json')

    def __init__(self, http_port):
        self.process = None
        self.error = None
        python = ROOT / '.venv-perception' / 'Scripts' / 'python.exe'
        override = os.environ.get('YRO_PERCEPTION_PYTHON')
        directml = ROOT / '.venv-perception-dml' / 'Scripts' / 'python.exe'
        if not override and os.environ.get('YRO_DETECTOR_EXECUTION_PROVIDER') == 'DML' and directml.is_file():
            override = str(directml)  # scripts/setup_perception_directml.ps1
        if override and Path(override).is_file():
            # Experimental interpreter (for example with a GPU runtime); the
            # worker code and model are the same. Unset keeps the default.
            python = Path(override)
        from .detector import default_model_path
        assets = [default_model_path()]
        if not python.is_file() or not all(asset.is_file() for asset in assets):
            self.error = 'The comparison detector is not installed; run scripts/setup_perception.ps1'
            return
        OUTPUT.mkdir(parents=True, exist_ok=True)
        (ROOT/'models'/'ultralytics-config'/'Ultralytics').mkdir(parents=True, exist_ok=True)
        self.log = (OUTPUT / 'worker.log').open('a', encoding='utf8')
        self.process = subprocess.Popen([str(python), '-m', 'backend.computer_vision.worker',
            '--port', str(http_port), '--parent', str(os.getpid())], cwd=ROOT,
            stdout=self.log, stderr=subprocess.STDOUT,
            env={**os.environ, 'OMP_NUM_THREADS':'1', 'MKL_NUM_THREADS':'1',
                 'YOLO_CONFIG_DIR':str(ROOT/'models'/'ultralytics-config'),
                 'YOLO_OFFLINE':'true','YOLO_AUTOINSTALL':'false'},
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)

    def latest(self, session_id=None):
        if self.error:
            return {'status':'UNAVAILABLE', 'error':self.error}
        if self.process is None or self.process.poll() is not None:
            return {'status':'ERROR', 'error':'Inference worker stopped; inspect output/perception/worker.log'}
        try:
            result = json.loads((OUTPUT / 'latest.json').read_text(encoding='utf8'))
        except (OSError, ValueError):
            return {'status':'LOADING'}
        if session_id and result.get('session_id') not in (None,session_id):
            return {'status':'WAITING', 'error':'Waiting for a frame from this session'}
        result['age_ms'] = max(0., (time.time()-result['published_at'])*1000)
        if result['age_ms'] > 10000:
            return {'status':'STALE', 'error':'Inference frame stopped updating'}
        return result

    def image(self, token):
        # Only immutable images produced by this worker, inside its bounded cache.
        if not token or not token.startswith('frame_') or not token.endswith('.jpg') or any(
                c not in 'abcdefghijklmnopqrstuvwxyz0123456789_.' for c in token):
            raise ValueError('Invalid perception frame token')
        return (OUTPUT / token).read_bytes()

    def close(self):
        if self.process and self.process.poll() is None:
            self.process.terminate()
            try: self.process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                self.process.kill(); self.process.wait(timeout=5)
        if hasattr(self,'log'): self.log.close()


class ControlPerceptionCache:
    """File polling belongs to a separate thread; the control read is atomic."""
    def __init__(self):
        self.value=None;self.stop=threading.Event()
        self.thread=threading.Thread(target=self._run,name='control-semantic-cache',daemon=True);self.thread.start()

    def _run(self):
        while not self.stop.is_set():
            try:self.value=json.loads((OUTPUT/'latest-detections.json').read_text(encoding='utf8'))
            except (OSError,ValueError):pass
            self.stop.wait(.1)

    def latest(self,session_id):
        value=self.value
        return value if value and value.get('session_id')==session_id else None

    def close(self):self.stop.set();self.thread.join(timeout=1.)
