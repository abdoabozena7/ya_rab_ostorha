import unittest
from backend.carla.population import WorldPopulationManager
from backend.core.service import SimulationService
from types import SimpleNamespace


class CompactPopulationTests(unittest.TestCase):
    def test_compact_observer_does_not_traverse_profiles_and_still_owns_nested_counts(self):
        class Profile:
            def __deepcopy__(self,memo):raise AssertionError('Expensive profiles traversed')
        manager=WorldPopulationManager.__new__(WorldPopulationManager)
        manager.state_cache={'frame_id':42,'actual':{'vehicles':24},'requested':{'seed':1},
            'driver_profiles':Profile(),'walker_profiles':Profile()}
        result=manager.get_population_state(compact=True)
        self.assertNotIn('walker_profiles',result);self.assertNotIn('driver_profiles',result)
        result['actual']['vehicles']=0
        self.assertEqual(manager.state_cache['actual']['vehicles'],24)

    def test_stream_uses_compact_observer_without_changing_full_inspection(self):
        service=SimulationService(None)
        service.provider=SimpleNamespace(population_state=lambda:{'profiles':'full'},
            operator_population_state=lambda:{'frame_id':42})
        self.assertEqual(service._population_snapshot(True),{'frame_id':42})
        self.assertEqual(service._population_snapshot(False),{'profiles':'full'})

    def test_legacy_provider_without_compact_observer_stays_supported(self):
        service=SimulationService(None)
        service.provider=SimpleNamespace(population_state=lambda:{'frame_id':1})
        self.assertEqual(service._population_snapshot(True),{'frame_id':1})
