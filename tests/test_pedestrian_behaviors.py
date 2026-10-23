import gzip
import json
import math
from pathlib import Path
import tempfile
from unittest import TestCase
import numpy as np
from backend.core.pedestrian_behaviors import (BEHAVIORS, SCRIPTS, WalkerScript, counterfactual_pair, lateral_profile,
    ORDINARY, load_suite, location_id, ordinary_journey, path_entry_labels, project_polyline, sample_episode, split_episodes,
    validate_spec, verify_realization)
from backend.core.scenarios import SEED_RANGES, DatasetSplit


def simulate(plan, *, near=5., far=5., seconds=14., dt=.05, trigger_at=1., ego_distance=None):
    """Integrate the walker script with ideal kinematics (offline test fixture)."""
    script = WalkerScript(plan, near_u=near, far_u=far);u = script.start_u;s = 0.;rows = []
    for k in range(int(seconds/dt)):
        t = k*dt
        distance = (ego_distance(t) if ego_distance else (100. if t < trigger_at else 0.))
        along, toward, _ = script.command(t, u, ego_distance_m=distance)
        u -= toward*dt;s += along*dt
        rows.append((t, s, u, math.hypot(along, toward)))
    return script, rows


class PedestrianSuiteTests(TestCase):
    suite = load_suite()

    def test_locations_seeds_and_scenarios_are_disjoint_across_splits(self):
        locations = {split: {location_id(r) for r in self.suite['locations'][split]} for split in ('TRAIN', 'VALIDATION', 'TEST')}
        self.assertFalse(locations['TRAIN'] & locations['VALIDATION'])
        self.assertFalse(locations['TRAIN'] & locations['TEST'])
        self.assertFalse(locations['VALIDATION'] & locations['TEST'])
        self.assertTrue(all(row.startswith('Town02_Opt') for row in locations['TEST'] if 'Town02' in row))
        self.assertFalse(any('Town02_Opt' in row for row in locations['TRAIN'] | locations['VALIDATION']))
        ids = {}
        for split in ('TRAIN', 'VALIDATION', 'TEST'):
            specs = split_episodes(self.suite, split, 30)
            lo, hi = SEED_RANGES[DatasetSplit(split)]
            self.assertTrue(all(lo <= s['seed'] <= hi for s in specs))
            self.assertTrue(all(location_id(s['location']) in locations[split] for s in specs))
            ids[split] = {s['scenario_id'] for s in specs}
            self.assertEqual(len(ids[split]), 30)
            self.assertEqual({s['behavior'] for s in specs}, set(BEHAVIORS))
        self.assertFalse(ids['TRAIN'] & ids['VALIDATION'] or ids['TRAIN'] & ids['TEST'] or ids['VALIDATION'] & ids['TEST'])

    def test_holdout_partition_is_independent_of_every_split(self):
        from backend.core.pedestrian_behaviors import HOLDOUT_SEED_RANGE, holdout_episode, holdout_ordinary
        from scripts.build_holdout_partition import build
        towns = {}
        def row(town, spawn, road, width=10.5, accepted=True):
            towns.setdefault(town, []).append({'town': town, 'spawn_index': spawn, 'accepted': accepted, 'road_id': road,
                                               'lane_id': -1, 'road_width_m': [width, width]})
        for split_rows in self.suite['locations'].values():
            for r in split_rows:row(r['town'], r['spawn_index'], road=f"used-{r['town']}-{r['spawn_index']}", width=r['road_width_m'])
        used = next(r for r in self.suite['locations']['TEST'])
        row(used['town'], 9001, road=f"used-{used['town']}-{used['spawn_index']}")   # new spawn on a used road
        row('Town09_Opt', 1, road=1);row('Town09_Opt', 2, road=1)                    # same road and lane: one kept
        row('Town09_Opt', 3, road=2, width=22.);row('Town09_Opt', 4, road=3, accepted=False)
        locations, _, specs = build(self.suite, {'towns': towns}, seeds_per_behavior=2, counterfactual_pairs=1, ordinary=2,
                                    time_limit_s=90.)
        self.assertEqual(sorted((l['town'], l['spawn_index']) for l in locations), [('Town09_Opt', 1), ('Town09_Opt', 3)])
        lo, hi = HOLDOUT_SEED_RANGE
        self.assertTrue(all(s['split'] == 'HOLDOUT' and lo <= s['seed'] <= hi and s['location']['town'] == 'Town09_Opt' for s in specs))
        self.assertEqual(len({s['scenario_id'] for s in specs}), len(specs))
        self.assertTrue(all(s['time_limit_s'] == 90. for s in specs))
        arms = [s for s in specs if s['behavior'] == 'COUNTERFACTUAL_PAIR']
        self.assertEqual(len(arms), 2);self.assertEqual(arms[0]['counterfactual']['pair_id'], arms[1]['counterfactual']['pair_id'])
        spec = holdout_ordinary(self.suite, locations, 200, time_limit_s=90.)
        self.assertEqual(spec, holdout_ordinary(self.suite, locations, 200, time_limit_s=90.))
        self.assertNotEqual(spec['scenario_id'], holdout_ordinary(self.suite, locations, 200)['scenario_id'])
        with self.assertRaises(ValueError):holdout_episode(self.suite, [], 0)
        with self.assertRaises(ValueError):holdout_episode(self.suite, locations, hi-lo+1)

    def test_sampling_is_deterministic_and_unsupported_behavior_fails_explicitly(self):
        self.assertEqual(sample_episode(self.suite, 'TRAIN', 11), sample_episode(self.suite, 'TRAIN', 11))
        with self.assertRaises(ValueError):sample_episode(self.suite, 'TRAIN', 0, behavior='JAYWALK_BACKWARDS')
        spec = sample_episode(self.suite, 'TRAIN', 0)
        spec['pedestrians'][0]['script'] = 'TELEPORT'
        with self.assertRaises(ValueError):validate_spec(spec)
        emerge = sample_episode(self.suite, 'TRAIN', 7, behavior='EMERGE_FROM_PARKED');emerge['occluder'] = None
        with self.assertRaises(ValueError):validate_spec(emerge)

    def test_counterfactual_arms_share_construction_and_differ_only_after_decision(self):
        a, b = counterfactual_pair(self.suite, 'TEST', 4)
        self.assertEqual(a['counterfactual']['pair_id'], b['counterfactual']['pair_id'])
        self.assertNotEqual(a['scenario_id'], b['scenario_id'])
        for key in ('location', 'route_length_m', 'ego', 'occluder', 'traffic', 'seed'):self.assertEqual(a[key], b[key])
        pa, pb = a['pedestrians'][0], b['pedestrians'][0]
        self.assertEqual({k: v for k, v in pa.items() if k != 'script'}, {k: v for k, v in pb.items() if k != 'script'})
        self.assertEqual((pa['script'], pb['script']), ('WAIT', 'RUN'))
        decision = a['counterfactual']['decision_s']
        _, rows_a = simulate(pa, trigger_at=decision);_, rows_b = simulate(pb, trigger_at=decision)
        before = [i for i, r in enumerate(rows_a) if r[0] < decision]
        self.assertEqual([rows_a[i] for i in before], [rows_b[i] for i in before])
        self.assertNotEqual(rows_a[-1][2], rows_b[-1][2])

    def test_every_script_physically_realizes_and_a_static_crossing_does_not(self):
        base = {'role': 'ped_0', 'side': 'RIGHT', 'along_m': 40., 'curb_offset_m': .8, 'walk_speed_mps': 1.4,
                'trigger': {'kind': 'EGO_DISTANCE', 'distance_m': 30.}, 'blueprint_index': 1}
        extra = {'RUN': {'run_speed_mps': 3.2, 'far_offset_m': 1.}, 'CROSS': {'far_offset_m': 1.},
                 'HESITATE_CROSS': {'hesitation_s': 1.2, 'approach_offset_m': .3, 'far_offset_m': 1.},
                 'HESITATE_RETREAT': {'hesitation_s': 1.2, 'approach_offset_m': .3, 'retreat_m': 1.},
                 'START_RETURN': {'incursion_m': 1.2, 'pause_s': .5}, 'PARALLEL': {'direction': 1, 'trigger': {'kind': 'EPISODE_START'}}}
        for script in SCRIPTS:
            plan = {**base, 'script': script, **extra.get(script, {})}
            walker, rows = simulate(plan)
            check = verify_realization(plan, rows, near_u=5., far_u=5., corridor_half_width_m=1.25)
            self.assertTrue(check['realized'], (script, check))
        stuck = [(t, 0., 5.8, 0.) for t in np.arange(0., 6., .05)]
        self.assertFalse(verify_realization({**base, 'script': 'CROSS', 'far_offset_m': 1.}, stuck, near_u=5., far_u=5.,
                                            corridor_half_width_m=1.25)['realized'])

    def test_hesitation_lasts_its_scheduled_interval_before_crossing(self):
        plan = {'role': 'p', 'script': 'HESITATE_CROSS', 'side': 'LEFT', 'along_m': 40., 'curb_offset_m': 1.,
                'walk_speed_mps': 1.2, 'trigger': {'kind': 'SIMULATION_TIME', 'at_s': 1.}, 'hesitation_s': 1.5,
                'approach_offset_m': .3, 'far_offset_m': 1., 'blueprint_index': 0}
        walker, _ = simulate(plan, trigger_at=0.)
        phases = dict((phase, t) for t, phase in walker.history)
        self.assertAlmostEqual(phases['CROSSING']-phases['HESITATING'], 1.5, delta=.06)
        self.assertGreaterEqual(phases['APPROACHING'], 1.)

    def test_polyline_projection_handles_bends_and_signs(self):
        line = np.array([[0., 0.], [10., 0.], [10., 10.]])
        s, d = project_polyline([[5., 1.], [5., -2.], [11., 5.], [-2., 0.]], line)
        np.testing.assert_allclose(s, [5., 5., 15., -2.]);np.testing.assert_allclose(d, [1., -2., -1., 0.])

    def test_path_entry_labels_and_explicit_statuses(self):
        t = np.round(np.arange(0., 6.01, .05), 3)
        lateral = np.where(t < 2., 4., np.maximum(-4., 4.-2.*(t-2.)))
        along = np.full_like(t, 30.)
        labels = path_entry_labels(1.0, 0., t, along, lateral, radius_m=.3, corridor_half_width_m=1.25, corridor_length_m=60.)
        # Entry when |offset| <= 1.55 m: 2 + (4-1.55)/2 = 3.225 s, first native sample 3.25 s.
        self.assertEqual(labels['1s'], {'status': 'LABELED', 'label': 0})
        self.assertEqual(labels['2s'], {'status': 'LABELED', 'label': 0});self.assertEqual(labels['3s']['label'], 1)
        self.assertAlmostEqual(labels['3s']['entry_time_s'], 2.25, places=2)
        inside = path_entry_labels(3.5, 0., t, along, lateral, radius_m=.3, corridor_half_width_m=1.25, corridor_length_m=60.)
        self.assertEqual(inside['1s']['status'], 'IN_PATH_AT_DECISION')
        late = path_entry_labels(5.5, 0., t, along, np.full_like(t, 4.), radius_m=.3, corridor_half_width_m=1.25, corridor_length_m=60.)
        self.assertEqual(late['3s']['status'], 'MISSING_FUTURE');self.assertEqual(late['1s']['status'], 'MISSING_FUTURE')
        contact = path_entry_labels(1.0, 0., t, along, np.full_like(t, 4.), radius_m=.3, corridor_half_width_m=1.25,
                                    corridor_length_m=60., contact_t=2.5)
        self.assertEqual(contact['1s']['label'], 0);self.assertEqual(contact['2s']['status'], 'POST_CONTACT')
        before = path_entry_labels(1.0, 0., t, along, lateral, radius_m=.3, corridor_half_width_m=1.25, corridor_length_m=60., contact_t=3.5)
        self.assertEqual(before['3s']['label'], 1)
        behind = path_entry_labels(1.0, 35., t, along, lateral, radius_m=.3, corridor_half_width_m=1.25, corridor_length_m=60.)
        self.assertEqual(behind['3s']['label'], 0)

    def test_ordinary_journeys_have_traffic_and_no_scripted_walkers(self):
        spec = ordinary_journey(self.suite, 'TEST', 2)
        self.assertEqual((spec['behavior'], spec['pedestrians']), (ORDINARY, []))
        self.assertGreater(spec['traffic']['vehicles'], 0);self.assertEqual(spec, ordinary_journey(self.suite, 'TEST', 2))
        with self.assertRaises(ValueError):validate_spec(spec)

    def test_lateral_profile_requires_measured_sidewalks(self):
        samples = [(y/4, 'Sidewalk' if abs(y/4) > 5.5 else 'Shoulder' if abs(y/4) > 4.5 else 'Driving') for y in range(-40, 41)]
        profile = lateral_profile(samples)
        self.assertAlmostEqual(profile['right']['curb_m'], 5.75);self.assertAlmostEqual(profile['left']['curb_m'], -5.75)
        self.assertTrue(profile['right']['parking_or_shoulder'])
        with self.assertRaises(ValueError):lateral_profile([(y, 'Driving' if abs(y) < 5 else 'NONE') for y in range(-10, 11)])
