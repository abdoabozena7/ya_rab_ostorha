"""CPU vs DirectML GPU detection on identical recorded frames (investigation; CPU stays the default).

Runs in an environment with onnxruntime-directml. Both sessions use the
production RoadDetector preprocessing, three-view layout and decoding; only
the ONNX execution provider differs. DirectML runs the views sequentially.
Detections are matched per class by IoU; timings alternate order per frame.
"""
import argparse
import json
from pathlib import Path
import statistics
import sys
import threading
import time
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.computer_vision.detector import RoadDetector, default_model_path  # noqa: E402


def iou(a, b):
    x1, y1 = max(a[0], b[0]), max(a[1], b[1]);x2, y2 = min(a[2], b[2]), min(a[3], b[3])
    inter = max(0., x2-x1)*max(0., y2-y1)
    union = (a[2]-a[0])*(a[3]-a[1])+(b[2]-b[0])*(b[3]-b[1])-inter
    return inter/union if union > 0 else 0.


def compare(cpu, gpu, *, threshold=.9):
    matched = 0;confidence = [];box = [];unmatched_cpu = 0;used = set()
    for d in cpu:
        best = max(((iou(d['xyxy'], g['xyxy']), i) for i, g in enumerate(gpu) if g['class'] == d['class'] and i not in used), default=(0., None))
        if best[0] >= threshold:
            g = gpu[best[1]];used.add(best[1]);matched += 1
            confidence.append(abs(d['confidence']-g['confidence']));box.append(max(abs(p-q) for p, q in zip(d['xyxy'], g['xyxy'])))
        else:unmatched_cpu += 1
    return {'cpu': len(cpu), 'gpu': len(gpu), 'matched': matched, 'unmatched_cpu': unmatched_cpu, 'unmatched_gpu': len(gpu)-len(used),
            'max_confidence_delta': max(confidence, default=0.), 'max_box_delta_px': max(box, default=0.)}


def stats(values):
    values = sorted(values)
    return {'n': len(values), 'median_ms': statistics.median(values), 'p95_ms': values[int(round(.95*(len(values)-1)))]}


def main():
    import onnxruntime as ort
    from PIL import Image
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', default=str(ROOT/'runs/normal_city/run_55f3028020ae4f449f4dceaaf9b7efc3'))
    parser.add_argument('--frames', type=int, default=40);parser.add_argument('--out', required=True)
    parser.add_argument('--label', default='')
    args = parser.parse_args()
    images = sorted(Path(args.run, 'rgb').glob('frontCamera-*.jpg'))[:args.frames]
    if not images:raise FileNotFoundError('No recorded frontCamera frames')
    cpu = RoadDetector(default_model_path())
    gpu = RoadDetector(default_model_path())
    options = ort.SessionOptions();options.enable_mem_pattern = False
    options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
    gpu.model = ort.InferenceSession(str(default_model_path()), sess_options=options, providers=['DmlExecutionProvider', 'CPUExecutionProvider'])
    providers = gpu.model.get_providers()
    lock = threading.Lock();run = gpu.model.run
    gpu.model.run = lambda names, feeds: (lock.acquire(), run(names, feeds), lock.release())[1]
    rgb0 = np.asarray(Image.open(images[0]).convert('RGB'))
    for _ in range(3):gpu.predict(rgb0, frame_id=0);cpu.predict(rgb0, frame_id=0)
    times = {'cpu': [], 'gpu': []};comparisons = []
    for index, path in enumerate(images):
        rgb = np.asarray(Image.open(path).convert('RGB'));frame_id = int(path.stem.rsplit('-', 1)[1])
        results = {}
        for name in (('cpu', 'gpu') if index % 2 == 0 else ('gpu', 'cpu')):
            detector = cpu if name == 'cpu' else gpu
            started = time.perf_counter();results[name] = detector.predict(rgb, frame_id=frame_id)
            times[name].append((time.perf_counter()-started)*1000)
        comparisons.append(compare(results['cpu'], results['gpu']))
    cpu.close();gpu.close()
    report = {'label': args.label, 'frames': len(images), 'gpu_providers': providers, 'onnxruntime': ort.__version__,
              'detector_profile': cpu.profile['id'], 'predict_three_views': {k: stats(v) for k, v in times.items()},
              'equivalence': {'frames_identical_sets': sum(c['unmatched_cpu'] == 0 and c['unmatched_gpu'] == 0 for c in comparisons),
                              'cpu_detections': sum(c['cpu'] for c in comparisons), 'gpu_detections': sum(c['gpu'] for c in comparisons),
                              'unmatched_cpu': sum(c['unmatched_cpu'] for c in comparisons), 'unmatched_gpu': sum(c['unmatched_gpu'] for c in comparisons),
                              'max_confidence_delta': max(c['max_confidence_delta'] for c in comparisons),
                              'max_box_delta_px': max(c['max_box_delta_px'] for c in comparisons)}}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, indent=1), encoding='utf8')
    print(json.dumps(report, indent=1))
    return 0


if __name__ == '__main__':sys.exit(main())
