"""Offline tests only: no native clients or actor creation."""
import unittest
from unittest.mock import MagicMock
from backend.carla.urban import sample_driver, apply_driver
from backend.carla.population import DEFAULT_POPULATION, WorldPopulationManager, validate_population


class CityChaosTests(unittest.TestCase):
    def test_chaos_changes_seeded_profiles_without_disabling_collision_avoidance(self):
        calm=[sample_driver(2604,i,'NORMAL',15.,80,0) for i in range(40)]
        chaos=[sample_driver(2604,i,'NORMAL',15.,80,85) for i in range(40)]
        self.assertEqual(chaos,[sample_driver(2604,i,'NORMAL',15.,80,85) for i in range(40)])
        self.assertNotEqual(chaos,[sample_driver(2605,i,'NORMAL',15.,80,85) for i in range(40)])
        self.assertGreater(sum(p['lane_change_percent'] for p in chaos),sum(p['lane_change_percent'] for p in calm))
        self.assertGreater(len({p['name'] for p in chaos}),1)
        for profile in chaos:
            tm=MagicMock();actor=object();apply_driver(tm,actor,profile)
            tm.ignore_vehicles_percentage.assert_called_once_with(actor,0.)
            tm.ignore_walkers_percentage.assert_called_once_with(actor,0.)
            tm.force_lane_change.assert_not_called()
            self.assertLessEqual(profile['light_violation_percent'],20.)
            self.assertLessEqual(profile['lane_change_percent'],.6)

    def test_population_compatibility_and_new_ranges_are_explicit(self):
        self.assertEqual(validate_population({**DEFAULT_POPULATION,'chaos_percent':100,'crossing_percent':60})['chaos_percent'],100)
        for changes in ({'chaos_percent':True},{'chaos_percent':101},{'chaos_percent':-1},{'crossing_percent':61}):
            with self.assertRaises(ValueError):validate_population({**DEFAULT_POPULATION,**changes})
        old={k:v for k,v in DEFAULT_POPULATION.items() if k!='chaos_percent'}
        self.assertEqual(validate_population(old)['chaos_percent'],0)

    def test_crossing_change_rebuilds_only_owned_walkers_before_spawn_not_ego_or_traffic(self):
        m=object.__new__(WorldPopulationManager)
        m.config=dict(DEFAULT_POPULATION);m.vehicles={10};m.walkers={20:{'controller_id':21}}
        m.pending_vehicles=set();m.world=MagicMock();m.traffic_manager=MagicMock()
        m.clear_pedestrians=MagicMock();m.spawn_traffic=MagicMock();m.spawn_pedestrians=MagicMock();m.get_population_state=MagicMock(return_value={})
        order=[]
        m.clear_pedestrians.side_effect=lambda:order.append('clear')
        m.world.set_pedestrians_cross_factor.side_effect=lambda v:order.append(('factor',v))
        m.spawn_pedestrians.side_effect=lambda v:order.append(('spawn',v))
        m.apply({**DEFAULT_POPULATION,'crossing_percent':60,'pedestrian_count':8})
        self.assertEqual(order,['clear',('factor',.6),('spawn',8)])
        m.spawn_traffic.assert_called_once_with(0)
        self.assertEqual(m.vehicles,{10});self.assertEqual(m.pending_vehicles,{10})
        m.world.tick.assert_not_called();m.world.apply_settings.assert_not_called()
        self.assertEqual(m.config['pedestrian_count'],8)

    def test_unchanged_crossing_setting_preserves_existing_walkers(self):
        m=object.__new__(WorldPopulationManager);m.config=dict(DEFAULT_POPULATION)
        m.vehicles={10};m.walkers={20:{}};m.pending_vehicles=set();m.world=MagicMock();m.traffic_manager=MagicMock()
        m.clear_pedestrians=MagicMock();m.spawn_traffic=MagicMock();m.spawn_pedestrians=MagicMock();m.get_population_state=MagicMock()
        m.apply({**DEFAULT_POPULATION,'chaos_percent':85});m.clear_pedestrians.assert_not_called()
