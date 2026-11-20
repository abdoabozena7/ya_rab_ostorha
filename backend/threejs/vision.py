"""Strict pixel-only vision boundary; optional inference lives in one child.

The normal Python/-S server imports no CV packages and starts nothing here.
Explicit start loads the already installed full-plus-fixed-focus YOLOX worker.
One pending frame replaces older work; observations expire after 750 ms.
"""

import base64
import binascii
import copy
import json
import math
import os
from pathlib import Path
import queue
import subprocess
import threading
import time
from collections import deque


ROOT = Path(__file__).resolve().parents[2]
WORKER_PYTHON = ROOT / ".venv-perception" / "Scripts" / "python.exe"
MODEL_PATH = ROOT / ".cache" / "models" / "cv" / "yolox_tiny.onnx"
MODEL_SHA256 = "427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7"
MODEL_ID = "YOLOX-Tiny / COCO"
MODEL_METHOD = "onnxruntime-yolox-tiny-416-full+center-half"
MODEL_PROVIDER = "CPUExecutionProvider"
MAX_JPEG_BYTES = 640_000
MAX_BASE64_CHARS = 4 * ((MAX_JPEG_BYTES + 2) // 3)
MAX_REPLY_CHARS = 65_536
MAX_STREAMS = 64
STALE_AFTER_S = 0.75
STARTUP_TIMEOUT_S = 15.0
RPC_TIMEOUT_S = 4.0
CLOSE_TIMEOUT_S = 1.0


def _model(sha256=None):
    return {
        "id": MODEL_ID, "method": MODEL_METHOD,
        "provider": MODEL_PROVIDER, "weightsSha256": sha256,
    }


def _envelope(status, available, model, error=None, result=None):
    return {
        "schemaVersion": 1, "source": "camera-pixels", "status": status,
        "available": available, "model": copy.deepcopy(model),
        "error": error, "result": copy.deepcopy(result),
    }


def capabilities():
    """Report configuration, never readiness inferred from file existence."""
    missing = []
    if not WORKER_PYTHON.is_file():
        missing.append("existing perception interpreter is missing")
    if not MODEL_PATH.is_file():
        missing.append("pinned YOLOX-Tiny weights are missing")
    return _envelope("disabled", False, _model(), "; ".join(missing) or None)


def _keys(value, required, name, optional=()):
    if type(value) is not dict:
        raise ValueError(f"{name} must be an object")
    actual = set(value)
    if not all(type(key) is str for key in actual):
        raise ValueError(f"{name} keys must be strings")
    extra = actual - set(required) - set(optional)
    missing = set(required) - actual
    if extra or missing:
        raise ValueError(f"{name} unknown/missing fields: {sorted(extra)}/{sorted(missing)}")


def _number(value, name, minimum=-1_000_000, maximum=1_000_000, integer=False):
    if type(value) not in (int, float) or (integer and type(value) is not int):
        raise ValueError(f"{name} must be a {'whole ' if integer else ''}number, not a boolean")
    if (type(value) is float and not math.isfinite(value)) or not minimum <= value <= maximum:
        raise ValueError(f"{name} must be finite and within [{minimum}, {maximum}]")
    return value


def _jpeg_dimensions(jpeg):
    """Bound JPEG geometry before handing bytes to the actual worker decoder."""
    if not jpeg.startswith(b"\xff\xd8") or not jpeg.endswith(b"\xff\xd9"):
        raise ValueError("imageJpegBase64 must contain a complete JPEG")
    offset = 2
    dimensions = None
    sof_markers = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7,
                   0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}
    while offset < len(jpeg) - 2:
        if jpeg[offset] != 0xFF:
            raise ValueError("Invalid JPEG marker")
        while offset < len(jpeg) and jpeg[offset] == 0xFF:
            offset += 1
        if offset >= len(jpeg):
            break
        marker = jpeg[offset]
        offset += 1
        if marker in (0x00, 0xD8, 0xD9) or 0xD0 <= marker <= 0xD7:
            raise ValueError("Invalid JPEG header")
        if offset + 2 > len(jpeg):
            break
        length = int.from_bytes(jpeg[offset:offset + 2], "big")
        end = offset + length
        if length < 2 or end > len(jpeg) - 2:
            raise ValueError("Truncated JPEG segment")
        if marker in sof_markers:
            if marker not in (0xC0, 0xC1, 0xC2) or dimensions is not None or length != 17:
                raise ValueError("Unsupported JPEG encoding")
            if jpeg[offset + 2] != 8 or jpeg[offset + 7] != 3:
                raise ValueError("Camera JPEG must be 8-bit three-channel RGB")
            height = int.from_bytes(jpeg[offset + 3:offset + 5], "big")
            width = int.from_bytes(jpeg[offset + 5:offset + 7], "big")
            _number(width, "JPEG width", 32, 1920, integer=True)
            _number(height, "JPEG height", 32, 1080, integer=True)
            dimensions = (width, height)
        if marker == 0xDA:
            if dimensions is None or end >= len(jpeg) - 2:
                raise ValueError("JPEG has no RGB image scan")
            return dimensions
        offset = end
    raise ValueError("JPEG has no complete RGB image header")


