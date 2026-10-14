import unittest
import tempfile
import json
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock,patch
from backend.core.service import SimulationService
from backend.carla.runtime import NativeRuntime


def service():
    provider=SimpleNamespace(name='carla',sensor_suite=False,
        connection=SimpleNamespace(host='127.0.0.1',port=2000),runtime=SimpleNamespace(stop=Mock()),shutdown_handler=Mock())
    return SimulationService(provider)


class ShutdownTests(unittest.TestCase):
    def test_cleanup_precedes_verified_process_stop_and_dashboard_remains_available(self):
        s=service();order=[];s.close=Mock(side_effect=lambda:order.append('cleanup'))
        s.provider.shutdown_handler.side_effect=lambda status:order.append(('handoff',status['status']))
        s._stop_simulator_native()
        self.assertEqual(order,['cleanup',('handoff','STOPPING')])
        s.provider.runtime.stop.assert_not_called()
        s.simulator_stop={'status':'STOPPED'}
        with self.assertRaisesRegex(ValueError,'Start-YA-RAB'):s.reconnect()

    def test_cleanup_failure_does_not_prevent_explicit_gpu_release_and_is_reported(self):
        s=service();s.close=Mock(side_effect=RuntimeError('recording flush failed'))
        s._stop_simulator_native()
        s.provider.shutdown_handler.assert_called_once()
        self.assertIn('recording flush failed',s.provider.shutdown_handler.call_args.args[0]['cleanup_warning'])

    def test_failed_kill_is_never_reported_as_gpu_release(self):
        s=service();s.close=Mock();s.provider.shutdown_handler.side_effect=RuntimeError('helper failed')
        s._stop_simulator_native()
        self.assertEqual(s.simulator_stop['status'],'FAILED')
        self.assertNotIn('process_exited',s.simulator_stop)

    def test_remote_and_non_native_providers_cannot_kill_local_carla(self):
        s=service();s.provider.connection.host='192.0.2.1'
        with self.assertRaisesRegex(ValueError,'local CARLA'):s.stop_simulator()
        s.provider.connection.host='127.0.0.1';s.provider.name='replay'
        with self.assertRaisesRegex(ValueError,'local CARLA'):s.stop_simulator()
        s.provider.runtime.stop.assert_not_called()

    def test_duplicate_stop_requests_start_one_shutdown_worker(self):
        s=service();s._stop_navigation=Mock();s.release_controls=Mock()
        with patch('backend.core.service.threading.Thread') as thread:
            s.stop_simulator();s.stop_simulator()
            thread.return_value.start.assert_called_once()

    def test_observer_can_explicitly_shutdown_without_stealing_driving_ownership(self):
        from backend.websocket_bridge import WebSocketBridge
        s=SimpleNamespace(rl_runtime=None,restarting=False,is_replay=False,stop_simulator=Mock())
        bridge=WebSocketBridge(s,'127.0.0.1',0,8000);owner=object();bridge.owner=owner
        try:
            self.assertTrue(bridge.process_message(object(),{'type':'stop_simulator'}))
            s.stop_simulator.assert_called_once();self.assertIs(bridge.owner,owner)
        finally:bridge.server.shutdown()

    def test_kill_is_scoped_to_this_rpc_port(self):
        owned={'ProcessId':101,'CommandLine':'CarlaUE4.exe -carla-rpc-port=2000'}
        other={'ProcessId':202,'CommandLine':'CarlaUE4.exe -carla-rpc-port=2001'}
        remaining=[owned,other];runtime=object.__new__(NativeRuntime);runtime.active={}
        def kill(args,**kw):
            self.assertEqual(args,['taskkill','/PID','101','/F']);remaining.remove(owned)
        with patch('backend.carla.runtime.native_processes',side_effect=lambda:list(remaining)),patch('backend.carla.runtime.subprocess.run',side_effect=kill):runtime.stop(port=2000)
        self.assertEqual(remaining,[other]);self.assertIsNone(runtime.active)

    def test_helper_returns_sdk_free_dashboard_only_after_verified_stop(self):
        from backend.carla.stop_helper import finish_stop
        for failure in (None,RuntimeError('engine still running')):
            with self.subTest(failure=failure),tempfile.TemporaryDirectory() as directory:
                path=Path(directory)/'ticket.json'
                ticket={'previous_pid':123,'host':'127.0.0.1','port':8000,'websocket_port':8001,'carla_port':2001,'result':{'status':'STOPPING'}}
                with patch('backend.carla.stop_helper.retire_host') as retire,patch('backend.carla.runtime.NativeRuntime') as runtime,patch('backend.carla.stop_helper.subprocess.Popen') as start:
                    runtime.return_value.stop.side_effect=failure;finish_stop(path,ticket)
                    retire.assert_called_once_with(123);runtime.return_value.stop.assert_called_once_with(port=2001)
                    args=start.call_args.args[0];self.assertNotIn('--carla',args);self.assertIn('--stopped-ticket',args)
                saved=json.loads(path.read_text())['result']
                self.assertEqual(saved['status'],'FAILED' if failure else 'STOPPED')
                self.assertEqual(saved.get('process_exited'),None if failure else True)

    def test_stopped_dashboard_has_no_native_sink_and_supports_a_failed_stop_retry(self):
        from backend.carla.stop_helper import stopped_service
        dispatch=Mock();s=stopped_service({'result':{'status':'FAILED','launch':{'quality':'Epic'}}},dispatch)
        self.assertIsNone(s.provider);self.assertFalse(s.snapshot()['connected']);self.assertTrue(s.snapshot()['simulatorStop']['available'])
        s.stop_simulator();dispatch.assert_called_once();self.assertEqual(s.simulator_stop['status'],'STOPPING')
        with self.assertRaisesRegex(ValueError,'Start-YA-RAB'):s.reconnect()
