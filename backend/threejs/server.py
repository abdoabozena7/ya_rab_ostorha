"""Serve the standalone Three.js game and its local observation API."""

import argparse
import base64
import json
import threading
import time
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit
from .nlp import health as nlp_health, interpret, ModelUnavailable
from .training import TRAINING


ROOT = Path(__file__).resolve().parents[2]
MAX_JSON = 16_384
MAX_FRAME = 400_000
PERCEPTION = None
VISION = None


class Store:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = {"connected": False, "speedKmh": 0, "fuel": 100, "mode": "manual"}
        self.state_at = 0.0
        self.frame = b""
        self.frame_id = 0
        self.vision_frame = b""
        self.vision_metadata = None


STORE = Store()


class Server(ThreadingHTTPServer):
    # Asset loading, telemetry and camera polling can connect in the same frame.
    request_queue_size = 32


class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        # Source files are edited in place in this development server. Revalidate
        # modules on reload so an old import cannot run against newer HTML.
        path = urlsplit(self.path).path
        if path == "/" or Path(path).suffix in {".js", ".css", ".html"}:
            self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, status, value):
        body = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        if status >= 400:
            self.send_header("Connection", "close")
            self.close_connection = True
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _static_allowed(self):
        path = unquote(urlsplit(self.path).path).replace("\\", "/")
        parts = path.strip("/").split("/")
        if any(part.startswith(".") or ":" in part or "\0" in part for part in parts):
            return False
        allowed = path in {
            "/", "/index.html", "/assets/LICENSES.md",
            "/assets/source/rocketbox/LICENSE.md",
            "/assets/source/car-concept/LICENSE.md",
            "/output/policy-lab.json", "/output/policy-lab-evaluation.json",
        } or path.startswith((
            "/src/", "/public/", "/assets/models/",
            "/assets/lighting/", "/assets/textures/",
        ))
        target = (ROOT / ("index.html" if path == "/" else path.lstrip("/"))).resolve()
        return allowed and target.is_relative_to(ROOT) and not target.is_dir()

    def do_HEAD(self):
        if not self._static_allowed():
            return self._json(404, {"error": "Not found"})
        return super().do_HEAD()

    def _read_json(self, maximum=MAX_JSON):
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size <= maximum:
            raise ValueError("Invalid JSON size")
        return json.loads(self.rfile.read(size))

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path == "/api/health":
            return self._json(200, {
                "ok": True, "service": "ya-rab-ostorha-threejs",
                "mode": "threejs", "externalSimulator": False,
            })
        if path == "/api/nlp/health":
            return self._json(200, nlp_health())
        if path == "/api/training":
            return self._json(200, TRAINING.snapshot())
        if path == "/api/vision/capabilities":
            from .vision import capabilities
            return self._json(200, capabilities())
        if path == "/api/vision/state":
            stream = parse_qs(urlsplit(self.path).query).get("streamId", [""])[0]
            return self._json(200, VISION.snapshot(stream) if VISION else {
                "schemaVersion": 1, "source": "camera-pixels", "available": False,
                "status": "disabled", "error": None, "result": None,
            })
        if path == "/api/vision/frame":
            with STORE.lock:
                frame = STORE.vision_frame
                metadata = STORE.vision_metadata
            if not frame:
                return self._json(404, {"error": "No admitted front vision frame yet"})
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(frame)))
            self.send_header("X-Frame-Id", str(metadata["frameId"]))
            self.end_headers()
            return self.wfile.write(frame)
        if path == "/api/detections":
            result = PERCEPTION.snapshot() if PERCEPTION else {
                "schemaVersion": 1, "source": "camera-pixels", "available": False,
                "status": "disabled", "result": None,
                "error": "Optional camera detection is disabled. Start with --perception after installing its dependencies and model.",
            }
            with STORE.lock:
                result["latestFrameId"] = STORE.frame_id
            return self._json(200, result)
        if path == "/api/state":
            with STORE.lock:
                state = STORE.state.copy()
                state["connected"] = state["connected"] and time.monotonic() - STORE.state_at < 2
            return self._json(200, state)
        if path == "/api/frame":
            with STORE.lock:
                frame = STORE.frame
                frame_id = STORE.frame_id
            if not frame:
                return self._json(404, {"error": "No camera frame yet"})
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("X-Frame-Id", str(frame_id))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(frame)))
            self.end_headers()
            return self.wfile.write(frame)
        if path.startswith("/api/") or not self._static_allowed():
            return self._json(404, {"error": "Not found"})
        return super().do_GET()

    def do_POST(self):
        global VISION
        path = urlsplit(self.path).path
        if path not in {
            "/api/training/start", "/api/training/stop",
            "/api/frame", "/api/intent", "/api/state",
            "/api/vision/start", "/api/vision/stop", "/api/vision/frame",
        }:
            return self._json(404, {"error": "Unknown API endpoint"})
        try:
            if path in {"/api/vision/start", "/api/vision/stop",
                        "/api/training/start", "/api/training/stop"}:
                if int(self.headers.get("Content-Length", "0")):
                    self._read_json()
            if path == "/api/vision/start":
                if VISION is None:
                    from .vision import VisionService
                    VISION = VisionService()
                result = VISION.start()
                if not isinstance(result, dict):
                    raise RuntimeError("Vision startup returned an invalid status")
                return self._json(200 if result.get("available") else 503, result)
            if path == "/api/vision/stop":
                if VISION is not None:
                    VISION.close()
                    VISION = None
                return self._json(200, {
                    "available": False, "status": "disabled", "source": "camera-pixels",
                    "error": None, "result": None,
                })
            if path == "/api/vision/frame":
                if VISION is None:
                    return self._json(503, {"error": "Start local camera perception before submitting frames."})
                data = self._read_json(900_000)
                result = VISION.submit(data)
                encoded = data["imageJpegBase64"]
                with STORE.lock:
                    STORE.vision_frame = base64.b64decode(encoded, validate=True)
                    STORE.vision_metadata = {key: value for key, value in data.items()
                                             if key != "imageJpegBase64"}
                return self._json(202, result)
            if path == "/api/training/start":
                started = TRAINING.start()
                return self._json(202 if started else 409, TRAINING.snapshot())
            if path == "/api/training/stop":
                stopped = TRAINING.stop()
                return self._json(200 if stopped else 409, TRAINING.snapshot())
            if path == "/api/frame":
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= MAX_FRAME or self.headers.get("Content-Type") != "image/jpeg":
                    raise ValueError("Expected a JPEG frame under 400 KB")
                frame = self.rfile.read(size)
                if not frame.startswith(b"\xff\xd8"):
                    raise ValueError("Invalid JPEG frame")
                with STORE.lock:
                    STORE.frame = frame
                    STORE.frame_id += 1
                    frame_id = STORE.frame_id
                if PERCEPTION:
                    PERCEPTION.submit(frame, frame_id)
                return self._json(200, {"ok": True, "frameId": frame_id})

            data = self._read_json()
            if not isinstance(data, dict):
                raise ValueError("Expected JSON object")
            if path == "/api/intent":
                return self._json(200, interpret(data.get("text"), data.get("environment", "city"), data.get("history")))
            if path == "/api/state":
                allowed = {"speedKmh", "fuel", "mode", "safety", "position", "onRoad", "sensorsM", "light", "destination", "actors"}
                if set(data) - allowed:
                    raise ValueError("Unknown state field")
                with STORE.lock:
                    STORE.state = {**data, "connected": True}
                    STORE.state_at = time.monotonic()
                return self._json(200, {"ok": True})
            return self._json(404, {"error": "Unknown API endpoint"})
        except ModelUnavailable as error:
            return self._json(503, {"error": str(error)})
        except (ValueError, json.JSONDecodeError, RuntimeError) as error:
            return self._json(400, {"error": str(error)})