def validate_frame(frame):
    """Return an independent, strictly admitted frame and its encoded pixels.

    Full JPEG decoding happens in the worker, not in the standard Python host.
    No unknown metadata is forwarded, including inside calibration/odometry.
    """
    _keys(frame, {
        "streamId", "frameId", "simulationTimeS", "imageJpegBase64", "camera", "ego",
    }, "frame", optional={"schema"})
    if "schema" in frame and (type(frame["schema"]) is not int or frame["schema"] != 1):
        raise ValueError("frame.schema must be 1")
    stream = frame["streamId"]
    if (type(stream) is not str or not stream or len(stream) > 80
            or any(ord(char) < 33 or ord(char) > 126 for char in stream)):
        raise ValueError("streamId must be a nonempty printable token of at most 80 characters")
    _number(frame["frameId"], "frameId", 0, 2 ** 53 - 1, integer=True)
    _number(frame["simulationTimeS"], "simulationTimeS", 0, 1_000_000_000)
    camera = frame["camera"]
    _keys(camera, {"width", "height", "fovYDeg", "position", "headingRad", "groundY"}, "camera")
    _number(camera["width"], "camera.width", 32, 1920, integer=True)
    _number(camera["height"], "camera.height", 32, 1080, integer=True)
    _number(camera["fovYDeg"], "camera.fovYDeg", 1, 175)
    _number(camera["headingRad"], "camera.headingRad")
    _number(camera["groundY"], "camera.groundY", -10_000, 10_000)
    _keys(camera["position"], {"x", "y", "z"}, "camera.position")
    for key, value in camera["position"].items():
        _number(value, f"camera.position.{key}")
    height_above_ground = camera["position"]["y"] - camera["groundY"]
    if not 0.05 <= height_above_ground <= 20:
        raise ValueError("camera.position.y must be above its declared flat ground")
    ego = frame["ego"]
    _keys(ego, {"x", "z", "headingRad", "speedMps", "lengthM", "widthM"}, "ego")
    for key in ("x", "z", "headingRad"):
        _number(ego[key], f"ego.{key}")
    _number(ego["speedMps"], "ego.speedMps", -80, 80)
    _number(ego["lengthM"], "ego.lengthM", 0.1, 30)
    _number(ego["widthM"], "ego.widthM", 0.1, 10)
    encoded = frame["imageJpegBase64"]
    if type(encoded) is not str or not encoded or len(encoded) > MAX_BASE64_CHARS:
        raise ValueError("imageJpegBase64 exceeds the bounded camera payload")
    try:
        jpeg = base64.b64decode(encoded, validate=True)
    except (ValueError, binascii.Error) as error:
        raise ValueError("imageJpegBase64 is not strict base64") from error
    if len(jpeg) > MAX_JPEG_BYTES:
        raise ValueError("JPEG exceeds the bounded camera payload")
    if _jpeg_dimensions(jpeg) != (camera["width"], camera["height"]):
        raise ValueError("JPEG dimensions do not match camera calibration")
    return copy.deepcopy(frame), jpeg


def _validate_model(model):
    if model != _model(MODEL_SHA256):
        raise RuntimeError("Vision worker did not load the pinned model/method/CPU provider")


def _same_json(left, right):
    if type(left) is not type(right):
        return False
    if type(left) is dict:
        return left.keys() == right.keys() and all(_same_json(left[key], right[key]) for key in left)
    if type(left) is list:
        return len(left) == len(right) and all(_same_json(a, b) for a, b in zip(left, right))
    return left == right


