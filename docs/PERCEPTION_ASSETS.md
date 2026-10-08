# Local perception dependencies and assets

The local setup uses official sources; model files are ignored by Git.
Runtime camera processing is local and CPU-only, and does not upload camera data.

| Dependency | Verified version | Source / license |
|---|---|---|
| Ultralytics | 8.4.174 | [official YOLOv8 documentation](https://docs.ultralytics.com/models/yolov8/), AGPL-3.0 |
| EasyOCR | 1.7.2 | [official repository](https://github.com/JaidedAI/EasyOCR), Apache-2.0 |
| PyTorch / torchvision CPU | 2.14.1+cpu / 0.29.1+cpu | [official CPU wheel index](https://download.pytorch.org/whl/cpu), BSD-style licenses |
| CARLA BasicAgent | installed 0.9.16 source | [official versioned source](https://github.com/carla-simulator/carla/blob/0.9.16/PythonAPI/carla/agents/navigation/basic_agent.py), CARLA MIT license |

| Asset | Official download |
|---|---|
| YOLOv8n | [Ultralytics release weights](https://github.com/ultralytics/assets/releases/download/v8.4.0/yolov8n.pt) |
| CRAFT detector | [EasyOCR release](https://github.com/JaidedAI/EasyOCR/releases/download/pre-v1.1.6/craft_mlt_25k.zip) |
| Arabic/English recognizer | [EasyOCR Arabic release](https://github.com/JaidedAI/EasyOCR/releases/download/pre-v1.1.6/arabic.zip) |
| English recognizer | [EasyOCR English release](https://github.com/JaidedAI/EasyOCR/releases/download/v1.3/english_g2.zip) |

Exact installed file sizes and SHA-256 hashes are retained in
[the tracked extension evidence](evidence/journey-perception-summary.json).
Package license notices remain in the isolated environment's installed packages.
