"""Integration tests use temporary deterministic packets only, never a world."""
from dataclasses import replace
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from unittest.mock import MagicMock
from backend.core.recording import RunRecorder
from backend.core.replay import ReplayReader
from backend.core.control import ControlMode
from backend.core.contracts import CommandSource, SensorKind, AssetReference
from backend.replay_service import ReplayService
from backend.server import Handler
from backend.simulation_service import SimulationService
from tests.core_packets import packet, sensor, metadata


class ServiceBoundaryTests(unittest.TestCase):
    def test_control_timeout_emergency_and_explicit_resume(self):
        now = [10.]
        service = SimulationService(None, now=lambda: now[0])
        service._publish(packet())
        self.assertEqual(service.snapshot()['mode'], 'MANUAL')
        service.set_controls(throttle=.7)
        now[0] += .4
        self.assertEqual(service.effective_controls()['throttle'], 0.)
        self.assertEqual(service.snapshot()['mode'], 'PAUSED')
        with self.assertRaises(RuntimeError):
            service.set_controls(throttle=1)
        service.set_paused(False)
        service.set_controls(throttle=.3)
        service.emergency_stop()
        self.assertEqual(service.snapshot()['mode'], 'EMERGENCY_STOP')
        self.assertEqual(service.effective_controls()['brake'], 1)
        service.acknowledge_stop()
        self.assertEqual(service.snapshot()['mode'], 'PAUSED')
        service.set_paused(False)
        self.assertEqual(service.snapshot()['mode'], 'MANUAL')

    def test_neutral_and_reverse_requests_survive_partial_browser_commands(self):
        now = [10.]
        service = SimulationService(None, now=lambda: now[0])
        service._publish(packet())
        service.set_controls(gear=0)
        now[0] += .05
        service.set_controls(throttle=0)
        self.assertEqual(service.effective_controls()['gear'], 0)
        now[0] += .05
        service.set_controls(gear=-1)
        now[0] += .05
        service.set_controls(throttle=.2)
        self.assertTrue(service.arbiter.safety.latest[CommandSource.MANUAL].reverse)
        self.assertEqual(service.effective_controls()['gear'], -1)

    def test_sensor_timeout_records_incomplete_frame_and_late_data_stays_separate(self):
        now = [0.]
        service = SimulationService(None, required_sensors=('imu',), now=lambda: now[0])
        service.synchronizer.begin(packet())
        now[0] = .3
        frame, = service.synchronizer.drain()
        service._publish(frame)
        self.assertFalse(service.snapshot()['frameComplete'])
        self.assertEqual(service.snapshot()['missingRequiredSensors'], ['imu'])
        service.ingest_sensor(sensor())
        self.assertEqual(service.observation.sensors, ())

    def test_provider_is_closed_when_safe_command_fails_and_recording_flushes(self):
        provider = MagicMock(cleanup_errors=[])
        provider.name = 'test-fixture'
        provider.apply_control.side_effect = RuntimeError('transport failed')
        with tempfile.TemporaryDirectory() as directory:
            recorder = RunRecorder(directory, metadata())
            service = SimulationService(provider, recorder)
            service._publish(packet())
            recorder.record(packet())
            service.close()
            provider.close.assert_called_once()
            self.assertTrue(recorder.closed)
            self.assertFalse(service.snapshot()['connected'])

    def test_shutdown_flushes_pending_incomplete_observations(self):
        with tempfile.TemporaryDirectory() as directory:
            recorder = RunRecorder(directory, metadata())
            service = SimulationService(None, recorder, required_sensors=('imu',))
            service.synchronizer.begin(packet())
            service.close()
            reader = ReplayReader(recorder.root, allow_test_data=True)
            observed = reader.frame_at(0)
            self.assertFalse(observed.complete)
            self.assertEqual(observed.missing_required_sensors, ('imu',))

    def test_matching_frame_id_with_wrong_timestamp_cannot_be_applied(self):
        now = [10.]
        service = SimulationService(None, now=lambda: now[0])
        service._publish(packet())
        with self.assertRaises(ValueError):
            service.set_controls(throttle=.5, frame_id=1, timestamp_s=.049)
        now[0] += 2
        snapshot = service.snapshot()
        self.assertEqual(snapshot['connectionState'], 'ERROR')
        self.assertEqual(snapshot['mode'], 'DISCONNECTED')
        self.assertIn('timeout', snapshot['error'])
        self.assertIsNone(snapshot['vehicle'])


