"""Isolated, read-only camera analysis. Never participates in command arbitration."""
import json
import os
from pathlib import Path
import subprocess
import time

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'output' / 'perception'


class PerceptionService:
    def __init__(self, http_port):
        self.process = None
        self.error = None
        python = ROOT / '.venv-perception' / 'Scripts' / 'python.exe'
        assets = [ROOT/'models'/'yolov8n.pt', ROOT/'models'/'ocr'/'craft_mlt_25k.pth',
                  ROOT/'models'/'ocr'/'arabic.pth', ROOT/'models'/'ocr'/'english_g2.pth']
        if not python.is_file() or not all(asset.is_file() for asset in assets):
            self.error = 'Models YOLO/OCR not installed; run scripts/setup_perception.ps1'
            return
        OUTPUT.mkdir(parents=True, exist_ok=True)
        (ROOT/'models'/'ultralytics-config'/'Ultralytics').mkdir(parents=True, exist_ok=True)
        self.log = (OUTPUT / 'worker.log').open('a', encoding='utf8')
        self.process = subprocess.Popen([str(python), '-m', 'backend.perception_worker',
            '--port', str(http_port), '--parent', str(os.getpid())], cwd=ROOT,
            stdout=self.log, stderr=subprocess.STDOUT,
            env={**os.environ, 'OMP_NUM_THREADS':'2', 'MKL_NUM_THREADS':'2',
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
