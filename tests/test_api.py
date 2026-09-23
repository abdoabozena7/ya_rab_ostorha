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

    def test_unknown_state_fields_rejected(self):
        with self.assertRaises(HTTPError) as raised:
            self.request("/api/state", {"unknown": "value"})
        self.assertEqual(raised.exception.code, 400)

    def test_git_files_not_exposed(self):
        with self.assertRaises(HTTPError) as raised:
            self.request("/.git/HEAD")
        self.assertEqual(raised.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
