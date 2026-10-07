"""Serve the control dashboard and authoritative BeamNG API."""

import argparse
import json
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit, parse_qs


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
                                    "beamngConnected": bool(provider and provider.snapshot()["connected"])})
        if path == "/api/simulation/status":
            return self._json(200, {"provider": "beamng", "configured": provider is not None,
                                    "beamngConnected": bool(provider and provider.snapshot()["connected"]),
                                    "websocketPort": getattr(self.server, "websocket_port", None),
                                    "error": None if provider else "BEAMNG BLOCKER: official installation and tech.key required"})
        if path.startswith("/api/simulation/"):
            if provider is None:
                return self._json(503, {"error": "BeamNG provider is not running"})
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
                    for key, header in (("sensorTimestamp", "X-Sensor-Time"),
                                        ("simulationTimeAtPoll", "X-Simulation-Time-At-Poll"),
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
                    return self._json(503, {"error": "BeamNG provider is not running"})
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
    parser = argparse.ArgumentParser(description="Ya Rab Ostorha BeamNG control center")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--beamng-home", help="BeamNG.tech installation directory")
    parser.add_argument("--beamng-user", help="BeamNG.tech user directory")
    parser.add_argument("--sensor-config", help="JSON file overriding named sensor configuration fields")
    parser.add_argument("--beamng-port", type=int, default=25252)
    parser.add_argument("--websocket-port", type=int, default=8001)
    parser.add_argument("--traffic-count", type=int, choices=range(0, 21), default=0, metavar="0..20",
                        help="Later-phase normal traffic; checkpoint 1 uses 0")
    parser.add_argument("--enable-sensors", action="store_true",
                        help="Prepared sensor suite; validate only after checkpoint 1")
    parser.add_argument("--enable-legacy-preview", action="store_true",
                        help="Explicitly serve the archived Three.js preview")
    parser.add_argument("--beamng-connect", action="store_true", help="Connect to an already running BeamNG.tech")
    args = parser.parse_args()
    if args.enable_legacy_preview and args.beamng_home:
        parser.error("Legacy preview and BeamNG production mode must run separately")
    if args.beamng_home:
        from .installation import require_installation, BeamNGBlocker
        try:
            require_installation(args.beamng_home)
        except BeamNGBlocker as error:
            parser.exit(2, str(error) + "\n")
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.enable_legacy_preview = args.enable_legacy_preview
    try:
        if args.beamng_home:
            from .beamng_provider import BeamNGProvider, load_sensor_config
            from .simulation_service import SimulationService
            from .websocket_bridge import WebSocketBridge
            provider = BeamNGProvider(args.beamng_home, args.beamng_user,
                                     port=args.beamng_port, launch=not args.beamng_connect,
                                     sensor_config=load_sensor_config(args.sensor_config) if args.sensor_config else None,
                                     traffic_count=args.traffic_count, enable_sensors=args.enable_sensors)
            server.simulation_service = SimulationService(provider)
            server.simulation_service.start()
            server.websocket_port = args.websocket_port
            server.websocket_bridge = WebSocketBridge(server.simulation_service, args.host,
                                                      args.websocket_port, args.port)
            server.websocket_bridge.start()
        print(f"Control center: http://{args.host}:{args.port}/", flush=True)
        if not args.beamng_home:
            print("BEAMNG NOT AVAILABLE - dashboard only; no simulated telemetry", flush=True)
        server.serve_forever()
    finally:
        if getattr(server, "websocket_bridge", None):
            server.websocket_bridge.close()
        if getattr(server, "simulation_service", None):
            server.simulation_service.close()
        server.server_close()


if __name__ == "__main__":
    main()
