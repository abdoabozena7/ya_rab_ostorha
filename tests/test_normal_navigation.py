import unittest
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import Mock, patch

from backend.carla.provider import CarlaProvider
from backend.core.contracts import CommandSource, ControlCommand
from backend.core.normal_navigation import sensor_navigation_command, stopping_distance
from backend.core.active_safety import RuntimeSafetyConfig
from backend.core.control import ControlMode
from backend.core.service import SimulationService
from tests.core_packets import packet


def command(throttle=.2, brake=0.):
    return ControlCommand(42, 2.1, throttle, brake, .12, False, False,
                          CommandSource.NAVIGATION, 1)


def measured(**updates):
    return {'frame_id': 42, 'timestamp_s': 2.1, 'risk': 'FORWARD_CLEAR_SIDE_REAR_UNVERIFIED',
            'measured_range_m': None, 'observed_road_range_m': 40.,
            'side_rear_observations': [], **updates}


def following(*, rear_updates=None, **status_updates):
    rear = {'relation': 'REAR_APPROACH', 'matched_frames': 8,
            'time_to_conflict_s': 1.1, 'center_m': [-5., 0.]}
    return measured(side_rear_observations=[{**rear, **(rear_updates or {})}], **status_updates)


class SensorNavigationTests(unittest.TestCase):
    def apply(self, base, status, normal=False, speed=2., target=8.):
        return sensor_navigation_command(base, status, frame_id=42, timestamp_s=2.1, speed_mps=speed,
                                         target_speed_mps=target, normal_mode=normal)

    def test_rear_catch_up_can_only_raise_low_throttle_with_clear_forward_space(self):
        base = command(.15)
        selected, reason, assisted = self.apply(base, following())
        self.assertTrue(assisted)
        self.assertIsNone(reason)
        self.assertEqual(selected.throttle, .55)
        self.assertEqual(selected.steering, base.steering)
        self.assertEqual(selected.brake, 0.)
        self.assertFalse(self.apply(base, following(), speed=8.)[2])
        self.assertFalse(self.apply(base, following(rear_updates={'time_to_conflict_s': 3.}))[2])
        self.assertFalse(self.apply(base, following(rear_updates={'matched_frames': 2}))[2])
        self.assertFalse(self.apply(replace(base, steering=.4), following())[2])

    def test_normal_preserves_pedals_even_with_front_and_rear_observations(self):
        base = command(.75)
        selected, reason, assisted = self.apply(command(.75),
            following(measured_range_m=.8, target_source='LIDAR'), normal=True)
        self.assertFalse(assisted)
        self.assertEqual(selected, base)
        self.assertIsNone(reason)

    def test_red_signal_or_other_route_brake_is_never_overridden(self):
        base = command(0., 1.)
        self.assertEqual(self.apply(base, following())[0], base)
        self.assertFalse(self.apply(base, following())[2])

    def test_manual_normal_never_generates_rear_throttle(self):
        base = command(.15)
        selected, reason, assisted = sensor_navigation_command(
            base, following(), frame_id=42, timestamp_s=2.1,
            speed_mps=2., target_speed_mps=8., normal_mode=True,
            allow_rear_assist=False)
        self.assertEqual(selected, base)
        self.assertIsNone(reason)
        self.assertFalse(assisted)

    def test_live_camera_view_keeps_an_automatic_recorded_journey_running(self):
        provider = Mock(sensor_suite=False, allow_navigation=True)
        provider.name = 'test-fixture'
        service = SimulationService(provider)
        service._publish(packet(speed=0.))
        service.recorder = object()
        service.journey['status'] = 'RUNNING'
        service.prepared_journey_pair = 'saved-pair'
        with patch.object(service, 'release_controls') as release:
            service.queue_dashboard_action('settings', {'camera_view': 'hood'})
            release.assert_not_called()
        self.assertEqual(service.journey['status'], 'RUNNING')
        self.assertEqual(service.prepared_journey_pair, 'saved-pair')
        service.recorder = None
        provider.get_simulation_frame.return_value = packet(2, .1, speed=0.)
        provider.drain_collision_events.return_value = []
        provider.drain_sensor_frames.return_value = []
        def apply_camera(action, value):
            self.assertEqual((action, value), ('settings', {'camera_view': 'hood'}))
            self.assertFalse(service.reconfiguring)
            return {}
        provider.dashboard_action.side_effect = apply_camera
        with patch.object(service, '_record'):
            service._iteration()
        self.assertEqual(service.journey['status'], 'RUNNING')
        with self.assertRaisesRegex(ValueError, 'Finish recording'):
            service.recorder = object()
            service.queue_dashboard_action('settings', {'camera_resolution': '800x450'})

    def test_normal_never_gates_commands_on_freshness_or_coverage(self):
        for status in (None, measured(frame_id=38), measured(timestamp_s=1.8), measured(risk='UNKNOWN_SPACE'),
                       measured(observed_road_range_m=2.), following()):
            base = command(.7)
            selected, reason, assisted = self.apply(base, status, normal=True)
            self.assertEqual(selected, base)
            self.assertIsNone(reason)
            self.assertFalse(assisted)

    def test_normal_at_eighty_kmh_keeps_the_driver_command(self):
        speed = 80/3.6
        self.assertGreaterEqual(RuntimeSafetyConfig.load().maximum_observed_range_m,
                                stopping_distance(speed)+1.)
        selected, _, _ = self.apply(command(.7), measured(observed_road_range_m=90.), speed=speed, normal=True)
        self.assertEqual(selected.throttle, .7)
        selected, reason, _ = self.apply(command(.7), measured(observed_road_range_m=45.), speed=speed, normal=True)
        self.assertEqual((selected.throttle, selected.brake), (.7, 0.))
        self.assertIsNone(reason)

    def test_one_previous_sensor_frame_remains_fresh_for_the_next_control_tick(self):
        selected, reason, assisted = self.apply(command(.4), measured(frame_id=41, timestamp_s=2.05))
        self.assertEqual(selected.throttle, .4)
        self.assertIsNone(reason)
        self.assertFalse(assisted)

    def test_protected_driver_keeps_rule_supervisor_as_braking_authority(self):
        base = command(.6)
        selected, reason, assisted = self.apply(base, measured(measured_range_m=.8), normal=False)
        self.assertEqual(selected, base)
        self.assertIsNone(reason)
        self.assertFalse(assisted)
        selected, reason, assisted = self.apply(command(.1), following(), normal=False)
        self.assertTrue(assisted)
        self.assertEqual(selected.throttle, .55)

    def test_normal_route_agent_disables_privileged_vehicle_queries(self):
        provider = CarlaProvider(sensor_suite=True)
        agent = Mock()
        provider.ego = SimpleNamespace(actor=Mock())
        provider.dashboard_tools = SimpleNamespace(route={'id': 'route'}, native_route=[],
            map=Mock(), route_service=SimpleNamespace(planner=Mock()),
            replan_route=Mock(), route_state=Mock(return_value={'id': 'route'}))
        with patch('backend.carla.route_agent.route_agent_class', return_value=Mock(return_value=agent)):
            provider.start_navigation(30, driving_mode='NORMAL')
        agent.ignore_vehicles.assert_called_once_with(True)
        agent.ignore_traffic_lights.assert_called_once_with(False)
        agent.ignore_stop_signs.assert_called_once_with(False)
        agent.set_global_plan.assert_called_once()


if __name__ == '__main__':
    unittest.main()
