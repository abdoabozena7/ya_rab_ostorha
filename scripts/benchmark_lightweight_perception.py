"""Offline CPU comparison on identical recorded native images. No CARLA controls."""
import argparse, ast, hashlib, json, statistics, subprocess, time
from pathlib import Path
import numpy as np
from PIL import Image
ROOT=Path(__file__).resolve().parents[1]
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--run',required=True);parser.add_argument('--mode',choices=['old','new'],required=True);args=parser.parse_args()
    images=sorted((Path(args.run)/'rgb').glob('*.jpg'))
    selected=[images[min(len(images)-1,i)] for i in (0,len(images)//3,len(images)*2//3)]
    samples=[];loaded=time.perf_counter()
    if args.mode=='old':
        import torch, easyocr
        from ultralytics import YOLO
        torch.set_num_threads(2);torch.set_num_interop_threads(1)
        detector=YOLO(str(ROOT/'models/yolov8n.pt'))
        arabic=easyocr.Reader(['ar','en'],gpu=False,model_storage_directory=str(ROOT/'models/ocr'),download_enabled=False,verbose=False)
        english=easyocr.Reader(['en'],gpu=False,detector=False,model_storage_directory=str(ROOT/'models/ocr'),download_enabled=False,verbose=False)
        source=subprocess.run(['git','show','2bdf8da:backend/perception_worker.py'],cwd=ROOT,capture_output=True,text=True,check=True).stdout
        definition=next(n for n in ast.parse(source).body if isinstance(n,ast.FunctionDef) and n.name=='read_texts')
        scope={};exec(compile(ast.Module(body=[definition],type_ignores=[]),'baseline-read-texts','exec'),scope)
    else:
        from backend.computer_vision.detector import RoadDetector
        from backend.computer_vision.ocr import EnglishRecognizer, text_regions
        detector=RoadDetector(ROOT/'models/yolov8n-320.onnx');english=EnglishRecognizer(ROOT/'models/ocr')
    load_ms=(time.perf_counter()-loaded)*1000
    for path in selected:
        rgb=np.array(Image.open(path).convert('RGB'));start=time.perf_counter();cpu=time.process_time()
        if args.mode=='old':
            prediction=detector.predict(Image.fromarray(rgb),imgsz=416,conf=.35,device='cpu',verbose=False,max_det=50)[0]
            detections=[{'class':prediction.names[int(b.cls.item())],'confidence':float(b.conf.item()),'xyxy':b.xyxy[0].tolist()} for b in prediction.boxes]
        else: detections=detector.predict(rgb)
        cv_ms=(time.perf_counter()-start)*1000;ocr_start=time.perf_counter()
        if args.mode=='old':texts=scope['read_texts'](rgb,arabic,english,detections);regions=None
        else:regions=text_regions(rgb,detections);texts=english.read(rgb,regions) if regions else []
        samples.append({'file':path.name,'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'cv_ms':cv_ms,'ocr_ms':(time.perf_counter()-ocr_start)*1000,'total_cpu_ms':(time.process_time()-cpu)*1000,'detections':len(detections),'texts':len(texts),'regions':regions})
    report={'source':'SAME_RECORDED_NATIVE_RGB','mode':args.mode,'device':'CPU','threads':2 if args.mode=='old' else 1,'load_ms':load_ms,'samples':samples,'cv_median_ms':statistics.median(s['cv_ms'] for s in samples),'ocr_median_ms':statistics.median(s['ocr_ms'] for s in samples),'cpu_median_ms':statistics.median(s['total_cpu_ms'] for s in samples),'cadence': 'At most CV 1 Hz; OCR two crops every 3 s' if args.mode=='new' else 'Full-image CRAFT + ar/en after every processed frame; paused in old comparison'}
    target=ROOT/'docs/evidence/urban_chaos';target.mkdir(parents=True,exist_ok=True);(target/f'perception-{args.mode}.json').write_text(json.dumps(report,indent=2),encoding='utf8');print(json.dumps(report,indent=2))
if __name__=='__main__':main()
