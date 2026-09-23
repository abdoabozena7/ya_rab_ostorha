"""Serve the simulator and a local observation API without dependencies."""

import argparse
import json
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit


ROOT = Path(__file__).resolve().parents[1]
MAX_JSON = 16_384
MAX_FRAME = 400_000


class Store:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = {"connected": False, "speedKmh": 0, "fuel": 100, "mode": "manual"}
        self.state_at = 0.0
        self.frame = b""


STORE = Store()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def _json(self, status, value):
        body = json.dumps(value).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self):
        size = int(self.headers.get("Content-Length", "0"))
        if not 0 < size <= MAX_JSON:
            raise ValueError("Invalid JSON size")
        return json.loads(self.rfile.read(size))

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if any(part.startswith(".") for part in Path(path).parts) or path.startswith(("/backend/", "/tests/")):
            return self._json(404, {"error": "Not found"})
        if path == "/api/health":
            return self._json(200, {"ok": True, "service": "ya-rab-ostorha-simulator"})
        if path == "/api/state":
            with STORE.lock:
                state = STORE.state.copy()
                state["connected"] = state["connected"] and time.monotonic() - STORE.state_at < 2
            return self._json(200, state)
        if path == "/api/frame":
            with STORE.lock:
                frame = STORE.frame
            if not frame:
                return self._json(404, {"error": "No camera frame yet"})
            self.send_response(200)
            self.send_header("Content-Type", "image/jpeg")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(frame)))
            self.end_headers()
            return self.wfile.write(frame)
        return super().do_GET()

    def do_POST(self):
        path = urlsplit(self.path).path
        try:
            if path == "/api/frame":
                size = int(self.headers.get("Content-Length", "0"))
                if not 0 < size <= MAX_FRAME or self.headers.get("Content-Type") != "image/jpeg":
                    raise ValueError("Expected a JPEG frame under 400 KB")
                frame = self.rfile.read(size)
                if not frame.startswith(b"\xff\xd8"):
                    raise ValueError("Invalid JPEG frame")
                with STORE.lock:
                    STORE.frame = frame
                return self._json(200, {"ok": True})

            data = self._read_json()
            if not isinstance(data, dict):
                raise ValueError("Expected JSON object")
            if path == "/api/state":
                allowed = {"speedKmh", "fuel", "mode", "safety", "position", "onRoad", "sensorsM", "light", "destination", "actors"}
                if set(data) - allowed:
                    raise ValueError("Unknown state field")
                with STORE.lock:
                    STORE.state = {**data, "connected": True}
                    STORE.state_at = time.monotonic()
                return self._json(200, {"ok": True})
            return self._json(404, {"error": "Unknown API endpoint"})
        except (ValueError, json.JSONDecodeError) as error:
            return self._json(400, {"error": str(error)})


def main():
    parser = argparse.ArgumentParser(description="Ya Rab Ostorha local simulator server")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"Simulator: http://{args.host}:{args.port}/")
    server.serve_forever()


if __name__ == "__main__":
    main()
