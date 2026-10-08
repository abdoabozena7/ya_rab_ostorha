"""Download official model assets once; runtime never downloads models."""
from pathlib import Path
import os

ROOT=Path(__file__).resolve().parents[1]


def main():
    (ROOT/'models'/'ultralytics-config'/'Ultralytics').mkdir(parents=True, exist_ok=True)
    os.environ['YOLO_CONFIG_DIR']=str(ROOT/'models'/'ultralytics-config')
    import torch
    from ultralytics import YOLO, settings
    import easyocr
    models=ROOT/'models';models.mkdir(exist_ok=True)
    os.chdir(models)
    torch.set_num_threads(2)
    settings.update({'sync':False})
    YOLO('yolov8n.pt')
    easyocr.Reader(['ar','en'],gpu=False,model_storage_directory=str(models/'ocr'),verbose=False)
    easyocr.Reader(['en'],gpu=False,detector=False,model_storage_directory=str(models/'ocr'),verbose=False)
    print('Official YOLOv8n and EasyOCR Arabic/English assets ready; runtime uses CPU.')


if __name__=='__main__':main()
