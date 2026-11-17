"""Offline admission/lifecycle tests; injected runtimes are not neural proof."""

import base64
import copy
import json
from pathlib import Path
import subprocess
import sys
import threading
import time
import types
import unittest
from unittest.mock import patch

from backend.threejs import vision
from backend.threejs.vision_tracking import focus_region, merge_view_detections


JPEG_BASE64 = (
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsj"
    "HBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgo"
    "KCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAAgACADASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAA"
    "AAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAk"
    "M2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKT"
    "lJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QA"
    "HwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdh"
    "cRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hp"
    "anN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk"
    "5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDMooooAKKKKACiiigAooooA//Z"
)


def frame(frame_id=0, simulation_time=0, stream="unit-stream"):
    return {
        "schema": 1, "streamId": stream, "frameId": frame_id,
        "simulationTimeS": simulation_time, "imageJpegBase64": JPEG_BASE64,
        "camera": {
            "width": 32, "height": 32, "fovYDeg": 76,
            "position": {"x": 0, "y": 1.3, "z": 2.1},
            "headingRad": 0, "groundY": 0.12,
        },
        "ego": {"x": 0, "z": 0, "headingRad": 0, "speedMps": 4,
                "lengthM": 4.2, "widthM": 1.85},
    }


def unit_result(observation):
    result = {key: copy.deepcopy(observation[key]) for key in
              ("streamId", "frameId", "simulationTimeS", "camera", "ego")}
    result.update({
        "width": 32, "height": 32, "latencyMs": 1,
        "model": vision._model(vision.MODEL_SHA256), "detections": [], "status": "ready",
    })
    return result


class UnitRuntime:
    """Explicit test double for orchestration, not a detector substitute."""

    def __init__(self):
        self.alive = True
        self.entered = threading.Event()
        self.release = threading.Event()
        self.release.set()
        self.frames = []
        self.transform = lambda value: value
        self.starts = 0

    def start(self):
        self.starts += 1
        return vision._model(vision.MODEL_SHA256)

    def infer(self, observation):
        self.frames.append(copy.deepcopy(observation))
        self.entered.set()
        if not self.release.wait(timeout=2):
            raise RuntimeError("Unit runtime deliberately blocked")
        if not self.alive:
            raise RuntimeError("Unit runtime closed")
        return self.transform(unit_result(observation))

    def close(self):
        self.alive = False
        self.release.set()


class FocusViewGeometryTests(unittest.TestCase):
    def test_fixed_focus_uses_only_camera_dimensions_and_maps_local_pixel_boxes(self):
        region = focus_region(640, 360)
        self.assertEqual(region, (160, 90, 320, 180))
        local = {"classId": 0, "box": [20.5, 30, 40.5, 90], "confidence": .72,
                 "label": "person", "labelAr": "شخص"}
        observed = merge_view_detections([([local], region[:2])], 640, 360)
        self.assertEqual(observed, [{
            "box": [180.5, 120, 200.5, 180], "label": "person", "confidence": .72,
        }])
        self.assertEqual(focus_region(641, 361), (160, 90, 320, 180))
        self.assertIsNone(focus_region(32, 32))

    def test_overlapping_views_keep_one_actual_highest_score_per_semantic_label(self):
        full = [
            {"classId": 0, "box": [355, 170, 380, 210], "confidence": .4},
            {"classId": 0, "box": [100, 100, 120, 140], "confidence": .5},
            {"classId": 2, "box": [355, 170, 380, 210], "confidence": .8},
        ]
        focused = [
            {"classId": 0, "box": [196, 80, 221, 120], "confidence": .7},
            {"classId": 7, "box": [195, 80, 220, 120], "confidence": .6},
        ]
        observed = merge_view_detections([(full, (0, 0)), (focused, (160, 90))], 640, 360)
        self.assertEqual(observed, [
            {"box": [355, 170, 380, 210], "label": "vehicle", "confidence": .8},
            {"box": [356, 170, 381, 210], "label": "person", "confidence": .7},
            {"box": [100, 100, 120, 140], "label": "person", "confidence": .5},
        ])

    def test_clipping_and_unsupported_classes_cannot_create_extra_semantic_findings(self):
        findings = [
            {"classId": 0, "box": [-5, -4, 20, 40], "confidence": .6},
            {"classId": 16, "box": [5, 5, 30, 40], "confidence": .9},
            {"classId": 0, "box": [700, 10, 710, 20], "confidence": .8},
        ]
        self.assertEqual(merge_view_detections([(findings, (0, 0))], 640, 360), [
            {"box": [0, 0, 20, 40], "label": "person", "confidence": .6},
        ])