def _validate_result(result, frame):
    _keys(result, {
        "streamId", "frameId", "simulationTimeS", "camera", "ego", "width", "height",
        "latencyMs", "model", "detections", "status",
    }, "worker result")
    for key in ("streamId", "frameId", "simulationTimeS", "camera", "ego"):
        if not _same_json(result[key], frame[key]):
            raise ValueError(f"Worker result changed frame provenance: {key}")
    if result["status"] != "ready":
        raise ValueError("Worker result is not ready")
    _validate_model(result["model"])
    width, height = frame["camera"]["width"], frame["camera"]["height"]
    if type(result["width"]) is not int or type(result["height"]) is not int:
        raise ValueError("Worker dimensions must be integers")
    if (result["width"], result["height"]) != (width, height):
        raise ValueError("Decoded dimensions do not match the admitted image")
    _number(result["latencyMs"], "latencyMs", 0, RPC_TIMEOUT_S * 1000)
    detections = result["detections"]
    if type(detections) is not list or len(detections) > 30:
        raise ValueError("Worker detections exceed the detector limit")
    for detection in detections:
        _keys(detection, {"box", "label", "confidence"}, "detection")
        if detection["label"] not in ("person", "vehicle"):
            raise ValueError("Unsupported semantic detector label")
        _number(detection["confidence"], "confidence", 0, 1)
        box = detection["box"]
        if type(box) is not list or len(box) != 4:
            raise ValueError("Detection box must contain four pixel coordinates")
        for index, value in enumerate(box):
            _number(value, "box", 0, width if index % 2 == 0 else height)
        if not box[0] < box[2] or not box[1] < box[3]:
            raise ValueError("Detection box has no pixel area")
    return result


def _worker_command():
    return [str(WORKER_PYTHON), "-B", "-u", "-m", "backend.threejs.vision_tracking", "--worker"]


class _FrameError(RuntimeError):
    pass


class _WorkerProcess:
    """One bounded JSON-lines RPC transport, including bounded pipe writes."""

    def __init__(self):
        self.process = None
        self.threads = []
        self.replies = queue.Queue(maxsize=2)
        self.requests = queue.Queue(maxsize=1)
        self.stderr = deque(maxlen=16)
        self.stopped = threading.Event()
        self.rpc_lock = threading.Lock()
        self.close_lock = threading.Lock()
        self.sequence = 0

    @property
    def alive(self):
        return self.process is not None and self.process.poll() is None and not self.stopped.is_set()

    def _publish(self, message):
        try:
            self.replies.put_nowait(message)
        except queue.Full:
            pass

    def _read(self):
        try:
            while not self.stopped.is_set():
                line = self.process.stdout.readline(MAX_REPLY_CHARS + 1)
                if not line:
                    break
                if len(line) > MAX_REPLY_CHARS or not line.endswith("\n"):
                    raise ValueError("Worker reply exceeded the protocol limit")
                message = json.loads(line, parse_constant=lambda value: (_ for _ in ()).throw(
                    ValueError(f"Nonfinite worker JSON: {value}")))
                if type(message) is not dict:
                    raise ValueError("Worker reply must be an object")
                self._publish(message)
        except (OSError, ValueError) as error:
            self._publish({"type": "transport-error", "error": str(error)})
        finally:
            self._publish({"type": "transport-error", "error": "Vision worker disconnected"})

    def _read_errors(self):
        try:
            while not self.stopped.is_set():
                line = self.process.stderr.readline(1024)
                if not line:
                    break
                self.stderr.append(line.rstrip())
        except (OSError, ValueError):
            pass

    def _write(self):
        while not self.stopped.is_set():
            message = self.requests.get()
            if message is None:
                return
            try:
                self.process.stdin.write(json.dumps(message, allow_nan=False, separators=(",", ":")) + "\n")
                self.process.stdin.flush()
            except (OSError, ValueError) as error:
                self._publish({"type": "transport-error", "error": str(error)})
                return

    def _receive(self, timeout, phase):
        try:
            reply = self.replies.get(timeout=timeout)
        except queue.Empty as error:
            detail = " ".join(self.stderr)[-1500:]
            raise RuntimeError(f"Vision worker {phase} timed out after {timeout:g}s. {detail}") from error
        if reply.get("type") == "transport-error":
            detail = " ".join(self.stderr)[-1500:]
            raise RuntimeError(f"{reply.get('error', 'Worker transport failed')}. {detail}")
        return reply

    def start(self):
        if not WORKER_PYTHON.is_file():
            raise RuntimeError(f"Existing perception interpreter is missing: {WORKER_PYTHON}")
        if not MODEL_PATH.is_file():
            raise RuntimeError(f"Pinned YOLOX-Tiny weights are missing: {MODEL_PATH}")
        environment = os.environ.copy()
        environment.update({
            "PYTHONDONTWRITEBYTECODE": "1", "OMP_NUM_THREADS": "2",
            "MKL_NUM_THREADS": "2", "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1", "HF_HUB_DISABLE_TELEMETRY": "1",
        })
        try:
            self.process = subprocess.Popen(
                _worker_command(), cwd=ROOT, env=environment,
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, encoding="utf-8", bufsize=1,
            )
            for name, target in (("read", self._read), ("stderr", self._read_errors), ("write", self._write)):
                thread = threading.Thread(target=target, name=f"vision-rpc-{name}", daemon=True)
                self.threads.append(thread)
                thread.start()
            reply = self._receive(STARTUP_TIMEOUT_S, "startup")
            if reply.get("type") != "ready":
                raise RuntimeError(str(reply.get("error", "Vision worker was not ready"))[:2000])
            _validate_model(reply.get("model"))
            if (reply.get("inputShape") != [1, 3, 416, 416]
                    or reply.get("outputShape") != [1, 3549, 85] or reply.get("threads") != 2):
                raise RuntimeError("Vision worker did not validate the selected tensors/threads")
            return reply["model"]
        except Exception:
            self.close()
            raise

    def infer(self, frame):
        if not self.rpc_lock.acquire(timeout=RPC_TIMEOUT_S):
            raise RuntimeError("Vision worker is busy beyond the bounded RPC wait")
        try:
            if not self.alive:
                raise RuntimeError("Vision worker is not running")
            self.sequence += 1
            request_id = self.sequence
            self.requests.put_nowait({"type": "frame", "requestId": request_id, "frame": frame})
            reply = self._receive(RPC_TIMEOUT_S, "inference")
            if reply.get("requestId") != request_id:
                raise RuntimeError("Vision worker returned an unrelated request")
            if reply.get("type") == "error":
                raise _FrameError(str(reply.get("error", "Frame inference failed"))[:2000])
            if reply.get("type") != "result":
                raise RuntimeError("Vision worker returned an invalid response")
            return reply.get("result")
        except _FrameError:
            raise
        except Exception:
            self.close()
            raise
        finally:
            self.rpc_lock.release()

    def close(self):
        with self.close_lock:
            self.stopped.set()
            self._publish({"type": "transport-error", "error": "Vision worker was closed"})
            try:
                self.requests.put_nowait(None)
            except queue.Full:
                pass
            process = self.process
            if process is not None:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=CLOSE_TIMEOUT_S)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=CLOSE_TIMEOUT_S)
                for pipe in (process.stdin, process.stdout, process.stderr):
                    if pipe is not None:
                        pipe.close()
            for thread in self.threads:
                if thread is not threading.current_thread():
                    thread.join(timeout=CLOSE_TIMEOUT_S)


