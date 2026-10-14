"""Latest-only CPU request queue; physics never waits for inference or IPC."""
import json
import os
from pathlib import Path
from queue import Queue, Empty, Full
import subprocess
import threading
import time

ROOT=Path(__file__).resolve().parents[2]


class AsyncPredictionWorker:
    def __init__(self, kind='trajectron'):
        self.kind=kind; self.queue=Queue(maxsize=1); self.latest=None; self.error=None
        self.stop=threading.Event(); self.latencies=[]
        env='.venv-trajectron' if kind=='trajectron' else '.venv-perception'
        python=ROOT/env/'Scripts/python.exe'
        logs=ROOT/'output/predictive-v2'; logs.mkdir(parents=True,exist_ok=True)
        self.log=(logs/(kind+'-worker.log')).open('a',encoding='utf8')
        self.process=subprocess.Popen([str(python),'-m','backend.learning.cpu_worker','--kind',kind],cwd=ROOT,
            stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=self.log,text=True,bufsize=1,
            env={**os.environ,'OMP_NUM_THREADS':'1','MKL_NUM_THREADS':'1'},
            creationflags=subprocess.CREATE_NO_WINDOW if os.name=='nt' else 0)
        self.thread=threading.Thread(target=self._run,daemon=True,name=kind+'-ipc'); self.thread.start()

    def submit(self, request):
        request={**request,'request_wall_s':time.monotonic()}
        try: self.queue.put_nowait(request)
        except Full:
            try: self.queue.get_nowait()
            except Empty: pass
            try: self.queue.put_nowait(request)
            except Full: pass

    def _run(self):
        try:
            while not self.stop.is_set():
                try: request=self.queue.get(timeout=.1)
                except Empty: continue
                self.process.stdin.write(json.dumps(request,allow_nan=False)+'\n'); self.process.stdin.flush()
                line=self.process.stdout.readline()
                if not line: raise RuntimeError('CPU worker exited')
                result=json.loads(line)
                if result.get('error'): raise ValueError(result['error'])
                result['end_to_end_ms']=(time.monotonic()-request['request_wall_s'])*1000
                result['request']=request; self.latest=result
                self.latencies.append(result['end_to_end_ms']); self.latencies=self.latencies[-1000:]
        except Exception as error: self.error=str(error)

    def current(self, session_id, timestamp_s, wall=None):
        result=self.latest; wall=time.monotonic() if wall is None else wall
        if not result or result['session_id']!=session_id: return None
        age=timestamp_s-result['timestamp_s']; wall_age=wall-result['request_wall_s']
        if not 0<=age<=.75 or not 0<=wall_age<=1.: return None
        return result

    def close(self):
        self.stop.set()
        if self.process.poll() is None:
            self.process.terminate()
            try: self.process.wait(timeout=3)
            except subprocess.TimeoutExpired: self.process.kill()
        self.thread.join(timeout=2); self.log.close()
