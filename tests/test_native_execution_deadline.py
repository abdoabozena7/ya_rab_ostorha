import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from scripts.native.validate_crossing_pair import drive_validation, worker_execution_window


class NativeExecutionDeadlineTests(unittest.TestCase):
    def options(self, **changes):
        return SimpleNamespace(**{'seconds': 180., 'scenario': 'EGYPT_URBAN_CHAOS_V1',
                                  'diagnostic': True, 'egypt_deadline': 580., **changes})

    def test_diagnostic_honors_execution_and_keeps_both_cleanup_reserves(self):
        execution, finalization = worker_execution_window(self.options(), 100.)
        self.assertEqual(execution, 280.)
        self.assertEqual(finalization, 355.)
        self.assertEqual(finalization-execution, 75.)
        self.assertGreaterEqual(580.-finalization, 90.)

    def test_tight_parent_preserves_reserves_and_expired_window_refuses(self):
        execution, finalization = worker_execution_window(self.options(egypt_deadline=300.), 100.)
        self.assertEqual((execution, finalization), (135., 210.))
        for parent in (200., 100., float('nan'), float('inf')):
            with self.subTest(parent=parent), self.assertRaises((ValueError, TimeoutError)):
                worker_execution_window(self.options(egypt_deadline=parent), 100.)

    def test_matrix_and_legacy_keep_their_old_boundaries(self):
        self.assertEqual(worker_execution_window(self.options(diagnostic=False), 100.), (205., 280.))
        self.assertEqual(worker_execution_window(self.options(scenario='LEGACY', diagnostic=False), 100.),
                         (205., 280.))
        for seconds in (True, 0., -1., float('nan'), float('inf')):
            with self.subTest(seconds=seconds), self.assertRaises(ValueError):
                worker_execution_window(self.options(seconds=seconds), 100.)

    def service(self, clock, report, *, goal_at=None, status_at=None):
        data = {'id': 'fixture', 'status': 'DRIVING'}
        steps = []
        def step():
            steps.append(clock[0])
            clock[0] += 1.
            if goal_at is not None and clock[0] >= goal_at:
                report['diagnostic_goal_reached'] = True
            if status_at is not None and clock[0] >= status_at[0]:
                data['status'] = status_at[1]
        service = SimpleNamespace(session_id='fixture', presentation=SimpleNamespace(
            data=data, choose_preloaded=Mock()), journey_recording_stop_pending=False,
            journey_heartbeat=Mock(), step_once=step, stop_driving=Mock())
        return service, steps

    def test_real_loop_uses_formerly_lost_75_seconds_and_stops_at_admitted_bound(self):
        clock, report = [100.], {}
        service, steps = self.service(clock, report)
        execution, _ = worker_execution_window(self.options(), clock[0])
        with tempfile.TemporaryDirectory() as directory, \
                patch('scripts.native.validate_crossing_pair.time.monotonic', side_effect=lambda: clock[0]):
            drive_validation(service, Path(directory), report, deadline=execution,
                             first_mode='NORMAL', diagnostic=True)
        self.assertEqual((len(steps), steps[0], steps[-1], clock[0]), (180, 100., 279., 280.))
        self.assertTrue(report['diagnostic_execution_window_expired'])
        service.stop_driving.assert_called_once_with('diagnostic_execution_window_expired',
                                                    cancel_comparison=False, cancel_presentation=False)

    def test_goal_terminal_error_and_abort_still_end_the_loop(self):
        for kind in ('goal', 'ERROR', 'RESULTS', 'CANCELLED', 'abort'):
            clock, report = [100.], {}
            service, steps = self.service(clock, report, goal_at=103. if kind == 'goal' else None,
                                          status_at=(103., kind) if kind in ('ERROR','RESULTS','CANCELLED') else None)
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as directory, \
                    patch('scripts.native.validate_crossing_pair.time.monotonic', side_effect=lambda: clock[0]):
                path = Path(directory)
                if kind == 'abort':
                    (path/'abort.json').write_text(json.dumps({'reason':'fixture'}))
                drive_validation(service, path, report, deadline=280., first_mode='NORMAL', diagnostic=True)
            self.assertEqual(len(steps), 6 if kind == 'abort' else 3)
            self.assertNotIn('diagnostic_execution_window_expired', report)


if __name__ == '__main__':
    unittest.main()
