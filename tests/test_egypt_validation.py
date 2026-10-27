import copy
from contextlib import ExitStack
import hashlib
from http.server import ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch
import urllib.request

from backend.core.egypt_urban import (
    acceptance_matrix, configuration, deployment_status, evaluate_matrix, evaluate_pair, scenario_catalog,
)
from backend.learning.egypt_budget import (
    DEVELOPMENT_EXTENSION_ID, EgyptBudget, active_ticket, effective_caps, ownership_status,
    require_simulator_access, save_json,
)
from backend.server import Handler
from scripts.native import validate_egypt_urban as runner
from scripts.native.validate_crossing_pair import validate_egypt_worker
from tests.test_egypt_urban import accepted_pair


def measured_pair(seed, first, *, acceptance):
    pair = accepted_pair()
    for run in pair['runs'].values():
        run['control_latency'] = {'samples': 600, 'p95_ms': 200., 'p99_ms': 225.,
                                  'deadline_exceeded_frames': 0, 'carla_call_p99_ms': 2.}
    pair['order'] = [first, 'ROBOSPHERE' if first == 'NORMAL' else 'NORMAL']
    for setup in [pair['manifest'], *(run['setup'] for run in pair['runs'].values())]:
        setup['comparison_scenario']['seed'] = seed
        setup['seed_partition'] = 'HOLDOUT' if acceptance else 'DEVELOPMENT'
    pair['conditions_match'] = True
    pair['scenario_validation'] = evaluate_pair(pair)
    return {'seed': seed, 'first_mode': first, 'source': 'LIVE_NATIVE_CARLA', 'source_sha256': 'frozen',
            'source_unchanged': True, 'attempts_retained': True, 'native_acceptance': True, 'pair': pair,
            'completed_without_shortening': True, 'finish_completed': True, 'exports_closed': True,
            'cleanup_confirmed': True, 'simulator_exit_confirmed': True,
            'native_worker_exit_code': 0, 'cleanup_stage': 'COMPLETE',
            'independent_cleanup_probe': {'passed': True}, 'video_playback_after_exit': {'passed': True},
            'render_profile': {'render_profile': 'LOW', 'renderer': configuration()['native_renderer']}}


def measured_matrix(*, acceptance):
    return [measured_pair(item['seed'], item['first_mode'], acceptance=acceptance)
            for item in runner.matrix_plan(acceptance=acceptance)]


