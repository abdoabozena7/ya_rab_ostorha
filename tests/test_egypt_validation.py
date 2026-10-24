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
    EgyptBudget, active_ticket, ownership_status, require_simulator_access, save_json,
)
from backend.server import Handler
from scripts.native import validate_egypt_urban as runner
from scripts.native.validate_crossing_pair import validate_egypt_worker
from tests.test_egypt_urban import accepted_pair


def measured_pair(seed, first, *, acceptance):
    pair = accepted_pair()
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
            'independent_cleanup_probe': {'passed': True}, 'video_playback_after_exit': {'passed': True},
            'render_profile': {'render_profile': 'LOW'}}


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
            command = launch.call_args.args[0]
            for flag, value in (('--egypt-budget', args.egypt_budget), ('--egypt-reservation', ticket['reservation_id']),
                                ('--egypt-deadline', '1200.0')):
                self.assertEqual(command[command.index(flag) + 1], value)
            runtime.stop.assert_called_once_with(port=2000, deadline=1200.)

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
    def setUp(self):
        super().setUp()
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
        pairs[-1] = copy.deepcopy(pairs[0])
        self.assertFalse(acceptance_matrix(pairs, 'frozen')['gates']['six_unique_pairs_twelve_trips'])
        pairs = measured_matrix(acceptance=False)
        pairs[0]['render_profile']['render_profile'] = 'HIGH'
        self.assertFalse(evaluate_matrix(pairs, 'frozen', acceptance=False)['passed'])


class ScenarioStatusHTTPTests(unittest.TestCase):
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
