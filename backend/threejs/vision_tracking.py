"""Owned YOLOX-Tiny worker; importing this module does not import CV packages.

This detector is deliberately stateless between images. Temporal association
belongs to the observed-box predictor, not actor geometry or synthetic boxes.
Each image uses its full view and one fixed central half-width/half-height
view (320x180 at 640x360). The crop never follows objects or scenario state.
"""

import hashlib
import json
import sys
import time

from .vision import (
    MAX_BASE64_CHARS, MAX_STREAMS, MODEL_PATH, MODEL_SHA256, MODEL_PROVIDER,
    _keys, _model, _number, validate_frame,
)


def focus_region(width, height):
    crop_width, crop_height = max(32, width // 2), max(32, height // 2)
    if (crop_width, crop_height) == (width, height):
        return None
    return (width - crop_width) // 2, (height - crop_height) // 2, crop_width, crop_height


def _box_iou(a, b):
    intersection = max(0, min(a[2], b[2]) - max(a[0], b[0])) * max(0, min(a[3], b[3]) - max(a[1], b[1]))
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - intersection
    return intersection / union if union > 0 else 0


def merge_view_detections(views, width, height):
    """Map real decoded view boxes to full pixels and suppress semantic duplicates."""
    candidates = []
    for findings, (offset_x, offset_y) in views:
        for finding in findings:
            class_id = finding["classId"]
            if class_id not in (0, 1, 2, 3, 5, 7):
                continue
            box = finding["box"]
            mapped = [
                round(max(0, min(width, box[0] + offset_x)), 1),
                round(max(0, min(height, box[1] + offset_y)), 1),
                round(max(0, min(width, box[2] + offset_x)), 1),
                round(max(0, min(height, box[3] + offset_y)), 1),
            ]
            if mapped[2] <= mapped[0] or mapped[3] <= mapped[1]:
                continue
            candidates.append({
                "box": mapped, "label": "person" if class_id == 0 else "vehicle",
                "confidence": finding["confidence"],
            })
    kept = []
    for finding in sorted(candidates, key=lambda value: value["confidence"], reverse=True):
        if not any(other["label"] == finding["label"] and _box_iou(other["box"], finding["box"]) > 0.45
                   for other in kept):
            kept.append(finding)
    return kept[:30]


class PixelDetector:
    """Load only the existing pinned detector and actually exercise its tensors."""

    def __init__(self):
        if not MODEL_PATH.is_file():
            raise RuntimeError(f"Pinned YOLOX-Tiny weights are missing: {MODEL_PATH}")
        digest = hashlib.sha256(MODEL_PATH.read_bytes()).hexdigest()
        if digest != MODEL_SHA256:
            raise RuntimeError("Existing YOLOX-Tiny weights do not match the selected SHA-256")
        from . import detector

        self.detector = detector
        detector.cv2.setNumThreads(1)
        options = detector.ort.SessionOptions()
        options.intra_op_num_threads = 2
        options.inter_op_num_threads = 1
        options.execution_mode = detector.ort.ExecutionMode.ORT_SEQUENTIAL
        options.log_severity_level = 3
        self.session = detector.ort.InferenceSession(
            str(MODEL_PATH), options, providers=[MODEL_PROVIDER],
        )
        inputs, outputs = self.session.get_inputs(), self.session.get_outputs()
        if (len(inputs) != 1 or inputs[0].shape != [1, 3, 416, 416]
                or inputs[0].type != "tensor(float)" or len(outputs) != 1
                or outputs[0].shape != [1, 3549, 85]
                or outputs[0].type != "tensor(float)"):
            raise RuntimeError("Pinned YOLOX model has unexpected input/output tensors")
        if self.session.get_providers() != [MODEL_PROVIDER]:
            raise RuntimeError("Selected CPU execution provider was not activated")
        self.input_name = inputs[0].name
        warmup = detector.np.full((1, 3, 416, 416), 114, dtype=detector.np.float32)
        output = self.session.run(None, {self.input_name: warmup})[0]
        if output.shape != (1, 3549, 85) or not detector.np.isfinite(output).all():
            raise RuntimeError("YOLOX tensor readiness inference failed")
        self.model = _model(digest)
        self.stream = None
        self.retired = set()
        self.last_id = -1
        self.last_time = -1

    def ready(self):
        return {
            "type": "ready", "model": self.model, "threads": 2,
            "inputShape": [1, 3, 416, 416], "outputShape": [1, 3549, 85],
        }

    def _infer_view(self, tensor, ratio, width, height):
        output = self.session.run(None, {self.input_name: tensor})[0]
        if not self.detector.np.isfinite(output).all():
            raise RuntimeError("YOLOX produced nonfinite detector output")
        return self.detector.decode(output, ratio, width, height)

    def _focus_tensor(self, jpeg, width, height, region):
        d = self.detector
        image = d.cv2.imdecode(d.np.frombuffer(jpeg, dtype=d.np.uint8), d.cv2.IMREAD_COLOR)
        if image is None or image.shape[:2] != (height, width):
            raise ValueError("Focus view did not decode the admitted RGB image")
        x, y, crop_width, crop_height = region
        crop = image[y:y + crop_height, x:x + crop_width]
        ratio = min(416 / crop_height, 416 / crop_width)
        scaled = d.cv2.resize(crop, (round(crop_width * ratio), round(crop_height * ratio)))
        canvas = d.np.full((416, 416, 3), 114, dtype=d.np.uint8)
        canvas[:scaled.shape[0], :scaled.shape[1]] = scaled
        return d.np.ascontiguousarray(canvas.transpose(2, 0, 1), dtype=d.np.float32)[None], ratio

    def process(self, frame):
        started = time.perf_counter()
        admitted, jpeg = validate_frame(frame)
        stream = admitted["streamId"]
        if stream in self.retired:
            raise ValueError("Worker rejected a retired stream")
        if stream != self.stream:
            if len(self.retired) >= MAX_STREAMS - 1:
                raise ValueError("Worker stream limit reached")
            if self.stream is not None:
                self.retired.add(self.stream)
            self.stream = stream
            self.last_id = self.last_time = -1
        if admitted["frameId"] <= self.last_id or admitted["simulationTimeS"] < self.last_time:
            raise ValueError("Worker rejected nonmonotonic frame identity/time")
        self.last_id, self.last_time = admitted["frameId"], admitted["simulationTimeS"]
        tensor, ratio, width, height = self.detector.preprocess(jpeg)
        if (width, height) != (admitted["camera"]["width"], admitted["camera"]["height"]):
            raise ValueError("Decoded JPEG dimensions disagree with camera metadata")
        views = [(self._infer_view(tensor, ratio, width, height), (0, 0))]
        region = focus_region(width, height)
        if region is not None:
            tensor, ratio = self._focus_tensor(jpeg, width, height, region)
            x, y, crop_width, crop_height = region
            views.append((self._infer_view(tensor, ratio, crop_width, crop_height), (x, y)))
        detections = merge_view_detections(views, width, height)
        return {
            "streamId": admitted["streamId"], "frameId": admitted["frameId"],
            "simulationTimeS": admitted["simulationTimeS"],
            "camera": admitted["camera"], "ego": admitted["ego"],
            "width": width, "height": height,
            "latencyMs": round((time.perf_counter() - started) * 1000, 3),
            "model": self.model, "detections": detections, "status": "ready",
        }


def _reject_constant(value):
    raise ValueError(f"Nonfinite JSON number: {value}")


def _strict_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"Duplicate JSON field: {key}")
        result[key] = value
    return result


