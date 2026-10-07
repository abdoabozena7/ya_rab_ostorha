"""Serve the control dashboard and authoritative CARLA API."""

import argparse
import json
import threading
import time
from datetime import datetime, timezone
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit, parse_qs
from .carla.target import VERSION, BLOCKER
from .core.logging import configure_logging, log, LogCategory


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
    def log_message(self, format, *args):
        log(LogCategory.CONNECTION, 'HTTP request', path=urlsplit(self.path).path, detail=format % args)

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
        if any(part.startswith(".") for part in Path(path).parts) or path.startswith(("/backend/", "/tests/", "/runs/", "/recordings/")) or Path(path).name == "tech.key":
            return self._json(404, {"error": "Not found"})
        if path.startswith(("/legacy/", "/api/legacy/")) and not getattr(self.server, "enable_legacy_preview", False):
            return self._json(404, {"error": "Archived preview is disabled"})
        path = {"/api/state": "/api/simulation/state", "/api/frame": "/api/simulation/camera.jpg"}.get(path, path)
        if path == "/api/health":
            service_snapshot = provider.snapshot() if provider else {}
            return self._json(200, {"ok": True, "service": "ya-rab-ostorha-control-center",
                                    "simulationProvider": service_snapshot.get('provider', 'carla'),
                                    "mode": service_snapshot.get('mode', 'DISCONNECTED'),
                                    "simulationConnected": service_snapshot.get('connected', False)})
        if path == "/api/simulation/status":
            snapshot = provider.snapshot() if provider else {}
            connected = snapshot.get('connected', False)
            replay = snapshot.get('mode') == 'REPLAY'
            return self._json(200, {"provider": 'replay' if replay else "carla", "configured": provider is not None,
                                    "connected": connected,
                                    "mode": snapshot.get('mode', 'DISCONNECTED'),
                                    "status": 'REPLAY' if replay else "CONNECTED" if connected else "ERROR" if snapshot.get('error') else "DISCONNECTED",
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
                    self.send_header("Content-Type", (metadata or {}).get('contentType', "image/jpeg"))
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
                if getattr(provider, 'is_replay', False) and path == '/api/simulation/replay':
                    if set(data)-{'paused', 'timestamp_s'}:
                        raise ValueError('Unknown replay option')
                    if 'paused' in data:
                        provider.set_paused(data['paused'])
                    if 'timestamp_s' in data:
                        provider.seek(data['timestamp_s'])
                    return self._json(200, {'ok': True, 'mode': 'REPLAY'})
                provider.require_connected()
                bridge = getattr(self.server, "websocket_bridge", None)
                if bridge and bridge.controller_lock.locked():
                    return self._json(409, {"error": "Browser connection controls this vehicle"})
                if path == "/api/simulation/control":
                    if 'frame_id' not in data or 'timestamp_s' not in data:
                        raise ValueError('Controls require frame_id and timestamp_s')
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
    parser.add_argument('--record-run', help='Output directory for a versioned replayable run')
    parser.add_argument('--replay', help='Read an existing real recorded run; never connects to CARLA')
    parser.add_argument('--experiment-config', help='Strict simulator-independent JSON experiment config')
    parser.add_argument("--websocket-port", type=int, default=8001)
    parser.add_argument("--enable-legacy-preview", action="store_true",
                        help="Explicitly serve the archived Three.js preview")
    args = parser.parse_args()
    configure_logging()
    if args.replay and (args.carla or args.enable_legacy_preview or args.record_run or args.record_log):
        parser.error('Replay, live simulation and recording are separate operating modes')
    if args.record_run and args.record_log:
        parser.error('Choose versioned run recording or the compatibility JSONL sink')
    config = None
    if args.experiment_config:
        from .core.config import load_config
        try:
            config = load_config(args.experiment_config)
        except (ValueError, OSError) as error:
            parser.error('Invalid experiment configuration: '+str(error))
        args.fixed_delta = config.simulation.fixed_delta_seconds
        if config.vehicle.blueprint:
            args.vehicle = config.vehicle.blueprint
        if config.vehicle.spawn_point is not None:
            args.spawn_index = config.vehicle.spawn_point
        if any(sensor.enabled for sensor in config.sensors.values()):
            parser.error('Native sensor activation is gated; configuration alone cannot enable unvalidated sensors')
        if config.recording.enabled and not args.record_run:
            args.record_run = config.recording.output_directory
    if args.replay and (args.record_run or args.record_log):
        parser.error('Replay cannot also record a new native run')
    if (args.record_run or args.record_log) and not args.carla:
        parser.error('Recording requires a live production provider')
    if args.enable_legacy_preview and args.carla:
        parser.error("Legacy preview and CARLA production mode must run separately")
    provider = None
    supervisor = None
    if args.carla:
        from .providers import create_provider
        from .core.lifecycle import ConnectionSupervisor
        try:
            provider = create_provider('carla', host=args.carla_host, port=args.carla_port,
                                     version=args.carla_version, map_name=args.map,
                                     blueprint=args.vehicle, spawn_index=args.spawn_index,
                                     fixed_delta=args.fixed_delta)
            supervisor = ConnectionSupervisor(config.simulation.connection_timeout_s if config else 10)
            supervisor.connect(provider)
        except Exception as error:
            reason = str(error)
            if supervisor:
                try:
                    supervisor.disconnect()
                except Exception as cleanup:
                    reason += '; cleanup unconfirmed: '+str(cleanup)
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
            if args.record_run:
                from .core.recording import RunRecorder
                from .core.contracts import ExperimentMetadata, DataOrigin, to_dict
                recorder = RunRecorder(args.record_run, ExperimentMetadata('run_'+uuid.uuid4().hex,
                                        config.experiment.name if config else 'Manual native session', provider.name, DataOrigin.REAL_SIMULATION,
                                        description=config.experiment.description if config else '', seed=config.experiment.seed if config else None,
                                        created_at_utc=datetime.now(timezone.utc).isoformat(), config=to_dict(config) if config else {}))
            server.simulation_service = SimulationService(provider, recorder)
            server.simulation_service.start()
            server.websocket_port = args.websocket_port
            server.websocket_bridge = WebSocketBridge(server.simulation_service, args.host,
                                                      args.websocket_port, args.port)
            server.websocket_bridge.start()
        elif args.replay:
            from .core.replay import ReplayReader
            from .replay_service import ReplayService
            from .websocket_bridge import WebSocketBridge
            try:
                reader = ReplayReader(args.replay)
            except (ValueError, OSError) as error:
                parser.exit(2, 'REPLAY UNAVAILABLE: '+str(error)+'\n')
            server.simulation_service = ReplayService(reader)
            server.websocket_port = args.websocket_port
            server.websocket_bridge = WebSocketBridge(server.simulation_service, args.host, args.websocket_port, args.port)
            server.websocket_bridge.start()
        log(LogCategory.CONNECTION, 'Control center listening', url=f'http://{args.host}:{args.port}/',
            mode='REPLAY' if args.replay else 'CARLA' if args.carla else 'DISCONNECTED')
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
                        log(LogCategory.SIMULATION, 'Simulation shutdown error', error=server.simulation_service.error)
                elif provider:
                    provider.close()
                    if provider.cleanup_errors:
                        log(LogCategory.CONNECTION, 'CARLA cleanup unconfirmed', errors=provider.cleanup_errors)
            finally:
                if server:
                    server.server_close()


if __name__ == "__main__":
    main()
