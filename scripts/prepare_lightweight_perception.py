"""One-time CPU export; download pinned official small weights when missing."""
from pathlib import Path
import shutil
import hashlib
import urllib.request
ROOT=Path(__file__).resolve().parents[1]

def main():
    import torch
    from ultralytics import YOLO
    torch.set_num_threads(1)
    small=ROOT/'models/yolov8s.pt'
    if not small.is_file():
        temporary=small.with_suffix('.download')
        urllib.request.urlretrieve('https://github.com/ultralytics/assets/releases/download/v8.3.0/yolov8s.pt',temporary)
        temporary.replace(small)
    if hashlib.sha256(small.read_bytes()).hexdigest()!='1f47a78bf100391c2a140b7ac73a1caae18c32779be7d310658112f7ac9aa78a':
        raise ValueError('The YOLOv8s source weights differ from the pinned official release')
    for family,size in (('yolov8n',320),('yolov8s',640)):
        target=ROOT/f'models/{family}-{size}.onnx'
        if target.is_file():print('Reusing '+str(target));continue
        source=ROOT/f'models/{family}.pt'
        if not source.is_file():raise RuntimeError('Existing source weights are required: '+str(source))
        exported=YOLO(str(source)).export(format='onnx',imgsz=size,batch=1,dynamic=False,
            simplify=False,opset=17,device='cpu')
        shutil.move(str(exported),str(target));print(target)

if __name__=='__main__':main()
