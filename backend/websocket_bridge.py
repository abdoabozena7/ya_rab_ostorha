"""Stream cached telemetry; only one connection may control the vehicle."""

import json
import threading
import time


class WebSocketBridge:
    def __init__(self, service, host, port, http_port):
        from websockets.sync.server import serve
        self.service = service
        self.controller_lock = threading.Lock()
        self.server = serve(self.handle, host, port, max_size=16_384,
                            origins=[None, f"http://127.0.0.1:{http_port}",
                                     f"http://localhost:{http_port}", f"http://{host}:{http_port}"])
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True,
                                       name="simulation-websocket")

    def start(self):
        self.thread.start()

    def handle(self, socket):
        from websockets.exceptions import ConnectionClosed
        controller = self.controller_lock.acquire(blocking=False)
        acknowledged = None
        try:
            while True:
                try:
                    payload = socket.recv(timeout=.05)
                    message = json.loads(payload)
                    if not isinstance(message, dict):
                        raise ValueError("Expected an object")
                    if message.get("type") in {"controls", "reset", "pause"}:
                        if not controller:
                            raise ValueError("Another connection controls this vehicle")
                        self.service.require_connected()
                        if message["type"] == "controls":
                            self.service.set_controls(**message.get("controls", {}))
                        elif message["type"] == "reset":
                            self.service.reset_vehicle()
                        else:
                            self.service.set_paused(message.get("paused"))
                        acknowledged = message.get("sequence")
                except TimeoutError:
                    pass
                except (ValueError, TypeError, RuntimeError) as error:
                    socket.send(json.dumps({"type": "error", "error": str(error)}))
                snapshot = self.service.snapshot()
                socket.send(json.dumps({"type": "snapshot", **snapshot,
                                        "controller": controller,
                                        "acknowledged": acknowledged}, allow_nan=False))
                # Commands can arrive at 20 Hz; never stream in an unbounded loop.
                time.sleep(.01)
        except ConnectionClosed:
            pass
        finally:
            if controller:
                self.service.release_controls()
                self.controller_lock.release()

    def close(self):
        self.server.shutdown()
        self.thread.join(timeout=2)
