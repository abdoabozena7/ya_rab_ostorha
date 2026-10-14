"""Frozen continuous speed head and lightweight motion branch (CPU NumPy).

The original sensor13 GRU contract/weights are preserved. New heads require an
actually trained, checksummed artifact. Missing/corrupt heads are fatal in MODEL.
"""
import hashlib
import json
from pathlib import Path
import numpy as np
from .inference import LearnedSafetyPolicy

ROOT = Path(__file__).resolve().parents[3]
DEFAULT = ROOT/'artifacts/learned_safety/predictive_v2'


def motion_features(track):
    return np.clip(np.array([*np.asarray(track['velocity_mps'])/15.,
        *np.asarray(track['acceleration_mps2'])/5., track['quality'],
        float(track['class'] == 'person')], np.float32), -1, 1)


def speed_features(hidden, speed, distance, conflict_time, conflict, free_range, cap):
    return np.r_[hidden, np.clip([speed/15., distance/50., conflict_time/3.,
        float(conflict), free_range/45., cap/15.], -1, 1)].astype(np.float32)


class PredictiveModel:
    def __init__(self, directory=DEFAULT):
        directory = Path(directory)
        self.metadata = json.loads((directory/'metadata.json').read_text())
        path = directory/'heads.npz'
        if self.metadata.get('trained') is not True or self.metadata.get('frozen') is not True:
            raise ValueError('Predictive v2 is a configuration until trained and frozen')
        if hashlib.sha256(path.read_bytes()).hexdigest() != self.metadata['weights_sha256']:
            raise ValueError('Predictive weight checksum mismatch')
        self.gru = LearnedSafetyPolicy()
        if self.gru.metadata['weights_sha256'] != self.metadata['base_weights_sha256']:
            raise ValueError('Original GRU checksum changed')
        shapes = {'speed.0.weight': (32, 38), 'speed.0.bias': (32,),
                  'speed.2.weight': (1, 32), 'speed.2.bias': (1,),
                  'motion.0.weight': (16, 6), 'motion.0.bias': (16,),
                  'motion.2.weight': (4, 16), 'motion.2.bias': (4,)}
        with np.load(path, allow_pickle=False) as archive:
            if set(archive.files) != set(shapes): raise ValueError('Undeclared predictive arrays')
            self.weights = {k: archive[k] for k in shapes}
        if any(a.shape != shapes[k] or not np.isfinite(a).all() for k, a in self.weights.items()):
            raise ValueError('Invalid predictive arrays')

    def reset(self): self.gru.reset()

    def forward(self, name, x):
        w = self.weights
        return w[name+'.2.weight']@np.tanh(w[name+'.0.weight']@x+w[name+'.0.bias'])+w[name+'.2.bias']

    def target_speed(self, original_features, context, *, ablate=False):
        self.gru.predict(original_features)
        x = speed_features(self.gru.hidden, **context)
        target = float(np.clip(self.forward('speed', x)[0], 0., 1.))*15.
        return context['cap'] if ablate else min(context['cap'], target)

    def modes(self, tracks, *, ablate=False):
        result = []; times = np.arange(7)*.5
        for tr in tracks:
            if not tr['confirmed']: continue
            p = np.asarray(tr['position_m']); v = np.asarray(tr['velocity_mps'])
            if np.linalg.norm(v) < .3:
                from ...core.kinematic_prediction import kinematic_modes
                result.extend(kinematic_modes([tr]))
                continue
            learned = self.forward('motion', motion_features(tr))
            acceleration = np.clip(learned[:2]*5., -5., 5.)
            spread = np.clip(np.abs(learned[2:])*2., .05, 1.)
            if ablate: acceleration *= 0; spread *= 0
            # Separate acceleration hypotheses, never their averaged path.
            for i, sign in enumerate((0., -1., 1.)):
                a = acceleration+sign*spread
                xy = p+times[:, None]*v+.5*times[:, None]**2*a
                result.append({'track_id': tr['id'], 'source': 'LIGHTWEIGHT_LEARNED_MOTION',
                    'mode': i, 'probability': (0.5, .25, .25)[i],
                    'points': np.column_stack((times, xy)).tolist()})
        return result
