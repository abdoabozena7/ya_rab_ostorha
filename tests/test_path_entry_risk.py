import hashlib
import json
from pathlib import Path
import tempfile
from unittest import TestCase
import numpy as np
from backend.core.path_entry_features import FEATURE_VERSION, INPUT_SIZE, STEPS
from backend.core.path_entry_risk import PathEntryRiskModel, RiskEstimator, admitted_model


def weights(hidden=4, encoded=5, seed=3):
    rng = np.random.default_rng(seed)
    return {'encoder.weight': rng.normal(0, .3, (encoded, INPUT_SIZE)), 'encoder.bias': rng.normal(0, .1, encoded),
            'gru.weight_ih_l0': rng.normal(0, .3, (3*hidden, encoded)), 'gru.weight_hh_l0': rng.normal(0, .3, (3*hidden, hidden)),
            'gru.bias_ih_l0': rng.normal(0, .1, 3*hidden), 'gru.bias_hh_l0': rng.normal(0, .1, 3*hidden),
            'head.weight': rng.normal(0, .3, (3, hidden)), 'head.bias': rng.normal(0, .1, 3)}


def reference(w, x):
    """Independent per-sample GRU (torch gate order r, z, n)."""
    sig = lambda v: 1/(1+np.exp(-v));hidden = w['gru.weight_hh_l0'].shape[1];out = []
    for sample in x:
        h = np.zeros(hidden)
        for step in sample:
            e = np.maximum(0, w['encoder.weight']@step+w['encoder.bias'])
            gi = w['gru.weight_ih_l0']@e+w['gru.bias_ih_l0'];gh = w['gru.weight_hh_l0']@h+w['gru.bias_hh_l0']
            r = sig(gi[:hidden]+gh[:hidden]);z = sig(gi[hidden:2*hidden]+gh[hidden:2*hidden])
            n = np.tanh(gi[2*hidden:]+r*gh[2*hidden:]);h = (1-z)*n+z*h
        out.append(w['head.weight']@h+w['head.bias'])
    return np.array(out)


def write_artifact(root, *, passed, calibrated=True):
    root = Path(root);root.mkdir(parents=True, exist_ok=True);np.savez(root/'weights.npz', **weights())
    calibration = {f'{h}s': {'a': 1.2, 'b': -.3} for h in (1, 2, 3)} if calibrated else {}
    manifest = {'feature_version': FEATURE_VERSION, 'steps': STEPS, 'weights_file': 'weights.npz',
                'weights_sha256': hashlib.sha256((root/'weights.npz').read_bytes()).hexdigest(),
                'calibration': calibration, 'admission': {'passed': passed}}
    (root/'manifest.json').write_text(json.dumps(manifest));return root


class PathEntryRiskTests(TestCase):
    def test_numpy_runtime_matches_an_independent_gru_and_is_horizon_monotone(self):
        w = weights();model = PathEntryRiskModel(w, {'feature_version': FEATURE_VERSION, 'steps': STEPS, 'calibration': {}})
        x = np.random.default_rng(1).normal(0, 1, (6, STEPS, INPUT_SIZE))
        np.testing.assert_allclose(model.logits(x), reference(w, x), atol=1e-10)
        p = model.probabilities(x);self.assertTrue(np.all(np.diff(p, axis=1) >= 0));self.assertFalse(model.calibrated)
        with self.assertRaises(ValueError):PathEntryRiskModel(w, {'feature_version': 'OTHER', 'steps': STEPS})

    def test_admission_states_and_tampered_weights(self):
        with tempfile.TemporaryDirectory() as root:
            import backend.core.path_entry_risk as risk
            original = risk.ROOT;risk.ROOT = Path(root)
            try:
                self.assertEqual(admitted_model({'artifact': None})[1]['reason'], 'NO_TRAINED_ARTIFACT')
                write_artifact(Path(root)/'a', passed=False)
                self.assertEqual(admitted_model({'artifact': 'a'})[1]['reason'], 'ADMISSION_NOT_PASSED')
                write_artifact(Path(root)/'b', passed=True, calibrated=False)
                self.assertEqual(admitted_model({'artifact': 'b'})[1]['reason'], 'UNCALIBRATED_OUTPUTS_ARE_NOT_PROBABILITIES')
                write_artifact(Path(root)/'c', passed=True)
                model, status = admitted_model({'artifact': 'c', 'enabled': False})
                self.assertTrue(status['admitted']);self.assertFalse(status['production_enabled'])
                self.assertTrue(admitted_model({'artifact': 'c', 'enabled': True})[1]['production_enabled'])
                with open(Path(root)/'c'/'weights.npz', 'ab') as stream:stream.write(b'0')
                self.assertTrue(admitted_model({'artifact': 'c'})[1]['reason'].startswith('ARTIFACT_INVALID'))
            finally:risk.ROOT = original

    def test_outputs_are_bound_to_their_frame_and_fail_closed(self):
        model = type('Stub', (), {'probabilities': lambda self, x: np.full((len(x), 3), .4)})()
        estimator = RiskEstimator(model, corridor_half_width_m=1.4, front_m=2.4)
        prediction = {'source': 'CONTROL_SENSOR_PIPELINE', 'evaluation_frame': 9, 'odometry_origin_m': [0., 0.], 'odometry_yaw_rad': 0.,
                      'tracks': [{'id': 'p', 'position_m': [20., 4.], 'velocity_mps': [0., 0.], 'confirmed': True, 'half_size_m': [.35, .35]}]}
        result = estimator.estimate(prediction, frame_id=9, timestamp_s=1., ego_speed_mps=5., steering=0.)
        self.assertEqual(RiskEstimator.for_frame(result, 9)['p']['3s'], .4)
        self.assertEqual(RiskEstimator.for_frame(result, 10), {})
        stale = estimator.estimate({**prediction, 'evaluation_frame': 8}, frame_id=9, timestamp_s=1., ego_speed_mps=5., steering=0.)
        self.assertEqual(stale['status'], 'NO_CURRENT_CONTROL_PREDICTION')
        broken = estimator.estimate({k: v for k, v in prediction.items() if k != 'odometry_origin_m'}, frame_id=9, timestamp_s=1.,
                                    ego_speed_mps=5., steering=0.)
        self.assertEqual((broken['status'], broken['tracks']), ('FAILED', {}))
