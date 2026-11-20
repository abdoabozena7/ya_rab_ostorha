"""Offline owned-worker fixtures only; no profiler attachment or native launch."""
import copy
import hashlib
import json
import os
from pathlib import Path
import subprocess
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch
import uuid

from backend.learning.egypt_budget import DEVELOPMENT_EXTENSION_ID, save_json
from scripts.native import validate_crossing_pair as crossing
from tests import test_egypt_validation as egypt_tests


def speedscope():
    return {'$schema': 'https://www.speedscope.app/file-format-schema.json',
        'shared': {'frames': [{'name': 'owned_fixture', 'file': 'fixture.py', 'line': 1}]},
        'profiles': [{'type': 'sampled', 'name': 'Fixture thread', 'unit': 'seconds',
            'startValue': 0., 'endValue': .03, 'samples': [[0], [0], [0]], 'weights': [.01] * 3}]}


def diagnostic_report():
    return {'seed': 2707, 'first_mode': 'ROBOSPHERE', 'source_sha256': 'frozen',
        'pair': {'runs': {'ROBOSPHERE': {'distance_m': 51., 'duration_s': 30., 'collisions': 0,
            'status': 'PAUSED', 'reason': 'diagnostic_goal_reached',
            'control_latency': {'samples': 601, 'p95_ms': 200., 'p99_ms': 225.,
                'deadline_exceeded_frames': 0, 'carla_call_p99_ms': 2.}}}},
        'native_worker_exit_code': 0, 'cleanup_stage': 'COMPLETE', 'cleanup_confirmed': True,
        'exports_closed': True, 'video_playback_after_exit': {'passed': True},
        'independent_cleanup_probe': {'passed': True}, 'simulator_exit_confirmed': True,
        'source_unchanged': True, 'attempts_retained': True}


