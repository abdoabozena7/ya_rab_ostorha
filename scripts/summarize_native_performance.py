"""Per-component wall-clock latency from native harness logs (evaluator side).

Pipeline: sensors -> detection -> tracking -> prediction -> safety -> applied
control. Every value comes from the per-frame timings recorded by the live
stack; nothing here is simulated.
"""
import argparse
import gzip
import json
from pathlib import Path
import numpy as np

STALE_STATUSES = ('SENSOR_DELAY_HOLD', 'SENSOR_FAULT_STOP')


def distribution(values):
    values = np.asarray([v for v in values if isinstance(v, (int, float)) and np.isfinite(v)], float)
    if not len(values):return None
    return {'n': int(len(values)), 'median': round(float(np.median(values)), 2), 'mean': round(float(np.mean(values)), 2),
            'p95': round(float(np.percentile(values, 95)), 2), 'p99': round(float(np.percentile(values, 99)), 2),
            'max': round(float(np.max(values)), 2)}


def episode_rows(directory):
    with gzip.open(Path(directory)/'episode.jsonl.gz', 'rt', encoding='utf8') as handle:
        return [json.loads(line) for line in handle]


def summarize(directories):
    series = {};counts = {'frames': 0, 'scene_unusable': 0, 'processing_deadline_holds': 0, 'stale_or_fault_frames': 0,
                          'risk_frames': 0, 'risk_ready': 0, 'frame_gaps': 0}
    real_time = [];detector_seen = set()

    def add(key, value):
        series.setdefault(key, []).append(value)
    for directory in directories:
        rows = episode_rows(directory)
        if not rows:continue
        wall = sum(r.get('step_ms') or 0. for r in rows)/1000.;simulated = rows[-1]['elapsed_s']-rows[0]['elapsed_s']
        if wall > 0:real_time.append(simulated/wall)
        previous = None
        for row in rows:
            counts['frames'] += 1
            if previous is not None and row['frame']-previous > 1:counts['frame_gaps'] += 1
            previous = row['frame']
            for field in ('step_ms', 'backend_step_ms', 'provider_step_ms'):
                value = row.get(field)
                for name, item in (value.items() if isinstance(value, dict) else (('total', value),)):
                    add(f'{field[:-3]}.{name}_ms', item)
            for name, sensor in (row.get('sensors') or {}).items():
                add(f'sensor_publication_after_first_ms.{name}', sensor.get('after_first_ms'))
                add(f'sensor_decode_ms.{name}', sensor.get('decode_ms'))
            scene = row.get('scene') or {}
            for name, value in (scene.get('timings_ms') or {}).items():add(f'scene.{name}', value)
            add('scene.build_ms', scene.get('build_ms'))
            if scene:counts['scene_unusable'] += not scene.get('usable')
            timing = row.get('control_timing_ms') or {}
            for name in ('sensor_to_scene', 'scene_to_control', 'navigation', 'safety', 'actuator_submit', 'sensor_age_before_safety_ms'):
                add(f'control.{name}', timing.get(name))
            if timing.get('sensor_age_before_safety_ms') is not None and timing.get('safety') is not None:
                add('observation_to_control_ms', timing['sensor_age_before_safety_ms']+timing['safety']+(timing.get('actuator_submit') or 0.))
            perception = row.get('perception') or {}
            if perception.get('frame_id') is not None:
                key = (str(directory), perception['frame_id'])
                if key not in detector_seen:
                    detector_seen.add(key);add('yolo_detector_ms', perception.get('detector_ms'))
                add('detection_age_frames', row['frame']-perception['frame_id'])
                add('detection_age_s', row['timestamp_s']-perception['timestamp_s'])
            safety = row.get('safety') or {}
            if safety.get('status') == 'HOLD' and 'PROCESSING_DEADLINE' in str(safety.get('reason')):counts['processing_deadline_holds'] += 1
            if safety.get('status') in STALE_STATUSES:counts['stale_or_fault_frames'] += 1
            risk = (safety.get('evidence_decision') or {}).get('risk_status') or {}
            if risk:
                counts['risk_frames'] += 1
                if risk.get('status') == 'READY':counts['risk_ready'] += 1;add('learned_risk_ms', risk.get('latency_ms'))
    result = {'episodes': len(directories), **counts,
              'scene_usable_fraction': 1.-counts['scene_unusable']/counts['frames'] if counts['frames'] else None,
              'processing_deadline_hold_fraction': counts['processing_deadline_holds']/counts['frames'] if counts['frames'] else None,
              'real_time_factor': distribution(real_time),
              'components_ms': {key: distribution(values) for key, values in sorted(series.items())}}
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--roots', required=True);parser.add_argument('--split', default='');parser.add_argument('--out', required=True)
    args = parser.parse_args()
    grouped = {}
    for root in args.roots.split(','):
        for outcome in Path(root).rglob('outcome.json'):
            data = json.loads(outcome.read_text(encoding='utf8'))
            if args.split and data.get('split') != args.split:continue
            if not (outcome.parent/'episode.jsonl.gz').exists():continue
            grouped.setdefault(data.get('configuration') or 'UNKNOWN', []).append(outcome.parent)
    report = {'source': 'LIVE_NATIVE_CARLA_HARNESS_LOGS', 'roots': args.roots, 'split': args.split or None,
              'by_configuration': {name: summarize(sorted(items)) for name, items in sorted(grouped.items())}}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, indent=1), encoding='utf8')
    for name, item in report['by_configuration'].items():
        components = item['components_ms']
        print(name, {'episodes': item['episodes'], 'frames': item['frames'], 'rtf': item['real_time_factor'],
                     'step': components.get('step.total_ms'), 'obs_to_control': components.get('observation_to_control_ms'),
                     'yolo': components.get('yolo_detector_ms'), 'risk': components.get('learned_risk_ms'),
                     'deadline_holds': item['processing_deadline_holds'], 'stale': item['stale_or_fault_frames']})
    return 0


if __name__ == '__main__':raise SystemExit(main())
