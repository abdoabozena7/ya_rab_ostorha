import copy
import hashlib
import json
import os
from pathlib import Path
import sys
from types import ModuleType, SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch

from backend.learning.egypt_budget import DEVELOPMENT_EXTENSION_ID, save_json
from scripts.native import validate_crossing_pair as crossing
from tests.test_egypt_validation import EgyptValidationFixture
from tests.test_native_gil_profile import diagnostic_report


class NativeCrashCaptureAdmissionTests(EgyptValidationFixture):
    def setUp(self):
        super().setUp()
        self.budget.extend_development(DEVELOPMENT_EXTENSION_ID)
        self.binary=self.root/'tmp'/'crash-tool'/'procdump64.exe'
        self.binary.parent.mkdir(parents=True)
        self.binary.write_bytes(b'OFFLINE ADMISSION FIXTURE, NOT AN EXECUTABLE')
        self.stack.enter_context(patch.object(crossing,'ROOT',self.root))
        self.stack.enter_context(patch.object(crossing,'NATIVE_CRASH_TOOL_SHA256',
            hashlib.sha256(self.binary.read_bytes()).hexdigest()))
        self.stack.enter_context(patch.dict(os.environ,{crossing.NATIVE_CRASH_TOOL_ENV:str(self.binary)}))

    def options(self,ticket):
        self.budget.claim_attempt(ticket,2707,'ROBOSPHERE','frozen')
        return NS(seed=2707,first='ROBOSPHERE',scenario='EGYPT_URBAN_CHAOS_V1',diagnostic=True,
            render_profile='LOW',rule_ticket=None,holdout_acceptance=False,seconds=300.,
            egypt_budget=str(self.budget.directory),egypt_reservation=ticket['reservation_id'],
            egypt_deadline=ticket['expires_monotonic_s'])

    def test_default_off_never_validates_or_changes_original_ten_gates(self):
        os.environ.pop(crossing.NATIVE_CRASH_TOOL_ENV)
        with patch.object(crossing,'validate_egypt_worker') as validate:
            self.assertIsNone(crossing.diagnostic_native_crash_request(NS()))
        validate.assert_not_called()
        self.assertEqual(len(crossing.diagnostic_assessment(diagnostic_report())['gates']),10)

    def test_live_exact_diagnostic_request_has_pinned_binary_identity(self):
        with self.budget.experiment('DEVELOPMENT',600,'fixture',purpose='DIAGNOSTIC') as ticket:
            args=self.options(ticket)
            actual=crossing.diagnostic_native_crash_request(args)
            self.assertTrue(actual['requested'])
            self.assertEqual(actual['status'],'REQUESTED')
            self.assertEqual(actual['binary']['executable'],str(self.binary.resolve()))
            self.assertEqual(actual['binary']['sha256'],hashlib.sha256(self.binary.read_bytes()).hexdigest())

    def test_matrix_acceptance_rule_and_wrong_target_refused_before_runtime(self):
        with self.budget.experiment('DEVELOPMENT',7200,'fixture',purpose='MATRIX') as ticket:
            args=self.options(ticket)
            for changes in ({},{'scenario':None},{'diagnostic':False},{'seed':961103},
                            {'rule_ticket':'foreign-rule'},{'holdout_acceptance':True}):
                denied=copy.copy(args);denied.__dict__.update(changes)
                with self.subTest(changes=changes),patch('backend.carla.runtime.NativeRuntime') as runtime:
                    with self.assertRaises(ValueError):
                        crossing.run(denied)
                    runtime.assert_not_called()
        with self.budget.experiment('ACCEPTANCE',7200,'fixture') as ticket:
            with self.assertRaises(ValueError):
                crossing.diagnostic_native_crash_request(self.options(ticket))

    def test_inactive_foreign_and_expired_ticket_are_not_reused(self):
        with self.budget.experiment('DEVELOPMENT',600,'fixture',purpose='DIAGNOSTIC') as ticket:
            args=self.options(ticket)
            with patch.dict(os.environ,{'OSTORHA_EGYPT_RESERVATION':'foreign'}):
                with self.assertRaises(ValueError):
                    crossing.diagnostic_native_crash_request(args)
        with self.assertRaises(ValueError):
            crossing.diagnostic_native_crash_request(args)
        with self.assertRaises(TimeoutError):
            with self.budget.experiment('DEVELOPMENT',600,'fixture',purpose='DIAGNOSTIC') as ticket:
                args=self.options(ticket);self.now=ticket['expires_monotonic_s']+1
                with self.assertRaises(ValueError):
                    crossing.diagnostic_native_crash_request(args)

    def test_unverified_or_escaped_executable_is_rejected(self):
        with self.budget.experiment('DEVELOPMENT',600,'fixture',purpose='DIAGNOSTIC') as ticket:
            args=self.options(ticket)
            outside=self.root/'procdump64.exe';outside.write_bytes(self.binary.read_bytes())
            wrong=self.binary.with_name('other.exe');wrong.write_bytes(self.binary.read_bytes())
            for path in (outside,wrong,self.binary.with_name('missing.exe')):
                with self.subTest(path=path),patch.dict(os.environ,{crossing.NATIVE_CRASH_TOOL_ENV:str(path)}):
                    with self.assertRaises((ValueError,FileNotFoundError)):
                        crossing.diagnostic_native_crash_request(args)
            self.binary.write_bytes(b'CHANGED TOOL')
            with self.assertRaisesRegex(ValueError,'verified Microsoft binary'):
                crossing.diagnostic_native_crash_request(args)

    def test_teardown_capture_refuses_live_driving_hook_or_unsaved_evidence(self):
        with self.budget.experiment('DEVELOPMENT',600,'fixture',purpose='DIAGNOSTIC') as ticket:
            args=self.options(ticket);folder=self.root/'output'/'owned-phase';folder.mkdir(parents=True)
            save_json(folder/'report.json',{'source':'OFFLINE_PHASE_FIXTURE'})
            with self.assertRaisesRegex(RuntimeError,'driving hook'):
                crossing.start_native_teardown_capture(args,folder,NS(after_control=lambda:None),args.egypt_deadline)
            (folder/'report.json').unlink()
            with self.assertRaisesRegex(RuntimeError,'Save original driving evidence'):
                crossing.start_native_teardown_capture(args,folder,NS(after_control=None),args.egypt_deadline)

    def test_teardown_capture_arms_only_after_evidence_and_hook_release(self):
        with self.budget.experiment('DEVELOPMENT',600,'fixture',purpose='DIAGNOSTIC') as ticket:
            args=self.options(ticket);folder=self.root/'output'/'owned-phase';folder.mkdir(parents=True)
            save_json(folder/'report.json',{'source':'OFFLINE_PHASE_FIXTURE'})
            helper=ModuleType('scripts.native.native_crash_capture')
            helper.start_capture=Mock(return_value={'requested':True,'attached':True,'status':'ARMED'})
            with patch.dict(sys.modules,{helper.__name__:helper}):
                result=crossing.start_native_teardown_capture(args,folder,NS(after_control=None),args.egypt_deadline)
            helper.start_capture.assert_called_once()
            self.assertEqual(helper.start_capture.call_args.args[0],folder/'native-crash-capture')
            self.assertLessEqual(helper.start_capture.call_args.kwargs['deadline'],args.egypt_deadline-90.)
            self.assertEqual(result['capture_scope'],'NATIVE_TEARDOWN_ONLY_AFTER_DRIVING_EVIDENCE')

    def test_parent_preserves_real_crash_code_and_finishes_capture_before_cleanup(self):
        with self.budget.experiment('DEVELOPMENT',600,'fixture',purpose='DIAGNOSTIC') as ticket:
            args=self.options(ticket)
            self.stack.enter_context(patch.object(crossing,'time',NS(monotonic=lambda:self.now)))
            self.stack.enter_context(patch('scripts.final_runtime.state',return_value={'connected':False}))
            runtime=self.stack.enter_context(patch('backend.carla.runtime.NativeRuntime')).return_value
            runtime.active=None
            self.stack.enter_context(patch('backend.carla.runtime.native_processes',return_value=[]))
            self.stack.enter_context(patch.object(crossing,'source_hashes',return_value={}))
            self.stack.enter_context(patch('backend.core.egypt_urban.source_fingerprint',return_value='frozen'))
            events=[]
            self.stack.enter_context(patch.object(crossing,'cleanup_probe',
                side_effect=lambda deadline:events.append('cleanup') or {'passed':True}))
            self.stack.enter_context(patch.object(crossing,'verify_videos',return_value={'passed':True}))
            def archive(folder,hashes):
                (folder/'source.zip').write_bytes(b'OFFLINE SOURCE FIXTURE')
                return {'source':'FIXTURE_ONLY'}
            self.stack.enter_context(patch.object(crossing,'archive_sources',side_effect=archive))
            child=Mock(returncode=None)
            child.poll.side_effect=lambda:child.returncode
            def exited(**unused):
                report=diagnostic_report();report['cleanup_stage']='HTTP_SERVER_CLOSE'
                save_json(args.report_folder/'report.json',report)
                child.returncode=0xC00000FD
            child.wait.side_effect=exited
            api=NS(Popen=Mock(return_value=child),STDOUT=-2,CREATE_NO_WINDOW=0,
                   TimeoutExpired=TimeoutError)
            self.stack.enter_context(patch.object(crossing,'subprocess',api))
            helper=ModuleType('scripts.native.native_crash_capture')
            def finish(folder,*,deadline,worker_exit_code):
                events.append('capture')
                self.assertEqual(folder,args.report_folder/'native-crash-capture')
                self.assertLessEqual(deadline,args.egypt_deadline-90.)
                self.assertEqual(worker_exit_code,0xC00000FD)
                return {'requested':True,'attached':True,'cleanup_confirmed':True,
                    'status':'CAPTURED_EXCEPTION','worker_exit_code':worker_exit_code,'error':None}
            helper.finish_capture=Mock(side_effect=finish)
            self.stack.enter_context(patch.dict(sys.modules,{helper.__name__:helper}))
            self.assertEqual(crossing.run(args),1)
            report=json.loads((args.report_folder/'report.json').read_text())
            self.assertEqual(events[:2],['capture','cleanup'])
            self.assertEqual(report['native_worker_exit_code'],0xC00000FD)
            self.assertTrue(report['diagnostic_assessment']['gates']['requested_native_crash_capture_verified'])
            self.assertFalse(report['diagnostic_assessment']['gates']['clean_worker_exit'])
            self.assertFalse(report['diagnostic_passed'])
            helper.finish_capture.assert_called_once()