class PixelAdmissionTests(unittest.TestCase):
    def test_actual_rgb_jpeg_header_and_metadata_are_copied(self):
        original = frame()
        admitted, pixels = vision.validate_frame(original)
        self.assertEqual(pixels[:2], b"\xff\xd8")
        self.assertEqual(vision._jpeg_dimensions(pixels), (32, 32))
        original["camera"]["position"]["x"] = 20
        self.assertEqual(admitted["camera"]["position"]["x"], 0)
        without_schema = frame()
        del without_schema["schema"]
        self.assertEqual(vision.validate_frame(without_schema)[0]["frameId"], 0)

    def test_unknown_truth_keys_are_rejected_at_every_metadata_level(self):
        for path, key in (
            ((), "actors"), ((), "scenarioId"), ((), "futurePath"),
            (("camera",), "world"), (("camera",), "pitchRad"),
            (("camera", "position"), "actorId"), (("ego",), "intent"),
            (("ego",), "sensorHits"),
        ):
            with self.subTest(path=path, key=key):
                observation = frame()
                target = observation
                for part in path:
                    target = target[part]
                target[key] = {"truth": True}
                with self.assertRaisesRegex(ValueError, "unknown/missing"):
                    vision.VisionService().submit(observation)

    def test_nonfinite_boolean_negative_and_unbounded_metadata_are_rejected(self):
        for path, value in (
            (("schema",), True), (("frameId",), True), (("frameId",), 1.0),
            (("frameId",), -1), (("frameId",), 2 ** 53),
            (("simulationTimeS",), float("nan")), (("simulationTimeS",), -0.1),
            (("simulationTimeS",), True), (("camera", "width"), True),
            (("camera", "height"), 1081), (("camera", "fovYDeg"), float("inf")),
            (("camera", "position", "x"), False), (("ego", "speedMps"), True),
            (("ego", "lengthM"), 0), (("streamId",), ""), (("streamId",), "x" * 81),
        ):
            with self.subTest(path=path, value=value):
                observation = frame()
                target = observation
                for part in path[:-1]:
                    target = target[part]
                target[path[-1]] = value
                with self.assertRaises(ValueError):
                    vision.validate_frame(observation)

    def test_bad_non_rgb_oversize_and_mismatched_images_are_rejected(self):
        pixels = base64.b64decode(JPEG_BASE64)
        for encoded in (
            "not base64", JPEG_BASE64 + "\n", base64.b64encode(b"\x89PNG\r\n").decode(),
            base64.b64encode(pixels[:-2]).decode(), "a" * (vision.MAX_BASE64_CHARS + 1),
            base64.b64encode(pixels.replace(b"\xff\xc0\x00\x11\x08", b"\xff\xc0\x00\x11\x0c")).decode(),
        ):
            with self.subTest(encoded=encoded[:30]):
                observation = frame()
                observation["imageJpegBase64"] = encoded
                with self.assertRaises(ValueError):
                    vision.validate_frame(observation)
        observation = frame()
        observation["camera"]["width"] = 64
        with self.assertRaisesRegex(ValueError, "dimensions"):
            vision.validate_frame(observation)


