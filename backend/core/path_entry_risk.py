"""Calibrated pedestrian path-entry risk: numpy GRU inference and admission.

The model estimates P(pedestrian enters the ego corridor within 1/2/3 s | the
measured track history and scene context). It ranks physical possibilities;
it never certifies free space or overrides a measured hazard. Unadmitted or
unavailable models leave the physical-only controller unchanged.
"""
import hashlib
import json
from pathlib import Path
import time
import numpy as np
from .path_entry_features import FEATURE_VERSION, INPUT_SIZE, STEPS, eligible_track, track_features

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT/'config/path-entry-risk.json'
MODEL_ID = 'PEDESTRIAN_PATH_ENTRY_RISK_GRU_V1'
HORIZONS_S = (1, 2, 3)


def _sigmoid(x):
    return 1./(1.+np.exp(-np.clip(x, -40., 40.)))


class PathEntryRiskModel:
    """Exact numpy forward pass of the exported torch encoder/GRU/head."""
    def __init__(self, weights, manifest):
        self.manifest = manifest
        required = ('encoder.weight', 'encoder.bias', 'gru.weight_ih_l0', 'gru.weight_hh_l0', 'gru.bias_ih_l0',
                    'gru.bias_hh_l0', 'head.weight', 'head.bias')
        if set(required)-set(weights):raise ValueError('Path-entry model weights are incomplete')
        self.w = {k: np.asarray(weights[k], np.float64) for k in required}
        if self.w['encoder.weight'].shape[1] != INPUT_SIZE:raise ValueError('Model input size differs from the feature contract')
        if manifest.get('feature_version') != FEATURE_VERSION or manifest.get('steps') != STEPS:
            raise ValueError('Model feature version differs from runtime features')
        calibration = manifest.get('calibration') or {}
        self.calibration = np.array([[calibration.get(f'{h}s', {}).get('a', 1.), calibration.get(f'{h}s', {}).get('b', 0.)]
                                     for h in HORIZONS_S], float)
        self.calibrated = all(f'{h}s' in calibration for h in HORIZONS_S)

    @classmethod
    def load(cls, directory):
        directory = Path(directory)
        manifest = json.loads((directory/'manifest.json').read_text(encoding='utf8'))
        path = directory/manifest['weights_file']
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != manifest['weights_sha256']:raise ValueError('Path-entry model weights hash mismatch')
        with np.load(path, allow_pickle=False) as data:
            return cls({k: data[k] for k in data.files}, manifest)

    def logits(self, inputs):
        x = np.asarray(inputs, np.float64)
        if x.ndim != 3 or x.shape[1:] != (STEPS, INPUT_SIZE):raise ValueError('Expected [N, steps, features] inputs')
        w = self.w;hidden = w['gru.weight_hh_l0'].shape[1]
        h = np.zeros((len(x), hidden))
        encoded = np.maximum(0., x@w['encoder.weight'].T+w['encoder.bias'])
        for t in range(x.shape[1]):
            gi = encoded[:, t]@w['gru.weight_ih_l0'].T+w['gru.bias_ih_l0']
            gh = h@w['gru.weight_hh_l0'].T+w['gru.bias_hh_l0']
            r = _sigmoid(gi[:, :hidden]+gh[:, :hidden])
            z = _sigmoid(gi[:, hidden:2*hidden]+gh[:, hidden:2*hidden])
            n = np.tanh(gi[:, 2*hidden:]+r*gh[:, 2*hidden:])
            h = (1.-z)*n+z*h
        return h@w['head.weight'].T+w['head.bias']

    def probabilities(self, inputs):
        """Calibrated, horizon-monotone probabilities (1 s <= 2 s <= 3 s)."""
        z = self.logits(inputs)
        calibrated = _sigmoid(z*self.calibration[:, 0]+self.calibration[:, 1])
        return np.maximum.accumulate(calibrated, axis=1)


def load_config(path=CONFIG):
    return json.loads(Path(path).read_text(encoding='utf8'))


