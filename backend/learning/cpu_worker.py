"""Line-delimited worker protocol; standalone process with bounded threads."""
import argparse
import base64
import io
import json
import sys
import time


def main():
    p=argparse.ArgumentParser(); p.add_argument('--kind',choices=['trajectron','classification'],required=True); args=p.parse_args()
    if args.kind=='trajectron':
        from .trajectron_adapter import TrajectronAdapter
        predictor=TrajectronAdapter()
    else:
        from ..computer_vision.detector import RoadDetector
        from pathlib import Path
        predictor=RoadDetector(Path(__file__).resolve().parents[2]/'models/yolov8n-320.onnx')
    for line in sys.stdin:
        try:
            request=json.loads(line); began=time.perf_counter()
            if args.kind=='trajectron': result=predictor.predict(request)
            else:
                import numpy as np
                from PIL import Image
                rgb=np.asarray(Image.open(io.BytesIO(base64.b64decode(request['image']))).convert('RGB'))
                result={'detections':predictor.predict(rgb),'width':rgb.shape[1],'height':rgb.shape[0]}
            result.update(session_id=request['session_id'],frame_id=request['frame_id'],timestamp_s=request['timestamp_s'],
                request_wall_s=request['request_wall_s'],worker_ms=(time.perf_counter()-began)*1000)
        except Exception as error: result={'error':str(error)}
        print(json.dumps(result,allow_nan=False),flush=True)

if __name__=='__main__': main()
