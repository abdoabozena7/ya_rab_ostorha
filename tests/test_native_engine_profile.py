import copy
import json
import os
from pathlib import Path
import struct
import tempfile
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch

from scripts.native.engine_profile import EngineSnapshots, captured, inspect_snapshot
from scripts.native import validate_crossing_pair as crossing
from tests.test_native_gil_profile import diagnostic_report


def snapshot(pid=41, flags=0):
    misc=struct.pack('<III',12,1,pid)
    threads=struct.pack('<III',12,64,1)+bytes(64)
    return (struct.pack('<4sIIIIIQ',b'MDMP',0,2,32,0,100,flags)
            +struct.pack('<III',15,len(misc),56)
            +struct.pack('<III',17,len(threads),56+len(misc))+misc+threads)


class EngineSnapshotTests(unittest.TestCase):
    def test_minimal_snapshot_verifies_pid_thread_info_bounds_and_hash(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'owned.dmp';path.write_bytes(snapshot())
            actual=inspect_snapshot(path,41)
            self.assertEqual(actual['pid'],41)
            self.assertEqual(actual['thread_count'],1)
            self.assertEqual(len(actual['sha256']),64)
            self.assertTrue(actual['thread_info'])

    def test_foreign_pid_full_memory_missing_or_malformed_streams_are_rejected(self):
        for data,pid in ((snapshot(),42),(snapshot(flags=2),41),(snapshot(flags=0x40),41),
                         (snapshot(flags=0x200),41),(snapshot()[:50],41),
                         (b'WRONG'+bytes(120),41),(snapshot(),0)):
            with self.subTest(pid=pid,data=data[:4]),tempfile.TemporaryDirectory() as directory:
                path=Path(directory)/'owned.dmp';path.write_bytes(data)
                with self.assertRaises(ValueError):
                    inspect_snapshot(path,pid)

    def profiler(self,directory,identities=None):
        validate=Mock()
        owner=Mock(return_value=identities if identities is not None else [
            {'ProcessId':41,'ExecutablePath':r'C:\CARLA\CarlaUE4-Win64-Shipping.exe'}])
        jobs=[]
        def job(child):
            closer=Mock();jobs.append(closer);return closer
        profile=EngineSnapshots(NS(),Path(directory),'owned-tool.exe',validate,owner,job)
        return profile,validate,owner,jobs

    def test_default_and_wrong_phase_never_start_or_enumerate_processes(self):
        with tempfile.TemporaryDirectory() as directory:
            profile,validate,owner,_=self.profiler(directory)
            service=NS(presentation=NS(data={'status':'PAUSED'}),observation=NS(frame_id=1,timestamp_s=1.))
            profile.after_control(service)
            service.presentation.data['status']='DRIVING'
            profile.after_control(service)
            validate.assert_not_called();owner.assert_not_called()
            self.assertEqual(profile.children,[])

    def test_ambiguous_or_missing_native_owner_is_refused_before_tool_launch(self):
        for identities in ([],[{'ProcessId':41,'ExecutablePath':'other.exe'}],
                           [{'ProcessId':41,'ExecutablePath':'CarlaUE4-Win64-Shipping.exe'},
                            {'ProcessId':42,'ExecutablePath':'CarlaUE4-Win64-Shipping.exe'}]):
            with self.subTest(identities=identities),tempfile.TemporaryDirectory() as directory:
                profile,_,_,_=self.profiler(directory,identities)
                service=NS(presentation=NS(data={'status':'DRIVING'}),observation=NS(frame_id=1,timestamp_s=1.))
                profile.after_control(service);service.observation=NS(frame_id=81,timestamp_s=5.)
                with patch('scripts.native.engine_profile.subprocess.Popen') as launch:
                    with self.assertRaises(RuntimeError):profile.after_control(service)
                    launch.assert_not_called()

    def test_two_async_owned_snapshots_are_closed_hashed_and_not_native_acceptance(self):
        with tempfile.TemporaryDirectory() as directory:
            profile,validate,_,jobs=self.profiler(directory)
            def launch(command,**kwargs):
                Path(command[-1]).write_bytes(snapshot())
                kwargs['stdout'].write(b'Dump 1 complete: fixture only\n')
                child=Mock(pid=91,returncode=None)
                child.poll.side_effect=lambda:child.returncode
                child.wait.side_effect=lambda **unused:setattr(child,'returncode',0)
                return child
            service=NS(presentation=NS(data={'status':'DRIVING'}),observation=NS(frame_id=1,timestamp_s=1.))
            with patch('scripts.native.engine_profile.subprocess.Popen',side_effect=launch):
                for frame in (1,81,381):
                    service.observation=NS(frame_id=frame,timestamp_s=frame*.05);profile.after_control(service)
                for child,_,_,_ in profile.children:child.wait.assert_not_called()
                result=profile.finish(float('inf'))
            self.assertTrue(captured(result))
            self.assertEqual(validate.call_count,2)
            self.assertEqual(len(jobs),2)
            for job in jobs:job.assert_called_once()
            self.assertEqual([row['frame_id'] for row in result['captures']],[81,381])
            self.assertTrue(all(row['dump_completion_observed'] for row in result['captures']))

    def test_partial_profile_or_error_cannot_pass_capture_gate(self):
        for evidence in ({},{'requested':True,'status':'CAPTURED','cleanup_confirmed':True,'captures':[]},
                         {'requested':True,'status':'ERROR','cleanup_confirmed':True,'captures':[]}):
            self.assertFalse(captured(evidence))

    def test_request_is_default_off_and_requires_exact_switch_tool_and_ticket(self):
        with patch.dict(os.environ,{},clear=True):
            self.assertIsNone(crossing.diagnostic_engine_request(NS()))
        with patch.dict(os.environ,{crossing.ENGINE_PROFILE_ENV:'other'}),self.assertRaises(ValueError):
            crossing.diagnostic_engine_request(NS())
        with patch.dict(os.environ,{crossing.ENGINE_PROFILE_ENV:'1'}),patch.object(
                crossing,'diagnostic_native_crash_request',return_value=None),self.assertRaises(ValueError):
            crossing.diagnostic_engine_request(NS())

    def test_extra_capture_gate_never_replaces_original_failed_timing(self):
        report=diagnostic_report()
        report['pair']['runs']['ROBOSPHERE']['control_latency']['p95_ms']=201.
        report['diagnostic_engine_profile']={'requested':True,'status':'ERROR','captures':[]}
        result=crossing.diagnostic_assessment(report)
        self.assertFalse(result['gates']['sensor_latency_targets'])
        self.assertFalse(result['gates']['requested_engine_snapshots_captured'])
        self.assertFalse(result['passed'])


if __name__=='__main__':
    unittest.main()