class VisionServiceUnitTests(unittest.TestCase):
    def setUp(self):
        self.runtime = UnitRuntime()
        self.factory = patch.object(vision, "_WorkerProcess", return_value=self.runtime)
        self.factory.start()
        self.addCleanup(self.factory.stop)
        self.service = vision.VisionService()
        self.addCleanup(self.service.close)
        self.assertTrue(self.service.start()["available"])

    def wait_for_frame(self, stream, frame_id):
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            observed = self.service.snapshot(stream)
            if observed["result"] is not None and observed["result"]["frameId"] == frame_id:
                return observed
            time.sleep(0.002)
        self.fail(f"No unit frame {frame_id}: {self.service.snapshot(stream)}")

    def test_sync_boundary_returns_exact_provenance_and_rejects_repeated_time_identity(self):
        first = self.service.process_frame(frame(3, 0.4))
        self.assertEqual(first["frameId"], 3)
        self.assertEqual(first["ego"], frame()["ego"])
        for observation in (frame(3, 0.5), frame(2, 0.6), frame(4, 0.3)):
            with self.subTest(observation=observation["frameId"]), self.assertRaises(ValueError):
                self.service.submit(observation)
        self.assertEqual(self.service.process_frame(frame(5, 0.5))["frameId"], 5)

    def test_latest_slot_replaces_work_and_never_uses_mutated_admitted_metadata(self):
        self.runtime.release.clear()
        self.service.submit(frame(1, 0.1))
        self.assertTrue(self.runtime.entered.wait(timeout=1))
        self.service.submit(frame(2, 0.2))
        newest = frame(3, 0.3)
        self.assertEqual(self.service.submit(newest)["frameId"], 3)
        newest["ego"]["x"] = 800
        self.runtime.release.set()
        observed = self.wait_for_frame("unit-stream", 3)
        self.assertEqual([item["frameId"] for item in self.runtime.frames], [1, 3])
        self.assertEqual(observed["result"]["ego"]["x"], 0)

    def test_new_stream_discards_inflight_result_and_retired_stream_cannot_return(self):
        self.runtime.release.clear()
        self.service.submit(frame(50, 5))
        self.assertTrue(self.runtime.entered.wait(timeout=1))
        self.service.submit(frame(0, 0, "new-stream"))
        self.assertIsNone(self.service.snapshot("unit-stream")["result"])
        self.assertIsNone(self.service.snapshot("new-stream")["result"])
        self.runtime.release.set()
        self.wait_for_frame("new-stream", 0)
        self.assertIsNone(self.service.snapshot("unit-stream")["result"])
        with self.assertRaisesRegex(ValueError, "Retired"):
            self.service.submit(frame(51, 5.1))

    def test_expired_result_and_slow_inference_are_explicitly_unavailable(self):
        clock = [10.0]
        with patch.object(vision, "time", types.SimpleNamespace(monotonic=lambda: clock[0])):
            self.service.process_frame(frame())
            clock[0] = 10.75
            expired = self.service.snapshot("unit-stream")
            self.assertEqual(expired["status"], "stale")
            self.assertFalse(expired["available"])
            self.assertIsNone(expired["result"])
            self.runtime.transform = lambda result: (clock.__setitem__(0, 11.6) or result)
            clock[0] = 10.8
            with self.assertRaisesRegex(RuntimeError, "expired"):
                self.service.process_frame(frame(1, 0.1))
            self.assertEqual(self.service.snapshot("unit-stream")["status"], "stale")

    def test_bad_worker_data_cannot_inherit_a_good_result_and_valid_input_recovers(self):
        self.service.process_frame(frame())
        for field, value in (("future", []), ("latencyMs", float("nan")), ("frameId", True)):
            with self.subTest(field=field):
                self.runtime.transform = lambda result: dict(result, **{field: value})
                current = self.service._last_id + 1
                with self.assertRaises((ValueError, RuntimeError)):
                    self.service.process_frame(frame(current, current / 10))
                snapshot = self.service.snapshot("unit-stream")
                self.assertEqual(snapshot["status"], "error")
                self.assertFalse(snapshot["available"])
                self.assertIsNone(snapshot["result"])
        self.runtime.transform = lambda result: result
        self.assertEqual(self.service.process_frame(frame(4, 0.4))["frameId"], 4)
        self.assertTrue(self.service.snapshot("unit-stream")["available"])

    def test_disconnection_close_and_repeated_start_do_not_leave_resources(self):
        self.assertTrue(self.service.start()["available"])
        self.assertEqual(self.runtime.starts, 1)
        self.service.process_frame(frame())
        self.runtime.alive = False
        self.assertEqual(self.service.snapshot("unit-stream")["status"], "error")
        self.assertIsNone(self.service.snapshot("unit-stream")["result"])
        thread = self.service._thread
        self.service.close()
        self.service.close()
        self.assertFalse(thread.is_alive())
        self.assertEqual(self.service.snapshot("unit-stream")["status"], "disabled")
        with self.assertRaises(RuntimeError):
            self.service.submit(frame())

    def test_closing_while_work_is_inflight_prevents_late_publication(self):
        self.runtime.release.clear()
        self.service.submit(frame())
        self.assertTrue(self.runtime.entered.wait(timeout=1))
        thread = self.service._thread
        self.service.close()
        self.assertFalse(thread.is_alive())
        self.assertFalse(self.runtime.alive)
        self.assertIsNone(self.service.snapshot("unit-stream")["result"])
        self.assertEqual(self.service.snapshot("unit-stream")["status"], "disabled")


