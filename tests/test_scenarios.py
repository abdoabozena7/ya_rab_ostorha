from dataclasses import replace
import unittest
from backend.core.contracts import from_dict,to_dict
from backend.core.scenarios import *
from backend.carla.scenarios import NativeScenarioManager
from tests.core_packets import TRANSFORM
from unittest.mock import MagicMock
from types import SimpleNamespace
from backend.core.service import SimulationService


class ScenarioTests(unittest.TestCase):
    def spec(self,**kwargs):
        return ScenarioSpec('front_v1',ScenarioType.FRONT_OBSTACLE,42,'Town10',0,0.,**kwargs)

    def test_roundtrip_and_partition_isolation(self):
        spec=self.spec()
        self.assertEqual(from_dict(ScenarioSpec,to_dict(spec)),spec)
        self.assertEqual(len(spec.condition_id),64)
        for split,seed in ((DatasetSplit.TRAIN,1042),(DatasetSplit.VALIDATION,42),(DatasetSplit.TEST,1042)):
            with self.assertRaises(ValueError):replace(spec,split=split,random_seed=seed)
        self.assertNotEqual(spec.condition_id,replace(spec,random_seed=43).condition_id)

    def test_native_clear_noon_azimuth_is_admitted_without_accepting_invalid_angles(self):
        provider=MagicMock()
        provider.world.world.get_map.return_value.name='Town10'
        provider.world.world.get_map.return_value.get_spawn_points.return_value=[object()]
        manager=NativeScenarioManager(provider)
        manager.reset=MagicMock()
        manager.load(self.spec(weather={'sun_altitude_angle':45.,'sun_azimuth_angle':-1.}))
        manager.reset.assert_called_once()
        manager.reset.reset_mock()
        for weather in ({'sun_azimuth_angle':-2.},{'sun_azimuth_angle':361.},{'sun_altitude_angle':91.}):
            with self.assertRaisesRegex(ValueError,'Invalid native sun angle'):
                manager.load(self.spec(weather=weather))
        manager.reset.assert_not_called()

    def test_stationary_survival_cannot_be_a_success_condition(self):
        for value in ({'min_progress_m':0.},{'max_collision_episodes':0.},{'mystery_reward':4.}):
            with self.assertRaises(ValueError):self.spec(success_conditions=value)
        with self.assertRaises(ValueError):ActorControlSegment(0.,throttle=1.,brake=1.)

    def test_proposed_curriculum_does_not_advance_without_measured_results(self):
        criteria=CurriculumCriteria(30,.05,.9,.8,0)
        self.assertFalse(criteria.passed({}))
        good=dict(episodes=30,collision_rate=0.,success_rate=1.,progress_fraction=.9,unsafe_interventions=0)
        self.assertTrue(criteria.passed(good))
        self.assertFalse(criteria.passed({**good,'progress_fraction':0.}))
        self.assertFalse(criteria.passed({**good,'collision_rate':-1.}))
        self.assertFalse(criteria.passed({**good,'unsafe_interventions':False}))
        self.assertEqual(len(load_curriculum('config/curriculum.json')),6)

    def test_unimplemented_scenarios_are_rejected_before_mutating_world(self):
        provider=MagicMock()
        manager=NativeScenarioManager(provider)
        with self.assertRaisesRegex(ValueError,'two verified vehicle prototypes'):
            manager.load(replace(self.spec(),scenario_type=ScenarioType.MULTI_HAZARD))
        provider.reset_vehicle.assert_not_called()
        provider.population.reset_population.assert_not_called()
        self.assertEqual(manager.status()['mode'],'LIVING_CITY')
        self.assertFalse(manager.status()['safety_policy']['active'])

    def test_recording_keeps_scenario_start_stop_but_blocks_actor_rebuilds(self):
        service=SimulationService(SimpleNamespace(name='test-fixture'))
        service.require_connected=MagicMock()
        service.recorder=MagicMock()
        for operation in ('start','stop','collect_outcome'):
            service.queue_dashboard_action('scenario',{'operation':operation})
        for operation in ('load','reset','cleanup'):
            with self.assertRaisesRegex(ValueError,'rebuilding scenario actors'):
                service.queue_dashboard_action('scenario',{'operation':operation})
        with self.assertRaises(ValueError):service.queue_dashboard_action('environment','LIVING_CITY')

    def test_native_collision_event_path_counts_contact_and_rejects_old_ego(self):
        from backend.core.contracts import CollisionEvent
        provider=SimpleNamespace(ego=SimpleNamespace(actor=SimpleNamespace(id=11)))
        manager=NativeScenarioManager(provider)
        manager.phase='RUNNING';manager.spec=self.spec(failure_conditions={'max_collision_episodes':10.})
        manager.started_at=1.;manager.metrics={'collision_callback_count':0,'collision_count':0,
            'collision_impulse_total_ns':0.,'collision_peak_impulse_ns':0.}
        event=CollisionEvent(22,1.1,11,12,(3.,4.,0.),'carla-world')
        manager.observe_collision(event);manager.observe_collision(event)
        manager.observe_collision(replace(event,frame_id=23,timestamp_s=1.15))
        manager.observe_collision(replace(event,frame_id=24,timestamp_s=1.2,ego_actor_id=99))
        self.assertEqual(manager.metrics['collision_count'],1)
        self.assertEqual(manager.metrics['collision_callback_count'],2)
        self.assertEqual(manager.metrics['collision_peak_impulse_ns'],5.)
