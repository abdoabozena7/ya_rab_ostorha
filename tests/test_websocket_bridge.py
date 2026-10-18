import importlib.util
import json
import time
import unittest
from pathlib import Path
from backend.simulation_service import SimulationService
from tests.core_packets import packet


@unittest.skipUnless(importlib.util.find_spec('websockets'), 'WebSocket dependency not installed')
class WebSocketTests(unittest.TestCase):
    def test_page_scene_handoff_has_one_owner_and_rejects_an_old_pages_start(self):
        from types import SimpleNamespace
        from unittest.mock import Mock
        from backend.websocket_bridge import WebSocketBridge
        import tempfile
        provider=SimpleNamespace(name='test-fixture',allow_navigation=True,prepare_presentation=Mock(),stop_navigation=Mock())
        service=SimulationService(provider);service._publish(packet())
        bridge=WebSocketBridge(service,'127.0.0.1',0,8000)
        first,second=object(),object()
        with tempfile.TemporaryDirectory() as directory:
            service.presentation.directory=Path(directory)
            try:
                bridge.process_message(first,{'type':'presentation','value':{'operation':'PRELOAD','page_id':'page-first'}})
                old_id=service.presentation.data['id']
                bridge.process_message(second,{'type':'presentation','value':{'operation':'PRELOAD','page_id':'page-second'}})
                self.assertIs(bridge.owner,second);self.assertNotEqual(service.presentation.data['id'],old_id)
                service.presentation.data['status']='CHOOSING'
                start={'operation':'START_GUIDED','prepared_id':service.presentation.data['id'],'first_mode':'NORMAL'}
                with self.assertRaisesRegex(ValueError,'fresh start'):
                    bridge.process_message(first,{'type':'presentation','value':{**start,'page_id':'page-first'}})
                self.assertIs(bridge.owner,second)
                bridge.process_message(second,{'type':'presentation','value':{**start,'page_id':'page-second'}})
                self.assertEqual(service.presentation.data['status'],'SELECTING')
                self.assertEqual(sum(a=='prepare_guided_vehicle' for a,v in service.actions),1)
            finally:bridge.server.shutdown()

    def test_explicit_emergency_stops_before_transferring_observer_ownership(self):
        from unittest.mock import Mock
        from types import SimpleNamespace
        import threading
        from backend.websocket_bridge import WebSocketBridge
        bridge=WebSocketBridge.__new__(WebSocketBridge)
        bridge.service=SimpleNamespace(emergency_stop=Mock(),restarting=False,rl_runtime=None)
        bridge.owner=object();observer=object();bridge.ownership_lock=threading.RLock();bridge.controller_lock=threading.Lock()
        bridge.service.emergency_stop.side_effect=lambda:self.assertIsNot(bridge.owner,observer)
        self.assertTrue(bridge.process_message(observer,{'type':'emergency_stop'}))
        self.assertIs(bridge.owner,observer);self.assertTrue(bridge.controller_lock.locked())

    def test_a_new_native_frame_invalidates_the_shared_snapshot_inside_its_ttl(self):
        from unittest.mock import Mock,patch
        from types import SimpleNamespace
        import threading
        from backend.websocket_bridge import WebSocketBridge
        service=SimpleNamespace(session_id='s',sequence=1,snapshot=Mock(),
            stream_snapshot=Mock(side_effect=[{'sequence':1},{'sequence':2}]))
        bridge=WebSocketBridge.__new__(WebSocketBridge);bridge.service=service
        bridge.snapshot_cache=None;bridge.snapshot_key=None;bridge.snapshot_lock=threading.Lock()
        with patch('backend.websocket_bridge.time.monotonic',return_value=1.):
            first=bridge.snapshot_payload();self.assertEqual(bridge.snapshot_payload(),first)
            service.sequence=2;second=bridge.snapshot_payload()
        self.assertEqual(json.loads(second)['sequence'],2)
        self.assertEqual(service.stream_snapshot.call_count,2)

    def test_native_pong_keeps_autonomous_intent_without_browser_js_and_close_stops_it(self):
        from websockets.sync.client import connect
        from backend.websocket_bridge import WebSocketBridge
        service=SimulationService(None);service._publish(packet())
        service.journey.update(status='RUNNING')
        bridge=WebSocketBridge(service,'127.0.0.1',0,8000);bridge.start()
        try:
            with connect(f'ws://127.0.0.1:{bridge.server.socket.getsockname()[1]}') as socket:
                socket.recv(timeout=2)
                time.sleep(.65)  # No application heartbeat or controls are sent.
                self.assertTrue(service._navigation_connection_alive())
                self.assertEqual(service.navigation_heartbeat_at,-float('inf'))
            until=time.monotonic()+1
            while bridge.owner is not None and time.monotonic()<until:time.sleep(.01)
            self.assertEqual(service.journey['status'],'PAUSED')
            self.assertEqual(service.journey['reason'],'dashboard_disconnected')
        finally:bridge.close()

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

    def test_disabled_autonomous_request_preserves_manual_owner_and_command(self):
        from backend.websocket_bridge import WebSocketBridge
        service = SimulationService(None); service._publish(packet())
        bridge = WebSocketBridge(service, '127.0.0.1', 0, 8000)
        owner, observer = object(), object()
        try:
            bridge.process_message(owner, {'type':'start_driving'})
            bridge.process_message(owner, {'type':'controls','frame_id':1,'timestamp_s':.05,
                                          'controls':{'throttle':.4}})
            with self.assertRaisesRegex(ValueError, 'disabled'):
                bridge.process_message(observer, {'type':'start_journey','speed_kmh':20})
            self.assertIs(bridge.owner, owner)
            self.assertEqual(service.effective_controls()['throttle'], .4)
        finally:
            bridge.server.shutdown()

    def test_missing_destination_cannot_steal_manual_ownership(self):
        from types import SimpleNamespace
        from backend.websocket_bridge import WebSocketBridge
        service = SimulationService(SimpleNamespace(name='test-fixture',allow_navigation=True, route_state=lambda:None))
        service._publish(packet())
        bridge = WebSocketBridge(service, '127.0.0.1', 0, 8000)
        owner, observer = object(), object()
        try:
            bridge.process_message(owner, {'type':'start_driving'})
            bridge.process_message(owner, {'type':'controls','frame_id':1,'timestamp_s':.05,
                                          'controls':{'throttle':.4}})
            with self.assertRaises(ValueError):
                bridge.process_message(observer, {'type':'start_journey','speed_kmh':20})
            self.assertIs(bridge.owner,owner)
            self.assertEqual(service.effective_controls()['throttle'],.4)
            self.assertFalse(service.actions and any(k=='start_journey' for k,_ in service.actions))
        finally:
            bridge.server.shutdown()

    def test_buffered_controls_recheck_coarse_admission_clock(self):
        from unittest.mock import patch
        from backend.websocket_bridge import WebSocketBridge
        service = SimulationService(None); service._publish(packet())
        bridge = WebSocketBridge(service, '127.0.0.1', 0, 8000)
        owner = object(); clock = [1.0]; sleeps = []
        service.arbiter.safety.now = lambda: clock[0]
        def coarse_sleep(delay):
            sleeps.append(delay)
            if len(sleeps) > 1:
                clock[0] += .025
        try:
            bridge.process_message(owner, {'type':'start_driving'})
            control = {'type':'controls','frame_id':1,'timestamp_s':.05,
                       'controls':{'throttle':.4}}
            bridge.process_message(owner, control)
            with patch('backend.websocket_bridge.time.sleep', side_effect=coarse_sleep):
                bridge.process_message(owner, control)
            self.assertGreaterEqual(len(sleeps), 2)
            self.assertEqual(service.effective_controls()['throttle'], .4)
            # Pacing does not waive frame freshness checks.
            clock[0] += .025
            with self.assertRaisesRegex(ValueError, 'future'):
                bridge.process_message(owner, {**control,'frame_id':2})
        finally:
            bridge.server.shutdown()
