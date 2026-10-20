"""Latest native RGB only; CPU inference never participates in arbitration."""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import time
import urllib.request
import urllib.error
ROOT=Path(__file__).resolve().parents[2]
OUTPUT=ROOT/'output/perception'

def ocr_requested(parent):
    try:
        value=json.loads((OUTPUT/'ocr-request.json').read_text(encoding='utf8'))
        return value.get('parent')==parent and 0<=time.time()-value['requested_at']<3.
    except (OSError,ValueError,KeyError,TypeError):return False
def publish(value, name='latest.json'):
    value['published_at'] = time.time()
    destination=OUTPUT/name
    temporary = destination.with_suffix('.tmp')
    temporary.write_text(json.dumps(value,ensure_ascii=False),encoding='utf8')
    # Windows readers may briefly hold the destination without delete sharing.
    # Retain the last complete result rather than expose partial JSON or crash.
    for attempt in range(12):
        try:
            os.replace(temporary, destination)
            return True
        except PermissionError:
            time.sleep(.01 * (attempt + 1))
    return False


def parent_alive(pid):
    if os.name == 'nt':
        import ctypes
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.OpenProcess.restype=ctypes.c_void_p
        kernel.OpenProcess.argtypes=[ctypes.c_uint32,ctypes.c_int,ctypes.c_uint32]
        kernel.WaitForSingleObject.argtypes=[ctypes.c_void_p,ctypes.c_uint32]
        kernel.CloseHandle.argtypes=[ctypes.c_void_p]
        handle=kernel.OpenProcess(0x100000,False,pid)
        if not handle: return False
        active=kernel.WaitForSingleObject(handle,0)==258
        kernel.CloseHandle(handle)
        return active
    try: os.kill(pid,0); return True
    except OSError: return False


