"""Measured forecast projection for derived videos; original images stay intact."""
import gzip
import hashlib
import json
import math
from pathlib import Path
import tempfile
import numpy as np
from PIL import Image, ImageDraw, ImageFont
from .camera_geometry import mount_rotation


def pose_rotation(pose):
    return mount_rotation({key:math.degrees(value) for key,value in pose.get('rotation_rad',{}).items()})


def project_prediction(point, reference, camera):
    world=pose_rotation(reference)@np.asarray(point)+np.asarray(reference['position_m'])
    local=pose_rotation(camera['world_transform']).T@(world-np.asarray(camera['world_transform']['position_m']))
    if local[0]<=.05:return None
    calibration=camera['calibration'];width,height=calibration['width'],calibration['height']
    focal=width/(2*math.tan(math.radians(calibration['fov_deg'])/2))
    pixel=((width-1)/2+focal*local[1]/local[0],(height-1)/2-focal*local[2]/local[0])
    return pixel if all(math.isfinite(value) for value in pixel) else None


def remaining_forecast(points, age):
    if not points or not math.isfinite(age) or age<0 or age>points[-1][0]:return []
    for index,row in enumerate(points):
        if row[0]<age:continue
        if index==0 or row[0]==age:return points[index:]
        previous=points[index-1];fraction=(age-previous[0])/(row[0]-previous[0])
        return [[age,previous[1]+fraction*(row[1]-previous[1]),previous[2]+fraction*(row[2]-previous[2])],*points[index:]]
    return []


def forecast_matches(prediction, camera, session):
    if not prediction or not session or prediction.get('session_id')!=session:return False
    age=camera['timestamp_s']-prediction.get('timestamp_s',-math.inf)
    return (0<=age<=.75 and prediction.get('coordinate_frame')=='EGO_AT_EVALUATION'
            and isinstance(prediction.get('evaluation_frame'),int)
            and prediction['evaluation_frame']<=camera.get('frame_id',-1)
            and bool(prediction.get('render_reference',{}).get('position_m'))
            and bool(camera.get('world_transform',{}).get('position_m'))
            and all(camera.get('calibration',{}).get(key) for key in ('width','height','fov_deg')))


def video_predictions(root):
    source=root/'telemetry/comparison-controls.jsonl'
    if not source.exists():return
    with source.open(encoding='utf8') as stream:
        previous=-math.inf
        for line in stream:
            row=json.loads(line)
            if row.get('kind')!='VIDEO_PREDICTION':continue
            prediction=row.get('prediction')
            if prediction is None and row.get('prediction_asset'):
                asset=row['prediction_asset'];path=(root/asset['path']).resolve()
                if root.resolve() not in path.parents:raise ValueError('Forecast asset escaped its recording')
                data=path.read_bytes()
                if hashlib.sha256(data).hexdigest()!=asset['sha256']:raise ValueError('Recorded forecast checksum mismatch')
                with gzip.open(path,'rb') as compressed:
                    decoded=compressed.read(32*1024*1024+1)
                if len(decoded)>32*1024*1024:raise ValueError('Recorded forecast exceeds its size bound')
                prediction=json.loads(decoded)
            if not prediction or prediction.get('session_id')!=row.get('session_id'):continue
            stamp=prediction['timestamp_s']
            if stamp<previous:raise ValueError('Recorded video forecasts must increase in time')
            previous=stamp
            yield prediction


