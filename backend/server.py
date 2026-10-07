"""Serve the control dashboard and authoritative CARLA API."""

import argparse
import json
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit, parse_qs
from .carla.target import VERSION, BLOCKER


ROOT = Path(__file__).resolve().parents[1]
MAX_JSON = 16_384
MAX_FRAME = 400_000


class LegacyStore:
    def __init__(self):
        self.lock = threading.Lock()
        self.state = {"connected": False, "source": "development-mock", "speedKmh": 0, "fuel": 100, "mode": "manual"}
        self.state_at = 0.0
        self.frame = b""
        self.clients = {}


STORE = LegacyStore()  # Used exclusively by the opt-in /api/legacy endpoints.


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        if not urlsplit(self.path).path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

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
        provider = getattr(self.server, "simulation_service", None)
        if any(part.startswith(".") for part in Path(path).parts) or path.startswith(("/backend/", "/tests/")) or Path(path).name == "tech.key":
            return self._json(404, {"error": "Not found"})
        if path.startswith(("/legacy/", "/api/legacy/")) and not getattr(self.server, "enable_legacy_preview", False):
            return self._json(404, {"error": "Archived preview is disabled"})
        path = {"/api/state": "/api/simulation/state", "/api/frame": "/api/simulation/camera.jpg"}.get(path, path)
        if path == "/api/health":
            return self._json(200, {"ok": True, "service": "ya-rab-ostorha-control-center",
                                    "simulationProvider": "carla",
                                    "simulationConnected": bool(provider and provider.snapshot()["connected"])})
        if path == "/api/simulation/status":
            snapshot = provider.snapshot() if provider else {}
            connected = snapshot.get('connected', False)
            return self._json(200, {"provider": "carla", "configured": provider is not None,
                                    "connected": connected,
                                    "status": "CONNECTED" if connected else "ERROR" if snapshot.get('error') else "DISCONNECTED",
                                    "websocketPort": getattr(self.server, "websocket_port", None),
                                    "error": snapshot.get('error') if provider else "CARLA is not connected. Start the official simulator and backend with --carla."})
        if path.startswith("/api/simulation/"):
            if provider is None:
                return self._json(503, {"error": "CARLA provider is not running"})
            try:
                if path == "/api/simulation/state":
                    return self._json(200, provider.get_vehicle_state())
                if path == "/api/simulation/sensor":
                    name = parse_qs(urlsplit(self.path).query).get("name", [""])[0]
                    return self._json(200, provider.get_sensor_frame(name))
                if path == "/api/simulation/camera.jpg":
                    frame, metadata = provider.get_camera_frame()
                    if not frame:
                        return self._json(503, {"error": "No camera frame yet"})
                    self.send_response(200)
                    self.send_header("Content-Type", "image/jpeg")
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Length", str(len(frame)))
                    for key, header in (("timestamp", "X-Sensor-Time"),
                                        ("frame", "X-Sensor-Frame"),
                                        ("receivedMonotonic", "X-Received-Monotonic")):
                        if metadata and metadata.get(key) is not None:
                            self.send_header(header, str(metadata[key]))
                    self.end_headers()
                    return self.wfile.write(frame)
            except KeyError:
                return self._json(404, {"error": "Unknown sensor"})
            except RuntimeError as error:
                return self._json(503, {"error": str(error)})
            return self._json(404, {"error": "Unknown simulation endpoint"})
        if path == "/api/legacy/state":
            with STORE.lock:
                client = parse_qs(urlsplit(self.path).query).get('client', [''])[0]
                record = STORE.clients.get(client) if client else None
                state = (record['state'] if record else {'connected': False} if client else STORE.state).copy()
                at = record['at'] if record else 0 if client else STORE.state_at
                state["connected"] = state["connected"] and time.monotonic() - at < 2
            return self._json(200, state)
        if path == "/api/legacy/frame":
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
            if path.startswith("/api/legacy/") and not getattr(self.server, "enable_legacy_preview", False):
                return self._json(404, {"error": "Archived preview is disabled"})
            if path.startswith("/api/simulation/"):
                provider = getattr(self.server, "simulation_service", None)
                if provider is None:
                    return self._json(503, {"error": "CARLA provider is not running"})
                data = self._read_json()
                if not isinstance(data, dict):
                    raise ValueError("Expected JSON object")
                provider.require_connected()
                bridge = getattr(self.server, "websocket_bridge", None)
                if bridge and bridge.controller_lock.locked():
                    return self._json(409, {"error": "Browser connection controls this vehicle"})
                if path == "/api/simulation/control":
                    provider.set_controls(**data)
                    return self._json(200, {"ok": True})
                if path == "/api/simulation/reset":
                    provider.reset_vehicle()
                    return self._json(200, {"ok": True})
                return self._json(404, {"error": "Unknown simulation endpoint"})
            if path == "/api/legacy/frame":
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
            if path == "/api/legacy/state":
                allowed = {"speedKmh", "fuel", "mode", "safety", "position", "onRoad", "sensorsM", "light", "destination", "actors",
                           "clearanceCm", "throttle", "brake", "surface", "grip", "stoppingDistanceM",
                           "requestedSpeedKmh", "plannedSpeedKmh", "cinematic", "timeScale", "cinematicEvents", "equipment", "tripRemainingM", "incidents", "simulationTime", "physicsTick"}
                if set(data) - allowed:
                    raise ValueError("Unknown state field")
                with STORE.lock:
                    STORE.state = {**data, "source": "development-mock", "connected": True}
                    STORE.state_at = time.monotonic()
                    client = parse_qs(urlsplit(self.path).query).get('client', [''])[0][:80]
                    if client:
                        STORE.clients[client] = {'state': STORE.state.copy(), 'at': STORE.state_at}
                        if len(STORE.clients) > 16:
                            oldest = min(STORE.clients, key=lambda key: STORE.clients[key]['at'])
                            del STORE.clients[oldest]
                return self._json(200, {"ok": True})
            return self._json(404, {"error": "Unknown API endpoint"})
        except (ValueError, json.JSONDecodeError) as error:
            return self._json(400, {"error": str(error)})
        except RuntimeError as error:
            return self._json(503, {"error": str(error)})


