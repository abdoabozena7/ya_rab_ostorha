import json
import threading
import unittest
import time
from types import SimpleNamespace
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from backend.server import Handler
from backend.simulation_service import SimulationService


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f'http://127.0.0.1:{cls.server.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown(); cls.server.server_close(); cls.thread.join()

    def request(self, path, data=None):
        request = Request(self.base + path, data=None if data is None else json.dumps(data).encode(),
                          headers={'Content-Type': 'application/json'})
        with urlopen(request) as response:
            return json.load(response)

    def expect_error(self, code, path, data=None):
        with self.assertRaises(HTTPError) as error:
            self.request(path, data)
        self.assertEqual(error.exception.code, code)
        error.exception.close()

    def test_missing_installation_is_reported_without_mock_fallback(self):
        status = self.request('/api/simulation/status')
        self.assertEqual(status['provider'], 'beamng')
        self.assertFalse(status['configured'])
        self.assertFalse(status['beamngConnected'])
        self.assertIsNone(status['websocketPort'])
        self.assertIn('BEAMNG BLOCKER', status['error'])
        for path in ['/api/simulation/state', '/api/state', '/api/frame', '/api/simulation/sensor?name=gps']:
            self.expect_error(503, path)

    def test_browser_cannot_post_fabricated_production_observations(self):
        self.expect_error(404, '/api/state', {'speedKmh': 100})
        self.expect_error(503, '/api/simulation/control', {'throttle': 1})

    def test_legacy_requires_explicit_opt_in(self):
        self.expect_error(404, '/legacy/threejs-simulator/index.html')
        self.expect_error(404, '/api/legacy/state')
        self.expect_error(404, '/api/legacy/state', {'speedKmh': 100})

    def test_private_files_and_key_are_not_served(self):
        for path in ['/.git/HEAD', '/.venv/pyvenv.cfg', '/backend/server.py', '/tech.key']:
            self.expect_error(404, path)

    def test_default_page_is_control_center(self):
        with urlopen(self.base + '/') as response:
            html = response.read().decode()
        self.assertIn('/frontend/dashboard.js', html)
        self.assertNotIn('three@', html)
        self.assertNotIn('gameCanvas', html)

    def test_production_api_reads_cached_beamng_and_rejects_stale_commands(self):
        service = SimulationService(None)
        service.state = {'source': 'beamng', 'speedMps': 7, 'engineRPM': 2200}
        service.state_at = time.monotonic()
        self.server.simulation_service = service
        try:
            self.assertEqual(self.request('/api/state')['vehicle']['engineRPM'], 2200)
            self.request('/api/simulation/control', {'throttle': .3})
            self.assertEqual(service.effective_controls()['throttle'], .3)
            service.state_at = time.monotonic() - 2
            self.expect_error(503, '/api/simulation/control', {'throttle': 1})
            self.assertEqual(service.effective_controls()['throttle'], 0)
        finally:
            del self.server.simulation_service

    def test_http_reset_respects_websocket_controller(self):
        service = SimulationService(None)
        service.state = {'source': 'beamng'}
        service.state_at = time.monotonic()
        self.server.simulation_service = service
        self.server.websocket_bridge = SimpleNamespace(controller_lock=SimpleNamespace(locked=lambda: True))
        try:
            self.expect_error(409, '/api/simulation/reset', {})
            self.assertEqual(len(service.actions), 0)
        finally:
            del self.server.simulation_service
            del self.server.websocket_bridge
