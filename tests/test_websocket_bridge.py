import importlib.util
import json
import time
import unittest
from backend.simulation_service import SimulationService
from tests.core_packets import packet


@unittest.skipUnless(importlib.util.find_spec('websockets'), 'WebSocket dependency not installed')
class WebSocketTests(unittest.TestCase):
    def test_stream_controls_exclusive_owner_and_release_on_disconnect(self):
        from websockets.sync.client import connect
        from backend.websocket_bridge import WebSocketBridge
        service = SimulationService(None)
        service._publish(packet())
        bridge = WebSocketBridge(service, '127.0.0.1', 0, 8000)
        bridge.start()
        uri = f'ws://127.0.0.1:{bridge.server.socket.getsockname()[1]}'
        try:
            with connect(uri) as first:
                first.send(json.dumps({'type': 'controls', 'sequence': 1,
                                       'frame_id': 1, 'timestamp_s': .05,
                                       'controls': {'throttle': .4, 'gear': 1}}))
                frame = json.loads(first.recv(timeout=2))
                self.assertTrue(frame['controller'])
                self.assertEqual(frame['acknowledged'], 1)
                self.assertEqual(service.effective_controls()['throttle'], .4)
                with connect(uri) as second:
                    frame = json.loads(second.recv(timeout=2))
                    self.assertFalse(frame['controller'])
                    second.send(json.dumps({'type': 'controls', 'controls': {'throttle': 1}}))
                    messages = [json.loads(second.recv(timeout=2)) for _ in range(2)]
                    self.assertTrue(any(m['type']=='error' for m in messages))
            until = time.monotonic()+1
            while bridge.controller_lock.locked() and time.monotonic()<until:
                time.sleep(.01)
            self.assertEqual(service.effective_controls()['throttle'], 0)
            self.assertEqual(service.effective_controls()['brake'], 1)
        finally:
            bridge.close()

    def test_disconnected_backend_rejects_throttle(self):
        from websockets.sync.client import connect
        from backend.websocket_bridge import WebSocketBridge
        service = SimulationService(None)
        bridge = WebSocketBridge(service, '127.0.0.1', 0, 8000)
        bridge.start()
        try:
            with connect(f'ws://127.0.0.1:{bridge.server.socket.getsockname()[1]}') as socket:
                socket.send(json.dumps({'type': 'controls', 'controls': {'throttle': 1}}))
                frame = json.loads(socket.recv(timeout=2))
                self.assertEqual(frame['type'], 'error')
                self.assertIn('suspended', frame['error'])
                self.assertEqual(service.effective_controls()['throttle'], 0)
        finally:
            bridge.close()

    def test_explicit_takeover_revokes_old_owner_atomically(self):
        from backend.websocket_bridge import WebSocketBridge
        service = SimulationService(None); service._publish(packet())
        bridge = WebSocketBridge(service, '127.0.0.1', 0, 8000)
        first, second = object(), object()
        try:
            bridge.process_message(first, {'type':'start_driving'})
            bridge.process_message(first, {'type':'controls','frame_id':1,'timestamp_s':.05,
                                           'controls':{'throttle':.5}})
            self.assertEqual(service.effective_controls()['throttle'], .5)
            bridge.process_message(second, {'type':'start_driving'})
            self.assertEqual(service.effective_controls()['throttle'], 0)
            with self.assertRaisesRegex(ValueError, 'Another dashboard'):
                bridge.process_message(first, {'type':'controls','frame_id':1,'timestamp_s':.05,
                                               'controls':{'throttle':1}})
            self.assertIs(bridge.owner, second)
        finally:
            bridge.server.shutdown()

    def test_replay_cannot_claim_control_or_reconnect(self):
        from types import SimpleNamespace
        from backend.websocket_bridge import WebSocketBridge
        bridge = WebSocketBridge(SimpleNamespace(is_replay=True), '127.0.0.1', 0, 8000)
        try:
            for kind in ('start_driving','reconnect'):
                with self.assertRaisesRegex(ValueError, 'Replay'):
                    bridge.process_message(object(), {'type':kind})
        finally:
            bridge.server.shutdown()