def main():
    parser = argparse.ArgumentParser(description="Ya Rab Ostorha CARLA control center")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--carla", action="store_true", help="Connect to the running CARLA simulator")
    parser.add_argument("--carla-host", default="127.0.0.1")
    parser.add_argument("--carla-port", type=int, default=2000)
    parser.add_argument("--carla-version", default=VERSION, choices=[VERSION])
    parser.add_argument("--map", help="Explicit CARLA map; defaults to the current world")
    parser.add_argument("--vehicle", default="vehicle.lincoln.mkz_2020")
    parser.add_argument("--spawn-index", type=int, default=0)
    parser.add_argument("--fixed-delta", type=float, default=.05)
    parser.add_argument("--record-log", help="Optional JSONL frame log")
    parser.add_argument("--websocket-port", type=int, default=8001)
    parser.add_argument("--enable-legacy-preview", action="store_true",
                        help="Explicitly serve the archived Three.js preview")
    args = parser.parse_args()
    if args.enable_legacy_preview and args.carla:
        parser.error("Legacy preview and CARLA production mode must run separately")
    provider = None
    if args.carla:
        from .carla.provider import CarlaProvider
        try:
            provider = CarlaProvider(host=args.carla_host, port=args.carla_port,
                                     version=args.carla_version, map_name=args.map,
                                     blueprint=args.vehicle, spawn_index=args.spawn_index,
                                     fixed_delta=args.fixed_delta).connect()
        except Exception as error:
            reason = str(error)
            parser.exit(2, (reason if reason.startswith(BLOCKER) else f'{BLOCKER}: {reason}') + '\n')
    server = None
    try:
        server = ThreadingHTTPServer((args.host, args.port), Handler)
        server.enable_legacy_preview = args.enable_legacy_preview
        if provider:
            from .simulation_service import SimulationService
            from .websocket_bridge import WebSocketBridge
            from .recording import FrameRecorder
            recorder = FrameRecorder(args.record_log) if args.record_log else None
            server.simulation_service = SimulationService(provider, recorder)
            server.simulation_service.start()
            server.websocket_port = args.websocket_port
            server.websocket_bridge = WebSocketBridge(server.simulation_service, args.host,
                                                      args.websocket_port, args.port)
            server.websocket_bridge.start()
        print(f"Control center: http://{args.host}:{args.port}/", flush=True)
        if not args.carla:
            print("CARLA DISCONNECTED - dashboard only; no simulated telemetry", flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        try:
            if getattr(server, "websocket_bridge", None):
                server.websocket_bridge.close()
        finally:
            try:
                if getattr(server, "simulation_service", None):
                    server.simulation_service.close()
                    if server.simulation_service.error:
                        print('Simulation shutdown: ' + server.simulation_service.error, flush=True)
                elif provider:
                    provider.close()
                    if provider.cleanup_errors:
                        print('CARLA cleanup unconfirmed: ' + '; '.join(provider.cleanup_errors), flush=True)
            finally:
                if server:
                    server.server_close()


if __name__ == "__main__":
    main()
