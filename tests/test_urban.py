import unittest
from unittest.mock import MagicMock
from backend.carla.urban import sample_driver, apply_driver
from backend.carla.population import validate_population, DEFAULT_POPULATION


class UrbanTests(unittest.TestCase):
    def test_seeded_profiles_are_stable_and_diverse_without_ignoring_collisions(self):
        profiles = [sample_driver(42, i, 'UNREGULATED', 15., 80) for i in range(100)]
        self.assertEqual(profiles, [sample_driver(42, i, 'UNREGULATED', 15., 80) for i in range(100)])
        self.assertEqual({p['name'] for p in profiles}, {'NORMAL','BUSY','AGGRESSIVE','UNREGULATED'})
        for p in profiles:
            tm = MagicMock(); actor = object(); apply_driver(tm, actor, p)
            tm.ignore_vehicles_percentage.assert_called_once_with(actor, 0.)
            tm.ignore_walkers_percentage.assert_called_once_with(actor, 0.)
            self.assertGreater(p['following_distance_m'], 1.)
            self.assertLessEqual(p['light_violation_percent'], 20.)

    def test_old_population_preferences_remain_readable_and_new_options_validate(self):
        legacy = {k:DEFAULT_POPULATION[k] for k in ('vehicle_count','pedestrian_count','speed_behavior','seed','fast_walk_percent')}
        self.assertEqual(validate_population(legacy), DEFAULT_POPULATION)
        for value in ({'crossing_percent':100}, {'driver_behavior':'CHAOS'}, {'world_profile':'FAST'}, {'light_compliance_percent':False}):
            with self.assertRaises(ValueError): validate_population({**DEFAULT_POPULATION, **value})
