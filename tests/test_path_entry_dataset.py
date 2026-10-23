import copy
import gzip
import json
from pathlib import Path
import tempfile
from unittest import TestCase
import numpy as np
from backend.core.path_entry_features import INPUT_SIZE, STEPS, corridor_coordinates, eligible_track, track_features
from backend.learning.path_entry_dataset import build_split, episode_samples
from backend.core.pedestrian_behaviors import load_suite

LABEL = load_suite()['label']


def synthetic_episode(directory, *, retreat_after=None, duration=8., missing_track_until=0.):
    """Native-shaped log: ego at 5 m/s; walker at x=40 crosses from y=+6 after 3 s."""
    directory = Path(directory);directory.mkdir(parents=True, exist_ok=True)
    manifest = {'scenario_id': 'synthetic', 'split': 'TRAIN', 'behavior': 'CROSS_NORMAL', 'route': [[x, 0., 0.] for x in range(0, 122, 2)],
                'ego_front_m': 2.3, 'corridor_half_width_m': 1.25,
                'spec': {'pedestrians': [{'role': 'ped_0', 'script': 'CROSS'}], 'counterfactual': None}, 'admission': {'configuration': 'B_PHYSICAL_PREDICTIVE'}}
    (directory/'manifest.json').write_text(json.dumps(manifest))
    (directory/'outcome.json').write_text(json.dumps({'outcome': 'ARRIVED', 'contacts': [], 'realization': {'ped_0': {'realized': True}}}))
    rows = [];history = []
    for k in range(int(duration/.05)+1):
        t = round(k*.05, 3);ego_x = 5.*t
        y = 6. if t < 3. else max(-6., 6.-1.5*(t-3.))
        if retreat_after is not None and t >= retreat_after:y = min(6., 6.-1.5*(retreat_after-3.)+1.5*(t-retreat_after))
        vy = 0. if t < 3. else -1.5
        truth_y = y
        scene_y = 6. if t < 3. else max(-6., 6.-1.5*(t-3.))
        if retreat_after is None or t < retreat_after:history.append([t, 40., scene_y, 0., vy])
        track = {'id': 'depth-person-1', 'class': 'person', 'confirmed': True, 'position_m': [40.-ego_x, scene_y],
                 'velocity_mps': [0., vy], 'half_size_m': [.35, .35], 'uncertainty_m': .25, 'occlusion_s': 0., 'quality': .8,
                 'motion_observations': 4, 'history': [h for h in history[-60:] if h[0] < t],
                 'semantic_evidence': {'confidence': .9}}
        scene_tracks = [track] if t >= missing_track_until else []
        rows.append({'frame': k, 'timestamp_s': t, 'elapsed_s': t,
                     'ego': {'speed_mps': 5., 'position_m': [ego_x, 0., 0.], 'yaw_rad': 0., 'steering': 0.},
                     'base_command': {'steering': 0.},
                     'scene': {'frame_id': k, 'timestamp_s': t, 'motion_tracking_complete': True, 'odometry_origin_m': [ego_x, 0.],
                               'odometry_yaw_rad': 0., 'tracks': scene_tracks},
                     'evaluator_truth': [{'id': 7, 'role': 'ped_0', 'kind': 'walker', 'position_m': [40., truth_y, 1.],
                                          'half_size_m': [.3, .3]}]})
    with gzip.open(directory/'episode.jsonl.gz', 'wt', encoding='utf8') as stream:
        for row in rows:stream.write(json.dumps(row)+'\n')
    return directory


class PathEntryDatasetTests(TestCase):
    def test_labels_come_from_future_truth_and_features_do_not(self):
        with tempfile.TemporaryDirectory() as root:
            crossing, _, _ = episode_samples(synthetic_episode(Path(root)/'a'), label_config=LABEL)
            retreat, _, _ = episode_samples(synthetic_episode(Path(root)/'b', retreat_after=4.), label_config=LABEL)
        by_time = {round(s['meta']['timestamp_s'], 3): s for s in retreat}
        compared = 0
        for sample in crossing:
            t = round(sample['meta']['timestamp_s'], 3)
            if t > 3.9 or t not in by_time:continue
            # The measured scene is identical before the alternative future.
            np.testing.assert_array_equal(sample['inputs'], by_time[t]['inputs']);compared += 1
        self.assertGreater(compared, 20)
        early = {round(s['meta']['timestamp_s'], 3): s['labels'] for s in crossing}
        self.assertEqual(early[1.0]['3s'], {'status': 'LABELED', 'label': 0})
        self.assertEqual(early[3.5]['3s']['label'], 1);self.assertEqual(early[3.5]['2s']['label'], 0)
        changed = {round(s['meta']['timestamp_s'], 3): s['labels'] for s in retreat}
        self.assertEqual(changed[3.5]['3s']['label'], 0)

    def test_every_relevant_walker_frame_has_an_explicit_status(self):
        with tempfile.TemporaryDirectory() as root:
            directory = synthetic_episode(Path(root)/'c', missing_track_until=2.)
            samples, coverage, _ = episode_samples(directory, label_config=LABEL)
            summary = build_split([directory], Path(root)/'out/train.npz', split='TRAIN')
            with np.load(Path(root)/'out/train.npz') as data:
                self.assertEqual(data['X'].shape[1:], (STEPS, INPUT_SIZE))
        self.assertEqual(coverage['relevant'], coverage['associated']+coverage['unobserved']+coverage['ambiguous']+coverage['scene_mismatch'])
        self.assertGreater(coverage['unobserved'], 0)
        self.assertEqual(summary['samples'], len(samples))
        counts = summary['label_counts']['3s']
        self.assertEqual(sum(counts.values()), summary['samples'])
        self.assertEqual(summary['positives']['3s']+summary['negatives']['3s'], counts['LABELED'])

    def test_feature_contract_masks_missing_history_and_filters_tracks(self):
        track = {'id': 'x', 'position_m': [12., 3.], 'velocity_mps': [0., -1.], 'confirmed': True, 'half_size_m': [.35, .35]}
        result = track_features(track, timestamp_s=5., odometry_origin_m=[0., 0.], odometry_yaw_rad=0., ego_speed_mps=4.,
                                steering=0., corridor_half_width_m=1.25)
        self.assertEqual(result['observed'].tolist(), [False]*(STEPS-1)+[True])
        self.assertTrue(np.all(result['inputs'][:-1, :7] == 0.))
        self.assertTrue(eligible_track(track));self.assertFalse(eligible_track({**track, 'half_size_m': [2., 2.]}))
        self.assertFalse(eligible_track({**track, 'position_m': [-3., 0.]}))
        s, d = corridor_coordinates([[10., 0.], [0., 2.]], 0.);np.testing.assert_allclose(s, [10., 0.]);np.testing.assert_allclose(d, [0., 2.])
        radius = 20.;s, d = corridor_coordinates([[radius*np.sin(.5), radius*(1-np.cos(.5))]], 1/radius)
        np.testing.assert_allclose([s[0], d[0]], [10., 0.], atol=1e-9)