class NativeGILProfileTests(egypt_tests.EgyptValidationFixture):
    def setUp(self):
        super().setUp()
        self.budget.extend_development(DEVELOPMENT_EXTENSION_ID)
        self.binary = self.root / 'tmp' / 'bin' / 'py-spy.exe'
        self.binary.parent.mkdir(parents=True)
        self.binary.write_bytes(b'NOT EXECUTABLE: offline py-spy fixture')
        self.digest = hashlib.sha256(self.binary.read_bytes()).hexdigest()
        self.stack.enter_context(patch.object(crossing, 'ROOT', self.root))
        self.stack.enter_context(patch.object(crossing, 'GIL_PROFILER_SHA256', self.digest))
        self.stack.enter_context(patch.dict(os.environ, {crossing.GIL_PROFILER_ENV: str(self.binary)}))
        self.stack.enter_context(patch.object(crossing, 'time', NS(
            monotonic=lambda: self.now, time=lambda: 1793270000. + self.now)))
        self.api = NS(run=Mock(return_value=NS(returncode=0, stdout='py-spy 0.4.1\n', stderr='')),
            Popen=Mock(side_effect=self.launch), STDOUT=subprocess.STDOUT,
            CREATE_NO_WINDOW=0, TimeoutExpired=subprocess.TimeoutExpired, SubprocessError=subprocess.SubprocessError)
        self.stack.enter_context(patch.object(crossing, 'subprocess', self.api))
        self.close_job = Mock()
        self.job = self.stack.enter_context(patch.object(crossing, 'gil_profiler_job', return_value=self.close_job))
        self.output = json.dumps(speedscope()).encode()
        self.exit_code = 0
        self.service = NS(presentation=NS(data={'status': 'DRIVING'}), session_id='fixture-session',
                          observation=NS(frame_id=42, timestamp_s=2.1))

    def options(self, ticket, **changes):
        return NS(seed=2707, first='ROBOSPHERE', scenario='EGYPT_URBAN_CHAOS_V1', diagnostic=True,
            render_profile='LOW', rule_ticket=None, holdout_acceptance=False, seconds=180.,
            egypt_budget=str(self.budget.directory), egypt_reservation=ticket['reservation_id'],
            egypt_deadline=ticket['expires_monotonic_s'], **changes)

    def claim(self, ticket):
        self.budget.claim_attempt(ticket, 2707, 'ROBOSPHERE', 'frozen')
        return self.options(ticket)

    def profiler(self, args):
        folder = self.root / 'output' / 'egypt-urban-pairs' / uuid.uuid4().hex
        folder.mkdir(parents=True)
        profiler = crossing.DiagnosticGILProfiler(args, folder, crossing.diagnostic_gil_request(args))
        self.addCleanup(lambda: profiler.finish(self.now))
        return profiler

    def launch(self, command, **kwargs):
        self.assertEqual(command[1], 'record')
        kwargs['stdout'].write(b'fixture stdout\nfixture stderr\n')
        if self.output is not None:
            Path(command[-1]).write_bytes(self.output)
        self.child = Mock(pid=880042, returncode=None)
        self.child.poll.side_effect = lambda: self.child.returncode
        def wait(**unused):
            self.child.returncode = self.exit_code
            return self.child.returncode
        self.child.wait.side_effect = wait
        self.child.terminate.side_effect = lambda: setattr(self.child, 'returncode', -15)
        self.child.kill.side_effect = lambda: setattr(self.child, 'returncode', -9)
        return self.child

    def test_default_off_never_validates_executes_or_adds_a_gate(self):
        os.environ.pop(crossing.GIL_PROFILER_ENV)
        with patch.object(crossing, 'validate_egypt_worker') as validate:
            self.assertIsNone(crossing.diagnostic_gil_request(NS()))
        validate.assert_not_called()
        self.api.run.assert_not_called()
        self.api.Popen.assert_not_called()
        self.assertEqual(len(crossing.diagnostic_assessment(diagnostic_report())['gates']), 10)

    def test_denied_modes_and_partitions_stop_before_any_native_or_tool_process(self):
        with self.budget.experiment('DEVELOPMENT', 7200, 'fixture', purpose='MATRIX') as ticket:
            args = self.claim(ticket)
            for changes in ({}, {'diagnostic': False}, {'scenario': None}, {'holdout_acceptance': True},
                            {'seed': 961103}, {'rule_ticket': 'foreign-ticket'}):
                denied = copy.copy(args)
                denied.__dict__.update(changes)
                with self.subTest(changes=changes), patch('backend.carla.runtime.NativeRuntime') as runtime:
                    with self.assertRaises(ValueError):
                        crossing.run(denied)
                    runtime.assert_not_called()
        with self.budget.experiment('ACCEPTANCE', 7200, 'fixture') as ticket:
            with self.assertRaises(ValueError):
                crossing.diagnostic_gil_request(self.options(ticket))
        with patch.object(crossing, 'validate_egypt_worker',
                          return_value={'phase': 'ACCEPTANCE', 'purpose': 'DIAGNOSTIC'}):
            with self.assertRaisesRegex(ValueError, 'DEVELOPMENT/DIAGNOSTIC'):
                crossing.diagnostic_gil_request(self.options(ticket))
        self.api.run.assert_not_called()
        self.api.Popen.assert_not_called()

    def test_foreign_inactive_and_expired_tickets_are_rejected(self):
        with self.budget.experiment('DEVELOPMENT', 600, 'fixture', purpose='DIAGNOSTIC') as ticket:
            args = self.claim(ticket)
            with patch.dict(os.environ, {'OSTORHA_EGYPT_RESERVATION': 'foreign'}):
                with self.assertRaisesRegex(ValueError, 'exact parent reservation'):
                    crossing.diagnostic_gil_request(args)
        with self.assertRaisesRegex(ValueError, 'exact parent reservation'):
            crossing.diagnostic_gil_request(args)
        with self.assertRaises(TimeoutError):
            with self.budget.experiment('DEVELOPMENT', 600, 'fixture', purpose='DIAGNOSTIC') as ticket:
                args = self.claim(ticket)
                self.now = ticket['expires_monotonic_s'] + 1
                with self.assertRaisesRegex(ValueError, 'exact parent reservation'):
                    crossing.diagnostic_gil_request(args)
        self.api.run.assert_not_called()
        self.api.Popen.assert_not_called()

    def test_unsafe_executables_hashes_versions_and_probe_failures_are_rejected(self):
        with self.budget.experiment('DEVELOPMENT', 600, 'fixture', purpose='DIAGNOSTIC') as ticket:
            args = self.claim(ticket)
            wrong_name = self.binary.with_name('other.exe')
            wrong_name.write_bytes(self.binary.read_bytes())
            for path in ('', str(self.root / 'py-spy.exe'), str(wrong_name),
                         str(self.root / 'tmp' / '..' / 'py-spy.exe'), str(self.binary.with_name('missing.exe'))):
                with self.subTest(path=path), patch.dict(os.environ, {crossing.GIL_PROFILER_ENV: path}):
                    with self.assertRaises((ValueError, OSError)):
                        crossing.diagnostic_gil_request(args)
            self.api.run.assert_not_called()
            with patch.object(crossing, 'GIL_PROFILER_SHA256', '0' * 64):
                with self.assertRaisesRegex(ValueError, 'SHA-256'):
                    crossing.diagnostic_gil_request(args)
            for result in (NS(returncode=0, stdout='py-spy 0.5.0', stderr=''),
                           NS(returncode=7, stdout='', stderr='fixture version denial')):
                self.api.run.return_value = result
                with self.assertRaisesRegex(ValueError, 'version check failed'):
                    crossing.diagnostic_gil_request(args)
            self.api.run.side_effect = subprocess.TimeoutExpired('fixture --version', 5)
            with self.assertRaises(subprocess.TimeoutExpired):
                crossing.diagnostic_gil_request(args)
        self.api.Popen.assert_not_called()

    def test_one_self_pid_record_after_actuation_retains_full_identity_and_valid_capture(self):
        from tests.test_braking_decisions import fixture
        with self.budget.experiment('DEVELOPMENT', 600, 'fixture', purpose='DIAGNOSTIC') as ticket:
            self.budget.claim_attempt(ticket, 1703, 'NORMAL', 'frozen')
            args = self.options(ticket)
            args.seed, args.first = 1703, 'NORMAL'
            args.pid = 123456  # Caller PIDs cannot influence the target.
            profiler = self.profiler(args)
            self.service.presentation.data['status'] = 'PREPARING'
            profiler.after_control(self.service)
            self.api.Popen.assert_not_called()
            service, _, _ = fixture(driving_mode='NORMAL', automatic=True)
            self.addCleanup(service.close)
            service.presentation.data.update(status='DRIVING', arm='NORMAL')
            def after_actuation(command, **kwargs):
                service.provider.apply_control.assert_called()
                service.provider.step.assert_not_called()
                return self.launch(command, **kwargs)
            self.api.Popen.side_effect = after_actuation
            service.after_control = lambda: profiler.after_control(service)
            service._iteration()
            profiler.after_control(service)
            self.assertEqual(self.api.Popen.call_count, 1)
            command = self.api.Popen.call_args.args[0]
            self.assertEqual(command, [str(self.binary), 'record', '--pid', str(os.getpid()),
                '--duration', '60', '--rate', '100', '--threads', '--gil', '--nonblocking',
                '--format', 'speedscope', '--output', str(profiler.folder / 'gil-profile.speedscope.json')])
            self.assertNotIn('--locals', command)
            self.assertNotIn('--subprocesses', command)
            self.assertEqual(self.api.Popen.call_args.kwargs['stderr'], subprocess.STDOUT)
            self.now += 60
            profiler.finish(ticket['expires_monotonic_s'] - 120)
            profiler.finish(self.now)
            evidence = profiler.evidence
            self.assertTrue(crossing.gil_profile_captured(evidence))
            self.assertEqual(evidence['worker_identity']['pid'], os.getpid())
            self.assertEqual(evidence['worker_identity']['session_id'], service.session_id)
            self.assertEqual(evidence['worker_identity']['frame_id'], 1)
            self.assertEqual(evidence['binary']['sha256'], self.digest)
            self.assertEqual(evidence['binary']['version'], 'py-spy 0.4.1')
            self.assertEqual(evidence['profiler_pid'], 880042)
            self.assertEqual(evidence['output']['sample_count'], 3)
            self.assertEqual(evidence['output']['sha256'], hashlib.sha256(self.output).hexdigest())
            self.assertEqual(Path(evidence['log']['path']).read_bytes(), b'fixture stdout\nfixture stderr\n')
            self.assertEqual(evidence['log']['sha256'], hashlib.sha256(b'fixture stdout\nfixture stderr\n').hexdigest())
            self.assertEqual(evidence['end_clocks']['monotonic_s'] - evidence['start_clocks']['monotonic_s'], 60)
            self.assertIsNotNone(evidence['start_clocks']['unix_time_s'])
            self.close_job.assert_called_once()
            self.assertTrue(profiler.log.closed)
            self.assertEqual(json.loads((profiler.folder / 'gil-profile-status.json').read_text()), evidence)

    def test_profile_output_must_stay_in_its_owned_pair_folder(self):
        with self.budget.experiment('DEVELOPMENT', 600, 'fixture', purpose='DIAGNOSTIC') as ticket:
            args = self.claim(ticket)
            request = crossing.diagnostic_gil_request(args)
            with self.assertRaisesRegex(ValueError, 'owned Egypt pair folder'):
                crossing.DiagnosticGILProfiler(args, self.root, request)
        self.api.Popen.assert_not_called()

    def test_missing_empty_invalid_and_nonzero_outputs_are_not_captured(self):
        empty = speedscope()
        empty['profiles'][0]['samples'] = []
        empty['profiles'][0]['weights'] = []
        bad_stack = speedscope()
        bad_stack['profiles'][0]['samples'][0] = [99]
        with self.budget.experiment('DEVELOPMENT', 600, 'fixture', purpose='DIAGNOSTIC') as ticket:
            args = self.claim(ticket)
            for raw, code in ((None, 0), (b'', 0), (b'not JSON', 0), (b'{}', 0),
                              (b'{"shared":null}', 0), (json.dumps(empty).encode(), 0),
                              (json.dumps(bad_stack).encode(), 0), (self.output, 7)):
                with self.subTest(raw=raw, code=code):
                    self.output, self.exit_code = raw, code
                    profiler = self.profiler(args)
                    profiler.after_control(self.service)
                    profiler.finish(ticket['expires_monotonic_s'] - 120)
                    self.assertFalse(crossing.gil_profile_captured(profiler.evidence))
                    self.assertEqual(profiler.evidence['status'], 'ERROR')
                    self.assertTrue(profiler.evidence['error'])
                    self.assertTrue(profiler.evidence['cleanup_confirmed'])
                    self.assertTrue(profiler.log.closed)
                    if raw is not None:
                        self.assertEqual(profiler.evidence['output']['sha256'], hashlib.sha256(raw).hexdigest())

    def test_timeout_and_expired_wait_stop_only_the_owned_child_without_promoting_partial_output(self):
        with self.budget.experiment('DEVELOPMENT', 600, 'fixture', purpose='DIAGNOSTIC') as ticket:
            args = self.claim(ticket)
            for escalate, deadline in ((False, 200.), (True, 200.), (False, 99.)):
                with self.subTest(escalate=escalate, deadline=deadline):
                    profiler = self.profiler(args)
                    profiler.after_control(self.service)
                    original_wait = self.child.wait.side_effect
                    failures = [subprocess.TimeoutExpired('fixture py-spy', 60)]
                    if escalate:
                        failures.append(subprocess.TimeoutExpired('fixture py-spy', 2))
                        self.child.terminate.side_effect = None
                    def wait(**kwargs):
                        if failures:
                            raise failures.pop(0)
                        return original_wait(**kwargs)
                    if deadline > self.now:
                        self.child.wait.side_effect = wait
                    profiler.finish(deadline)
                    self.assertEqual(profiler.evidence['status'], 'INCOMPLETE')
                    self.assertFalse(crossing.gil_profile_captured(profiler.evidence))
                    self.child.terminate.assert_called_once()
                    self.assertEqual(self.child.kill.call_count, int(escalate))
                    self.assertTrue(profiler.evidence['cleanup_confirmed'])
                    self.assertEqual(profiler.evidence['output']['sample_count'], 3)
                    self.assertTrue(profiler.log.closed)

    def test_spawn_job_and_cleanup_failures_remain_explicit_and_close_owned_resources(self):
        with self.budget.experiment('DEVELOPMENT', 600, 'fixture', purpose='DIAGNOSTIC') as ticket:
            args = self.claim(ticket)
            self.api.Popen.side_effect = OSError('fixture spawn denied')
            profiler = self.profiler(args)
            profiler.after_control(self.service)
            self.assertEqual(profiler.evidence['error'], 'fixture spawn denied')
            self.assertEqual(profiler.evidence['status'], 'ERROR')
            self.assertTrue(profiler.log.closed)
            self.api.Popen.side_effect = self.launch
            self.job.side_effect = OSError('fixture job denied')
            profiler = self.profiler(args)
            profiler.after_control(self.service)
            self.assertEqual(profiler.evidence['error'], 'fixture job denied')
            self.child.terminate.assert_called_once()
            self.assertTrue(profiler.evidence['cleanup_confirmed'])
            self.job.side_effect = None
            self.close_job.side_effect = OSError('fixture job close failed')
            profiler = self.profiler(args)
            profiler.after_control(self.service)
            profiler.finish(200.)
            self.assertFalse(crossing.gil_profile_captured(profiler.evidence))
            self.assertEqual(profiler.evidence['cleanup_error'], 'fixture job close failed')
            self.assertTrue(profiler.log.closed)

    def test_never_driving_changed_binary_and_stale_destinations_cannot_capture(self):
        with self.budget.experiment('DEVELOPMENT', 600, 'fixture', purpose='DIAGNOSTIC') as ticket:
            args = self.claim(ticket)
            profiler = self.profiler(args)
            profiler.finish(200.)
            self.assertEqual(profiler.evidence['status'], 'INCOMPLETE')
            self.api.Popen.assert_not_called()
            profiler = self.profiler(args)
            self.binary.write_bytes(b'changed after preflight')
            profiler.after_control(self.service)
            self.assertIn('changed before DRIVING', profiler.evidence['error'])
            self.api.Popen.assert_not_called()
            self.binary.write_bytes(b'NOT EXECUTABLE: offline py-spy fixture')
            profiler = self.profiler(args)
            Path(profiler.evidence['output']['path']).write_bytes(self.output)
            profiler.after_control(self.service)
            self.assertIn('refusing to overwrite', profiler.evidence['error'])
            self.api.Popen.assert_not_called()

    def test_original_ten_gates_and_worker_default_return_are_preserved(self):
        report = diagnostic_report()
        original = {'measured_diagnostic_goal', 'protected_without_contact', 'no_control_timeout',
            'sensor_latency_targets', 'clean_worker_exit', 'exports_closed', 'saved_video_playback',
            'independent_cleanup', 'engine_exited', 'source_unchanged'}
        self.assertEqual(crossing.diagnostic_assessment(report)['gates'], dict.fromkeys(original, True))
        args = NS(seed=2707, first='ROBOSPHERE')
        self.assertTrue(crossing.diagnostic_worker_passed(args, report))
        for profile in ({'requested': True}, {'requested': True, 'status': 'ERROR'},
                        {'requested': True, 'status': 'CAPTURED', 'returncode': 0, 'output': {}}):
            report['diagnostic_gil_profile'] = profile
            result = crossing.diagnostic_assessment(report)
            self.assertFalse(result['gates']['requested_profile_captured'])
            self.assertFalse(result['passed'])
            self.assertEqual(set(result['gates']), original | {'requested_profile_captured'})
            self.assertFalse(crossing.diagnostic_worker_passed(args, report))
        with self.budget.experiment('DEVELOPMENT', 600, 'fixture', purpose='DIAGNOSTIC') as ticket:
            profiler = self.profiler(self.claim(ticket))
            profiler.after_control(self.service)
            profiler.finish(200.)
        report['diagnostic_gil_profile'] = profiler.evidence
        self.assertTrue(crossing.diagnostic_assessment(report)['passed'])
        self.assertTrue(crossing.diagnostic_worker_passed(args, report))
        for gate, path, value in (
                ('measured_diagnostic_goal', ('pair', 'runs', 'ROBOSPHERE', 'distance_m'), 0),
                ('protected_without_contact', ('pair', 'runs', 'ROBOSPHERE', 'collisions'), 1),
                ('no_control_timeout', ('error',), 'fixture control timeout'),
                ('sensor_latency_targets', ('pair', 'runs', 'ROBOSPHERE', 'control_latency', 'p95_ms'), 206.428),
                ('clean_worker_exit', ('native_worker_exit_code',), 3),
                ('exports_closed', ('exports_closed',), False),
                ('saved_video_playback', ('video_playback_after_exit', 'passed'), False),
                ('independent_cleanup', ('independent_cleanup_probe', 'passed'), False),
                ('engine_exited', ('simulator_exit_confirmed',), False),
                ('source_unchanged', ('source_unchanged',), False)):
            with self.subTest(gate=gate):
                broken = copy.deepcopy(report)
                current = broken
                for key in path[:-1]:
                    current = current[key]
                current[path[-1]] = value
                result = crossing.diagnostic_assessment(broken)
                self.assertFalse(result['gates'][gate])
                self.assertTrue(result['gates']['requested_profile_captured'])
                self.assertFalse(result['passed'])

    def test_supervisor_does_not_lose_requested_failure_when_worker_omits_profile(self):
        with self.budget.experiment('DEVELOPMENT', 600, 'fixture', purpose='DIAGNOSTIC') as ticket:
            args = self.claim(ticket)
            self.stack.enter_context(patch('scripts.final_runtime.state', return_value={'connected': False}))
            runtime = self.stack.enter_context(patch('backend.carla.runtime.NativeRuntime')).return_value
            runtime.active = None
            self.stack.enter_context(patch('backend.carla.runtime.native_processes', return_value=[]))
            self.stack.enter_context(patch.object(crossing, 'source_hashes', return_value={}))
            self.stack.enter_context(patch('backend.core.egypt_urban.source_fingerprint', return_value='frozen'))
            self.stack.enter_context(patch.object(crossing, 'cleanup_probe', return_value={'passed': True}))
            self.stack.enter_context(patch.object(crossing, 'verify_videos', return_value={'passed': True}))
            def archive(folder, hashes):
                (folder / 'source.zip').write_bytes(b'offline source archive fixture')
                return {'source': 'FIXTURE_ONLY'}
            self.stack.enter_context(patch.object(crossing, 'archive_sources', side_effect=archive))
            child = Mock(returncode=None)
            child.poll.side_effect = lambda: child.returncode
            self.api.Popen.side_effect = None
            self.api.Popen.return_value = child
            for malformed_marker in (False, True):
                def finalize(**unused):
                    save_json(args.report_folder / 'report.json', diagnostic_report())
                    if malformed_marker:
                        (args.report_folder / 'gil-profile-status.json').write_text('not JSON')
                    child.returncode = 0
                child.returncode = None
                child.wait.side_effect = finalize
                self.assertEqual(crossing.run(args), 1)
                saved = json.loads((args.report_folder / 'report.json').read_text())
                self.assertEqual(saved['diagnostic_gil_profile']['status'], 'ERROR' if malformed_marker else 'INCOMPLETE')
                self.assertFalse(saved['diagnostic_assessment']['gates']['requested_profile_captured'])
                self.assertTrue(all(value for key, value in saved['diagnostic_assessment']['gates'].items()
                                    if key != 'requested_profile_captured'))
                self.assertFalse(saved['diagnostic_passed'])


class GILProfilerJobTests(unittest.TestCase):
    def test_windows_job_uses_only_owned_handle_and_closes_on_success_or_assignment_failure(self):
        for assign in (True, False):
            with self.subTest(assign=assign), patch('ctypes.WinDLL') as dll, patch('ctypes.get_last_error', return_value=5):
                kernel = dll.return_value
                kernel.CreateJobObjectW.return_value = 42000
                kernel.SetInformationJobObject.return_value = True
                kernel.AssignProcessToJobObject.return_value = assign
                kernel.CloseHandle.return_value = True
                child = NS(_handle=43000)
                if assign:
                    close = crossing.gil_profiler_job(child)
                    kernel.CloseHandle.assert_not_called()
                    close()
                else:
                    with self.assertRaises(OSError):
                        crossing.gil_profiler_job(child)
                kernel.CreateJobObjectW.assert_called_once_with(None, None)
                kernel.AssignProcessToJobObject.assert_called_once_with(42000, 43000)
                self.assertEqual(kernel.SetInformationJobObject.call_args.args[2]._obj.basic.flags, 0x2000)
                kernel.CloseHandle.assert_called_once_with(42000)
