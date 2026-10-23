"""Train the lightweight pedestrian path-entry risk GRU (run in .venv-learned).

TRAIN fits weights; VALIDATION selects the checkpoint, fits per-horizon Platt
calibration and fixes decision thresholds. TEST is never read here. Exported
weights are evaluated by the numpy runtime before any admission decision.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
import uuid
import numpy as np
import torch
from torch import nn

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.core.path_entry_features import FEATURE_VERSION, INPUT_SIZE, STEPS  # noqa: E402
from backend.core.path_entry_risk import MODEL_ID, PathEntryRiskModel  # noqa: E402
from backend.learning import path_entry_metrics as metrics  # noqa: E402

HORIZONS = (1, 2, 3)
ADMISSION = {'auroc_min': .85, 'ece_max': .06, 'auprc_margin_over_best_baseline': .05,
             'brier_ratio_to_constant_max': .8, 'missed_entry_rate_max': .15,
             'evaluated_on': 'TEST only, after VALIDATION selection; every horizon must pass'}


class RiskNet(nn.Module):
    def __init__(self, hidden=32, encoded=32):
        super().__init__()
        self.encoder = nn.Linear(INPUT_SIZE, encoded);self.gru = nn.GRU(encoded, hidden, batch_first=True)
        self.head = nn.Linear(hidden, len(HORIZONS))

    def forward(self, x):
        _, h = self.gru(torch.relu(self.encoder(x)))
        return self.head(h[-1])


def load(path):
    with np.load(path) as data:
        arrays = {k: data[k] for k in data.files}
    meta = [json.loads(line) for line in Path(path).with_suffix('.meta.jsonl').read_text(encoding='utf8').splitlines()]
    return arrays, meta


def baselines(arrays, prevalence):
    cv = arrays['cv_entry_s'];physical = arrays['physical_any_entry']
    result = {}
    for k, h in enumerate(HORIZONS):
        result[f'{h}s'] = {'constant_prevalence': np.full(len(cv), prevalence[k]),
                           'kinematic_constant_velocity': (cv <= h).astype(float),
                           'kinematic_constant_velocity_soft': 1./(1.+np.exp(np.clip((np.minimum(cv, 99.)-h)/.5, -40, 40))),
                           'existing_physical_alternatives': physical[:, k].astype(float)}
    return result


def platt(logits, labels, iterations=200):
    """Fit sigmoid(a*z+b) on validation log loss (stable BCE-with-logits, LBFGS)."""
    z = torch.tensor(np.asarray(logits, float), dtype=torch.float64);y = torch.tensor(np.asarray(labels, float), dtype=torch.float64)
    params = torch.tensor([1., 0.], dtype=torch.float64, requires_grad=True)
    optimizer = torch.optim.LBFGS([params], lr=.5, max_iter=iterations, line_search_fn='strong_wolfe')
    loss_fn = nn.BCEWithLogitsLoss()
    def closure():
        optimizer.zero_grad();loss = loss_fn(params[0]*z+params[1], y);loss.backward();return loss
    optimizer.step(closure)
    a, b = (float(v) for v in params.detach())
    if not (np.isfinite(a) and np.isfinite(b)) or a <= 0.:raise RuntimeError(f'Calibration fit is not a valid monotone map: a={a}, b={b}')
    return a, b


def evaluate(scores, y, meta, thresholds):
    return {f'{h}s': {**metrics.summary(y[:, k], scores[:, k], threshold=thresholds[k]),
                      'events': metrics.event_metrics(meta, y[:, k], scores[:, k], thresholds[k], h)}
            for k, h in enumerate(HORIZONS)}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--train', required=True);parser.add_argument('--validation', required=True)
    parser.add_argument('--out', default=str(ROOT/'artifacts/learned_safety/path_entry_risk_v1'))
    parser.add_argument('--epochs', type=int, default=80);parser.add_argument('--seed', type=int, default=7)
    parser.add_argument('--hidden', type=int, default=32);parser.add_argument('--patience', type=int, default=12)
    args = parser.parse_args()
    torch.manual_seed(args.seed);np.random.seed(args.seed)
    train, train_meta = load(args.train);validation, validation_meta = load(args.validation)
    if any(m['split'] != 'TRAIN' for m in train_meta) or any(m['split'] != 'VALIDATION' for m in validation_meta):
        raise ValueError('Training requires TRAIN and VALIDATION splits only')
    for name, arrays in (('train', train), ('validation', validation)):
        if arrays['X'].shape[1:] != (STEPS, INPUT_SIZE):raise ValueError(name+' features differ from the runtime contract')
    X = torch.tensor(train['X']);Y = torch.tensor(train['y'].astype(np.float32))
    mask = torch.tensor(np.isin(train['y'], (0, 1)).astype(np.float32))
    positives = (Y*mask).sum(0);negatives = ((1-Y)*mask).sum(0)
    pos_weight = (negatives/positives.clamp(min=1.)).clamp(max=50.)
    model = RiskNet(args.hidden);optimizer = torch.optim.Adam(model.parameters(), lr=2e-3, weight_decay=1e-4)
    loss_fn = nn.BCEWithLogitsLoss(pos_weight=pos_weight, reduction='none')
    Xv = torch.tensor(validation['X']);yv = validation['y']
    best = (-1., None, -1);history = []
    generator = torch.Generator().manual_seed(args.seed)
    for epoch in range(args.epochs):
        model.train();order = torch.randperm(len(X), generator=generator);total = 0.
        for start in range(0, len(X), 256):
            index = order[start:start+256]
            logits = model(X[index]);target = torch.where(mask[index] > 0, Y[index], torch.zeros_like(Y[index]))
            loss = (loss_fn(logits, target)*mask[index]).sum()/mask[index].sum().clamp(min=1.)
            optimizer.zero_grad();loss.backward();optimizer.step();total += float(loss.detach())*len(index)
        model.eval()
        with torch.no_grad():zv = model(Xv).numpy()
        scores = [metrics.average_precision(yv[:, k], zv[:, k]) for k in range(len(HORIZONS))]
        selection = float(np.mean([s for s in scores if s is not None])) if any(s is not None for s in scores) else -1.
        history.append({'epoch': epoch, 'train_loss': total/len(X), 'validation_mean_auprc': selection})
        if selection > best[0]:best = (selection, {k: v.clone() for k, v in model.state_dict().items()}, epoch)
        elif epoch-best[2] >= args.patience:break
    model.load_state_dict(best[1]);model.eval()
    with torch.no_grad():zv = model(Xv).numpy()
    calibration = {}
    for k, h in enumerate(HORIZONS):
        labeled = np.isin(yv[:, k], (0, 1))
        a, b = platt(zv[labeled, k], yv[labeled, k])
        calibration[f'{h}s'] = {'a': a, 'b': b, 'method': 'PLATT_ON_VALIDATION', 'n': int(labeled.sum())}
    run_id = uuid.uuid4().hex;directory = Path(args.out)/run_id;directory.mkdir(parents=True)
    weights = {k: v.detach().cpu().numpy().astype(np.float32) for k, v in model.state_dict().items()}
    np.savez(directory/'weights.npz', **weights)
    digest = hashlib.sha256((directory/'weights.npz').read_bytes()).hexdigest()
    manifest = {'model_id': MODEL_ID, 'run_id': run_id, 'feature_version': FEATURE_VERSION, 'steps': STEPS, 'input_size': INPUT_SIZE,
                'architecture': {'encoder': f'Linear({INPUT_SIZE},32)+ReLU', 'gru_hidden': args.hidden, 'head': 'Linear(hidden,3)'},
                'target': 'P(pedestrian enters the planned ego corridor within H s | measured history and scene context)',
                'horizons_s': list(HORIZONS), 'weights_file': 'weights.npz', 'weights_sha256': digest, 'calibration': calibration,
                'training': {'seed': args.seed, 'epochs_run': len(history), 'selected_epoch': best[2], 'pos_weight': pos_weight.tolist(),
                             'loss': 'BCEWithLogits with pos_weight=negatives/positives (max 50), masked unlabeled',
                             'selection': 'max mean VALIDATION AUPRC (uncalibrated logits)', 'history': history,
                             'train_dataset_sha256': hashlib.sha256(Path(args.train).read_bytes()).hexdigest(),
                             'validation_dataset_sha256': hashlib.sha256(Path(args.validation).read_bytes()).hexdigest(),
                             'train_samples': int(len(X)), 'validation_samples': int(len(Xv)),
                             'torch': torch.__version__, 'trained_at_unix': time.time()},
                'admission': {'passed': False, 'status': 'PENDING_INDEPENDENT_TEST', 'criteria': ADMISSION}}
    (directory/'manifest.json').write_text(json.dumps(manifest, indent=1), encoding='utf8')
    runtime = PathEntryRiskModel.load(directory)
    with torch.no_grad():reference = torch.sigmoid(torch.tensor(zv)*torch.tensor([[calibration[f'{h}s']['a'] for h in HORIZONS]])
                                                   +torch.tensor([[calibration[f'{h}s']['b'] for h in HORIZONS]])).numpy()
    numpy_probabilities = runtime.probabilities(validation['X'])
    parity = float(np.max(np.abs(np.maximum.accumulate(reference, axis=1)-numpy_probabilities)))
    if parity > 1e-4:raise RuntimeError(f'Numpy runtime differs from torch by {parity}')
    prevalence = [float(np.mean(train['y'][np.isin(train['y'][:, k], (0, 1)), k])) for k in range(len(HORIZONS))]
    thresholds = [metrics.best_f1_threshold(yv[:, k], numpy_probabilities[:, k]) for k in range(len(HORIZONS))]
    result = {'model': evaluate(numpy_probabilities, yv, validation_meta, thresholds)}
    for name in ('constant_prevalence', 'kinematic_constant_velocity', 'kinematic_constant_velocity_soft', 'existing_physical_alternatives'):
        scores = np.column_stack([baselines(validation, prevalence)[f'{h}s'][name] for h in HORIZONS])
        base_thresholds = [.5 if name != 'constant_prevalence' else prevalence[k] for k in range(len(HORIZONS))]
        result[name] = evaluate(scores, yv, validation_meta, base_thresholds)
    manifest.update(thresholds={f'{h}s': thresholds[k] for k, h in enumerate(HORIZONS)}, train_prevalence=prevalence,
                    numpy_torch_parity_max_abs=parity, validation=result)
    (directory/'manifest.json').write_text(json.dumps(manifest, indent=1, default=float), encoding='utf8')
    print(json.dumps({'artifact': str(directory), 'selected_epoch': best[2], 'parity': parity,
                      'validation': {f'{h}s': {k: result['model'][f'{h}s'][k] for k in ('auroc', 'auprc', 'brier', 'ece')} for h in HORIZONS}}, indent=1))
    return 0


if __name__ == '__main__':sys.exit(main())
