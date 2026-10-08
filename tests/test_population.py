"""Offline lifecycle/safety invariants; never substitute for Gate 4 native tests."""
import unittest
from types import SimpleNamespace
from unittest.mock import MagicMock
from backend.carla.population import DEFAULT_POPULATION, SPEED_DIFFERENCE, WorldPopulationManager, validate_population
from backend.carla.provider import CarlaProvider
from backend.core.service import SimulationService
from backend.carla.routes import RouteService
from backend.core.contracts import PopulationState, from_dict, to_dict


class PopulationTests(unittest.TestCase):
    def test_population_values_and_speed_units_are_explicit(self):
        self.assertEqual(validate_population(DEFAULT_POPULATION), DEFAULT_POPULATION)
        self.assertEqual(SPEED_DIFFERENCE, {'SLOW':30., 'NORMAL':15., 'FAST':0.})
        for changes in ({'vehicle_count':True},{'vehicle_count':76},{'pedestrian_count':51},
                        {'seed':-1},{'speed_behavior':'120 kmh'},{'fast_walk_percent':100}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                validate_population({**DEFAULT_POPULATION, **changes})

    def test_incremental_reduction_retains_existing_actors_and_never_ticks(self):
        manager=object.__new__(WorldPopulationManager)
        manager.config=dict(DEFAULT_POPULATION)
        manager.vehicles={10,11,12};manager.pending_vehicles={12};manager.errors=[]
        manager.seen_vehicles={10,11,12}
        manager.missing_vehicle_frames={}
        manager.api=SimpleNamespace(command=SimpleNamespace(DestroyActor=lambda i:('destroy',i)))
        manager.client=MagicMock()
        manager.client.apply_batch_sync.return_value=[SimpleNamespace(error=None)]
        manager.spawn_traffic(2)
        self.assertEqual(manager.vehicles,{10,11})
        manager.client.apply_batch_sync.assert_called_once_with([('destroy',12)],False)
        self.assertEqual(manager.pending_vehicles,set())

    def test_cleanup_failure_does_not_lose_owned_actor_ids(self):
        manager=object.__new__(WorldPopulationManager)
        manager.config=dict(DEFAULT_POPULATION);manager.vehicles={10};manager.pending_vehicles=set();manager.errors=[]
        manager.api=SimpleNamespace(command=SimpleNamespace(DestroyActor=lambda i:i))
        manager.client=MagicMock()
        manager.client.apply_batch_sync.return_value=[SimpleNamespace(error='native destruction failed')]
        with self.assertRaisesRegex(RuntimeError,'cleanup failed'):manager.clear_traffic()
        self.assertEqual(manager.vehicles,{10})
        self.assertTrue(manager.errors)

    def test_gate4_rejects_ego_autonomous_start_before_queueing(self):
        service=SimulationService(CarlaProvider())
        with self.assertRaises(ValueError):service.start_journey(20)
        self.assertFalse(service.actions)
        self.assertFalse(service.arbiter.machine.allow_navigation)

    def test_snapshot_absence_prunes_ghost_sdk_actor_without_waiving_cleanup(self):
        manager=object.__new__(WorldPopulationManager)
        manager.config=dict(DEFAULT_POPULATION); manager.vehicles={10}; manager.seen_vehicles={10}
        manager.missing_vehicle_frames={10:1}; manager.pending_vehicles=set(); manager.walkers={}
        manager.vehicles_removed_native=manager.walkers_lost=0
        manager.last_replacement_at=manager.last_walker_replacement_at=-float('inf')
        manager.errors=[];manager.spawn_report={};manager.frame_id=None
        manager.traffic_manager=SimpleNamespace(connected=True,port=8050)
        manager.api=SimpleNamespace(command=SimpleNamespace(DestroyActor=lambda i:i))
        manager.client=MagicMock();manager.world=MagicMock()
        manager.client.apply_batch_sync.return_value=[SimpleNamespace(error='actor not found')]
        snapshot=SimpleNamespace(frame=42,timestamp=SimpleNamespace(elapsed_seconds=2.1),find=lambda i:None)
        manager.update(snapshot)
        self.assertFalse(manager.vehicles)
        self.assertEqual(manager.vehicles_removed_native,1)
        self.assertEqual(manager.get_population_state()['actual']['vehicles'],0)
        manager.client.apply_batch_sync.assert_called_once_with([10],False)
        manager.world.get_actor.assert_not_called()

    def test_map_reset_retires_sdk_through_managed_restart(self):
        provider=CarlaProvider()
        provider.runtime=SimpleNamespace(active={'quality':'Low','resolution':'1280x720'})
        provider.reset_world=MagicMock()
        service=SimulationService(provider)
        service.require_connected=MagicMock();service.restart_graphics=MagicMock()
        service.queue_dashboard_action('world_reset',None)
        service.restart_graphics.assert_called_once_with({'quality':'Low','resolution':'1280x720'},operation='WORLD_RESET')
        provider.reset_world.assert_not_called()
        self.assertFalse(service.actions)

    def test_saved_destination_from_another_map_is_rejected_before_planning(self):
        routes=RouteService(SimpleNamespace(name='Town10'), None)
        with self.assertRaisesRegex(ValueError,'different CARLA map'):
            routes.plan(None, {'map':'Town03','location':[0,0,0]})
        self.assertIsNone(routes.planner)

    def test_native_population_roundtrip_preserves_actual_and_requested_counts(self):
        population=PopulationState(42,2.1,23,14,14,12,25,25,True,'NORMAL',15.,42)
        self.assertEqual(from_dict(PopulationState,to_dict(population)),population)
        with self.assertRaises(ValueError):PopulationState(42,2.1,23,14,14,15,25,25,True,'NORMAL',15.,42)


if __name__=='__main__':unittest.main()
