"""Prepare only the existing Nano and small English recognizer on CPU."""
from pathlib import Path

def main():
    root=Path(__file__).resolve().parents[1]
    import torch,easyocr
    torch.set_num_threads(1)
    if not (root/'models/yolov8n.pt').exists():raise FileNotFoundError('Existing YOLOv8n weights required')
    easyocr.Reader(['en'],gpu=False,detector=False,model_storage_directory=str(root/'models/ocr'),verbose=False)
    from scripts.prepare_lightweight_perception import main as export
    export()

if __name__=='__main__':main()
