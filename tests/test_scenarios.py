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
