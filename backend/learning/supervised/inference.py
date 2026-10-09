"""CPU NumPy export of a trained torch.nn.GRU. No Torch/CUDA in driving loop."""
import hashlib
import json
from pathlib import Path
import numpy as np
from .features import VERSION, DIM, DECISIONS

ROOT = Path(__file__).resolve().parents[3]
DEFAULT_MODEL = ROOT/'artifacts/learned_safety/v1'


class LearnedSafetyPolicy:
    def __init__(self, directory=DEFAULT_MODEL):
        directory=Path(directory)
        self.metadata=json.loads((directory/'metadata.json').read_text())
        if self.metadata['feature_version']!=VERSION or self.metadata['input_dim']!=DIM or self.metadata['decisions']!=list(DECISIONS):
            raise ValueError('Learned model contract differs')
        path=directory/'weights.npz'
        if hashlib.sha256(path.read_bytes()).hexdigest()!=self.metadata['weights_sha256']:
            raise ValueError('Learned model integrity check failed')
        h=self.metadata['hidden_dim']
        if type(h) is not int or not 1<=h<=64: raise ValueError('Invalid model size')
        shapes={'gru.weight_ih_l0':(3*h,DIM),'gru.weight_hh_l0':(3*h,h),
            'gru.bias_ih_l0':(3*h,),'gru.bias_hh_l0':(3*h,), 'head.weight':(3,h),'head.bias':(3,)}
        with np.load(path,allow_pickle=False) as archive:
            if set(archive.files)!=set(shapes): raise ValueError('Undeclared model arrays')
            self.weights={k:archive[k].astype(np.float32) for k in shapes}
        if any(v.shape!=shapes[k] or not np.isfinite(v).all() for k,v in self.weights.items()):
            raise ValueError('Invalid trained weights')
        self.hidden_dim=h; self.reset()

    def reset(self): self.hidden=np.zeros(self.hidden_dim,np.float32)

    def predict(self, values):
        x=np.asarray(values,np.float32)
        if x.shape!=(DIM,) or not np.isfinite(x).all() or np.any(np.abs(x)>1): raise ValueError('Invalid model inputs')
        w=self.weights
        ir,iz,inn=np.split(w['gru.weight_ih_l0']@x+w['gru.bias_ih_l0'],3)
        hr,hz,hn=np.split(w['gru.weight_hh_l0']@self.hidden+w['gru.bias_hh_l0'],3)
        sigmoid=lambda a:1/(1+np.exp(-np.clip(a,-60,60)))
        r=sigmoid(ir+hr); z=sigmoid(iz+hz)
        n=np.tanh(inn+r*hn)
        self.hidden=(1-z)*n+z*self.hidden
        logits=w['head.weight']@self.hidden+w['head.bias']
        probs=np.exp(logits-logits.max()); probs/=probs.sum()
        if not np.isfinite(probs).all(): raise ValueError('Invalid model prediction')
        return DECISIONS[int(probs.argmax())],probs
