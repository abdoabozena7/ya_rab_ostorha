"""Offline readiness/admission controls; no fixture is claimed as a native run."""
import argparse
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from integrations.gta import project_runner as runner


def sample(frame=1):
    common = dict(run_id='run', pid=42, frame=frame, host_ms=1000)
    native = dict(**common, stage='FOUNDATION_CALIBRATION', ped_alive=1)
    capture = dict(**common, serial=frame, native_host_ms=1000, capture_end_ms=1000, rgb_ok=True, depth_ok=True)
    geometry = dict(**common, rays=[[a, e, 2, 0, 100.] for a in range(0, 360, 2) for e in (-6, -2, -.5, 0, 2, 6)])
    return [native, capture, geometry, 'run', 1001]


class ProjectRunnerTests(unittest.TestCase):
    def test_menu_and_missing_sources_do_not_connect(self):
        data = sample(); data[0]['stage'] = 'INITIALIZING'
        self.assertFalse(runner.readiness(*data))
        for index in (0, 1, 2):
            data = sample(); data[index] = None
            self.assertFalse(runner.readiness(*data))

    def test_stale_future_or_wrong_run_sources_do_not_connect(self):
        for index, key, value in ((0, 'host_ms', 500), (1, 'native_host_ms', 1500),
                                   (1, 'pid', 44), (2, 'run_id', 'old')):
            data = sample(); data[index][key] = value
            self.assertFalse(runner.readiness(*data))

    def test_partial_or_invalid_scan_does_not_connect(self):
        data = sample(); data[2]['rays'].pop()
        self.assertFalse(runner.readiness(*data))
        for value in (-1, float('nan')):
            data = sample(); data[2]['rays'][0][4] = value
            self.assertFalse(runner.readiness(*data))

    def test_capture_failure_does_not_connect(self):
        data = sample(); data[1]['depth_ok'] = False
        self.assertFalse(runner.readiness(*data))

    def test_three_advancing_native_and_camera_samples_required(self):
        tracker = runner.ReadySequence()
        self.assertFalse(tracker.observe(*sample(1)))
        for _ in range(10): self.assertFalse(tracker.observe(*sample(1)))
        self.assertFalse(tracker.observe(*sample(2)))
        self.assertTrue(tracker.observe(*sample(3)))

    def test_a_static_camera_cannot_qualify_from_world_frames(self):
        tracker = runner.ReadySequence()
        for frame in range(1, 10):
            data = sample(frame); data[1]['serial'] = 1
            self.assertFalse(tracker.observe(*data))

    def test_lost_measurement_resets_readiness(self):
        tracker = runner.ReadySequence()
        tracker.observe(*sample(1)); tracker.observe(*sample(2))
        invalid = sample(3); invalid[0] = None
        self.assertFalse(tracker.observe(*invalid))
        self.assertFalse(tracker.observe(*sample(4)))

    def test_blocked_budget_cannot_build_open_browser_or_launch(self):
        args = argparse.Namespace(check=False, report=None, calibrate=False, no_browser=False)
        with patch.object(runner, 'check', return_value={'launch_admitted': False}), \
                patch.object(runner.live, 'build') as build, \
                patch.object(runner.live, 'native') as native, \
                patch.object(runner.webbrowser, 'open_new_tab') as browser:
            self.assertEqual(runner.run(args), 2)
            build.assert_not_called(); native.assert_not_called(); browser.assert_not_called()

    def test_read_only_check_never_starts_game(self):
        args = argparse.Namespace(check=True, report=None, calibrate=False, no_browser=False)
        with patch.object(runner, 'check', return_value={'launch_admitted': True}), \
                patch.object(runner.live, 'native') as native:
            self.assertEqual(runner.run(args), 0)
            native.assert_not_called()

    def test_extra_grant_reservation_preserves_base_and_cannot_repeat(self):
        authorization = (runner.HERE/'downloads/project-runtime-authorization.json').read_bytes()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root/'downloads').mkdir()
            base = root/'downloads/native-runtime-ledger.json'
            base.write_text('unchanged original history')
            (root/'downloads/project-runtime-authorization.json').write_bytes(authorization)
            with patch.object(runner, 'HERE', root):
                budget = runner.ProjectValidationBudget(base)
                item = budget.reserve('run-a')
                with self.assertRaises(ValueError): budget.reserve('run-b')
                budget.finish(item, 170.)
                with self.assertRaises(ValueError): budget.finish(item, 170.)
                reloaded = runner.ProjectValidationBudget(base)
                self.assertEqual(reloaded.state['charged_seconds'], 170.)
                with self.assertRaises(ValueError): reloaded.reserve('run-b')
            self.assertEqual(base.read_text(), 'unchanged original history')

    def test_modified_authority_is_not_permission(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder); (root/'downloads').mkdir()
            (root/'downloads/project-runtime-authorization.json').write_text('{"limit_seconds":600}')
            with patch.object(runner, 'HERE', root), self.assertRaises(ValueError):
                runner.ProjectValidationBudget(root/'downloads/native-runtime-ledger.json')


if __name__ == '__main__':
    unittest.main()