def _send(message):
    sys.stdout.write(json.dumps(message, allow_nan=False, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def run_worker():
    try:
        detector = PixelDetector()
        _send(detector.ready())
    except Exception as error:
        message = f"{type(error).__name__}: {error}"[:2000]
        _send({"type": "error", "error": message})
        print(message, file=sys.stderr, flush=True)
        return 1
    while True:
        line = sys.stdin.readline(MAX_BASE64_CHARS + 16_384)
        if not line:
            return 0
        request_id = None
        try:
            if not line.endswith("\n"):
                raise ValueError("Worker request exceeds the bounded protocol")
            request = json.loads(line, parse_constant=_reject_constant, object_pairs_hook=_strict_object)
            _keys(request, {"type", "requestId", "frame"}, "worker request")
            request_id = _number(request["requestId"], "requestId", 1, 2 ** 53 - 1, integer=True)
            if request["type"] != "frame":
                raise ValueError("Unsupported worker request")
            result = detector.process(request["frame"])
            _send({"type": "result", "requestId": request_id, "result": result})
        except Exception as error:
            message = f"{type(error).__name__}: {error}"[:2000]
            _send({"type": "error", "requestId": request_id, "error": message})
            print(message, file=sys.stderr, flush=True)


if __name__ == "__main__":
    if sys.argv[1:] != ["--worker"]:
        print("Use --worker for the owned local pixel-detector subprocess.", file=sys.stderr)
        raise SystemExit(2)
    raise SystemExit(run_worker())