def main():
    parser = argparse.ArgumentParser(description="Ya Rab Ostorha standalone Three.js game")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--check", action="store_true", help="Check local game files without starting a server")
    parser.add_argument("--open-browser", action="store_true")
    parser.add_argument("--perception", action="store_true", help="Enable the optional local YOLOX camera detector")
    args = parser.parse_args()
    required = [
        "index.html", "public/threejs/game.bundle.js",
        "public/threejs/game.styles.css", "public/threejs/pursuit-lab-worker.bundle.js",
    ]
    missing = [name for name in required if not (ROOT / name).is_file()]
    if missing:
        parser.error("Missing game files: " + ", ".join(missing) + ". Run npm ci and npm run build:dashboard.")
    if args.check:
        print(json.dumps({
            "ok": True, "mode": "threejs", "externalSimulator": False,
            "url": f"http://{args.host}:{args.port}/",
        }))
        return
    if args.perception:
        global PERCEPTION
        try:
            from .detector import PERCEPTION
        except ImportError as error:
            parser.error(f"Optional camera detection dependencies are unavailable: {error}")
    server = Server((args.host, args.port), Handler)
    url = f"http://{args.host}:{server.server_port}/"
    print(f"Three.js: {url}", flush=True)
    try:
        if args.open_browser:
            webbrowser.open(url)
        server.serve_forever()
    except KeyboardInterrupt:
        print("Three.js server stopped.", flush=True)
    finally:
        server.server_close()
        if VISION is not None:
            VISION.close()


if __name__ == "__main__":
    main()
