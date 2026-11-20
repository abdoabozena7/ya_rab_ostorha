"""Pixel-only YOLOX-Tiny perception for the simulator's JPEG camera frames.

Pre/post-processing follows the official YOLOX ONNXRuntime demo. Actor state is
never accepted here; it is ground truth for later evaluation, not model input.
"""

from pathlib import Path
import threading
import time

import cv2
import numpy as np
import onnxruntime as ort


ROOT = Path(__file__).resolve().parents[2]
MODEL = ROOT / ".cache" / "models" / "cv" / "yolox_tiny.onnx"
INPUT_SIZE = 416
STRIDES = (8, 16, 32)
SCORE_THRESHOLD = 0.32
NMS_THRESHOLD = 0.45
MAX_RESULTS = 30
LABELS = {
    0: ("person", "شخص"),
    1: ("bicycle", "عجلة"),
    2: ("car", "عربية"),
    3: ("motorcycle", "موتوسيكل"),
    5: ("bus", "أتوبيس"),
    7: ("truck", "نقل"),
}


def decode_image(jpeg):
    image = cv2.imdecode(np.frombuffer(jpeg, dtype=np.uint8), cv2.IMREAD_COLOR)
    if image is None:
        raise ValueError("Frame is not a decodable JPEG")
    height, width = image.shape[:2]
    if width < 32 or height < 32 or width > 1920 or height > 1080:
        raise ValueError("Unsupported camera frame dimensions")
    return image


def image_tensor(image):
    height, width = image.shape[:2]
    ratio = min(INPUT_SIZE / height, INPUT_SIZE / width)
    scaled = cv2.resize(image, (round(width * ratio), round(height * ratio)))
    canvas = np.full((INPUT_SIZE, INPUT_SIZE, 3), 114, dtype=np.uint8)
    canvas[: scaled.shape[0], : scaled.shape[1]] = scaled
    tensor = np.ascontiguousarray(canvas.transpose(2, 0, 1), dtype=np.float32)[None]
    return tensor, ratio, width, height


def preprocess(jpeg):
    return image_tensor(decode_image(jpeg))


def _head_grid():
    grids = []
    strides = []
    for stride in STRIDES:
        count = INPUT_SIZE // stride
        yy, xx = np.meshgrid(np.arange(count), np.arange(count), indexing="ij")
        grids.append(np.stack((xx, yy), axis=-1).reshape(-1, 2))
        strides.append(np.full((count * count, 1), stride))
    return np.concatenate(grids), np.concatenate(strides)


_GRID, _STRIDE = _head_grid()


def decode(output, ratio, width, height):
    """Decode the raw [1, 3549, 85] YOLOX heads and apply classwise NMS."""
    if output.shape != (1, 3549, 85):
        raise ValueError(f"Unexpected YOLOX output shape: {output.shape}")
    prediction = output[0].copy()
    prediction[:, :2] = (prediction[:, :2] + _GRID) * _STRIDE
    prediction[:, 2:4] = np.exp(np.clip(prediction[:, 2:4], -20, 20)) * _STRIDE

    results = []
    for class_id, (label, label_ar) in LABELS.items():
        scores = prediction[:, 4] * prediction[:, 5 + class_id]
        candidates = np.flatnonzero(scores >= SCORE_THRESHOLD)
        if not len(candidates):
            continue
        boxes = prediction[candidates, :4]
        x1 = (boxes[:, 0] - boxes[:, 2] / 2) / ratio
        y1 = (boxes[:, 1] - boxes[:, 3] / 2) / ratio
        x2 = (boxes[:, 0] + boxes[:, 2] / 2) / ratio
        y2 = (boxes[:, 1] + boxes[:, 3] / 2) / ratio
        x1 = np.clip(x1, 0, width)
        y1 = np.clip(y1, 0, height)
        x2 = np.clip(x2, 0, width)
        y2 = np.clip(y2, 0, height)
        valid = (x2 - x1 >= 2) & (y2 - y1 >= 2)
        candidates = candidates[valid]
        if not len(candidates):
            continue
        xywh = np.stack((x1[valid], y1[valid], x2[valid] - x1[valid], y2[valid] - y1[valid]), axis=1)
        keep = cv2.dnn.NMSBoxes(xywh.tolist(), scores[candidates].tolist(), SCORE_THRESHOLD, NMS_THRESHOLD)
        for index in np.asarray(keep).reshape(-1):
            box = xywh[index]
            results.append({
                "classId": class_id,
                "label": label,
                "labelAr": label_ar,
                "confidence": round(float(scores[candidates[index]]), 3),
                "box": [round(float(value), 1) for value in (box[0], box[1], box[0] + box[2], box[1] + box[3])],
            })
    results.sort(key=lambda detection: detection["confidence"], reverse=True)
    return results[:MAX_RESULTS]


class PerceptionWorker:
    """Single latest-frame worker: a slow detector cannot queue old video."""

    def __init__(self):
        self.lock = threading.Lock()
        self.wake = threading.Event()
        self.pending = None
        self.result = None
        self.error = None
        self.started = False
        self.session = None

    def submit(self, jpeg, frame_id):
        if not MODEL.is_file():
            return False
        with self.lock:
            self.pending = (jpeg, frame_id)
            if not self.started:
                threading.Thread(target=self._run, name="pixel-perception", daemon=True).start()
                self.started = True
        self.wake.set()
        return True

    def snapshot(self):
        with self.lock:
            return {
                "schemaVersion": 1,
                "source": "camera-pixels",
                "available": MODEL.is_file(),
                "model": "YOLOX-Tiny / COCO",
                "status": "error" if self.error else "ready" if self.result else "waiting",
                "error": self.error,
                "result": self.result,
            }

    def _run(self):
        while True:
            self.wake.wait()
            self.wake.clear()
            with self.lock:
                pending = self.pending
                self.pending = None
            if not pending:
                continue
            jpeg, frame_id = pending
            try:
                if self.session is None:
                    options = ort.SessionOptions()
                    options.intra_op_num_threads = 2
                    self.session = ort.InferenceSession(str(MODEL), options, providers=["CPUExecutionProvider"])
                started = time.perf_counter()
                tensor, ratio, width, height = preprocess(jpeg)
                output = self.session.run(None, {self.session.get_inputs()[0].name: tensor})[0]
                detections = decode(output, ratio, width, height)
                result = {
                    "frameId": frame_id,
                    "width": width,
                    "height": height,
                    "latencyMs": round((time.perf_counter() - started) * 1000, 1),
                    "detections": detections,
                }
                with self.lock:
                    self.result = result
                    self.error = None
            except Exception as error:
                # A camera/model error must not silently kill the only worker.
                with self.lock:
                    self.error = str(error)


PERCEPTION = PerceptionWorker()
