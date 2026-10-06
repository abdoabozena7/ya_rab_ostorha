import json
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from backend.server import Handler


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.server.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()

    def request(self, path, data=None):
        body = None if data is None else json.dumps(data).encode()
        request = Request(self.base + path, data=body, headers={"Content-Type": "application/json"})
        with urlopen(request) as response:
            return json.load(response)

    def test_simulator_state_reaches_observation_api(self):
        self.request("/api/state", {"speedKmh": 22, "fuel": 85, "mode": "auto", "safety": "clear", "position": {"x": 10, "z": 20},
                                    "actors": [{"type": "pedestrian", "x": 11, "z": 20, "vx": 0.1, "vz": 0, "radius": 0.55}]})
        data = self.request("/api/state")
        self.assertEqual(data["speedKmh"], 22)
        self.assertEqual(data["actors"][0]["type"], "pedestrian")
        self.assertTrue(data["connected"])
        self.assertEqual(data["source"], "development-mock")

    def test_unknown_state_fields_rejected(self):
        with self.assertRaises(HTTPError) as raised:
            self.request("/api/state", {"unknown": "value"})
        self.assertEqual(raised.exception.code, 400)

    def test_browser_sessions_do_not_overwrite_each_others_measurements(self):
        self.request('/api/state?client=current', {'speedKmh': 32, 'clearanceCm': 146})
        self.request('/api/state?client=old-preview', {'speedKmh': 0})
        data = self.request('/api/state?client=current')
        self.assertEqual(data['speedKmh'], 32)
        self.assertEqual(data['clearanceCm'], 146)
        self.assertFalse(self.request('/api/state?client=missing')['connected'])

    def test_physical_measurements_and_incidents_round_trip(self):
        self.request('/api/state', {'speedKmh': 45, 'clearanceCm': 123,
                     'throttle': 0.45, 'brake': 0.2, 'surface': 'wet', 'grip': 0.48,
                     'stoppingDistanceM': 22.73, 'requestedSpeedKmh': 100,
                     'plannedSpeedKmh': 45, 'cinematic': True, 'timeScale': 0.22,
                     'equipment': {'lights': True, 'signal': 'left'}, 'tripRemainingM': 612,
                     'incidents': [{'id': 1, 'type': 'braking', 'remaining': 7}]})
        data = self.request('/api/state')
        self.assertEqual(data['clearanceCm'], 123)
        self.assertEqual(data['equipment']['signal'], 'left')
        self.assertEqual(data['timeScale'], 0.22)
        self.assertEqual(data['incidents'][0]['type'], 'braking')

    def test_git_files_not_exposed(self):
        with self.assertRaises(HTTPError) as raised:
            self.request("/.git/HEAD")
        self.assertEqual(raised.exception.code, 404)

    def test_beamng_endpoints_do_not_silently_return_mock_data(self):
        status = self.request('/api/simulation/status')
        self.assertFalse(status['beamngConnected'])
        self.assertFalse(status['worldAlignedWithBrowser'])
        with self.assertRaises(HTTPError) as raised:
            self.request('/api/simulation/state')
        self.assertEqual(raised.exception.code, 503)


if __name__ == "__main__":
    unittest.main()
