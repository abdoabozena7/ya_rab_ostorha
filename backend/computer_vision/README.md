# Computer Vision

This section implements the actual camera analysis worker. It does not send driving controls. RULE safety uses synchronized sensor measurements in the shared controller.

## Inputs and outputs

Input: native CARLA RGB JPEG with its frame ID, simulation timestamp and session ID. Output: road-object bounding boxes, confidence, recognized English text crops, an annotated image and timings. The annotated image is immutable and belongs to exactly the published source frame. NLP results retain their own source frame when OCR runs less frequently.

## Algorithm and files

- `detector.py`: letterbox to 320×320, normalize, run the existing YOLOv8n weights exported to ONNX, confidence filtering and class-wise nonmaximum suppression. Road classes only; at most 20 detections.
- `ocr.py`: OpenCV gradient/threshold/morphology text proposals or a detected sign crop; EasyOCR `english_g2` recognizer only. Arabic and CRAFT detection weights are not loaded.
- `worker.py`: latest-frame polling, one image per second, at most two OCR regions every three seconds, lineage verification and bounded image cache.
- `service.py`: isolated CPU process lifecycle and result/image endpoints.

ONNX Runtime uses CPUExecutionProvider and one intra/inter-op thread. Torch recognition and OpenCV also use one thread. There is no CUDA inference, image queue, model training or larger model download. `backend/perception.py` and `backend/perception_worker.py` are compatibility imports.

## Runtime call and demonstration

`backend/server.py` starts `PerceptionService`; it launches the worker independently of the dashboard's selected workflow step. The worker reads `/api/simulation/state` and `/api/simulation/camera.jpg`; `frontend/perception-view.js` displays its results. Run `Start-YA-RAB-OSTORHA.ps1`, watch the analysis below the native camera and inspect this folder in your code editor. Initial preparation: `scripts/setup_perception.ps1`; export uses `scripts/prepare_lightweight_perception.py` and the existing Nano weights.

## Limits and discussion questions

Small distant objects and tiny sign letters may be missed at 320 pixels. Text proposals are heuristics and can include buildings or road markings. Confidence is a model score, not a calibrated probability or protection guarantee. Why recognizer only? It avoids the full-frame CRAFT network. Why a separate process? Heavy imports and occasional OCR cannot block the driving worker. Why retain frame IDs? Old text must never be drawn on a newer camera image.

Primary API reference: [EasyOCR Reader and recognize](https://jaided.ai/easyocr/documentation/). `detector=False` avoids loading CRAFT; `recognize` treats a provided crop as one text box.