class EgyptValidationFixture(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.owner = self.root / 'simulator-owner.json'
        self.progress = self.root / 'progress.json'
        self.stack.enter_context(patch('backend.learning.egypt_budget.OWNERSHIP', self.owner))
        self.stack.enter_context(patch('backend.learning.egypt_budget.PROGRESS', self.progress))
        self.stack.enter_context(patch.object(runner, 'PROGRESS', self.progress))
        self.stack.enter_context(patch.dict(os.environ, {}, clear=False))
        for name in ('OSTORHA_EGYPT_BUDGET', 'OSTORHA_EGYPT_RESERVATION', 'OSTORHA_EGYPT_DEADLINE'):
            os.environ.pop(name, None)
        self.now = 100.
        clock = runner.SimpleNamespace(monotonic=lambda: self.now, sleep=time.sleep)
        for module in ('backend.learning.egypt_budget', 'backend.core.egypt_urban',
                       'scripts.native.validate_egypt_urban', 'scripts.native.validate_crossing_pair'):
            self.stack.enter_context(patch(module + '.time', clock))
        self.budget = EgyptBudget.create(self.root / 'allowance')


class IsolatedEgyptTests(EgyptValidationFixture):
    def test_development_extension_is_immutable_idempotent_and_preserves_prior_charges(self):
        with self.budget.experiment('DEVELOPMENT', 300, 'old-development'):
            self.now += 123
        original = self.budget.status()
        base = self.budget.authorization.read_bytes()
        self.assertTrue(self.budget.extend_development(DEVELOPMENT_EXTENSION_ID))
        extended = self.budget.status()
        self.assertEqual(extended['cap_s'], 21600)
        self.assertEqual(extended['development_remaining_s'], 14400 - 123)
        self.assertEqual(extended['acceptance_remaining_s'], 7200)
        self.assertEqual(extended['reservations'], original['reservations'])
        self.assertEqual(extended['extensions'][0]['prior_ledger_sha256'], original['sha256'])
        self.assertEqual(self.budget.authorization.read_bytes(), base)
        self.assertFalse(self.budget.extend_development(DEVELOPMENT_EXTENSION_ID))
        self.assertEqual(self.budget.status()['sha256'], extended['sha256'])
        with self.assertRaises(ValueError):
            self.budget.extend_development('another-extension')
        import sqlite3
        from contextlib import closing
        with closing(self.budget.connect()) as db, self.assertRaises(sqlite3.IntegrityError):
            db.execute('DELETE FROM extensions')
        with self.assertRaises(ValueError):
            effective_caps(extended['extensions'] * 2)

    def test_diagnostics_preserve_matrix_and_browser_windows(self):
        self.budget.extend_development(DEVELOPMENT_EXTENSION_ID)
        available = self.budget.status()['diagnostic_remaining_s']
        with self.budget.experiment('DEVELOPMENT', available, 'diagnosis', purpose='DIAGNOSTIC') as ticket:
            self.assertEqual(ticket['purpose'], 'DIAGNOSTIC')
            self.now += available
        with self.assertRaisesRegex(ValueError, 'preserve'):
            with self.budget.experiment('DEVELOPMENT', 1, 'extra-diagnosis', purpose='DIAGNOSTIC'):
                self.fail('Spent protected development time')
        with self.budget.experiment('DEVELOPMENT', 7200, 'matrix', purpose='MATRIX'):
            self.now += 7200
        with self.budget.experiment('DEVELOPMENT', 480, 'browser', purpose='BROWSER'):
            self.now += 480
        self.assertEqual(self.budget.status()['development_remaining_s'], 0)
        self.assertEqual(self.budget.status()['acceptance_remaining_s'], 7200)

    def test_separate_allowance_never_resets_or_charges_old_ledgers(self):
        research = self.root / 'research.sqlite'
        rule = self.root / 'rule.json'
        research.write_bytes(b'untouched research fixture')
        rule.write_text('{"scope":"NATIVE_RULE_REPAIR","allowance_s":3600}')
        before = [hashlib.sha256(path.read_bytes()).hexdigest() for path in (research, rule)]
        with self.budget.experiment('DEVELOPMENT', 300, self.root / 'attempt.json'):
            self.now += 123.
        self.assertEqual(self.budget.status()['charged_s'], 123.)
        self.assertEqual(self.budget.status()['acceptance_remaining_s'], 7200.)
        self.assertEqual(before, [hashlib.sha256(path.read_bytes()).hexdigest() for path in (research, rule)])
        with self.assertRaises(ValueError):
            EgyptBudget.create(self.budget.directory)
        for seconds in (True, float('nan'), float('inf'), 7201., -1.):
            with self.assertRaises(ValueError):
                with self.budget.experiment('DEVELOPMENT', seconds, 'invalid'):
                    self.fail('Invalid reservation entered')

    def test_development_cannot_borrow_protected_acceptance_and_acceptance_cannot_retry(self):
        with self.budget.experiment('DEVELOPMENT', 7200, 'development'):
            self.now += 7200
        with self.assertRaisesRegex(ValueError, 'acceptance window is protected'):
            with self.budget.experiment('DEVELOPMENT', 1, 'exhausted'):
                self.fail('Spent protected time')
        self.assertEqual(self.budget.status()['acceptance_remaining_s'], 7200.)
        with self.budget.experiment('ACCEPTANCE', 7200, 'acceptance'):
            self.now += 20
        with self.assertRaisesRegex(ValueError, 'one-shot'):
            with self.budget.experiment('ACCEPTANCE', 7200, 'retry'):
                self.fail('Retried acceptance')

    def test_failed_interrupted_and_overdue_work_remain_charged(self):
        for error, outcome in ((RuntimeError('setup failed'), 'FAILED'), (KeyboardInterrupt(), 'INTERRUPTED')):
            with self.assertRaises(type(error)):
                with self.budget.experiment('DEVELOPMENT', 180, 'failed'):
                    self.now += 60
                    raise error
            self.assertEqual(self.budget.status()['reservations'][-1]['outcome'], outcome)
        with self.assertRaisesRegex(TimeoutError, 'expired'):
            with self.budget.experiment('DEVELOPMENT', 180, 'overdue'):
                self.now += 181
        self.assertEqual(self.budget.status()['reservations'][-1]['outcome'], 'EXPIRED')
        self.assertEqual(self.budget.status()['charged_s'], 301)
        self.assertFalse(self.owner.exists())

    def test_cleanup_failure_retains_exclusive_lock_and_actual_overrun_is_not_hidden(self):
        with self.assertRaises(TimeoutError):
            with self.budget.experiment('DEVELOPMENT', 7200, 'cleanup-failure') as ticket:
                self.budget.activate(ticket)
                ticket['cleanup_verified'] = False
                self.now += 7201
        status = self.budget.status()
        self.assertEqual(status['charged_s'], 7201)
        self.assertEqual(status['remaining_s'], 7199)
        self.assertTrue(self.owner.is_file())
        self.assertEqual(ownership_status()['stage'], 'CLEANUP_REQUIRED')
        require_simulator_access(shutdown=True)
        with self.assertRaises(RuntimeError):
            require_simulator_access()

    def test_crashed_reservation_keeps_its_full_charge_and_blocks_new_native_work(self):
        crash_budget = EgyptBudget.create(self.root / 'crash')
        code = (
            'import os; from pathlib import Path; import backend.learning.egypt_budget as b; '
            f'b.OWNERSHIP=Path({str(self.owner)!r}); budget=b.EgyptBudget({str(crash_budget.directory)!r}); '
            'context=budget.experiment("DEVELOPMENT",7200,"crashed-attempt"); context.__enter__(); os._exit(7)'
        )
        result = subprocess.run([sys.executable, '-c', code], capture_output=True, timeout=20)
        self.assertEqual(result.returncode, 7, result.stderr)
        status = crash_budget.status()
        self.assertEqual(status['charged_s'], 7200)
        self.assertEqual(status['unfinished'], 1)
        self.assertEqual(status['acceptance_remaining_s'], 7200)
        with self.assertRaises(FileExistsError):
            with crash_budget.experiment('ACCEPTANCE', 7200, 'blocked'):
                self.fail('Interrupted native ownership was ignored')

    def test_worker_uses_exact_reservation_partition_and_delegated_deadline(self):
        with self.budget.experiment('DEVELOPMENT', 1200, 'worker') as ticket:
            self.budget.claim_attempt(ticket, 1703, 'NORMAL', 'frozen')
            options = runner.SimpleNamespace(egypt_budget=str(self.budget.directory), egypt_reservation=ticket['reservation_id'],
                egypt_deadline=1000., seed=1703, first='NORMAL', render_profile='LOW', holdout_acceptance=False)
            self.assertEqual(validate_egypt_worker(options)['expires_monotonic_s'], 1000.)
            for deadline in (99., 1301., float('inf'), float('nan')):
                options.egypt_deadline = deadline
                with self.assertRaises(ValueError):
                    validate_egypt_worker(options)
            options.egypt_deadline = 1000.
            options.holdout_acceptance = True
            with self.assertRaisesRegex(ValueError, 'partition'):
                validate_egypt_worker(options)
            os.environ['OSTORHA_EGYPT_DEADLINE'] = '150'
            self.assertEqual(active_ticket()['expires_monotonic_s'], 150.)
            self.now = 151.
            self.assertIsNone(active_ticket())
            with self.assertRaises(RuntimeError):
                require_simulator_access()
            require_simulator_access(shutdown=True)
            from backend.core.service import SimulationService
            from tests.core_packets import packet
            provider = runner.SimpleNamespace(name='test-fixture', stop_navigation=Mock())
            service = SimulationService(provider, now=lambda: self.now)
            service._publish(packet(speed=0))
            service.journey.update(status='RUNNING', driving_mode='ROBOSPHERE')
            service.stop_driving('egypt_validation_expired')
            self.assertEqual(service.journey['status'], 'PAUSED')
            self.assertEqual(service.journey['reason'], 'egypt_validation_expired')
            provider.stop_navigation.assert_called_once()

    def test_normal_handoff_saves_current_attempt_and_requests_the_existing_shutdown_path(self):
        current = {'connected': True, 'journey': {'status': 'RUNNING', 'recording': 'retained-current-recording'}}
        stopped = {'connected': False, 'simulatorStop': {'status': 'STOPPED', 'process_exited': True}}
        socket = Mock()
        socket.recv.side_effect = ['{"type":"snapshot"}', '{"type":"snapshot","acknowledged":0}', '{"acknowledged":1}']
        socket.__enter__ = Mock(return_value=socket)
        socket.__exit__ = Mock(return_value=False)
        with patch('scripts.final_runtime.state', side_effect=[current, stopped]), patch(
                'backend.carla.runtime.native_processes', return_value=[]), patch(
                'websockets.sync.client.connect', return_value=socket):
            runner.save_current_and_shutdown(self.root / 'handoff', 500)
        saved = json.loads((self.root / 'handoff' / 'before-validation.json').read_text())
        self.assertEqual(saved['state'], current)
        self.assertEqual(json.loads(socket.send.call_args.args[0])['type'], 'stop_simulator')
        self.assertTrue((self.root / 'handoff' / 'shutdown-complete.json').is_file())

    def test_pair_runner_passes_budget_reservation_and_deadline_to_child(self):
        from scripts.native import validate_crossing_pair as crossing
        with self.budget.experiment('DEVELOPMENT', 1200, 'propagation') as ticket, ExitStack() as stack:
            self.budget.claim_attempt(ticket, 1703, 'NORMAL', 'frozen')
            args = runner.SimpleNamespace(seed=1703, first='NORMAL', scenario='EGYPT_URBAN_CHAOS_V1', seconds=900.,
                render_profile='LOW', rule_ticket=None, holdout_acceptance=False, egypt_budget=str(self.budget.directory),
                egypt_reservation=ticket['reservation_id'], egypt_deadline=1200.)
            stack.enter_context(patch('scripts.final_runtime.state', return_value={'connected': False}))
            runtime = stack.enter_context(patch('backend.carla.runtime.NativeRuntime')).return_value
            runtime.active = None
            stack.enter_context(patch('backend.carla.runtime.native_processes', return_value=[]))
            stack.enter_context(patch.object(crossing, 'ROOT', self.root))
            stack.enter_context(patch.object(crossing, 'source_hashes', return_value={}))
            stack.enter_context(patch('backend.core.egypt_urban.source_fingerprint', return_value='frozen'))
            stack.enter_context(patch.object(crossing, 'cleanup_probe', return_value={'passed': True}))
            stack.enter_context(patch.object(crossing, 'verify_videos', return_value={'passed': True}))
            def archive(folder, hashes):
                (folder / 'source.zip').write_bytes(b'isolated source archive fixture')
                return {'source': 'UNIT_TEST_ONLY'}
            stack.enter_context(patch.object(crossing, 'archive_sources', side_effect=archive))
            child = Mock(returncode=0)
            child.poll.side_effect = [None, 0, 0]
            def finalize(**kwargs):
                save_json(args.report_folder / 'report.json', measured_pair(1703, 'NORMAL', acceptance=False))
            child.wait.side_effect = finalize
            launch = stack.enter_context(patch.object(crossing.subprocess, 'Popen', return_value=child))
            self.assertEqual(crossing.run(args), 0)
            finalized = json.loads((args.report_folder / 'report.json').read_text())
            self.assertEqual(finalized['native_worker_exit_code'], 0)
            command = next(call.args[0] for call in launch.call_args_list
                           if call.args[0][1:3] == ['-m', 'scripts.native.validate_crossing_pair'])
            for flag, value in (('--egypt-budget', args.egypt_budget), ('--egypt-reservation', ticket['reservation_id']),
                                ('--egypt-deadline', '1200.0')):
                self.assertEqual(command[command.index(flag) + 1], value)
            runtime.stop.assert_called_once_with(port=2000, deadline=1200.)
            # A worker can save its measurements and then crash in native
            # destruction. Keep that exit code even when report.json exists.
            child.returncode = 3221225725
            child.poll.side_effect = [None, child.returncode, child.returncode]
            self.assertEqual(crossing.run(args), 1)
            crashed = json.loads((args.report_folder / 'report.json').read_text())
            self.assertEqual(crashed['native_worker_exit_code'], 3221225725)
            self.assertFalse(crashed['native_acceptance'])
            self.assertIn('pair', crashed)

    def test_progress_checkpoint_is_small_and_cannot_certify_native_acceptance(self):
        from scripts.native.validate_crossing_pair import progress_pair
        original = measured_pair(1703, 'NORMAL', acceptance=False)
        pair = original.get('pair') or {'version': 7, 'manifest': {}, 'runs': {}}
        pair['manifest']['initial_conditions'] = {'actors': ['large raw actor proof'] * 1000}
        checkpoint = progress_pair(runner.SimpleNamespace(data=pair))
        self.assertTrue(checkpoint['progress_only'])
        self.assertFalse(checkpoint['conditions_match'])
        self.assertNotIn('initial_conditions', checkpoint['manifest'])
        self.assertNotIn('scenario_validation', checkpoint)
        self.assertLess(len(json.dumps(checkpoint)), 5000)
        self.assertIn('initial_conditions', pair['manifest'])

    def test_duplicate_seed_order_and_reserved_seed_rejected_before_worker_launch(self):
        with self.budget.experiment('DEVELOPMENT', 1200, 'duplicates') as ticket:
            self.budget.claim_attempt(ticket, 1703, 'NORMAL', 'frozen')
            with self.assertRaisesRegex(ValueError, 'Duplicate'):
                self.budget.claim_attempt(ticket, 1703, 'NORMAL', 'frozen')
            with self.assertRaisesRegex(ValueError, 'partition'):
                self.budget.claim_attempt(ticket, 961103, 'NORMAL', 'frozen')

    def test_foreign_dashboard_cannot_start_prepare_or_stop_owned_validation(self):
        from backend.carla.stop_helper import stopped_service
        with self.budget.experiment('DEVELOPMENT', 1200, 'ownership') as ticket:
            with patch.dict(os.environ, {'OSTORHA_EGYPT_RESERVATION': ''}):
                with self.assertRaisesRegex(RuntimeError, 'exclusively'):
                    require_simulator_access()
                require_simulator_access(shutdown=True)
            self.budget.activate(ticket)
            with patch.dict(os.environ, {'OSTORHA_EGYPT_RESERVATION': ''}):
                self.assertTrue(ownership_status()['reserved'])
                with self.assertRaises(RuntimeError):
                    require_simulator_access(shutdown=True)
                dispatch = Mock()
                service = stopped_service({'result': {'status': 'STOPPED'}}, Mock(), dispatch, dispatch)
                self.assertFalse(service.can_start_simulation())
                with self.assertRaises(RuntimeError):
                    service.start_simulation()
                with self.assertRaises(RuntimeError):
                    service.reset_simulation()
                with self.assertRaises(RuntimeError):
                    service.presentation.preload()
                dispatch.assert_not_called()


class EgyptRunnerTests(EgyptValidationFixture):
    def test_completed_trips_excludes_errors_timeouts_and_stopped_prefixes(self):
        statuses = ('ARRIVED', 'COLLISION', 'ERROR', 'RUNNING', 'PAUSED', 'TIMEOUT', None)
        pairs = [{'pair': {'runs': {str(i): {'status': status} for i, status in enumerate(statuses)}}}]
        self.assertEqual(runner.completed_trips(pairs), 2)

    def test_failed_preparation_without_manifest_remains_a_reported_failure(self):
        pair = runner.compact_pair({'manifest': None, 'runs': {}, 'conditions_match': False})
        self.assertEqual(pair['manifest'], {})
        self.assertEqual(pair['runs'], {})
        result = {'seed': 1703, 'first_mode': 'NORMAL', 'pair': pair,
                  'preparation_failure': {'message': 'Missing physical pass_obstacle_2 participant'}}
        self.assertIn('1703/NORMAL: preparation: Missing physical pass_obstacle_2 participant', runner.failed_pair_gates(result))

    def test_recording_and_cleanup_errors_are_visible_in_scenario_progress(self):
        result = {'seed': 1703, 'first_mode': 'NORMAL', 'pair': {'runs': {
            'NORMAL': {'status': 'ERROR', 'reason': 'recording_failure'}}},
            'cleanup_error': 'Recording stopped before exhausting the disk reserve'}
        failures = runner.failed_pair_gates(result)
        self.assertIn('1703/NORMAL: NORMAL: recording_failure', failures)
        self.assertIn('1703/NORMAL: cleanup_error: Recording stopped before exhausting the disk reserve', failures)

    def test_start_route_and_control_timeout_details_survive_progress_compaction(self):
        result = {'seed': 2707, 'first_mode': 'ROBOSPHERE', 'pair': {},
            'drive_failures': [{'mode': 'ROBOSPHERE', 'reason': 'Route failed revalidation'}],
            'drive_stop': {'status': 'ERROR', 'reason': 'runtime_failure', 'detail': 'Current scene unavailable for one second'}}
        failures = runner.failed_pair_gates(result)
        self.assertIn('2707/ROBOSPHERE: ROBOSPHERE: Route failed revalidation', failures)
        self.assertIn('2707/ROBOSPHERE: drive: Current scene unavailable for one second', failures)

    def setUp(self):
        super().setUp()
        self.budget.extend_development(DEVELOPMENT_EXTENSION_ID)
        self.stack.enter_context(patch.object(runner, 'software_gate_status', return_value={'passed': True}))
        self.stack.enter_context(patch.object(runner, 'diagnostic_gate_status', return_value={
            'passed': True, 'passed_targets': runner.DIAGNOSTIC_ORDER, 'attempted_targets': []}))
        self.stack.enter_context(patch.object(runner, 'storage_preflight', return_value={'passed': True}))
        self.stack.enter_context(patch.object(runner, 'compress_pair_recordings', return_value=[]))
        self.stack.enter_context(patch.object(runner, 'publish_accepted_recordings', return_value=[]))
        self.artifact = self.root / 'acceptance.json'
        self.stack.enter_context(patch.object(runner, 'ACCEPTANCE', self.artifact))
        self.stack.enter_context(patch.object(runner, 'source_fingerprint', return_value='frozen'))
        self.stack.enter_context(patch.object(runner, 'source_manifest', return_value={'source': 'frozen'}))
        self.stack.enter_context(patch('backend.core.egypt_urban.source_manifest', return_value={'source': 'frozen'}))
        self.handoff = self.stack.enter_context(patch.object(runner, 'save_current_and_shutdown'))
        self.pair_runner = self.stack.enter_context(patch('scripts.native.validate_crossing_pair.run', side_effect=self.fake_pair))
        self.sequence = []

    def options(self, *extra):
        return runner.parser().parse_args(['--run', '--egypt-budget', str(self.budget.directory),
            '--report', str(self.root / ('matrix-' + str(len(self.sequence)) + '.json')), *extra])

    def fake_pair(self, options):
        self.sequence.append((options.seed, options.first))
        self.assertLessEqual(options.egypt_deadline, active_ticket()['expires_monotonic_s'])
        self.assertEqual(options.egypt_reservation, active_ticket()['reservation_id'])
        folder = self.root / ('pair-' + str(len(self.sequence)))
        folder.mkdir()
        options.report_folder = folder
        save_json(folder / 'report.json', measured_pair(options.seed, options.first, acceptance=options.holdout_acceptance))

    def ready_development(self):
        save_json(self.budget.directory / 'development.json', {'source_sha256': 'frozen', 'pairs': measured_matrix(acceptance=False)})

    def test_development_all_seeds_both_orders_succeeds_without_deployment_acceptance(self):
        args = self.options()
        self.assertEqual(runner.run(args), 0)
        report = json.loads(Path(args.report).read_text())
        self.assertEqual(len(self.sequence), 6)
        self.assertTrue(report['development_passed'])
        self.assertTrue(report['development_matrix_passed'])
        self.assertFalse(report['accepted'])
        self.assertFalse(report['native_acceptance'])
        self.assertFalse(self.artifact.exists())
        self.assertEqual(json.loads(self.progress.read_text())['phase'], 'DEVELOPMENT')

    def test_acceptance_is_refused_without_full_current_source_development(self):
        for pairs, fingerprint in (([], 'frozen'), (measured_matrix(acceptance=False)[:-1], 'frozen'),
                                   (measured_matrix(acceptance=False), 'old-source')):
            save_json(self.budget.directory / 'development.json', {'source_sha256': fingerprint, 'pairs': pairs})
            self.assertEqual(runner.run(self.options('--acceptance')), 2)
        self.pair_runner.assert_not_called()
        self.handoff.assert_not_called()
        self.assertEqual(self.budget.status()['charged_s'], 0)

    def test_software_diagnostics_and_space_are_ordered_native_prerequisites(self):
        for target, result in (
                ('software_gate_status', {'passed': False, 'reason': 'Software gate missing'}),
                ('diagnostic_gate_status', {'passed': False, 'passed_targets': [], 'attempted_targets': []}),
                ('storage_preflight', {'passed': False, 'required_free_bytes': 100, 'free_bytes': 99})):
            with patch.object(runner, target, return_value=result):
                self.assertEqual(runner.run(self.options()), 2)
        self.pair_runner.assert_not_called()
        self.handoff.assert_not_called()

    def test_diagnostic_is_separate_from_development_matrix_and_protects_windows(self):
        def diagnostic_pair(options):
            self.fake_pair(options)
            path = options.report_folder / 'report.json'
            report = json.loads(path.read_text())
            report.update(native_acceptance=False, diagnostic_passed=True,
                          diagnostic_assessment={'passed': True, 'gates': {'software_fixture': True}})
            report['pair']['runs'] = {'ROBOSPHERE': {'status': 'PAUSED', 'reason': 'diagnostic_goal_reached'}}
            save_json(path, report)
        self.pair_runner.side_effect = diagnostic_pair
        args = self.options('--diagnostic', '--development-seed', '2707', '--first', 'ROBOSPHERE',
                            '--seconds-per-pair', '600', '--hypothesis', 'Software fixture: move audit before fresh frame')
        self.assertEqual(runner.run(args), 0)
        report = json.loads(Path(args.report).read_text())
        self.assertTrue(report['diagnostic_passed'])
        self.assertEqual(report['pairs'], [])
        self.assertFalse(report['development_passed'])
        self.assertFalse((self.budget.directory / 'development.json').exists())
        self.assertEqual(json.loads(self.progress.read_text())['completed_trips'], 0)
        self.assertEqual(report['required_reservation_s'], 900)
        self.assertEqual(report['protected_development_reservation_s'], 7680)

    def test_browser_ticket_reaches_stopped_server_without_allowing_foreign_dashboard(self):
        from backend.carla.stop_helper import stopped_service
        from backend.learning.egypt_budget import inherited_session_duration
        with self.budget.experiment('DEVELOPMENT', 480, 'browser', purpose='BROWSER'):
            server = stopped_service({'result': {'status': 'STOPPED'}}, Mock(), Mock())
            self.assertTrue(server.can_start_simulation())
            self.assertEqual(inherited_session_duration(), 480)
            self.assertEqual(inherited_session_duration(60), 60)
            self.assertEqual(inherited_session_duration(1000), 480)
            with patch.dict(os.environ, {'OSTORHA_EGYPT_RESERVATION': ''}):
                self.assertFalse(server.can_start_simulation())

    def test_full_acceptance_publishes_only_after_exports_cleanup_and_budget_finalization(self):
        self.ready_development()
        args = self.options('--acceptance')
        self.assertEqual(runner.run(args), 0)
        report = json.loads(self.artifact.read_text())
        self.assertEqual(len(self.sequence), 6)
        self.assertEqual(set(self.sequence), {(seed, first) for seed in configuration()['holdout_seeds'] for first in ('NORMAL', 'ROBOSPHERE')})
        self.assertTrue(report['accepted'])
        self.assertTrue(report['native_acceptance'])
        self.assertEqual(report['budget_after']['reservations'][-1]['outcome'], 'FINISHED')
        self.assertFalse(self.owner.exists())
        with patch('backend.core.egypt_urban.ACCEPTANCE', self.artifact), patch(
                'backend.core.egypt_urban.source_fingerprint', return_value='frozen'):
            self.assertTrue(deployment_status()['accepted'])
            self.assertEqual(scenario_catalog()['default_id'], 'EGYPT_URBAN_CHAOS_V1')
            self.progress.unlink()
            self.assertEqual(scenario_catalog()['validation']['completed_trips'], 12)
        with patch('backend.core.egypt_urban.ACCEPTANCE', self.artifact), patch(
                'backend.core.egypt_urban.source_fingerprint', return_value='changed'):
            self.assertFalse(deployment_status()['accepted'])
        self.assertEqual(runner.run(self.options('--acceptance')), 2)
        self.assertEqual(len(self.sequence), 6)

    def test_failed_acceptance_retains_all_pairs_exact_gates_and_lock_without_retry(self):
        self.ready_development()
        def failed(options):
            self.fake_pair(options)
            path = options.report_folder / 'report.json'
            report = json.loads(path.read_text())
            if len(self.sequence) == 1:
                report['pair']['runs']['ROBOSPHERE']['completed_maneuvers'] = []
                report['native_acceptance'] = False
            save_json(path, report)
        self.pair_runner.side_effect = failed
        args = self.options('--acceptance')
        self.assertEqual(runner.run(args), 1)
        self.assertEqual(len(self.sequence), 6)
        self.assertFalse(self.artifact.exists())
        report = json.loads(Path(args.report).read_text())
        self.assertIn('961103/NORMAL: three_measured_complete_overtakes', report['failed_gates'])
        self.assertEqual(json.loads(self.progress.read_text())['completed_trips'], 12)
        self.assertEqual(runner.run(self.options('--acceptance')), 2)

    def test_source_change_aborts_remaining_holdout_instead_of_tuning_or_retrying(self):
        self.ready_development()
        def changed(options):
            self.fake_pair(options)
            runner.source_fingerprint.return_value = 'changed'
        self.pair_runner.side_effect = changed
        args = self.options('--acceptance')
        self.assertEqual(runner.run(args), 1)
        self.assertEqual(len(self.sequence), 1)
        report = json.loads(Path(args.report).read_text())
        self.assertIn('frozen_source', report['failed_gates'])
        self.assertFalse(self.artifact.exists())

    def test_interrupted_matrix_retains_partial_worker_report_without_acceptance_or_retry(self):
        self.ready_development()
        def interrupted(options):
            self.fake_pair(options)
            raise KeyboardInterrupt()
        self.pair_runner.side_effect = interrupted
        args = self.options('--acceptance')
        self.assertEqual(runner.run(args), 130)
        report = json.loads(Path(args.report).read_text())
        self.assertTrue(report['interrupted_attempt']['report_exists'])
        self.assertEqual(report['budget_after']['reservations'][-1]['outcome'], 'INTERRUPTED')
        self.assertEqual(json.loads(self.progress.read_text())['state'], 'INTERRUPTED')
        self.assertEqual(json.loads(self.progress.read_text())['completed_trips'], 2)
        self.assertFalse(self.artifact.exists())
        self.assertEqual(runner.run(self.options('--acceptance')), 2)
        self.assertEqual(len(self.sequence), 1)

    def test_matrix_rejects_duplicates_incomplete_exports_and_unsupported_rendering(self):
        pairs = measured_matrix(acceptance=True)
        self.assertTrue(acceptance_matrix(pairs, 'frozen')['accepted'])
        for key in ('exports_closed', 'cleanup_confirmed', 'simulator_exit_confirmed'):
            broken = copy.deepcopy(pairs)
            broken[0][key] = False
            self.assertFalse(acceptance_matrix(broken, 'frozen')['accepted'])
        for key, value in (('native_worker_exit_code', 3221225725), ('cleanup_stage', 'DRAIN_FINAL_EVENTS')):
            broken = copy.deepcopy(pairs)
            broken[0][key] = value
            self.assertFalse(acceptance_matrix(broken, 'frozen')['accepted'])
        for metric, value in (('p95_ms', 200.01), ('p99_ms', 225.01), ('deadline_exceeded_frames', 1)):
            broken = copy.deepcopy(pairs)
            broken[0]['pair']['runs']['ROBOSPHERE']['control_latency'][metric] = value
            self.assertFalse(acceptance_matrix(broken, 'frozen')['accepted'])
        pairs[-1] = copy.deepcopy(pairs[0])
        self.assertFalse(acceptance_matrix(pairs, 'frozen')['gates']['six_unique_pairs_twelve_trips'])
        pairs = measured_matrix(acceptance=False)
        pairs[0]['render_profile']['render_profile'] = 'HIGH'
        self.assertFalse(evaluate_matrix(pairs, 'frozen', acceptance=False)['passed'])


class ScenarioStatusHTTPTests(unittest.TestCase):
    def test_accepted_comparison_archives_remain_readable_without_rewriting_latest_results(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(runner, 'ROOT', Path(directory)):
            root = Path(directory)
            original = root / 'output' / 'native' / 'report.json'
            identity = 'a' * 32
            raw = {'pair': {'pair_id': identity, 'runs': {'NORMAL': {'recording': 'retained-original'}}},
                   'shared_perception': {'status': 'READY', 'recording': 'retained-original'}}
            save_json(original, raw)
            latest = root / 'output' / 'journey-comparisons' / 'latest.json'
            save_json(latest, {'existing_result': True})
            matrix = {'accepted': True, 'source_sha256': 'frozen', 'pairs': [{
                'report': str(original), 'report_sha256': hashlib.sha256(original.read_bytes()).hexdigest()}]}
            saved = runner.publish_accepted_recordings(matrix)
            self.assertEqual(len(saved), 1)
            pair = json.loads(Path(saved[0]).read_text())
            self.assertEqual(pair['pair_id'], identity)
            self.assertEqual(pair['shared_perception'], raw['shared_perception'])
            self.assertEqual(json.loads(latest.read_text()), {'existing_result': True})
            self.assertEqual(runner.publish_accepted_recordings(matrix), saved)
            with self.assertRaisesRegex(ValueError, 'fully accepted'):
                runner.publish_accepted_recordings({**matrix, 'accepted': False})

    def test_guided_start_uses_accepted_default_and_its_speed_without_rewriting_explicit_legacy(self):
        from backend.websocket_bridge import WebSocketBridge
        for explicit, speed, scenario in ((None, 60, 'EGYPT_URBAN_CHAOS_V1'),
                                         ('SUDDEN_PEDESTRIAN_COMPARISON_V1', 120, 'SUDDEN_PEDESTRIAN_COMPARISON_V1')):
            service = Mock(rl_runtime=None, restarting=False, is_replay=False)
            service.presentation.busy = False
            service.presentation.data = {'status': 'IDLE'}
            service.presentation.TERMINAL = ('IDLE', 'COMPLETE', 'ERROR', 'CANCELLED')
            bridge = WebSocketBridge(service, '127.0.0.1', 0, 8000)
            try:
                value = {'operation': 'START_GUIDED'}
                if explicit:
                    value['scenario_id'] = explicit
                with patch('backend.core.egypt_urban.default_scenario', return_value='EGYPT_URBAN_CHAOS_V1'):
                    self.assertTrue(bridge.process_message(object(), {'type': 'presentation', 'value': value}))
                self.assertEqual(service.presentation.start.call_args.args, (speed,))
                self.assertEqual(service.presentation.start.call_args.kwargs['scenario_id'], scenario)
            finally:
                bridge.server.shutdown()

    def test_status_without_service_or_native_engine_is_read_only_and_preserves_catalog_fields(self):
        with tempfile.TemporaryDirectory() as directory, ExitStack() as stack:
            root = Path(directory)
            stack.enter_context(patch('backend.core.egypt_urban.ACCEPTANCE', root / 'absent.json'))
            stack.enter_context(patch('backend.learning.egypt_budget.PROGRESS', root / 'progress.json'))
            stack.enter_context(patch('backend.learning.egypt_budget.OWNERSHIP', root / 'owner.json'))
            native = stack.enter_context(patch('backend.carla.runtime.NativeRuntime'))
            allocate = stack.enter_context(patch.object(EgyptBudget, 'create'))
            class QuietHandler(Handler):
                def log_message(self, *args):
                    pass
            server = ThreadingHTTPServer(('127.0.0.1', 0), QuietHandler)
            thread = threading.Thread(target=server.serve_forever, kwargs={'poll_interval': .01}, daemon=True)
            thread.start()
            try:
                url = f'http://127.0.0.1:{server.server_port}/api/simulation/scenarios'
                with urllib.request.urlopen(url) as response:
                    catalog = json.load(response)
                    self.assertEqual(response.status, 200)
                    self.assertEqual(response.headers['Cache-Control'], 'no-store')
                self.assertEqual(catalog['default_id'], 'SUDDEN_PEDESTRIAN_COMPARISON_V1')
                option = catalog['options'][1]
                self.assertFalse(option['available'])
                self.assertFalse(option['native_accepted'])
                self.assertEqual(option['version'], 1)
                self.assertEqual(option['maximum_speed_kmh'], 60)
                self.assertEqual(option['validation']['completed_trips'], 0)
                self.assertTrue(option['blocking_reasons'])
                save_json(root / 'progress.json', {'state': 'RUNNING', 'phase': 'ACCEPTANCE', 'completed_trips': 3})
                with urllib.request.urlopen(url) as response:
                    status = json.load(response)['validation']
                self.assertEqual(status['state'], 'INTERRUPTED')
                self.assertIn('reservation_interrupted', status['failed_gates'])
                native.assert_not_called()
                allocate.assert_not_called()
            finally:
                server.shutdown()
                server.server_close()
                thread.join(2)


if __name__ == '__main__':
    unittest.main()
