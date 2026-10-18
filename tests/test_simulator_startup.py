import json
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from pathlib import Path
from unittest.mock import Mock,patch
from http.server import ThreadingHTTPServer
from backend.carla.stop_helper import stopped_service
from backend.carla.start_helper import finish_start,launch_settings,backend_command
from backend.server import Handler,DashboardHTTPServer


class StartupTests(unittest.TestCase):
    def test_concurrent_pages_dispatch_only_one_engine_start(self):
        from concurrent.futures import ThreadPoolExecutor
        start=Mock(return_value=None)
        service=stopped_service({'result':{'status':'STOPPED'}},Mock(),start)
        server=DashboardHTTPServer(('127.0.0.1',0),Handler);server.simulation_service=service
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        def request(_):
            message=urllib.request.Request(f'http://127.0.0.1:{server.server_port}/api/simulation/start',data=b'{}',headers={'Content-Type':'application/json'})
            with urllib.request.urlopen(message,timeout=5) as response:return json.load(response)['status']
        try:
            with ThreadPoolExecutor(max_workers=12) as pool:self.assertEqual(set(pool.map(request,range(24))),{'STARTING'})
            start.assert_called_once()
        finally:server.shutdown();server.server_close();thread.join(timeout=2)

    def test_stopped_start_is_explicit_idempotent_and_never_creates_an_sdk_sink(self):
        start=Mock(return_value=None)
        s=stopped_service({'result':{'status':'STOPPED'}},Mock(),start)
        self.assertEqual(s.snapshot()['simulatorStart']['status'],'IDLE');start.assert_not_called()
        self.assertEqual(s.start_simulation()['status'],'STARTING')
        self.assertEqual(s.start_simulation()['status'],'STARTING');start.assert_called_once()
        self.assertIsNone(s.provider);self.assertFalse(s.snapshot()['connected'])

    def test_start_failure_is_visible_and_can_be_retried(self):
        start=Mock(side_effect=OSError('Cannot launch helper'))
        s=stopped_service({'result':{'status':'STOPPED'}},Mock(),start)
        self.assertEqual(s.start_simulation()['status'],'FAILED')
        self.assertIn('Cannot launch',s.snapshot()['simulatorStart']['error'])
        start.side_effect=None;self.assertEqual(s.start_simulation()['status'],'STARTING')
        self.assertEqual(start.call_count,2)

    def test_launch_failure_restores_a_retryable_sdk_free_dashboard(self):
        ticket={'previous_pid':123,'host':'127.0.0.1','port':8000,'websocket_port':8001,
            'carla_host':'127.0.0.1','carla_port':2000,'launch':{'quality':'Epic','resolution':'1280x720'},
            'configuration':{'vehicle':'vehicle.lincoln.mkz_2020','spawn_index':152,'fixed_delta':.05},
            'result':{'status':'STOPPED'},'startup':{'status':'STARTING'}}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'ticket.json'
            with patch('backend.carla.start_helper.retire_host') as retire,patch('backend.carla.runtime.NativeRuntime') as runtime,patch('backend.carla.runtime.native_processes',return_value=[]),patch('backend.carla.start_helper.start_backend') as backend:
                runtime.return_value.launch.side_effect=RuntimeError('GPU launch failed')
                finish_start(path,ticket)
                retire.assert_called_once_with(123)
                backend.assert_called_once_with(path,ticket,stopped=True)
                runtime.return_value.stop.assert_called_once_with(port=2000)
            result=json.loads(path.read_text())
            self.assertEqual(result['startup']['status'],'FAILED')
            self.assertIn('GPU launch failed',result['startup']['error'])
            self.assertEqual(result['result']['status'],'STOPPED')
            self.assertNotIn('--carla',backend_command(ticket,stopped=True,path=path))
            self.assertIn('--start-paused',backend_command(ticket))

    def test_saved_graphics_are_used_and_validated(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'config').mkdir()
            path=root/'config/dashboard-preferences.json'
            path.write_text(json.dumps({'next_launch':{'quality':'Epic','resolution':'1280x720','render_profile':'HIGH'}}))
            with patch('backend.carla.start_helper.ROOT',root):
                self.assertEqual(launch_settings({})['render_profile'],'HIGH')
                path.write_text(json.dumps({'next_launch':{'quality':'Unknown'}}))
                with self.assertRaises(ValueError):launch_settings({})

    def test_immediate_operator_stop_after_ready_is_not_a_startup_failure(self):
        ticket={'previous_pid':123,'host':'127.0.0.1','port':8000,'carla_host':'127.0.0.1',
            'carla_port':2000,'launch':{},'result':{'status':'STOPPED'},'startup':{'status':'STARTING'}}
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'ticket.json'
            def ready(*args,**kwargs):
                path.write_text(json.dumps({**ticket,'startup':{'status':'READY'}}))
                return Mock(poll=Mock(return_value=0))
            with patch('backend.carla.start_helper.retire_host'),patch('backend.carla.runtime.NativeRuntime') as runtime,patch('backend.carla.runtime.native_processes',return_value=[]),patch('backend.carla.start_helper.start_backend',side_effect=ready) as backend:
                finish_start(path,ticket)
                backend.assert_called_once();runtime.return_value.stop.assert_not_called()
                self.assertEqual(json.loads(path.read_text())['startup']['status'],'READY')

    def test_one_local_http_request_starts_without_granting_driving_control(self):
        start=Mock(return_value=None)
        service=stopped_service({'result':{'status':'STOPPED'}},Mock(),start)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.simulation_service=service
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        url=f'http://127.0.0.1:{server.server_port}/api/simulation/start'
        try:
            bad=urllib.request.Request(url,data=b'{}',headers={'Content-Type':'application/json','Origin':'https://unrelated.example'})
            with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(bad)
            self.assertEqual(error.exception.code,403);start.assert_not_called()
            good=urllib.request.Request(url,data=b'{}',headers={'Content-Type':'application/json'})
            with urllib.request.urlopen(good) as response:
                self.assertEqual(response.status,202);self.assertEqual(json.load(response)['status'],'STARTING')
            self.assertFalse(service.snapshot()['connected']);self.assertFalse(service.actions)
            self.assertEqual(service.effective_controls()['throttle'],0)
        finally:server.shutdown();server.server_close();thread.join(timeout=2)


if __name__=='__main__':unittest.main()
