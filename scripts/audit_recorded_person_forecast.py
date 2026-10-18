"""Reprocess recorded RGB/depth; never connect to CARLA or apply a command.

Run in .venv-perception. Recorded actor truth is used only after prediction, to
compare its timing with physical crossing/contact. It is never passed to control.
"""
import argparse
import hashlib
import io
import json
from pathlib import Path
import time
import numpy as np
from PIL import Image
from backend.computer_vision.detector import RoadDetector
from backend.computer_vision.depth_evidence import attach_depth
from backend.core.contracts import ControlCommand,CommandSource,to_dict
from backend.core.control_scene import ControlSceneBuilder
from backend.core.motion_geometry import VehicleGeometry
from backend.core.pedestrian_anticipation import crossing_forecast
from backend.core.replay import ReplayReader
from backend.core.safety_policy import sensor_observation


def audit(report_path,*,stride=5,delay_frames=3):
    path=Path(report_path);report=json.loads(path.read_text())
    root=Path(report['recording']['runs']['ROBOSPHERE']['recording']);reader=ReplayReader(root)
    detector=RoadDetector('models/yolov8n-320.onnx');session='recorded-person-audit'
    builder=ControlSceneBuilder(session,VehicleGeometry(**report['fixture']['ego_geometry']))
    reference={s['frame_id']:s for s in report['samples']};pending=[];latest=None;forecasts=[];classified=0
    zero=report['samples'][0]['timestamp_s'];source_images=[]
    for index,frame in enumerate(reader.frames()):
        observation=sensor_observation(frame)
        if index%stride==0:
            rgb=next(c for c in observation.channels if c.sensor_id=='frontCamera')
            depth=next(c for c in observation.channels if c.sensor_id=='depth')
            source=(root/rgb.asset.path).read_bytes();source_images.append(hashlib.sha256(source).hexdigest())
            image=np.asarray(Image.open(io.BytesIO(source)).convert('RGB'))
            detections=detector.predict(image);values=np.load(root/depth.asset.path,allow_pickle=False)
            attach_depth(detections,values,frame.frame_id,frame.timestamp_s)
            pending.append({'status':'RUNNING','session_id':session,'frame_id':frame.frame_id,
                'timestamp_s':frame.timestamp_s,'detections':detections})
        while pending and pending[0]['frame_id']<=frame.frame_id-delay_frames:latest=pending.pop(0)
        scene=builder.build(observation,lambda a:(root/a.path).read_bytes(),
            received_wall_s=time.monotonic(),semantic_result=latest)
        people=[t for t in scene.prediction['tracks'] if t.get('class')=='person' and t.get('confirmed')]
        classified+=bool(people)
        sample=reference.get(frame.frame_id,{});v=frame.vehicle
        base=sample.get('stop',{}).get('base_command') or {}
        command=ControlCommand(frame.frame_id,frame.timestamp_s,base.get('throttle',v.throttle),
            base.get('brake',0.),base.get('steering',v.steering),False,False,CommandSource.SYSTEM,v.gear)
        conflict=crossing_forecast(scene.prediction,observation,command,scene.geometry)
        if conflict:
            person=next(t for t in people if t['id']==conflict['track_id'])
            forecasts.append({'frame':frame.frame_id,'elapsed_s':frame.timestamp_s-zero,
                'speed_kmh':v.speed_mps*3.6,'source':conflict['source'],'time_to_overlap_s':conflict['time_s'],
                'position_m':to_dict(person['position_m']),'velocity_mps':to_dict(person['velocity_mps']),
                'measurement_evidence':to_dict(person['measurement_evidence']),
                'semantic_evidence':to_dict(person['semantic_evidence'])})
    # Evaluation only, after the sensor-only pipeline has finished.
    physical=[s for s in report['samples'] if any(a['category']=='WALKER' and
        np.linalg.norm(a['velocity_mps'])>.2 for a in s['independent_reference']['actors'])]
    contact=report['contacts'][0]['timestamp_s']-zero if report['contacts'] else None
    return {'scope':'OFFLINE_RECORDED_NATIVE_SENSORS; no counterfactual braking is applied or guaranteed',
        'source_report':str(path),'source_report_sha256':hashlib.sha256(path.read_bytes()).hexdigest(),
        'model_sha256':hashlib.sha256(Path('models/yolov8n-320.onnx').read_bytes()).hexdigest(),
        'source_image_hashes_sha256':hashlib.sha256(''.join(source_images).encode()).hexdigest(),
        'detector_stride_frames':stride,'semantic_delay_frames':delay_frames,'classified_frames':classified,
        'recorded_contact_elapsed_s':contact,'first_physical_crossing_elapsed_s':physical[0]['timestamp_s']-zero if physical else None,
        'forecast_samples':len(forecasts),'first_forecast':forecasts[0] if forecasts else None,
        'last_forecast':forecasts[-1] if forecasts else None,
        'limitation':'This holds the recorded ego trajectory fixed. A fresh native drive must verify the effect of braking.'}


def main():
    parser=argparse.ArgumentParser();parser.add_argument('report');parser.add_argument('--out',required=True)
    args=parser.parse_args();result=audit(args.report)
    Path(args.out).write_text(json.dumps(result,indent=2)+'\n',encoding='utf8');print(json.dumps(result,indent=2))


if __name__=='__main__':main()
