import json
import shutil
import subprocess
import sys
import threading
import unittest
from http.server import ThreadingHTTPServer
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from backend.threejs import server


class ThreeJsServerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.http = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        cls.thread = threading.Thread(target=cls.http.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.http.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.http.shutdown()
        cls.http.server_close()
        cls.thread.join()

    def setUp(self):
        self.previous_store = server.STORE
        server.STORE = server.Store()

    def tearDown(self):
        server.STORE = self.previous_store

    def request(self, path, data=None, method=None, content_type="application/json"):
        body = data if isinstance(data, bytes) else None if data is None else json.dumps(data).encode()
        request = Request(self.base + path, data=body, method=method,
                          headers={"Content-Type": content_type})
        return urlopen(request, timeout=5)

    def test_root_serves_the_real_game_bundle_and_local_player_model(self):
        with self.request("/") as response:
            html = response.read().decode()
        self.assertIn("/public/threejs/game.bundle.js", html)
        self.assertNotIn("dashboard.bundle.js", html)
        for path, prefix in (
            ("/public/threejs/game.bundle.js", None),
            ("/public/threejs/game.styles.css", None),
            ("/assets/models/vehicles/player-concept.glb", b"glTF"),
        ):
            with self.subTest(path=path), self.request(path) as response:
                body = response.read()
                self.assertGreater(len(body), 1000)
                if prefix:
                    self.assertTrue(body.startswith(prefix))
        with self.request("/", method="HEAD") as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(response.read(), b"")

    def test_health_identifies_a_standalone_game_without_external_simulator(self):
        with self.request("/api/health") as response:
            health = json.load(response)
        self.assertTrue(health["ok"])
        self.assertEqual(health["mode"], "threejs")
        self.assertFalse(health["externalSimulator"])

    def test_observations_round_trip_and_invalid_updates_preserve_the_last_state(self):
        state = {"speedKmh": 22, "mode": "auto", "position": {"x": 10, "z": 20}}
        with self.request("/api/state", state):
            pass
        with self.assertRaises(HTTPError) as raised:
            self.request("/api/state", {"unknown": "value"})
        self.assertEqual(raised.exception.code, 400)
        with self.request("/api/state") as response:
            observed = json.load(response)
        self.assertEqual(observed["position"], state["position"])
        self.assertEqual(observed["speedKmh"], 22)
        self.assertTrue(observed["connected"])

    def test_optional_camera_detection_is_explicitly_off_without_model_dependencies(self):
        with self.request("/api/detections") as response:
            result = json.load(response)
        self.assertFalse(result["available"])
        self.assertEqual(result["status"], "disabled")
        self.assertIsNone(result["result"])
        self.assertIn("--perception", result["error"])
        with self.request("/api/training") as response:
            self.assertFalse(json.load(response)["running"])

    def test_private_files_and_native_engine_routes_are_not_served(self):
        paths = (
            "/.git/HEAD", "/.runtime-proof/active.json", "/backend/server.py",
            "/config/dashboard-preferences.json", "/public/../README.md",
            "/api/simulation/state", "/legacy/carla-dashboard/index.html",
        )
        for path in paths:
            for method in ("GET", "HEAD"):
                with self.subTest(path=path, method=method), self.assertRaises(HTTPError) as raised:
                    self.request(path, method=method)
                self.assertEqual(raised.exception.code, 404)
        with self.assertRaises(HTTPError) as raised:
            self.request("/api/simulation/start", {})
        self.assertEqual(raised.exception.code, 404)

    def test_public_module_entrypoint_checks_files_without_site_packages(self):
        result = subprocess.run(
            [sys.executable, "-S", "-m", "backend.threejs.server", "--check"],
            cwd=server.ROOT, capture_output=True, text=True, timeout=20, check=True,
        )
        self.assertEqual(json.loads(result.stdout)["mode"], "threejs")
        self.assertEqual(result.stderr, "")

    @unittest.skipUnless(sys.platform == "win32", "Windows launcher integration")
    def test_both_windows_launchers_use_the_standalone_entrypoint(self):
        powershell = shutil.which("powershell.exe")
        self.assertIsNotNone(powershell)
        for name in ("Start-YA-RAB-OSTORHA.ps1", "Run-Project.ps1"):
            with self.subTest(launcher=name):
                result = subprocess.run(
                    [powershell, "-NoProfile", "-File", str(server.ROOT / name), "-Check"],
                    cwd=server.ROOT, capture_output=True, text=True, timeout=20, check=False,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                report = json.loads(result.stdout)
                self.assertEqual(report["mode"], "threejs")
                self.assertFalse(report["externalSimulator"])


if __name__ == "__main__":
    unittest.main()
