"""Operator input/route invariants; native evidence is in output/native-validation."""
import unittest
from types import SimpleNamespace
from backend.carla.dashboard_tools import validate_settings, NativeDashboardTools


class DashboardSettingsTests(unittest.TestCase):
    def test_invalid_settings_are_rejected_before_native_calls(self):
        for data in ({'camera_resolution':'4k'}, {'simulation_hz':60}, {'camera_fov':float('nan')},
                     {'weather':{'cloudiness':-1}}, {'camera_view':'fake'},
                     {'camera_view':['front']},
                     {'traffic_plan':{'vehicle_count':5,'speed_min_kmh':50,'speed_max_kmh':20,'seed':42}},
                     {'native_command':'exec'}):
            with self.subTest(data=data), self.assertRaises(ValueError):
                validate_settings(data)

    def test_prepared_traffic_has_explicit_bounded_values(self):
        data = {'traffic_plan':{'vehicle_count':5,'speed_min_kmh':20,'speed_max_kmh':40,'seed':42}}
        self.assertEqual(validate_settings(data), data)

    def test_route_progress_does_not_repeat_a_passed_turn(self):
        tools = object.__new__(NativeDashboardTools)
        tools.provider = SimpleNamespace(last_vehicle={'positionWorldM':[18.,0.,0.]})
        tools.route = {'points':[[0.,0.,0.],[10.,0.,0.],[20.,0.,0.],[30.,0.,0.]],
                       'destination':{'location':[30.,0.,0.]},
                       'instructions':[{'point_index':1,'action':'LEFT'},{'point_index':3,'action':'RIGHT'}]}
        state = tools.route_state()
        self.assertEqual(state['next_instruction']['action'], 'RIGHT')
        self.assertAlmostEqual(state['remaining_m'], 12.)
        self.assertFalse(state['arrived'])