def main():
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8000)
    parser.add_argument('--parent',type=int,required=True);args=parser.parse_args()
    OUTPUT.mkdir(parents=True,exist_ok=True)
    # The previous owned worker has exited before this lifecycle starts.
    # Expired annotated images from earlier sessions must not accumulate.
    for expired in OUTPUT.glob('frame_*.jpg'):
        expired.unlink(missing_ok=True)
    publish({'status':'LOADING'})
    import cv2
    import numpy as np
    from PIL import Image,ImageDraw
    from .detector import RoadDetector,default_model_path
    from .ocr import EnglishRecognizer,text_regions
    from ..nlp.processor import interpret
    cv2.setNumThreads(1)
    detector=RoadDetector(default_model_path())
    recognizer=None;previous=None;history=[];last_ocr=-float('inf');nlp=None;aligned_session=None
    url=f'http://127.0.0.1:{args.port}/api/simulation/'
    while parent_alive(args.parent):
        began=time.monotonic();cpu_began=time.process_time();period=1.
        try:
            with urllib.request.urlopen(url+'status',timeout=3) as response:state=json.load(response)
            if not state.get('connected') or state.get('mode')=='REPLAY':
                publish({'status':'DISCONNECTED'});time.sleep(1);continue
            driving=state.get('mode')=='AUTOMATIC';warming=state.get('vision_warmup',False);period=.2 if driving or warming else 1.
            fid=state['vehicle']['frame'];stamp=state['vehicle']['timestamp'];session=state['sessionId']
            if (session,fid)==previous:time.sleep(.1);continue
            if previous and previous[0]!=session:nlp=None
            with urllib.request.urlopen(url+'camera.jpg?frame_id='+str(fid),timeout=3) as response:
                if int(response.headers['X-Sensor-Frame'])!=fid or abs(float(response.headers['X-Sensor-Time'])-stamp)>1e-6:
                    raise ValueError('Native camera/telemetry identity mismatch')
                source=response.read()
            image=Image.open(io.BytesIO(source)).convert('RGB');rgb=np.asarray(image)
            started=time.monotonic();detections=detector.predict(rgb,frame_id=fid);detection_ms=(time.monotonic()-started)*1000
            # A 2D box can also cover a distant wall. Associate labels only to
            # matching measured range, using synchronized existing depth.
            try:
                if aligned_session!=session:
                    metadata=[]
                    for name in ('frontCamera','depth'):
                        with urllib.request.urlopen(url+'sensor?name='+name,timeout=2) as response:
                            metadata.append(json.load(response)['metadata'])
                    keys=('fov_deg','mount_transform')
                    if any(metadata[0].get(k)!=metadata[1].get(k) for k in keys):raise ValueError('RGB/depth calibration differs')
                    if abs(metadata[0]['width']/metadata[0]['height']-metadata[1]['width']/metadata[1]['height'])>1e-6:raise ValueError('RGB/depth aspect differs')
                    aligned_session=session
                with urllib.request.urlopen(url+'sensor.bin?name=depth&frame_id='+str(fid),timeout=2) as response:
                    if int(response.headers['X-Sensor-Frame'])!=fid or abs(float(response.headers['X-Sensor-Time'])-stamp)>1e-6:
                        raise ValueError('RGB/depth identity differs')
                    depth=np.load(io.BytesIO(response.read()),allow_pickle=False)
                from .depth_evidence import attach_depth
                attach_depth(detections,depth,fid,stamp,rgb_size=(image.width,image.height))
            except (OSError,ValueError,KeyError):pass
            # Dedicated control semantics are published before OCR/annotation.
            # Geometry control never waits for either this worker or this file.
            detection_result={'status':'RUNNING','session_id':session,'frame_id':fid,'timestamp_s':stamp,
                'detector_profile':detector.profile,'width':image.width,'height':image.height,
                'detections':detections,'detector_ms':detection_ms,'published_at':time.time(),
                'source_sensor':'frontCamera','semantic_coverage':'FRONT_CAMERA_ONLY'}
            detection_result['source_image_sha256']=hashlib.sha256(source).hexdigest()
            detection_published=publish(detection_result,'latest-detections.json')
            texts=[];ocr_ms=0.;regions=[]
            if not driving and not warming and ocr_requested(args.parent) and time.monotonic()-last_ocr>=3:
                regions=text_regions(rgb,detections)
                if regions:
                    started=time.monotonic()
                    if recognizer is None:recognizer=EnglishRecognizer(ROOT/'models/ocr')
                    texts=recognizer.read(rgb,regions);ocr_ms=(time.monotonic()-started)*1000
                    nlp={'session_id':session,'frame_id':fid,'timestamp_s':stamp,
                        'items':[interpret(t['text'],t['confidence']) for t in texts]}
                    last_ocr=time.monotonic()
            draw=ImageDraw.Draw(image)
            for d in detections:
                draw.rectangle(d['xyxy'],outline='#2764c5',width=2)
                label=('Possible ' if d.get('classification_status')=='UNCERTAIN' else '')+d['class']+' '+str(round(d['confidence']*100))+'%'
                draw.text((d['xyxy'][0],max(0,d['xyxy'][1]-13)),label,fill='white',stroke_width=1,stroke_fill='black')
            for t in texts:draw.line([tuple(p) for p in t['polygon']]+[tuple(t['polygon'][0])],fill='#e7a12c',width=2)
            token=f'frame_{session}_{fid}.jpg';image.save(OUTPUT/token,format='JPEG',quality=85)
            history.append(token)
            while len(history)>4:(OUTPUT/history.pop(0)).unlink(missing_ok=True)
            publish({'status':'RUNNING','source':'REAL_CARLA_RGB_MODEL_INFERENCE','device':'CPU',
                'session_id':session,'frame_id':fid,'timestamp_s':stamp,'width':image.width,'height':image.height,
                'image_token':token,'source_image_sha256':hashlib.sha256(source).hexdigest(),
                'model':'YOLOv8s ONNX 640 + central and roadside focus','detector_profile':detector.profile,'ocr':'English g2 crop-only (on request)','detections':detections,'texts':texts,
                'nlp':nlp,'inference_ms':(time.monotonic()-began)*1000,'detector_ms':detection_ms,'ocr_ms':ocr_ms,
                'cpu_ms':(time.process_time()-cpu_began)*1000,'threads':1,'maximum_rate_hz':1/period,'ocr_regions':len(regions),
                'semantic_publication': 'PUBLISHED' if detection_published else 'READER_LOCK_RETAINED_PREVIOUS'})
            previous=(session,fid)
        except urllib.error.HTTPError as error:
            publish({'status':'WAITING' if error.code in (404,409,503) else 'ERROR','error':str(error)})
        except Exception as error:
            publish({'status':'ERROR','error':str(error)});print(str(error),flush=True)
        time.sleep(max(.05,period-(time.monotonic()-began)))

if __name__=='__main__':main()
