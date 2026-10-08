"""YOLOv8n + Arabic/English OCR on immutable native RGB frames, CPU only.

No CARLA SDK import, WebSocket control socket, planner or decision output.
Latest-frame acquisition drops backlog; image + boxes + text share one identity.
"""
import argparse
import hashlib
import io
import json
import os
from pathlib import Path
import time
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'output' / 'perception'


def read_texts(rgb, arabic_reader, english_reader, detections=()):
    import cv2
    horizontal, free = arabic_reader.detect(rgb, canvas_size=800, min_size=10,
                                          text_threshold=.5, low_text=.3, link_threshold=.3)
    gray=cv2.cvtColor(rgb,cv2.COLOR_RGB2GRAY)
    best={}
    for language,reader in [('en',english_reader),('ar/en',arabic_reader)] if horizontal[0] or free[0] else []:
        for polygon,text,confidence in reader.recognize(gray, horizontal[0], free[0],
                reformat=False, detail=1, paragraph=False, workers=0, batch_size=1):
            if confidence<.45 or len(text.strip())<2: continue
            points=[[float(x),float(y)] for x,y in polygon]
            key=tuple(v for point in points for v in point)
            if key not in best or confidence>best[key]['confidence']:
                best[key]={'text':text,'confidence':float(confidence),'polygon':points,'language':language}
    # Remove octagonal sign borders from the candidate text crop. The text itself
    # still comes from the recognizer; no sign label is substituted for OCR.
    for detection in detections:
        if detection['class']!='stop sign': continue
        x1,y1,x2,y2=detection['xyxy'];w=x2-x1;h=y2-y1
        left=max(0,int(x1+w*.2));right=min(gray.shape[1],int(x2-w*.2))
        top=max(0,int(y1+h*.35));bottom=min(gray.shape[0],int(y2-h*.35))
        if right-left<12 or bottom-top<6: continue
        crop=cv2.resize(gray[top:bottom,left:right],None,fx=4,fy=4,interpolation=cv2.INTER_CUBIC)
        for _,text,confidence in english_reader.recognize(crop,detail=1,workers=0,batch_size=1,reformat=False):
            if confidence<.45 or len(text.strip())<2: continue
            points=[[float(left),float(top)],[float(right),float(top)],
                    [float(right),float(bottom)],[float(left),float(bottom)]]
            best[tuple(v for point in points for v in point)]={
                'text':text,'confidence':float(confidence),'polygon':points,'language':'en','method':'model_box_text_crop'}
    return list(best.values())


def publish(value):
    value['published_at'] = time.time()
    temporary = OUTPUT / 'latest.tmp'
    temporary.write_text(json.dumps(value,ensure_ascii=False),encoding='utf8')
    # Windows readers may briefly hold the destination without delete sharing.
    # Retain the last complete result rather than expose partial JSON or crash.
    for attempt in range(12):
        try:
            os.replace(temporary, OUTPUT / 'latest.json')
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
    for cached in OUTPUT.glob('frame_*.jpg'): cached.unlink(missing_ok=True)
    publish({'status':'LOADING'})
    import torch
    import numpy as np
    from PIL import Image, ImageDraw
    from ultralytics import YOLO, settings
    import easyocr
    torch.set_num_threads(2);torch.set_num_interop_threads(1)
    settings.update({'sync':False})
    detector=YOLO(str(ROOT/'models'/'yolov8n.pt'))
    reader=easyocr.Reader(['ar','en'],gpu=False,model_storage_directory=str(ROOT/'models'/'ocr'),
                          download_enabled=False,verbose=False)
    english_reader=easyocr.Reader(['en'],gpu=False,detector=False,
        model_storage_directory=str(ROOT/'models'/'ocr'),download_enabled=False,verbose=False)
    url=f'http://127.0.0.1:{args.port}/api/simulation/'
    previous=None;history=[]
    while parent_alive(args.parent):
        started=time.monotonic()
        try:
            with urllib.request.urlopen(url+'state',timeout=5) as response: state=json.load(response)
            if not state.get('connected') or state.get('mode')=='REPLAY':
                publish({'status':'DISCONNECTED'});time.sleep(1);continue
            if not state.get('frameComplete'):
                publish({'status':'WAITING','session_id':state.get('sessionId'),
                         'error':'Waiting for complete camera frame'});time.sleep(.1);continue
            fid=state['vehicle']['frame'];session=state['sessionId'];stamp=state['vehicle']['timestamp']
            identity=(session,fid)
            if identity==previous: time.sleep(.1);continue
            with urllib.request.urlopen(url+'camera.jpg?frame_id='+str(fid),timeout=5) as response:
                if int(response.headers['X-Sensor-Frame'])!=fid or abs(float(response.headers['X-Sensor-Time'])-stamp)>1e-6:
                    raise ValueError('Camera/telemetry identity mismatch')
                source_bytes=response.read()
                image=Image.open(io.BytesIO(source_bytes)).convert('RGB')
            prediction=detector.predict(image,imgsz=416,conf=.35,device='cpu',verbose=False,max_det=50)[0]
            detections=[];draw=ImageDraw.Draw(image)
            for box in prediction.boxes:
                xy=[float(v) for v in box.xyxy[0].tolist()];label=prediction.names[int(box.cls.item())]
                confidence=float(box.conf.item());detections.append({'class':label,'confidence':confidence,'xyxy':xy})
                draw.rectangle(xy,outline='#63a8ff',width=2)
                draw.text((xy[0]+2,max(0,xy[1]-13)),f'{label} {confidence:.0%}',fill='#ffffff',stroke_width=1,stroke_fill='#000000')
            # Read the same untouched RGB bytes, not detector labels painted above.
            # prediction.orig_img is BGR; use RGB for OCR.
            rgb=prediction.orig_img[:,:,::-1].copy()
            texts=read_texts(rgb,reader,english_reader,detections)
            for item in texts:
                points=item['polygon']
                draw.line([tuple(point) for point in points]+[tuple(points[0])],fill='#fbbf24',width=2)
            token=f'frame_{session}_{fid}.jpg';image.save(OUTPUT/token,format='JPEG',quality=95)
            history.append(token)
            while len(history)>4:
                old=history.pop(0)
                if old!=token: (OUTPUT/old).unlink(missing_ok=True)
            elapsed=(time.monotonic()-started)*1000
            publish({'status':'RUNNING','source':'REAL_CARLA_RGB_MODEL_INFERENCE',
                'session_id':session,'frame_id':fid,'timestamp_s':stamp,'width':image.width,'height':image.height,
                'image_token':token,'model':'YOLOv8n COCO','ocr':'EasyOCR ar/en',
                'source_image_sha256':hashlib.sha256(source_bytes).hexdigest(),
                'device':'CPU','inference_ms':elapsed,'detections':detections,'texts':texts})
            previous=identity
        except urllib.error.HTTPError as error:
            if error.code in (404,409,503):
                publish({'status':'WAITING','error':'Waiting for available camera frame'} )
            else:
                publish({'status':'ERROR','error':str(error)});print(str(error),flush=True)
        except Exception as error:
            publish({'status':'ERROR','error':str(error)});print(str(error),flush=True)
        time.sleep(max(.05,1-(time.monotonic()-started)))


if __name__=='__main__': main()