class StandardLibraryAndTransportTests(unittest.TestCase):
    def test_default_import_is_stdlib_only_and_never_starts_a_process(self):
        script = (
            "import json,sys; from unittest.mock import patch; "
            "from backend.threejs.vision import VisionService,capabilities; "
            "import backend.threejs.vision_tracking; "
            "s=VisionService(); "
            "print(json.dumps({'status':s.snapshot('x')['status'],"
            "'heavy':[n for n in ('cv2','numpy','onnxruntime') if n in sys.modules]}))"
        )
        observed = subprocess.run(
            [sys.executable, "-S", "-B", "-c", script], cwd=vision.ROOT,
            text=True, capture_output=True, timeout=10, check=True,
        )
        self.assertEqual(json.loads(observed.stdout), {"status": "disabled", "heavy": []})
        self.assertEqual(observed.stderr, "")

    def test_absent_runtime_is_an_error_not_an_empty_ready_detection(self):
        service = vision.VisionService()
        self.addCleanup(service.close)
        with patch.object(vision, "WORKER_PYTHON", vision.ROOT / "not-installed-python.exe"):
            with patch.object(vision.subprocess, "Popen") as popen:
                observed = service.start()
                popen.assert_not_called()
        self.assertEqual(observed["status"], "error")
        self.assertFalse(observed["available"])
        self.assertIn("interpreter is missing", observed["error"])
        self.assertIsNone(observed["result"])

    def protocol_runtime(self, script):
        # These are actual stdlib child processes, explicitly not model checks.
        command = [sys.executable, "-S", "-B", "-u", "-c", script]
        patches = (
            patch.object(vision, "WORKER_PYTHON", Path(sys.executable)),
            patch.object(vision, "MODEL_PATH", Path(__file__)),
            patch.object(vision, "_worker_command", return_value=command),
            patch.object(vision, "STARTUP_TIMEOUT_S", 0.2),
            patch.object(vision, "RPC_TIMEOUT_S", 0.1),
        )
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        runtime = vision._WorkerProcess()
        self.addCleanup(runtime.close)
        return runtime

    def test_startup_timeout_kills_and_joins_the_owned_protocol_process(self):
        runtime = self.protocol_runtime("import time; time.sleep(20)")
        with self.assertRaisesRegex(RuntimeError, "startup timed out"):
            runtime.start()
        self.assertIsNotNone(runtime.process.poll())
        self.assertTrue(all(not thread.is_alive() for thread in runtime.threads))

    def test_rpc_timeout_and_wrong_tensor_readiness_cannot_report_success(self):
        ready = {
            "type": "ready", "model": vision._model(vision.MODEL_SHA256), "threads": 2,
            "inputShape": [1, 3, 416, 416], "outputShape": [1, 3549, 85],
        }
        script = f"import time; print({json.dumps(ready)!r}, flush=True); time.sleep(20)"
        runtime = self.protocol_runtime(script)
        runtime.start()
        with self.assertRaisesRegex(RuntimeError, "inference timed out"):
            runtime.infer(frame())
        self.assertIsNotNone(runtime.process.poll())
        self.assertTrue(all(not thread.is_alive() for thread in runtime.threads))
        ready["inputShape"] = [1, 3, 640, 640]
        script = f"import time; print({json.dumps(ready)!r}, flush=True); time.sleep(20)"
        with patch.object(vision, "_worker_command",
                          return_value=[sys.executable, "-S", "-B", "-u", "-c", script]):
            wrong = vision._WorkerProcess()
            self.addCleanup(wrong.close)
            with self.assertRaisesRegex(RuntimeError, "tensors"):
                wrong.start()
            self.assertIsNotNone(wrong.process.poll())


if __name__ == "__main__":
    unittest.main()