class VisionService:
    """Explicit model lifecycle and a single replaceable pending RGB frame."""

    def __init__(self):
        self._lock = threading.RLock()
        self._lifecycle = threading.RLock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._runtime = None
        self._thread = None
        self._model = _model()
        self._model_ready = False
        self._status = "disabled"
        self._error = None
        self._pending = None
        self._result = None
        self._result_admitted_at = None
        self._last_admitted_at = None
        self._stream = None
        self._retired = set()
        self._last_id = -1
        self._last_time = -1
        self._generation = 0

    def start(self):
        with self._lifecycle:
            with self._lock:
                if self._model_ready and self._runtime is not None and self._runtime.alive:
                    # Starting a client acknowledges the warm worker, not a frame
                    # from a previous (possibly stale) camera stream.
                    return _envelope("ready", True, self._model)
            self.close()
            with self._lock:
                self._status = "loading"
                self._stop = threading.Event()
                self._wake = threading.Event()
                runtime = _WorkerProcess()
                self._runtime = runtime
            try:
                model = runtime.start()
                _validate_model(model)
                with self._lock:
                    self._model = model
                    self._model_ready = True
                    self._status = "ready"
                    self._error = None
                    self._thread = threading.Thread(
                        target=self._run, name="vision-latest-frame", daemon=True,
                    )
                    self._thread.start()
            except Exception as error:
                runtime.close()
                with self._lock:
                    self._runtime = None
                    self._model_ready = False
                    self._status = "error"
                    self._error = str(error)[:2000]
            return self.snapshot(self._stream)

    def _admit(self, frame):
        if not self._model_ready or self._runtime is None or not self._runtime.alive:
            raise RuntimeError("Start an available local vision worker before submitting frames")
        stream = frame["streamId"]
        if stream in self._retired:
            raise ValueError("Retired stream cannot be resumed; reset with a fresh streamId")
        if stream != self._stream:
            if len(self._retired) >= MAX_STREAMS - 1:
                raise ValueError("Stream limit reached; explicitly restart local vision")
            if self._stream is not None:
                self._retired.add(self._stream)
            self._stream = stream
            self._last_id = -1
            self._last_time = -1
            self._result = None
            self._result_admitted_at = None
            self._pending = None
            self._generation += 1
        if frame["frameId"] <= self._last_id or frame["simulationTimeS"] < self._last_time:
            raise ValueError("Frame identity/time must increase monotonically within its stream")
        self._last_id = frame["frameId"]
        self._last_time = frame["simulationTimeS"]
        self._last_admitted_at = time.monotonic()
        self._status = "loading" if self._result is None else self._status
        self._error = None
        return frame, self._generation, self._last_admitted_at, self._runtime

    def submit(self, frame):
        admitted, _ = validate_frame(frame)
        with self._lock:
            self._pending = self._admit(admitted)
            self._wake.set()
        return {"accepted": True, "streamId": admitted["streamId"], "frameId": admitted["frameId"]}

    def _execute(self, pending):
        frame, generation, admitted_at, runtime = pending
        try:
            result = _validate_result(runtime.infer(frame), frame)
        except Exception as error:
            with self._lock:
                if generation == self._generation and runtime is self._runtime:
                    self._status = "error"
                    self._error = str(error)[:2000]
                    self._result = None
            raise
        with self._lock:
            if generation != self._generation or runtime is not self._runtime:
                raise _FrameError("Vision result was discarded after stream reset/close")
            if (time.monotonic() - admitted_at >= STALE_AFTER_S
                    or self._last_time - frame["simulationTimeS"] >= STALE_AFTER_S):
                self._status = "stale"
                self._error = "Camera frame expired during processing"
                self._result = None
                raise _FrameError(self._error)
            if self._result is None or result["frameId"] > self._result["frameId"]:
                self._result = copy.deepcopy(result)
                self._result_admitted_at = admitted_at
                self._status = "ready"
                self._error = None
        return result

    def process_frame(self, frame):
        admitted, _ = validate_frame(frame)
        with self._lock:
            pending = self._admit(admitted)
            self._pending = None
        return self._execute(pending)

    def _run(self):
        while not self._stop.is_set():
            self._wake.wait()
            self._wake.clear()
            if self._stop.is_set():
                return
            with self._lock:
                pending = self._pending
                self._pending = None
            if pending is None:
                continue
            try:
                self._execute(pending)
            except Exception:
                # The exact error is retained by _execute; a later valid frame
                # can recover a decoder error without fabricating clear road.
                pass

    def snapshot(self, stream_id=None):
        with self._lock:
            status, error, result = self._status, self._error, None
            available = self._model_ready
            if available and (self._runtime is None or not self._runtime.alive):
                self._status = status = "error"
                self._error = error = "Vision worker disconnected"
                self._model_ready = available = False
                self._result = None
            if status in ("disabled", "error"):
                return _envelope(status, False, self._model, error)
            if stream_id != self._stream:
                return _envelope("stale", False, self._model, "No observation for the requested stream")
            if self._result is not None:
                if (time.monotonic() - self._result_admitted_at >= STALE_AFTER_S
                        or self._last_time - self._result["simulationTimeS"] >= STALE_AFTER_S):
                    status, available, error = "stale", False, "Camera observation is older than 750ms"
                else:
                    result = self._result
            elif (self._last_admitted_at is not None
                  and time.monotonic() - self._last_admitted_at >= STALE_AFTER_S):
                status, available, error = "stale", False, "No fresh camera observation"
            if status == "stale":
                available = False
            return _envelope(status, available, self._model, error, result)

    def close(self):
        with self._lifecycle:
            with self._lock:
                self._stop.set()
                self._wake.set()
                runtime, thread = self._runtime, self._thread
                self._runtime = self._thread = None
                self._generation += 1
                self._pending = self._result = None
                self._stream = None
                self._retired.clear()
                self._last_id = self._last_time = -1
                self._last_admitted_at = self._result_admitted_at = None
                self._model = _model()
                self._model_ready = False
                self._status, self._error = "disabled", None
            if runtime is not None:
                runtime.close()
            if thread is not None and thread is not threading.current_thread():
                thread.join(timeout=RPC_TIMEOUT_S + CLOSE_TIMEOUT_S)
                if thread.is_alive():
                    with self._lock:
                        self._status = "error"
                        self._error = "Owned vision thread did not stop"
