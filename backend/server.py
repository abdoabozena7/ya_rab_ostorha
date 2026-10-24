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
class DashboardHTTPServer(ThreadingHTTPServer):
    # Several pages load fonts/bundles and status together. Keep that burst
    # queued while native work is busy instead of using the tiny default queue.
    request_queue_size = 64

class Handler(SimpleHTTPRequestHandler):
    def log_message(self, format, *args):
        # Per-frame image/telemetry logs can block a terminal and stall live ticks.
        if len(args) > 1 and str(args[1]) in ('200', '304'):
            return
        log(LogCategory.CONNECTION, 'HTTP request', path=urlsplit(self.path).path, detail=format % args)

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        if not urlsplit(self.path).path.startswith('/api/'):
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def _json(self, status, value):
        body = json.dumps(value,separators=(',',':'),allow_nan=False).encode("utf-8")
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
        from .core.video_http import serve_video
        if serve_video(self,path,getattr(provider,'recording_directory',ROOT/'runs/normal_city')):return
        if any(part.startswith(".") for part in Path(path).parts) or path.startswith(("/backend/", "/tests/", "/runs/", "/recordings/", '/config/')) or Path(path).name == "tech.key":
            return self._json(404, {"error": "Not found"})
        if path.startswith(("/legacy/", "/api/legacy/")):
            return self._json(404, {"error": "Archived preview is disabled"})
        path = {"/api/state": "/api/simulation/state", "/api/frame": "/api/simulation/camera.jpg"}.get(path, path)
        if path == "/api/health":
            service_snapshot = getattr(provider,'status_snapshot',provider.snapshot)() if provider else {}
            return self._json(200, {"ok": True, "service": "ya-rab-ostorha-control-center",
                                    "simulationProvider": service_snapshot.get('provider', 'carla'),
                                    "mode": service_snapshot.get('mode', 'DISCONNECTED'),
                                    "simulationConnected": service_snapshot.get('connected', False)})
        if path == "/api/simulation/status":
            snapshot = getattr(provider,'status_snapshot',provider.snapshot)() if provider else {}
            connected = snapshot.get('connected', False)
            replay = snapshot.get('mode') == 'REPLAY'
            return self._json(200, {"provider": 'replay' if replay else "carla", "configured": provider is not None,
                                    "connected": connected,
                                    "mode": snapshot.get('mode', 'DISCONNECTED'),
                                    "sessionId":snapshot.get('sessionId'), "vehicle":snapshot.get('vehicle'),
                                    "vision_warmup":snapshot.get('vision_warmup',False),
                                    "status": 'REPLAY' if replay else "CONNECTED" if connected else "ERROR" if snapshot.get('error') else "DISCONNECTED",
                                    "websocketPort": getattr(self.server, "websocket_port", None),
                                    "imageWebsocketPath": "/images" if not replay and provider is not None else None,
                                    "error": snapshot.get('error') if provider else "CARLA is not connected. Start the official simulator and backend with --carla."})
        if path == '/api/simulation/scenarios':
            from .core.egypt_urban import scenario_catalog
            return self._json(200, scenario_catalog())
        if path.startswith("/api/simulation/"):
            if provider is None:
                return self._json(503, {"error": "CARLA provider is not running"})
            try:
                if path == '/api/simulation/prediction':
                    observer = getattr(self.server, 'display_prediction', None)
                    requested=parse_qs(urlsplit(self.path).query).get('frame_id',[None])[0]
                    return self._json(200, observer.snapshot(int(requested) if requested is not None else None) if observer else {'status':'UNAVAILABLE'})
                if path == '/api/simulation/perception':
                    analysis = getattr(self.server, 'perception', None)
                    if parse_qs(urlsplit(self.path).query).get('ocr')==['1'] and analysis and callable(getattr(analysis,'request_ocr',None)):analysis.request_ocr()
                    snapshot = getattr(provider,'status_snapshot',provider.snapshot)()
                    if not snapshot.get('connected'):
                        return self._json(200, {'status':'DISCONNECTED'})
                    return self._json(200, analysis.latest(snapshot.get('sessionId')) if analysis else {'status':'UNAVAILABLE'})
                if path == '/api/simulation/perception.jpg':
                    analysis = getattr(self.server, 'perception', None)
                    provider.require_connected()
                    token = parse_qs(urlsplit(self.path).query).get('token',[''])[0]
                    try: body = analysis.image(token) if analysis else None
                    except (ValueError,OSError): body = None
                    if not body: return self._json(404, {'error':'Processed frame expired or unavailable'})
                    self.send_response(200);self.send_header('Content-Type','image/jpeg')
                    self.send_header('Cache-Control','no-store');self.send_header('Content-Length',str(len(body)))
                    self.send_header('X-Perception-Token',token)
                    self.end_headers();return self.wfile.write(body)
                if path == "/api/simulation/state":
                    return self._json(200, provider.get_vehicle_state())
                if path == '/api/simulation/catalog':
                    return self._json(200, provider.dashboard_catalog())
                if path == "/api/simulation/sensor":
                    name = parse_qs(urlsplit(self.path).query).get("name", [""])[0]
                    return self._json(200, provider.get_sensor_frame(name))
                if path == '/api/simulation/camera-raw.png':
                    import io
                    from PIL import Image
                    provider.require_connected()
                    manager = getattr(provider.provider, 'sensor_manager', None)
                    if manager is None:
                        return self._json(503, {'error':'No native diagnostic RGB; start the sensor suite first'})
                    with provider.lock:
                        with manager.lock:
                            raw = getattr(manager, 'diagnostic_rgb', {}).get(provider.observation.frame_id)
                    if raw is None:
                        return self._json(503, {'error':'No native diagnostic RGB'})
                    frame_id, timestamp, width, height, pixels = raw
                    output = io.BytesIO()
                    Image.frombytes('RGB', (width,height), pixels).save(output, format='PNG')
                    body = output.getvalue()
                    self.send_response(200)
                    self.send_header('Content-Type', 'image/png')
                    self.send_header('Content-Length', str(len(body)))
                    self.send_header('X-Sensor-Frame', str(frame_id))
                    self.send_header('X-Sensor-Time', str(timestamp))
                    self.send_header('Cache-Control', 'no-store')
                    self.end_headers(); self.wfile.write(body)
                    return
                if path in ("/api/simulation/camera.jpg", '/api/simulation/sensor.bin'):
                    requested = parse_qs(urlsplit(self.path).query).get('frame_id', [None])[0]
                    if requested is not None and (not requested.isdigit() or len(requested)>12):
                        return self._json(400, {'error': 'Sensor frame_id must be a nonnegative integer'})
                    options = {'frame_id': int(requested)} if requested is not None else {}
                    if path.endswith('sensor.bin'):
                        name = parse_qs(urlsplit(self.path).query).get('name', [''])[0]
                        frame, metadata = provider.get_sensor_asset(name, **options)
                    else:
                        if parse_qs(urlsplit(self.path).query).get('view')==['driving']:options['view']='driving'
                        frame, metadata = provider.get_camera_frame(**options)
                    if not frame:
                        return self._json(503, {"error": "No camera frame yet"})
                    self.send_response(200)
                    self.send_header("Content-Type", (metadata or {}).get('contentType', "image/jpeg"))
                    self.send_header("Cache-Control", "no-store")
                    self.send_header("Content-Length", str(len(frame)))
                    for key, header in (("timestamp", "X-Sensor-Time"),
                                        ("frame", "X-Sensor-Frame"),
                                        ("width", "X-Image-Width"), ("height", "X-Image-Height"),
                                        ("sensorId", "X-Camera-Id"),
                                        ("receivedMonotonic", "X-Received-Monotonic")):
                        if metadata and metadata.get(key) is not None:
                            self.send_header(header, str(metadata[key]))
                    self.send_header('X-Session-Id', provider.session_id)
                    self.end_headers()
                    return self.wfile.write(frame)
            except KeyError:
                return self._json(404, {"error": "Unknown sensor"})
            except RuntimeError as error:
                return self._json(503, {"error": str(error)})
            return self._json(404, {"error": "Unknown simulation endpoint"})
        return super().do_GET()

    def do_HEAD(self):
        from .core.video_http import serve_video
        provider=getattr(self.server,'simulation_service',None)
        if serve_video(self,unquote(urlsplit(self.path).path),getattr(provider,'recording_directory',ROOT/'runs/normal_city')):return
        return super().do_HEAD()

    def do_POST(self):
        path = urlsplit(self.path).path
        try:
            if path.startswith("/api/legacy/"):
                return self._json(404, {"error": "Archived preview is disabled"})
            if path.startswith("/api/simulation/"):
                provider = getattr(self.server, "simulation_service", None)
                if provider is None:
                    return self._json(503, {"error": "CARLA provider is not running"})
                data = self._read_json()
                if not isinstance(data, dict):
                    raise ValueError("Expected JSON object")
                if path in ('/api/simulation/start','/api/simulation/reset-session'):
                    if getattr(provider,'is_replay',False):raise ValueError('Replay cannot start a simulator')
                    origins={f'http://{host}:{self.server.server_port}' for host in ('127.0.0.1','localhost','[::1]')}
                    if self.client_address[0] not in ('127.0.0.1','::1') or self.headers.get('Origin') not in origins|{None}:
                        return self._json(403,{'error':'Simulation startup is local to this dashboard'})
                    if self.headers.get_content_type() != 'application/json' or data:
                        raise ValueError('Simulation startup takes an empty JSON object')
                    return self._json(202,provider.reset_simulation() if path.endswith('reset-session') else provider.start_simulation())
                if getattr(provider, 'is_replay', False) and path == '/api/simulation/replay':
                    if set(data)-{'paused', 'timestamp_s'}:
                        raise ValueError('Unknown replay option')
                    if 'paused' in data:
                        provider.set_paused(data['paused'])
                    if 'timestamp_s' in data:
                        provider.seek(data['timestamp_s'])
                    return self._json(200, {'ok': True, 'mode': 'REPLAY'})
                if path == '/api/simulation/rl' and not getattr(provider, 'is_replay', False):
                    operation = data.pop('operation', None)
                    if operation not in ('acquire','reset','step','close','heartbeat','baseline',
                        'maneuver_acquire','maneuver_reset','maneuver_step','maneuver_close','maneuver_heartbeat'):
                        raise ValueError('Unknown RL operation')
                    return self._json(200, provider.rl_request(operation, **data))
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
    parser.add_argument('--run-profile', choices=('LEGACY','PERFORMANCE_60'),
                        help='Opt-in 60 Hz physics/display with synchronized 20 Hz driving')
    parser.add_argument('--session-duration', type=float, help='Stop cleanly after this many wall-clock seconds (native validation/recording)')
    parser.add_argument('--collision-sensor', action='store_true', help='Attach the real native collision sensor (Gate 2)')
    parser.add_argument('--sensors', action='store_true', help='Attach the validated seven native sensors (Gate 3)')
    parser.add_argument("--record-log", help="Optional JSONL frame log")
    parser.add_argument('--record-run', help='Output directory for a versioned replayable run')
    parser.add_argument('--replay', help='Read an existing real recorded run; never connects to CARLA')
    parser.add_argument('--experiment-config', help='Strict simulator-independent JSON experiment config')
    parser.add_argument('--restart-ticket', help=argparse.SUPPRESS)
    parser.add_argument('--stopped-ticket', help=argparse.SUPPRESS)
    parser.add_argument('--startup-ticket', help=argparse.SUPPRESS)
    parser.add_argument('--start-paused', action='store_true', help='Connect with native brakes applied; requires explicit driving')
    parser.add_argument('--fresh-start', action='store_true', help='Ignore saved view/population for an empty default session')
    parser.add_argument('--validation-ticket', help='Explicit expiring RULE integration validation authorization')
    parser.add_argument("--websocket-port", type=int, default=8001)
    args = parser.parse_args()
    if args.stopped_ticket and (args.carla or args.replay):parser.error('Stopped dashboard cannot own a simulator or replay')
    if args.startup_ticket and not args.carla:parser.error('Native startup ticket requires CARLA')
    if args.session_duration is not None and args.session_duration <= 0:
        parser.error('Session duration must be positive')
    configure_logging()
    validation_budget = None
    if args.validation_ticket:
        from .learning.native_validation_budget import NativeValidationBudget
        validation_budget = NativeValidationBudget(args.validation_ticket)
        if validation_budget.ticket.get('scope')=='NATIVE_RULE_REPAIR':validation_budget.activate_rule()
        remaining = validation_budget.status()['remaining_s']
        if not args.carla or remaining <= 0: parser.error('Native RULE validation authorization has expired or CARLA is not enabled')
        args.session_duration = min(args.session_duration or remaining, remaining)
    if args.replay and (args.carla or args.record_run or args.record_log):
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
    provider = None
    supervisor = None
    if args.carla:
        from .providers import create_provider
        from .core.lifecycle import ConnectionSupervisor
        try:
            provider = create_provider('carla', host=args.carla_host, port=args.carla_port,
                                     version=args.carla_version, map_name=args.map,
                                     blueprint=args.vehicle, spawn_index=args.spawn_index,
                                     fixed_delta=args.fixed_delta, collision_sensor=args.collision_sensor, sensor_suite=args.sensors,
                                     fresh_start=args.fresh_start, run_profile=args.run_profile)
            ticket = json.loads(Path(args.restart_ticket).read_text(encoding='utf-8')) if args.restart_ticket else None
            if ticket:
                provider.configure_run_profile(ticket['configuration'].get('run_profile', provider.run_profile))
                provider.camera_settings.update(ticket['configuration']['camera'])
                provider.restart_ticket = args.restart_ticket
            supervisor = ConnectionSupervisor(config.simulation.connection_timeout_s if config else 60)
            supervisor.connect(provider)
            if ticket:
                weather = provider.world.world.get_weather()
                for key,value in ticket['configuration']['weather'].items(): setattr(weather,key,value)
                provider.world.world.set_weather(weather)
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
        server = DashboardHTTPServer((args.host, args.port), Handler)
        if provider:
            from .simulation_service import SimulationService
            from .websocket_bridge import WebSocketBridge
            from .recording import FrameRecorder
            recorder = FrameRecorder(args.record_log) if args.record_log else None
            if args.record_run:
                from .core.recording import RunRecorder
                from .core.contracts import ExperimentMetadata, DataOrigin, to_dict
                recorder = RunRecorder(args.record_run, ExperimentMetadata('run_'+uuid.uuid4().hex,
                                        config.experiment.name if config else 'Native dashboard manual/navigation validation', provider.name, DataOrigin.REAL_SIMULATION,
                                        description=config.experiment.description if config else '', seed=config.experiment.seed if config else None,
                                        created_at_utc=datetime.now(timezone.utc).isoformat(),
                                        config={**(to_dict(config) if config else {}), **provider.recording_metadata()}))
            server.simulation_service = SimulationService(provider, recorder, required_sensors=provider.required_sensors,
                                                          sensor_timeout_s=.5, validation_budget=validation_budget)
            server.simulation_service.start()
            if args.start_paused:
                ready_deadline=time.monotonic()+10
                while not server.simulation_service.snapshot()['connected'] and time.monotonic()<ready_deadline:
                    time.sleep(.05)
                server.simulation_service.stop_driving('fresh_native_session')
            from .carla.restart_helper import dispatch_restart
            provider.restart_handler = lambda launch,previous,configuration: dispatch_restart(
                server, args, launch, previous, configuration)
            from .carla.stop_helper import dispatch_stop
            provider.shutdown_handler=lambda status:dispatch_stop(server,args,status)
            from .carla.start_helper import dispatch_start
            provider.startup_handler=lambda status:dispatch_start(server,args,status)
            provider.reset_handler=lambda status:dispatch_start(server,args,status,fresh=True)
            server.websocket_port = args.websocket_port
            server.websocket_bridge = WebSocketBridge(server.simulation_service, args.host,
                                                      args.websocket_port, args.port)
            server.websocket_bridge.start()
        elif args.stopped_ticket:
            from .websocket_bridge import WebSocketBridge
            from .carla.stop_helper import read_ticket,stopped_service,dispatch_stop
            from .carla.start_helper import dispatch_start
            _,ticket=read_ticket(args.stopped_ticket)
            configuration=ticket.get('configuration') or {'vehicle':args.vehicle,'spawn_index':152,'map':args.map,'fixed_delta':args.fixed_delta}
            server.simulation_service=stopped_service(ticket,lambda status:dispatch_stop(server,args,status),
                lambda status:dispatch_start(server,args,status,configuration),lambda status:dispatch_start(server,args,status,fresh=True))
            server.websocket_port=args.websocket_port
            server.websocket_bridge=WebSocketBridge(server.simulation_service,args.host,args.websocket_port,args.port)
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
        else:
            from .websocket_bridge import WebSocketBridge
            from .carla.stop_helper import stopped_service,dispatch_stop
            from .carla.start_helper import dispatch_start
            server.simulation_service=stopped_service({'result':{'status':'STOPPED'}},
                lambda status:dispatch_stop(server,args,status),lambda status:dispatch_start(server,args,status),
                lambda status:dispatch_start(server,args,status,fresh=True))
            server.websocket_port=args.websocket_port
            server.websocket_bridge=WebSocketBridge(server.simulation_service,args.host,args.websocket_port,args.port)
            server.websocket_bridge.start()
        if args.carla:
            from .perception import PerceptionService
            server.perception = PerceptionService(args.port)
            from .core.display_prediction import DisplayPredictionService
            server.display_prediction = DisplayPredictionService(server.simulation_service, server.perception)
            from .computer_vision.service import ControlPerceptionCache
            server.simulation_service.control_perception = ControlPerceptionCache()
        if args.startup_ticket:
            from .carla.stop_helper import read_ticket,save
            startup_path,startup_ticket=read_ticket(args.startup_ticket)
            ready=server.simulation_service.snapshot()
            if ready.get('connected') and ready.get('mode')=='PAUSED' and ready.get('sensorRegistry'):
                startup_ticket['startup']={'status':'READY','session_id':ready['sessionId']}
                save(startup_path,startup_ticket)
                server.simulation_service.simulator_start=startup_ticket['startup']
        log(LogCategory.CONNECTION, 'Control center listening', url=f'http://{args.host}:{args.port}/',
            mode='REPLAY' if args.replay else 'CARLA' if args.carla else 'DISCONNECTED')
        if args.session_duration:
            if validation_budget:
                # A single long monotonic Timer can outlive an absolute grant
                # across host sleep/clock jumps. Recheck its wall deadline.
                validation_deadline = time.time() + args.session_duration
                def expire_validation():
                    validation_budget.wait_for_expiry(deadline=validation_deadline)
                    server.shutdown()
                threading.Thread(target=expire_validation, daemon=True,
                    name='native-validation-expiry').start()
            else:
                timer = threading.Timer(args.session_duration, server.shutdown)
                timer.daemon = True
                timer.start()
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if getattr(server,'display_prediction',None):
            server.display_prediction.close()
        if getattr(server,'perception',None):
            try: server.perception.close()
            except Exception as error:
                log(LogCategory.SENSOR, 'Perception shutdown error', error=str(error))
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
