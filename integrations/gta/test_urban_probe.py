import copy
import json
from pathlib import Path
import unittest
import urban_probe as urban


class UrbanControls(unittest.TestCase):
    def test_requested_counts_cannot_be_silently_reduced(self):
        config=json.loads((urban.HERE/'urban-scenario.json').read_text());config['on_foot_pedestrians']=40
        with self.assertRaises(ValueError):urban.validate_scenario(config)
    def test_training_is_not_admitted_by_scene_setup(self):
        config=json.loads((urban.HERE/'urban-scenario.json').read_text());config['training_admitted']=True
        with self.assertRaises(ValueError):urban.validate_scenario(config)
    def test_split_seed_overlap_is_rejected(self):
        config=json.loads((urban.HERE/'urban-scenario.json').read_text());config['split_sites']['TEST']['seeds']=[1000,1999]
        with self.assertRaises(ValueError):urban.validate_scenario(config)
    def test_global_standstill_is_not_local_jam(self):
        rows=[{'host_ms':i*1000,'blocker_stopped':True,'near_slow':20,'near_queue_from_moving':10,'away_moving':0} for i in range(10)]
        self.assertFalse(urban.local_jam(rows))
    def test_preexisting_parked_actors_are_not_traffic_response(self):
        rows=[{'host_ms':i*1000,'blocker_stopped':True,'near_slow':20,'near_queue_from_moving':0,'away_moving':5} for i in range(10)]
        self.assertFalse(urban.local_jam(rows))
    def test_short_or_repeated_observation_does_not_make_five_seconds(self):
        row={'host_ms':0,'blocker_stopped':True,'near_slow':6,'near_queue_from_moving':6,'away_moving':5}
        self.assertFalse(urban.local_jam([copy.deepcopy(row) for _ in range(10)]))
    def test_local_responding_queue_with_moving_away_traffic_meets_time_oracle(self):
        rows=[{'host_ms':i*1000,'blocker_stopped':True,'near_slow':6,'near_queue_from_moving':4,'away_moving':5} for i in range(6)]
        self.assertTrue(urban.local_jam(rows))


if __name__=='__main__':unittest.main()