class NativeCrashCaptureGateTests(unittest.TestCase):
    def capture(self,**changes):
        return {'requested':True,'attached':True,'cleanup_confirmed':True,
                'status':'NO_EXCEPTION','worker_exit_code':0,'error':None,**changes}

    def test_requested_capture_adds_a_gate_without_replacing_original_gates(self):
        original=diagnostic_report()
        report=copy.deepcopy(original);report['diagnostic_native_crash_capture']=self.capture()
        result=crossing.diagnostic_assessment(report)
        self.assertTrue(result['passed'])
        self.assertEqual(len(result['gates']),11)
        for key,value in crossing.diagnostic_assessment(original)['gates'].items():
            self.assertEqual(result['gates'][key],value)

    def test_captured_native_exception_does_not_certify_clean_worker_exit(self):
        report=diagnostic_report();report['native_worker_exit_code']=0xC00000FD
        report['cleanup_stage']='HTTP_SERVER_CLOSE'
        report['diagnostic_native_crash_capture']=self.capture(
            status='CAPTURED_EXCEPTION',worker_exit_code=0xC00000FD)
        result=crossing.diagnostic_assessment(report)
        self.assertTrue(result['gates']['requested_native_crash_capture_verified'])
        self.assertFalse(result['gates']['clean_worker_exit'])
        self.assertFalse(result['passed'])
        self.assertFalse(result['native_acceptance'])

    def test_timeout_unattached_error_and_contradictory_outcomes_stay_failed(self):
        for changes in ({'cleanup_confirmed':False},{'attached':False},{'status':'ARMED'},
                        {'error':'access denied'},{'worker_exit_code':0xC00000FD},
                        {'status':'CAPTURED_EXCEPTION','worker_exit_code':0}):
            with self.subTest(changes=changes):
                report=diagnostic_report();report['diagnostic_native_crash_capture']=self.capture(**changes)
                self.assertFalse(crossing.diagnostic_assessment(report)['passed'])


if __name__=='__main__':
    unittest.main()
