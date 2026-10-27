from dataclasses import replace
import threading
from types import SimpleNamespace as NS
import unittest
from unittest.mock import Mock, patch

import numpy as np

from backend.carla.sensors import CarlaSensorManager
from backend.core.control import ControlMode
from backend.core.contracts import CommandSource, to_dict
from backend.core.maneuver_candidates import ExecutionShield, signed_path
from backend.core.prediction import assess_conflicts, forecast_geometry
from backend.core.service import SimulationService
from backend.signals.image_encoding import LatestImageEncoder
from tests.core_packets import packet, command
from tests.test_control_scene import ControlSceneTests


class EgyptControlLifecycleTests(unittest.TestCase):
    def test_current_native_route_proposal_is_staged_during_sensor_wait_and_consumed_once(self):
        from backend.core.urban_driver import UrbanManeuverDriver
        scene, base, _ = ControlSceneTests().measured(frame=2)
        base = replace(base, source=CommandSource.NAVIGATION)
        driver = UrbanManeuverDriver(scene.geometry)
        driver.evaluate = Mock(return_value=(base, {'decision_id': 'current', 'action': 'FOLLOW'}))
        road = {'session_id': 'test', 'centerline': [[0., 0.], [50., 0.]], 'drivable_strips': [[0., 0., 50., 0., 1.75]],
                'left_allowed': True, 'right_allowed': False}
        provider = NS(name='test-fixture', sensor_suite=False, allow_navigation=True,
            urban_driver=driver, hybrid_driver=driver, navigation=object(), dashboard_tools=NS(native_route=[]),
            navigation_command=Mock(return_value=base), navigation_done=Mock(return_value=False),
            navigation_speed_limit_mps=60/3.6, hybrid_road_context=Mock(return_value=road),
            route_state=lambda: {'arrived': False, 'remaining_m': 100.})
        service = SimulationService(provider, now=lambda: 100.)
        service.session_id = 'test'
        service._publish(packet(1, .05, speed=0.))
        service.journey.update(status='RUNNING', driving_mode='ROBOSPHERE', speed_kmh=60.)
        service._navigation_connection_alive = lambda: True
        service.arbiter.machine.transition(ControlMode.AUTOMATIC, connected=True, explicit=True)
        current = packet(base.frame_id, base.timestamp_s, speed=0.)
        service._prefetch_navigation(current)
        service._prefetch_navigation(current)
        provider.navigation_command.assert_called_once_with(base.frame_id, base.timestamp_s, 60.)
        self.assertIsNone(service.base_driver_command)
        service._publish(current)
        service.control_scene = scene
        service._navigation_step()
        provider.navigation_command.assert_called_once()
        provider.hybrid_road_context.assert_called_once()
        driver.evaluate.assert_called_once()
        frozen = service._hybrid_road_context()
        with self.assertRaises(TypeError):
            frozen['centerline'][0][1] = 7.
        frozen['left_allowed'] = False
        self.assertTrue(service._hybrid_road_context()['left_allowed'])
        service.journey['speed_kmh'] = 50.
        self.assertNotEqual(service.navigation_prefetch['key'], service._road_context_key())

    def test_initial_audit_and_release_hold_until_a_new_frame(self):
        order = []
        fixture = NS(verify=Mock(side_effect=lambda: order.append('verify') or {'passed': True}),
                     release=Mock(side_effect=lambda: order.append('release')))
        provider = NS(name='test-fixture', sensor_suite=False, allow_navigation=True, benchmark_fixture=fixture,
                      apply_control=lambda c: order.append(('apply', c.brake)), fixed_delta=.05)
        service = SimulationService(provider, now=lambda: 100.)
        service._publish(packet(10, .5, speed=0))
        service.clock.frame_id, service.clock.timestamp_s = 10, .5
        service.journey.update(status='STARTING', driving_mode='ROBOSPHERE', benchmark=True)
        service.navigation_ready_frame = 10
        service._navigation_connection_alive = lambda: True
        service.journey_comparison.active = {}
        service.journey_comparison.save = lambda: order.append('save')
        service._release_navigation_start()
        self.assertEqual(order, [('apply', 1.), 'verify', 'save', 'release'])
        self.assertEqual(service.navigation_ready_frame, 11)
        self.assertEqual(service.journey['status'], 'STARTING')
        self.assertNotEqual(service.arbiter.machine.mode, ControlMode.AUTOMATIC)
        self.assertEqual(service.journey['startup_stage'], 'WAITING_FOR_FRESH_SENSORS')
        service._release_navigation_start()
        fixture.release.assert_called_once()
        self.assertEqual(service.journey['release_timestamp_s'], .5)

    def test_application_check_records_original_receipt_and_rejects_a_newer_unmatched_frame(self):
        scene, base, _ = ControlSceneTests().measured()
        now = [100.2]
        provider = NS(name='test-fixture', allow_navigation=True, sensor_suite=False, fixed_delta=.05)
        service = SimulationService(provider, now=lambda: now[0])
        service._publish(packet(base.frame_id, base.timestamp_s, speed=0.))
        provider.sensor_suite = True
        service.control_scene = replace(scene, session_id=service.session_id)
        service.arbiter.machine.transition(ControlMode.AUTOMATIC, connected=True, explicit=True)
        service.journey.update(status='RUNNING', driving_mode='ROBOSPHERE')
        self.assertEqual(service._application_guard(base), base)
        self.assertAlmostEqual(service.application_timing['sensor_to_application_check_ms'], 200.)
        now[0] = 100.251
        self.assertEqual(service._application_guard(base).brake, 1.)
        self.assertFalse(service.application_timing['fresh_aligned'])
        now[0] = 100.21
        service.clock.frame_id, service.clock.timestamp_s = base.frame_id + 1, base.timestamp_s + .05
        self.assertEqual(service._application_guard(base).throttle, 0.)
        self.assertEqual(service.application_timing['source_frame'], scene.observation.frame_id)

    def test_forecast_geometry_is_shared_only_with_identical_frame_prediction_and_grid(self):
        scene, base, _ = ControlSceneTests().measured()
        grid = np.arange(31) * .1
        first = scene.space.forecast_geometry(scene.prediction, grid)
        self.assertIs(scene.space.forecast_geometry(scene.prediction, grid.copy()), first)
        changed = dict(scene.prediction)
        self.assertIsNot(scene.space.forecast_geometry(changed, grid), first)
        self.assertIsNot(scene.space.forecast_geometry(scene.prediction, grid[:-1]), first)
        path = signed_path(0., 0., 0., scene.geometry)
        paths = [{'intent': 'CANDIDATE', 'points': path, 'half': scene.geometry.half}]
        a = assess_conflicts(scene.prediction['tracks'], scene.prediction['control_trajectories'], paths)
        b = assess_conflicts(scene.prediction['tracks'], scene.prediction['control_trajectories'], paths,
                             prepared=forecast_geometry(scene.prediction['tracks'], scene.prediction['control_trajectories'], grid))
        self.assertEqual(to_dict(a), to_dict(b))

    def test_evidence_encoder_overflow_is_explicit_and_retains_the_ordered_prefix(self):
        entered, release = threading.Event(), threading.Event()
        encoded = []
        def callback(value, *_):
            entered.set()
            release.wait(2)
            encoded.append(value)
        encoder = LatestImageEncoder(callback, name='test-evidence-encoder', lossless=True, capacity=1)
        try:
            self.assertTrue(encoder.submit(1, 1., 1.))
            self.assertTrue(entered.wait(1))
            self.assertTrue(encoder.submit(2, 2., 2.))
            self.assertFalse(encoder.submit(3, 3., 3.))
        finally:
            release.set()
            with self.assertRaisesRegex(RuntimeError, 'evidence image queue exhausted'):
                encoder.close()
        self.assertEqual(encoded, [1, 2])
        self.assertEqual(encoder.snapshot()['droppedBeforeEncoding'], 0)
        self.assertEqual(encoder.snapshot()['failed'], 1)

    def test_sensor_stop_preserves_pending_events_and_assets_until_final_drain(self):
        manager = CarlaSensorManager(None, None)
        actor = NS(stop=Mock(), destroy=Mock(return_value=True), is_alive=True, id=1)
        manager.actors['sensor'] = actor
        manager.pending_collisions.append('last collision')
        manager.pending_frames.append('last sensor')
        manager.assets['lidar/last.bin'] = b'original'
        manager.stop_receiving()
        self.assertEqual(manager.drain_collisions(), ('last collision',))
        self.assertEqual(manager.drain_frames(), ('last sensor',))
        self.assertEqual(manager.assets['lidar/last.bin'], b'original')
        manager.close()
        manager.close()
        actor.stop.assert_called_once()
        actor.destroy.assert_called_once()

    def test_repeated_concurrent_close_orders_recordings_and_exports_before_actor_destruction(self):
        order, entered, release = [], threading.Event(), threading.Event()
        def destroy():
            order.append('destroy')
            entered.set()
            release.wait(2)
        provider = NS(name='test-fixture', sensor_suite=False, cleanup_errors=[], is_connected=lambda: True,
                      apply_control=lambda _: order.append('control'),
                      stop_sensor_receiving=lambda: order.append('sensors'), close=destroy)
        service = SimulationService(provider)
        service._audit_command = Mock()
        service._drain_collision_events = lambda: order.append('events')
        service._ingest_provider_sensors = Mock()
        service.last_recording = NS(close=lambda: order.append('recording'))
        errors = []
        def close():
            try:
                service.close()
            except RuntimeError as error:
                errors.append(str(error))
        with patch('backend.core.driving_video.wait_for_exports', side_effect=lambda _: order.append('exports') or True):
            first = threading.Thread(target=close)
            second = threading.Thread(target=close)
            first.start()
            self.assertTrue(entered.wait(1))
            second.start()
            release.set()
            first.join(3)
            second.join(3)
        self.assertFalse(first.is_alive() or second.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(order, ['control', 'sensors', 'events', 'recording', 'exports', 'destroy'])
        self.assertEqual(service.shutdown_stages[-1]['stage'], 'COMPLETE')

    def test_normal_reacts_to_real_sensor_obstacle_and_resumes_after_it_clears(self):
        from backend.core.active_safety import ActiveSafetySupervisor
        from tests.test_active_safety import scene as sensor_scene
        from tests.test_safety_teacher import case
        supervisor = ActiveSafetySupervisor()
        supervisor.anticipation_enabled = False
        braked = False
        for frame in range(1, 41):
            observation, base = case(frame, distance=None, speed=6. if frame < 5 else 0.)
            observation, assets = sensor_scene(observation, clear=True, obstacle=frame < 15)
            chosen = supervisor.evaluate(observation, base, assets, as_of_timestamp_s=observation.timestamp_s)
            if frame < 15:
                braked = braked or chosen is not None and chosen.brake > 0.
        self.assertTrue(braked)
        self.assertTrue(chosen is None or chosen.brake == 0., supervisor.status)
        self.assertFalse(supervisor.status.get('motion_prediction_used', False))


if __name__ == '__main__':
    unittest.main()