class ReplayApiTests(unittest.TestCase):
    def test_read_only_replay_http_and_websocket_cleanup(self):
        with tempfile.TemporaryDirectory() as directory:
            with RunRecorder(directory, metadata()) as recorder:
                recorder.record(packet())
                recorder.record(packet(2, .1))
            service = ReplayService(ReplayReader(recorder.root, allow_test_data=True))
            server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
            server.simulation_service = service
            server.websocket_port = 1
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f'http://127.0.0.1:{server.server_port}'
            try:
                with urlopen(base+'/api/simulation/status') as response:
                    status = json.load(response)
                self.assertEqual((status['provider'], status['mode'], status['connected']), ('replay', 'REPLAY', False))
                with urlopen(base+'/api/health') as response:
                    self.assertFalse(json.load(response)['simulationConnected'])
                with urlopen(base+'/api/simulation/state') as response:
                    state = json.load(response)
                self.assertEqual(state['mode'], 'REPLAY')
                self.assertFalse(state['connected'])
                for endpoint in ('control', 'reset'):
                    with self.assertRaises(HTTPError) as error:
                        urlopen(Request(base+'/api/simulation/'+endpoint, data=b'{"throttle":1}', headers={'Content-Type': 'application/json'}))
                    self.assertEqual(error.exception.code, 503)
                    error.exception.close()
                with urlopen(Request(base+'/api/simulation/replay', data=b'{"paused":true,"timestamp_s":0.05}', headers={'Content-Type': 'application/json'})) as response:
                    self.assertEqual(json.load(response)['mode'], 'REPLAY')
                if importlib.util.find_spec('websockets'):
                    from websockets.sync.client import connect
                    from backend.websocket_bridge import WebSocketBridge
                    bridge = WebSocketBridge(service, '127.0.0.1', 0, server.server_port)
                    bridge.start()
                    try:
                        with connect(f'ws://127.0.0.1:{bridge.server.socket.getsockname()[1]}') as socket:
                            snapshot = json.loads(socket.recv(timeout=2))
                            self.assertFalse(snapshot['controller'])
                            self.assertFalse(snapshot['connected'])
                            self.assertEqual(snapshot['mode'], 'REPLAY')
                    finally:
                        bridge.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join()
                service.close()


class NativePreparationTests(unittest.TestCase):
    @unittest.skipIf(importlib.util.find_spec('carla') is not None, 'Native API is installed; offline absence check is inapplicable')
    def test_every_native_entry_point_reports_absence_instead_of_passing(self):
        for name in ('connection', 'vehicle_spawn', 'vehicle_control', 'collision', 'rgb', 'depth', 'radar', 'lidar', 'imu', 'gnss', 'cleanup'):
            with self.subTest(check=name):
                result = subprocess.run([sys.executable, '-m', 'scripts.native.verify_'+name], capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode, 2)
                self.assertIn('CARLA NOT INSTALLED', result.stdout)
                self.assertNotIn('"status": "PASS"', result.stdout)

    def test_core_imports_no_sdk_renderer_or_ml_dependency(self):
        import ast
        prohibited = {'carla', 'beamngpy', 'torch', 'tensorflow', 'ultralytics'}
        for path in Path('backend/core').glob('*.py'):
            for node in ast.walk(ast.parse(path.read_text(encoding='utf-8-sig'))):
                if isinstance(node, ast.Import):
                    self.assertFalse(prohibited & {alias.name.split('.')[0] for alias in node.names})
                if isinstance(node, ast.ImportFrom):
                    self.assertNotIn((node.module or '').split('.')[0], prohibited)
