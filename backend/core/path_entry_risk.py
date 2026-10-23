"""Calibrated pedestrian path-entry risk: numpy GRU inference and admission.

The model estimates P(pedestrian enters the ego corridor within 1/2/3 s | the
measured track history and scene context). It ranks physical possibilities;
it never certifies free space or overrides a measured hazard. Unadmitted or
unavailable models leave the physical-only controller unchanged.
"""
from collections.abc import Mapping
import hashlib
import json
from pathlib import Path
import threading
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


TRACK_FIELDS = ('id', 'position_m', 'velocity_mps', 'history', 'half_size_m', 'semantic_evidence', 'class', 'quality',
                'uncertainty_m', 'occlusion_s', 'confirmed', 'observed_crossing_cleared', 'motion_observations')


def _plain(value):
    """Detached plain copy (mappings, sequences, arrays) of a published value."""
    if isinstance(value, np.ndarray):return value.tolist()
    if isinstance(value, np.generic):return value.item()
    if isinstance(value, Mapping):return {k: _plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):return [_plain(v) for v in value]
    return value


class AsyncRiskEstimator:
    """Learned risk off the safety path, bound to the submitting frame.

    The safety step submits frame k's measured prediction when it starts; one
    background thread runs the unchanged ``RiskEstimator``. The pedestrian layer
    later takes the result only if it belongs to frame k and finished within the
    bounded budget measured from submission; otherwise that frame runs
    physics-only. A newer submission replaces a pending older one, and results
    are never applied to another frame. Risk can only add caution, so a missing
    result never relaxes a physical decision."""
    inference = 'ASYNC_FRAME_BOUND'

    def __init__(self, estimator, *, wait_budget_ms=15.):
        self.estimator = estimator;self.wait_budget_ms = float(wait_budget_ms)
        self._condition = threading.Condition();self._job = None;self._result = None;self._submitted = {}
        self._closed = False
        self._thread = threading.Thread(target=self._run, name='path-entry-risk', daemon=True);self._thread.start()

    @property
    def model(self):return self.estimator.model

    def submit(self, prediction, *, frame_id, timestamp_s, ego_speed_mps, steering, observation_age_s=0.):
        front = self.estimator.front_m
        snapshot = None
        try:
            if prediction:
                # The worker must not read structures the next frame may modify;
                # copy only what the feature contract reads, as plain values.
                snapshot = {k: _plain(prediction[k]) for k in ('source', 'evaluation_frame', 'frame_id', 'odometry_origin_m',
                                                                'odometry_yaw_rad') if k in prediction}
                snapshot['tracks'] = [{k: _plain(t[k]) for k in TRACK_FIELDS if k in t}
                                      for t in prediction.get('tracks', ()) if eligible_track(t, front_m=front)]
        except (TypeError, ValueError, KeyError, AttributeError) as error:
            # Learned risk never interrupts the safety step: this frame runs physics-only.
            with self._condition:
                self._submitted = {'frame_id': frame_id, 'at': time.perf_counter()}
                self._result = {'frame_id': frame_id, 'status': 'FAILED', 'error': 'snapshot: '+str(error), 'tracks': {},
                                'inference': self.inference, 'model_id': MODEL_ID, 'experimental': self.estimator.experimental}
                self._condition.notify_all()
            return
        submitted = time.perf_counter()
        with self._condition:
            self._job = (snapshot, {'frame_id': frame_id, 'timestamp_s': timestamp_s, 'ego_speed_mps': ego_speed_mps,
                                    'steering': steering, 'observation_age_s': observation_age_s}, submitted)
            self._submitted = {'frame_id': frame_id, 'at': submitted}
            self._condition.notify_all()

    def _run(self):
        while True:
            with self._condition:
                while self._job is None and not self._closed:self._condition.wait()
                if self._closed:return
                prediction, arguments, submitted = self._job;self._job = None
            started = time.perf_counter()
            try:result = self.estimator.estimate(prediction, **arguments)
            except Exception as error:  # noqa: BLE001 - the worker must survive and fail closed
                result = {'frame_id': arguments['frame_id'], 'status': 'FAILED', 'error': str(error), 'tracks': {},
                          'model_id': MODEL_ID, 'experimental': self.estimator.experimental}
            result = {**result, 'inference': self.inference, 'queue_ms': (started-submitted)*1000}
            with self._condition:
                self._result = result;self._condition.notify_all()

    def result_for(self, frame_id):
        with self._condition:
            submitted = self._submitted.get('at') if self._submitted.get('frame_id') == frame_id else None
            if submitted is None:
                return {'frame_id': frame_id, 'status': 'NOT_SUBMITTED', 'inference': self.inference, 'tracks': {}}
            deadline = submitted+self.wait_budget_ms/1000.
            while not (self._result and self._result.get('frame_id') == frame_id):
                remaining = deadline-time.perf_counter()
                if remaining <= 0.:break
                self._condition.wait(remaining)
            result = self._result if self._result and self._result.get('frame_id') == frame_id else None
            waited = max(0., (time.perf_counter()-submitted)*1000)
        if result is None:
            return {'frame_id': frame_id, 'status': 'NOT_READY_WITHIN_BUDGET', 'inference': self.inference, 'tracks': {},
                    'since_submit_ms': waited, 'model_id': MODEL_ID, 'experimental': self.estimator.experimental}
        return {**result, 'since_submit_ms': waited}

    def close(self):
        with self._condition:
            self._closed = True;self._condition.notify_all()
