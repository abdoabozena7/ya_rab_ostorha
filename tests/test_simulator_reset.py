import json
import tempfile
import threading
import unittest
import urllib.request
import urllib.error
from pathlib import Path
from unittest.mock import Mock,patch
from http.server import ThreadingHTTPServer
from backend.carla.start_helper import fresh_configuration,backend_command,dispatch_start,reset_preferences
from backend.carla.stop_helper import stopped_service
from backend.server import Handler
from tests.test_simulator_shutdown import service


class ResetTests(unittest.TestCase):
    def test_clean_preferences_keep_saved_places_and_graphics_without_old_traffic(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);(root/'config').mkdir()
            path=root/'config/dashboard-preferences.json'
            path.write_text(json.dumps({'population':{'vehicle_count':31},'view':{'camera_view':'rear'},
                'favorite_places':{'Town10HD_Opt':['saved-place']},'next_launch':{'quality':'Low'}}))
            with patch('backend.carla.start_helper.ROOT',root):reset_preferences()
            result=json.loads(path.read_text())
        self.assertEqual(result['population']['vehicle_count'],0);self.assertEqual(result['population']['pedestrian_count'],0)
        self.assertEqual(result['view'],{});self.assertEqual(result['favorite_places']['Town10HD_Opt'],['saved-place'])
        self.assertEqual(result['next_launch']['quality'],'Low')

    def test_moving_drive_can_reset_once_and_cleanup_precedes_fresh_handoff(self):
        s=service();s.provider.reset_handler=Mock();s._stop_navigation=Mock();s.release_controls=Mock()
        with patch('backend.core.service.threading.Thread') as worker:
            self.assertEqual(s.reset_simulation()['operation'],'RESET')
            s.reset_simulation();worker.return_value.start.assert_called_once()
            self.assertEqual(worker.call_args.kwargs['args'],(True,))
        order=[];s.close=Mock(side_effect=lambda:order.append('cleanup'))
        s.provider.reset_handler.side_effect=lambda status:order.append('fresh_handoff')
        s._start_simulation_native(True)
        self.assertEqual(order,['cleanup','fresh_handoff'])

    def test_reset_does_not_allow_remote_native_process_changes(self):
        s=service();s.provider.reset_handler=Mock();s.provider.connection.host='192.0.2.1'
        with self.assertRaisesRegex(ValueError,'Local'):s.reset_simulation()
        s.provider.reset_handler.assert_not_called()

    def test_stopped_dashboard_can_reset_without_creating_native_state_in_old_host(self):
        reset=Mock();s=stopped_service({'result':{'status':'STOPPED'}},Mock(),Mock(),reset)
        self.assertTrue(s.snapshot()['simulatorReset']['available'])
        self.assertEqual(s.reset_simulation()['operation'],'RESET')
        s.reset_simulation();reset.assert_called_once();self.assertIsNone(s.provider)

    def test_reset_configuration_ignores_current_vehicle_spawn_and_map(self):
        from types import SimpleNamespace
        args=SimpleNamespace(host='127.0.0.1',port=8000,websocket_port=8001,carla_host='127.0.0.1',carla_port=2000,
            vehicle='vehicle.other',spawn_index=91,map='Town03',fixed_delta=.1)
        with tempfile.TemporaryDirectory() as directory,patch('backend.carla.start_helper.DIRECTORY',Path(directory)),\
             patch('backend.carla.start_helper.launch_settings',return_value={}),patch('backend.carla.start_helper.subprocess.Popen'),\
             patch('backend.carla.start_helper.threading.Timer'):
            ticket_path=dispatch_start(Mock(),args,{},fresh=True)
            ticket=json.loads(Path(ticket_path).read_text())
        self.assertEqual(ticket['configuration'],fresh_configuration());self.assertTrue(ticket['fresh_start'])
        self.assertIn('--fresh-start',backend_command(ticket));self.assertIn('--start-paused',backend_command(ticket))

    def test_reset_http_rejects_foreign_origins_and_nonempty_requests(self):
        reset=Mock();s=stopped_service({'result':{'status':'STOPPED'}},Mock(),Mock(),reset)
        server=ThreadingHTTPServer(('127.0.0.1',0),Handler);server.simulation_service=s
        worker=threading.Thread(target=server.serve_forever,daemon=True);worker.start()
        url=f'http://127.0.0.1:{server.server_port}/api/simulation/reset-session'
        try:
            for data,origin,code in ((b'{}','https://unrelated.example',403),(b'{"spawn":91}',None,400)):
                headers={'Content-Type':'application/json',**({'Origin':origin} if origin else {})}
                with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(urllib.request.Request(url,data=data,headers=headers))
                self.assertEqual(error.exception.code,code)
            reset.assert_not_called()
            with urllib.request.urlopen(urllib.request.Request(url,data=b'{}',headers={'Content-Type':'application/json'})) as response:
                self.assertEqual(json.load(response)['operation'],'RESET')
            reset.assert_called_once()
        finally:server.shutdown();server.server_close();worker.join(timeout=2)


if __name__=='__main__':unittest.main()