def admitted_model(config=None):
    """Return (model, status). Production requires explicit enablement and passed admission."""
    config = config or load_config()
    status = {'model_id': MODEL_ID, 'enabled': bool(config.get('enabled')), 'artifact': config.get('artifact'),
              'admitted': False, 'reason': None}
    if not config.get('artifact'):
        status['reason'] = 'NO_TRAINED_ARTIFACT';return None, status
    try:
        model = PathEntryRiskModel.load(ROOT/config['artifact'])
    except (OSError, ValueError, KeyError) as error:
        status['reason'] = 'ARTIFACT_INVALID: '+str(error);return None, status
    admission = model.manifest.get('admission') or {}
    status.update(admission=admission, calibrated=model.calibrated, production_enabled=False)
    if not model.calibrated:status['reason'] = 'UNCALIBRATED_OUTPUTS_ARE_NOT_PROBABILITIES';return model, status
    if not admission.get('passed'):status['reason'] = 'ADMISSION_NOT_PASSED';return model, status
    # Prediction admission (independent TEST) is separate from driving
    # acceptance; ordinary production journeys still require enablement.
    status.update(admitted=True, production_enabled=bool(config.get('enabled')),
                  reason='ADMITTED' if config.get('enabled') else 'ADMITTED_PREDICTION_PRODUCTION_DISABLED')
    return model, status


class RiskEstimator:
    """Per-frame risk for eligible measured tracks, bound to the source frame.

    Outputs carry the measurement frame and are rejected for any other frame.
    Failures and time-budget overruns return no risk; physics stays in charge.
    """
    def __init__(self, model, *, corridor_half_width_m, front_m, time_budget_ms=15., experimental=False):
        self.model = model;self.corridor_half_width_m = corridor_half_width_m;self.front_m = front_m
        self.time_budget_ms = time_budget_ms;self.experimental = experimental
        self.last = None

    def estimate(self, prediction, *, frame_id, timestamp_s, ego_speed_mps, steering, observation_age_s=0.):
        began = time.perf_counter()
        result = {'frame_id': frame_id, 'timestamp_s': timestamp_s, 'tracks': {}, 'status': 'UNAVAILABLE',
                  'model_id': MODEL_ID, 'experimental': self.experimental}
        if (self.model is None or not prediction or prediction.get('source') != 'CONTROL_SENSOR_PIPELINE'
                or prediction.get('evaluation_frame', prediction.get('frame_id')) != frame_id):
            result['status'] = 'NO_CURRENT_CONTROL_PREDICTION' if self.model is not None else 'NO_MODEL'
            self.last = result;return result
        try:
            tracks = [t for t in prediction.get('tracks', ()) if eligible_track(t, front_m=self.front_m)]
            if tracks:
                features = [track_features(t, timestamp_s=timestamp_s, odometry_origin_m=prediction['odometry_origin_m'],
                    odometry_yaw_rad=prediction['odometry_yaw_rad'], ego_speed_mps=ego_speed_mps, steering=steering,
                    corridor_half_width_m=self.corridor_half_width_m, front_m=self.front_m,
                    observation_age_s=observation_age_s) for t in tracks]
                probabilities = self.model.probabilities(np.stack([f['inputs'] for f in features]))
                for track, f, p in zip(tracks, features, probabilities):
                    result['tracks'][str(track['id'])] = {f'{h}s': float(v) for h, v in zip(HORIZONS_S, p)}
                    result['tracks'][str(track['id'])]['history_span_s'] = f['history_span_s']
            elapsed = (time.perf_counter()-began)*1000
            result.update(status='OVER_TIME_BUDGET' if elapsed > self.time_budget_ms else 'READY', latency_ms=elapsed)
            if elapsed > self.time_budget_ms:result['tracks'] = {}
        except (ValueError, KeyError, TypeError, FloatingPointError) as error:
            result.update(status='FAILED', error=str(error), tracks={})
        self.last = result
        return result

    @staticmethod
    def for_frame(result, frame_id):
        """Reject stale outputs rather than applying them to newer frames."""
        if not result or result.get('status') != 'READY' or result.get('frame_id') != frame_id:return {}
        return result['tracks']
