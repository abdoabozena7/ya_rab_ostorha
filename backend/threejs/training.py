"""Run the local JS simulation trainer as an isolated background process."""

import json
import os
import shutil
import subprocess
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
WEIGHTS = ROOT / "output" / "policy-lab.json"
REPORT = ROOT / "output" / "policy-lab-evaluation.json"
LOG = ROOT / "output" / "policy-lab-training.log"


class TrainingJob:
    def __init__(self):
        self.lock = threading.Lock()
        self.process = None

    def snapshot(self):
        with self.lock:
            running = self.process is not None and self.process.poll() is None
            exit_code = None if self.process is None or running else self.process.returncode
        episodes = None
        if WEIGHTS.exists():
            try:
                episodes = json.loads(WEIGHTS.read_text(encoding="utf-8")).get("episodes")
            except (OSError, ValueError):
                pass
        report = None
        if REPORT.exists() and not running:
            try:
                saved = json.loads(REPORT.read_text(encoding="utf-8"))
                if saved.get("trainEpisodes") == episodes:
                    report = {"baseline": saved["baseline"], "trained": saved["trained"],
                              "evaluationSeeds": saved["evaluationSeeds"]}
            except (OSError, ValueError, KeyError):
                pass
        return {"schemaVersion": 1, "running": running, "exitCode": exit_code,
                "episodes": episodes, "weightsReady": WEIGHTS.exists(), "report": report}

    def start(self):
        with self.lock:
            if self.process is not None and self.process.poll() is None:
                return False
            node = shutil.which("node")
            if not node:
                raise RuntimeError("Node.js is required for training")
            WEIGHTS.parent.mkdir(parents=True, exist_ok=True)
            command = [node, str(ROOT / "tools" / "train-policy.mjs"),
                       str(WEIGHTS), "24", "8"]
            if WEIGHTS.exists():
                command.append("--resume")
            with LOG.open("w", encoding="utf-8") as stream:
                self.process = subprocess.Popen(command, cwd=ROOT, stdout=stream,
                                                stderr=subprocess.STDOUT,
                                                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        return True

    def stop(self):
        with self.lock:
            if self.process is None or self.process.poll() is not None:
                return False
            self.process.terminate()
        return True


TRAINING = TrainingJob()
