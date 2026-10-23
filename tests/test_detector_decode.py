import importlib.util
import unittest
import numpy as np
from backend.computer_vision.detector import ROAD_CLASSES, decode_output


def reference_decode(output, *, width, height, ratio, left, top):
    """The previous per-row decoder, kept verbatim as the equivalence oracle."""
    import cv2
    boxes, scores, labels = [], [], []
    for row in output:
        label = int(row[4:].argmax()); confidence = float(row[4+label])
        if label not in ROAD_CLASSES or confidence < (.65 if label in (9,11) else .25): continue
        x,y,w,h = row[:4]
        x1,y1 = max(0.,float((x-w/2-left)/ratio)),max(0.,float((y-h/2-top)/ratio))
        x2,y2 = min(width,float((x+w/2-left)/ratio)),min(height,float((y+h/2-top)/ratio))
        if x2 <= x1 or y2 <= y1: continue
        boxes.append([x1,y1,x2-x1,y2-y1]);scores.append(confidence);labels.append(label)
    results = []
    for label in ROAD_CLASSES:
        indices = [i for i,l in enumerate(labels) if l==label]
        chosen = cv2.dnn.NMSBoxes([boxes[i] for i in indices], [scores[i] for i in indices], .25,.45)
        for local in np.asarray(chosen).reshape(-1):
            i=indices[int(local)];x,y,w,h=boxes[i]
            results.append({'class':ROAD_CLASSES[label],'confidence':scores[i],'xyxy':[x,y,x+w,y+h],
                'classification_status':'SUPPORTED' if scores[i]>=.65 else 'UNCERTAIN'})
    return sorted(results,key=lambda d:d['confidence'],reverse=True)[:256]


@unittest.skipUnless(importlib.util.find_spec('cv2'), 'OpenCV is optional in the control environment')
class DetectorDecodeTest(unittest.TestCase):
    def outputs(self, seed):
        rng = np.random.default_rng(seed);rows = 8400
        output = np.zeros((84, rows), np.float32)
        output[0] = rng.uniform(-20, 660, rows);output[1] = rng.uniform(-20, 660, rows)
        output[2] = rng.uniform(0, 200, rows);output[3] = rng.uniform(0, 300, rows)
        output[4:] = rng.beta(.3, 4., (80, rows)).astype(np.float32)
        hot = rng.choice(rows, 300, replace=False)
        output[4+rng.choice(list(ROAD_CLASSES)+[4, 6, 10, 40], 300), hot] = rng.uniform(.1, 1., 300)
        # Exact thresholds in float32, ties, NaN scores and degenerate boxes.
        output[4+9, hot[:10]] = np.float32(.65);output[4+0, hot[10:20]] = np.float32(.25)
        output[4+11, hot[20:25]] = np.nan;output[4:, hot[25:30]] = np.float32(.5)
        output[2, hot[30:40]] = 0.;output[3, hot[40:45]] = -1.
        return output.T

    def test_matches_previous_per_row_decoder(self):
        for seed in range(12):
            output = self.outputs(seed)
            for geometry in ({'width': 800, 'height': 600, 'ratio': .8, 'left': 0, 'top': 80},
                             {'width': 150, 'height': 150, 'ratio': 640/150, 'left': 0, 'top': 0}):
                expected = reference_decode(output, **geometry);actual = decode_output(output, **geometry)
                self.assertEqual(actual, expected, (seed, geometry))
                self.assertTrue(expected, 'fixture must exercise accepted detections')


@unittest.skipUnless(importlib.util.find_spec('onnxruntime') and importlib.util.find_spec('cv2'), 'Detector runtime is optional')
class DetectorExecutionProviderTest(unittest.TestCase):
    def test_directml_request_falls_back_to_cpu_with_identical_detections(self):
        import onnxruntime as ort
        from backend.computer_vision.detector import RoadDetector, default_model_path
        if not default_model_path().is_file():self.skipTest('Detector model is not installed')
        cpu = RoadDetector(default_model_path())
        requested = RoadDetector(default_model_path(), execution_provider='DML')
        self.assertNotIn('execution_provider', cpu.profile)
        if 'DmlExecutionProvider' not in ort.get_available_providers():
            # Unavailable GPU runtime: explicit CPU fallback, unchanged profile.
            self.assertEqual(requested.profile, cpu.profile)
        else:
            self.assertEqual(requested.profile.get('execution_provider'), 'DmlExecutionProvider')
        image = np.random.default_rng(4).integers(0, 255, (450, 800, 3), dtype=np.uint8)
        a = cpu.predict(image, frame_id=1);b = requested.predict(image, frame_id=1)
        self.assertEqual([d['class'] for d in a], [d['class'] for d in b])
        for x, y in zip(a, b):
            self.assertAlmostEqual(x['confidence'], y['confidence'], places=4)
            np.testing.assert_allclose(x['xyxy'], y['xyxy'], atol=.01)


if __name__ == '__main__':
    unittest.main()
