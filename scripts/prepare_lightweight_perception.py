"""One-time CPU export of existing pretrained weights. No training/download."""
from pathlib import Path
import shutil
ROOT=Path(__file__).resolve().parents[1]

def main():
    import torch
    from ultralytics import YOLO
    torch.set_num_threads(1)
    target=ROOT/'models/yolov8n-320.onnx'
    if target.is_file():
        print('Reusing existing 320 ONNX export: '+str(target));return
    source=ROOT/'models/yolov8n.pt'
    if not source.is_file():raise RuntimeError('Existing Nano weights are required')
    exported=YOLO(str(source)).export(format='onnx',imgsz=320,batch=1,dynamic=False,
        simplify=False,opset=17,device='cpu')
    shutil.move(str(exported),str(target))
    print(target)

if __name__=='__main__':main()
