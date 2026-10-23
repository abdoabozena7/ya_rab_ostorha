"""Before/after benchmark of YOLO output decoding on recorded native frames.

Runs in .venv-perception (OpenCV + onnxruntime). The previous per-row decoder
is the oracle from tests/test_detector_decode.py; both decoders receive the
same model outputs, and full predict() timings alternate between them.
"""
import argparse
import json
from pathlib import Path
import statistics
import sys
import time
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from backend.computer_vision import detector as detector_module  # noqa: E402
from tests.test_detector_decode import reference_decode  # noqa: E402


def stats(values):
    values = sorted(values)
    return {'n': len(values), 'median_ms': statistics.median(values), 'mean_ms': statistics.fmean(values),
            'p95_ms': values[min(len(values)-1, int(round(.95*(len(values)-1))))]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--run', default=str(ROOT/'runs/normal_city/run_57c0aceb80604461a9608725b47c5683'))
    parser.add_argument('--frames', type=int, default=40);parser.add_argument('--out', required=True)
    args = parser.parse_args()
    from PIL import Image
    images = sorted(Path(args.run, 'rgb').glob('frontCamera-*.jpg'))[:args.frames]
    if not images:raise FileNotFoundError('No recorded frontCamera frames')
    model = detector_module.RoadDetector(detector_module.default_model_path())
    captured = [];original_run = model.model.run

    def capture(names, feeds):
        output = original_run(names, feeds);captured.append(output[0][0].T.copy());return output
    decode = {'before': [], 'after': []};predict = {'before': [], 'after': []};identical = True
    try:
        for index, path in enumerate(images):
            rgb = np.asarray(Image.open(path).convert('RGB'));frame_id = int(path.stem.rsplit('-', 1)[1])
            order = ('before', 'after') if index % 2 == 0 else ('after', 'before')
            results = {}
            for label in order:
                detector_module.decode_output = reference_decode if label == 'before' else ORIGINAL_DECODE
                started = time.perf_counter();results[label] = model.predict(rgb, frame_id=frame_id)
                predict[label].append((time.perf_counter()-started)*1000)
            identical &= results['before'] == results['after']
            detector_module.decode_output = ORIGINAL_DECODE
            # Decode-only timing on this frame's real model outputs (full view geometry).
            model.model.run = capture;captured.clear();model._view(rgb);model.model.run = original_run
            height, width = rgb.shape[:2];ratio = min(model.size/width, model.size/height)
            geometry = {'width': width, 'height': height, 'ratio': ratio, 'left': (model.size-round(width*ratio))//2,
                        'top': (model.size-round(height*ratio))//2}
            for label, function in (('before', reference_decode), ('after', ORIGINAL_DECODE)):
                started = time.perf_counter();decoded = function(captured[0], **geometry)
                decode[label].append((time.perf_counter()-started)*1000)
            identical &= reference_decode(captured[0], **geometry) == ORIGINAL_DECODE(captured[0], **geometry)
    finally:
        detector_module.decode_output = ORIGINAL_DECODE;model.close()
    report = {'frames': len(images), 'source_run': str(Path(args.run).relative_to(ROOT)).replace('\\', '/'),
              'detector_profile': model.profile['id'], 'outputs_identical': bool(identical),
              'decode_one_view': {k: stats(v) for k, v in decode.items()},
              'predict_three_views': {k: stats(v) for k, v in predict.items()}}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, indent=1), encoding='utf8')
    print(json.dumps(report, indent=1))
    return 0 if identical else 1


ORIGINAL_DECODE = detector_module.decode_output

if __name__ == '__main__':sys.exit(main())
