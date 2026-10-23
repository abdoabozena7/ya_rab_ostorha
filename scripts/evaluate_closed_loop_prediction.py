"""Closed-loop prediction metrics for an admitted path-entry model (evaluator side).

Scores datasets built from closed-loop evaluation logs with the fixed artifact,
VALIDATION thresholds and calibration. It never changes the artifact manifest
or its one-time TEST admission record.
"""
import argparse
import json
from pathlib import Path
import sys
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.core.path_entry_risk import PathEntryRiskModel  # noqa: E402
from backend.learning import path_entry_metrics as metrics  # noqa: E402
from scripts.evaluate_path_entry_risk import HORIZONS, baseline_scores  # noqa: E402

BASELINES = ('constant_prevalence', 'kinematic_constant_velocity_soft', 'existing_physical_alternatives')


def evaluate(model, manifest, dataset):
    with np.load(dataset) as data:arrays = {k: data[k] for k in data.files}
    meta = [json.loads(line) for line in Path(dataset).with_suffix('.meta.jsonl').read_text(encoding='utf8').splitlines()]
    summary = json.loads(Path(dataset).with_suffix('.summary.json').read_text(encoding='utf8'))
    y = arrays['y'];result = {'samples': int(len(y)), 'prediction_coverage': summary.get('prediction_coverage'),
                              'label_counts': summary.get('label_counts'), 'model': {}, 'baselines': {n: {} for n in BASELINES}}
    if not len(y):return result
    probabilities = model.probabilities(arrays['X']);prevalence = manifest['train_prevalence']
    for k, h in enumerate(HORIZONS):
        key = f'{h}s';threshold = manifest['thresholds'][key]
        report = metrics.summary(y[:, k], probabilities[:, k], threshold=threshold)
        report.pop('reliability', None)
        result['model'][key] = {**report, 'events': metrics.event_metrics(meta, y[:, k], probabilities[:, k], threshold, h)}
        for name in BASELINES:
            scores = baseline_scores(arrays, prevalence, name, k, h)
            cut = prevalence[k] if name == 'constant_prevalence' else .5
            report = metrics.summary(y[:, k], scores, threshold=cut);report.pop('reliability', None)
            result['baselines'][name][key] = {**report, 'events': metrics.event_metrics(meta, y[:, k], scores, cut, h)}
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifact', required=True)
    parser.add_argument('--datasets', required=True, help='Comma-separated label=path.npz entries')
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    directory = Path(args.artifact);manifest = json.loads((directory/'manifest.json').read_text(encoding='utf8'))
    model = PathEntryRiskModel.load(directory)
    report = {'artifact': str(directory).replace('\\', '/'), 'admission': manifest['admission'].get('status'),
              'note': 'Closed-loop logs; the formal one-time TEST admission is recorded in the artifact manifest.', 'datasets': {}}
    for entry in args.datasets.split(','):
        label, path = entry.split('=', 1)
        report['datasets'][label] = evaluate(model, manifest, path)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, indent=1, default=float), encoding='utf8')
    print(json.dumps({label: {'samples': r['samples'], 'coverage': r['prediction_coverage'],
                              'model': {k: {n: v.get(n) for n in ('auroc', 'auprc', 'brier', 'ece')} for k, v in r['model'].items()}}
                      for label, r in report['datasets'].items()}, indent=1, default=float))
    return 0


if __name__ == '__main__':sys.exit(main())
