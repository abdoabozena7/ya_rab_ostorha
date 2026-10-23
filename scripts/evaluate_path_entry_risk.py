"""Final, one-time TEST evaluation and admission of a trained path-entry model.

Runs in .venv-carla with the numpy runtime. Thresholds and calibration come
from VALIDATION (stored in the manifest). Results are written beside the
artifact; a failed gate keeps ``admission.passed`` false and production off.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import time
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.core.path_entry_risk import PathEntryRiskModel  # noqa: E402
from backend.learning import path_entry_metrics as metrics  # noqa: E402

HORIZONS = (1, 2, 3)
BASELINES = ('constant_prevalence', 'kinematic_constant_velocity', 'kinematic_constant_velocity_soft', 'existing_physical_alternatives')


def baseline_scores(arrays, prevalence, name, k, h):
    cv = arrays['cv_entry_s']
    if name == 'constant_prevalence':return np.full(len(cv), prevalence[k])
    if name == 'kinematic_constant_velocity':return (cv <= h).astype(float)
    if name == 'kinematic_constant_velocity_soft':return 1./(1.+np.exp(np.clip((np.minimum(cv, 99.)-h)/.5, -40, 40)))
    return arrays['physical_any_entry'][:, k].astype(float)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--artifact', required=True);parser.add_argument('--test', required=True)
    args = parser.parse_args()
    directory = Path(args.artifact);manifest_path = directory/'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf8'))
    if manifest.get('test_evaluation'):raise RuntimeError('TEST was already evaluated for this artifact; no re-selection on TEST')
    model = PathEntryRiskModel.load(directory)
    with np.load(args.test) as data:arrays = {k: data[k] for k in data.files}
    meta = [json.loads(line) for line in Path(args.test).with_suffix('.meta.jsonl').read_text(encoding='utf8').splitlines()]
    if any(m['split'] != 'TEST' for m in meta):raise ValueError('Final evaluation requires TEST samples only')
    summary = json.loads(Path(args.test).with_suffix('.summary.json').read_text(encoding='utf8'))
    probabilities = model.probabilities(arrays['X']);y = arrays['y']
    thresholds = [manifest['thresholds'][f'{h}s'] for h in HORIZONS];prevalence = manifest['train_prevalence']
    result = {'model': {}, 'baselines': {name: {} for name in BASELINES}}
    for k, h in enumerate(HORIZONS):
        key = f'{h}s'
        result['model'][key] = {**metrics.summary(y[:, k], probabilities[:, k], threshold=thresholds[k]),
                                'events': metrics.event_metrics(meta, y[:, k], probabilities[:, k], thresholds[k], h)}
        for name in BASELINES:
            scores = baseline_scores(arrays, prevalence, name, k, h)
            threshold = prevalence[k] if name == 'constant_prevalence' else .5
            result['baselines'][name][key] = {**metrics.summary(y[:, k], scores, threshold=threshold),
                                              'events': metrics.event_metrics(meta, y[:, k], scores, threshold, h)}
    criteria = manifest['admission']['criteria'];gates = {}
    for k, h in enumerate(HORIZONS):
        key = f'{h}s';m = result['model'][key]
        best_baseline = max((result['baselines'][n][key]['auprc'] or 0.) for n in BASELINES if n != 'constant_prevalence')
        constant_brier = result['baselines']['constant_prevalence'][key]['brier']
        missed = m['events']['missed_entry_rate']
        gates[key] = {'auroc': (m['auroc'] or 0.) >= criteria['auroc_min'], 'ece': (m['ece'] if m['ece'] is not None else 1.) <= criteria['ece_max'],
                      'auprc_over_baselines': (m['auprc'] or 0.) >= best_baseline+criteria['auprc_margin_over_best_baseline'],
                      'brier_vs_constant': m['brier'] is not None and constant_brier and m['brier'] <= criteria['brier_ratio_to_constant_max']*constant_brier,
                      'missed_entries': missed is not None and missed <= criteria['missed_entry_rate_max'],
                      'positives_present': m['positives'] >= 20}
    passed = all(all(v for v in g.values()) for g in gates.values())
    manifest['test_evaluation'] = {'evaluated_at_unix': time.time(), 'test_dataset_sha256': hashlib.sha256(Path(args.test).read_bytes()).hexdigest(),
        'samples': int(len(y)), 'prediction_coverage': summary.get('prediction_coverage'), 'coverage': summary.get('coverage'),
        'label_counts': summary.get('label_counts'), 'result': result, 'gates': gates}
    manifest['admission'] = {**manifest['admission'], 'passed': passed, 'status': 'ADMITTED' if passed else 'REJECTED_ON_TEST'}
    manifest_path.write_text(json.dumps(manifest, indent=1, default=float), encoding='utf8')
    print(json.dumps({'artifact': str(directory), 'admission': manifest['admission']['status'], 'gates': gates,
                      'model': {key: {n: result['model'][key][n] for n in ('auroc', 'auprc', 'brier', 'ece')} for key in result['model']},
                      'coverage': summary.get('prediction_coverage')}, indent=1, default=float))
    return 0 if passed else 1


if __name__ == '__main__':sys.exit(main())
