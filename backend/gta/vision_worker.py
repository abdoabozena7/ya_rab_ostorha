"""Actual local YOLO on current native GTA RGB only, no internal actor truth."""
import argparse
import json
from pathlib import Path
import sys
import time
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT/'integrations/gta'))
from backend.gta.provider import latest_json, TICK
import vision_probe
from backend.computer_vision.detector import RoadDetector


def run(output):
    lock, _ = vision_probe.validate()
    deadline = time.monotonic()+550
    while time.monotonic() < deadline and not (output/'stop-live-vision').exists():
        c = latest_json(output/'capture.jsonl')
        if c and c.get('rgb_ok'):
            break
        time.sleep(.05)
    else:
        return
    detector = RoadDetector(ROOT/lock['model_path'], execution_provider='DML')
    if detector.runtime['execution_provider'] != 'DmlExecutionProvider':
        raise ValueError('Actual DirectML required')
    serial = 0;count = 0
    try:
        with (output/'live-vision.jsonl').open('w', encoding='utf8') as stream:
            while time.monotonic() < deadline and not (output/'stop-live-vision').exists():
                c = latest_json(output/'capture.jsonl')
                if not c or c['serial'] <= serial or not c['rgb_ok']:
                    time.sleep(.01);continue
                serial = c['serial']
                rgb = np.fromfile(output/('capture-%06d.rgb' % serial), np.uint8).reshape(360, 640, 3)
                started = time.perf_counter();detections = detector.predict(rgb, frame_id=c['native_frame'])
                row = {'serial': serial, 'native_frame': c['native_frame'], 'game_ms': c['game_ms'],
                       'run_id': c['run_id'], 'pid': c['pid'], 'inference_ms': (time.perf_counter()-started)*1000,
                       'snapshot_age_ms': TICK()-c['native_host_ms'], 'execution_provider': detector.runtime['execution_provider'],
                       'detections': detections}
                stream.write(json.dumps(row, allow_nan=False)+'\n');stream.flush();count += 1
    finally:
        detector.close()
        (output/'live-vision-result.json').write_text(json.dumps({'processed_frames': count, 'runtime': detector.runtime}))


if __name__ == '__main__':
    parser = argparse.ArgumentParser();parser.add_argument('--output', type=Path, required=True)
    run(parser.parse_args().output)
