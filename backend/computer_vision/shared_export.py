"""CPU-only exact-image detections for missing frames of the common prelude."""
import argparse
import hashlib
import json
from pathlib import Path
import numpy as np
from PIL import Image
from .detector import RoadDetector,default_model_path

ROOT=Path(__file__).resolve().parents[2]


def detect(root,job):
    from backend.core.recording_locations import recording_location
    root=recording_location(root,ROOT/'runs/normal_city')
    profile=job.get('detector_profile') or {}
    model_path=ROOT/'models/yolov8n-320.onnx' if profile.get('id')=='LEGACY_320' else default_model_path()
    model=RoadDetector(model_path,profile_id=profile.get('id'))
    if profile.get('model_sha256') and profile['model_sha256']!=model.profile['model_sha256']:
        raise ValueError('Recorded detector weights are unavailable for this export')
    model_sha=hashlib.sha256(model_path.read_bytes()).hexdigest();result=[]
    for sensor in job['frames']:
        path=(root/sensor['asset']['path']).resolve()
        if root not in path.parents:raise ValueError('Camera asset escaped its recording')
        digest=hashlib.sha256(path.read_bytes()).hexdigest()
        if digest!=sensor['asset']['sha256']:raise ValueError('Camera checksum mismatch')
        with Image.open(path) as image:
            image=image.convert('RGB');detections=model.predict(np.asarray(image),frame_id=sensor['frame_id']);width,height=image.size
        result.append({'frame_id':sensor['frame_id'],'timestamp_s':sensor['timestamp_s'],'session_id':job['session_id'],
            'source_image_sha256':digest,'width':width,'height':height,'detections':detections,
            'source':'POST_DRIVE_EXACT_FRAME_RGB_DETECTION','model_sha256':model_sha,'detector_profile':model.profile})
    target=root/'telemetry/shared-camera-detections.jsonl';temporary=target.with_suffix('.tmp')
    temporary.write_text(''.join(json.dumps(r)+'\n' for r in result),encoding='utf8');temporary.replace(target)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('root');args=parser.parse_args()
    root=Path(args.root);job=json.loads((root/'shared-detection-job.json').read_text(encoding='utf8'));detect(root,job)
