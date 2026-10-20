import unittest
from types import SimpleNamespace as NS
from unittest.mock import Mock,patch
from backend.carla.provider import CarlaProvider


class NativeTickOrderTests(unittest.TestCase):
    def test_population_commands_run_before_physics_and_new_sensor_receipts(self):
        order=[];previous=object();current=Mock()
        current.find.return_value.get_transform.return_value=object()
        world=NS(world=NS(get_snapshot=lambda:previous),state=lambda _: {},
            advance=Mock(side_effect=lambda:order.append('physics') or current))
        population=NS(update=Mock(side_effect=lambda _:order.append('population')))
        provider=NS(benchmark_fixture=None,scenarios=None,population=population,dashboard_tools=None,
            world=world,ego=NS(actor=NS(id=1)),inspector=None,_follow_ego=Mock(),
            connection=NS(server_version='test',api_version='test'))
        with patch('backend.carla.provider.vehicle_state',return_value={'frame':2}):
            CarlaProvider.step(provider)
        self.assertEqual(order,['population','physics'])
        population.update.assert_called_once_with(previous)
        self.assertEqual(provider.last_vehicle,{'frame':2})
        self.assertTrue(all(value>=0 for value in provider.step_timing_ms.values()))