def draw_forecast(image, prediction, camera, session, *, predictive):
    drawing=ImageDraw.Draw(image)
    count=0
    if predictive and forecast_matches(prediction,camera,session):
        if prediction.get('visual_version')==1:
            from .scene_overlays import draw_scene
            box_count,count=draw_scene(image,prediction,camera)
        else:
            box_count=0
        tracks={track['id']:track for track in prediction.get('tracks',[]) if track.get('confirmed')}
        modes=sorted(prediction.get('trajectories',[]),key=lambda mode:
            0 if tracks.get(mode['track_id'],{}).get('class')=='person' else 1)
        counts={}
        for mode in (() if prediction.get('visual_version')==1 else modes):
            identity=mode['track_id'];track=tracks.get(identity)
            if not track or counts.get(identity,0)>=1 or count>=1:continue
            counts[identity]=counts.get(identity,0)+1
            color='#FFB7B2' if track.get('class')=='person' and track.get('semantic_evidence') else '#83d9df'
            previous=None;segments=0
            for point in remaining_forecast(mode.get('points',[]),camera['timestamp_s']-prediction['timestamp_s']):
                projected=project_prediction((point[1],point[2],.3),prediction['render_reference'],camera)
                if previous is not None and projected is not None:
                    drawing.line([previous,projected],fill=color,width=max(2,image.width//400));segments+=1
                previous=projected
            if segments:count+=1
        path_age=camera['timestamp_s']-prediction.get('selected_path_timestamp_s',prediction['timestamp_s'])
        if prediction.get('selected_path') and prediction.get('selected_path_reference') and 0<=path_age<=.1+1e-6:
            previous=None;segments=0
            for point in remaining_forecast(prediction['selected_path'],path_age):
                projected=project_prediction((point[1],point[2],.15),prediction['selected_path_reference'],camera)
                if previous is not None and projected is not None:
                    drawing.line([previous,projected],fill='#00BA69',width=max(2,image.width//300));segments+=1
                previous=projected
            if segments:count+=1
    font=ImageFont.load_default(size=max(10,min(22,image.width//45)))
    title='Ya Rab Ostorha | predictive driving' if predictive else 'Normal | sensors + reactive braking'
    subtitle=('Measured 3D detections and corridor risk forecasts' if predictive and prediction and prediction.get('visual_version')==1 and forecast_matches(prediction,camera,session)
              else 'Selected risk forecast - may change' if count
              else 'No risk forecast selected' if predictive and forecast_matches(prediction,camera,session) and prediction.get('focused')
              else 'Forecast unavailable for this frame' if predictive else 'Project motion prediction: off')
    drawing.rectangle((0,0,image.width,max(38,image.height//9)),fill='#172932')
    drawing.text((8,4),title,font=font,fill='white')
    drawing.text((8,7+font.size),subtitle,font=font,fill='#c9e5df')
    return count


def export_annotated(root, frames, metadata, encode):
    profile=metadata['config']['driver_profile'];predictive=profile['motion_prediction_used']
    session=metadata['config'].get('session_id')
    predictions=iter(video_predictions(root));upcoming=next(predictions,None);current=None
    drawn_frames=0;total_paths=0;available_frames=0
    with tempfile.TemporaryDirectory(prefix='video-overlay-',dir=root) as temporary:
        derived=[]
        for index,camera in enumerate(frames):
            while upcoming is not None and upcoming['timestamp_s']<=camera['timestamp_s']:
                current=upcoming;upcoming=next(predictions,None)
            with Image.open(root/camera['asset']['path']) as original:
                image=original.convert('RGB')
            count=draw_forecast(image,current,camera,session,predictive=predictive)
            available_frames+=int(forecast_matches(current,camera,session))
            drawn_frames+=int(count>0);total_paths+=count
            target=Path(temporary)/f'{index:08d}.jpg';image.save(target,quality=95)
            derived.append({**camera,'asset':{'path':str(target.relative_to(root))}})
        encode(derived,'driving-annotated.mp4')
    output=root/'driving-annotated.mp4'
    return {'status':'READY','video':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),
            'source':'RECORDED_NATIVE_DRIVING_CAMERA_WITH_MEASURED_OVERLAY',
            'overlay':{'status':'READY','predictive':predictive,'forecast_frames':drawn_frames,
                       'rendered_paths':total_paths,'maximum_forecast_age_s':.75,
                       'available_forecast_frames':available_frames if predictive else 0,
                       'no_selected_risk_frames':available_frames-drawn_frames if predictive else 0,
                       'missing_forecast_frames':len(frames)-available_frames if predictive else 0}}
