# Existing vision and future-motion models on recorded GTA data

The unchanged local YOLO detector and Trajectron++ adapter execute on actual
RGB/depth from [the native sensor run](GTA_SENSOR_QUALIFICATION_20261031.md).
This is a static recorded-domain smoke, not moving prediction, native concurrent
timing, policy admission or completed migration. CARLA and its data remain.

The isolated sealed task `integrations/gta/.runtime-proof/gta-vision-replay-20261031`
passed controls, actual model execution, evidence review and the current-source
gate at source `e3ddb0b1`; model run `20261031T104545-b15a9857bf`. No root active
task was replaced. Existing weights, thresholds and preprocessing were unchanged;
no dependencies or weights were downloaded. Raw inputs, native receipt, upstream
source and model identities are pinned in `integrations/gta/vision-lock.json`.
Replay also accepts identical raw bytes from a lossless `raw-captures.zip` if flat
captures are later archived; every selected input is checked against its hash.

| Measured item | Actual result |
| --- | --- |
| Existing model | `models/yolov8s-640.onnx`, three-view V3 preprocessing |
| CPU | CPUExecutionProvider, ONNX Runtime1.23.2; median394.592ms |
| GPU | DmlExecutionProvider, existing `.venv-perception-dml`,1.24.4; median38.688ms |
| CPU/GPU comparison | All detections in six selected frames match within1px and .02 confidence |
| Center vehicle found | 10m bus;30/80m truck, although the actual object is a bus |
| Center vehicle missed | 60m,100m,120m; no score reduction or success relabeling |
| Measured track | 35 image/depth positions; seven historical observations spanning.658s enter inference |
| Actual forecast | One vehicle,25 unranked modes,0–3s at.5s intervals; no probabilities |
| Model-only forecast call | 22.774ms; no startup/concurrency/latency-percentile claim |
| Experiment time | 16.828s final run; earlier attempts retained and charged |
| Original10800s ledger | 1609.799s charged;9190.201s remain |

The earlier attempted GPU selection used a CPU-only environment and actually
fell back to CPU. That receipt is preserved. The final run requires actual DML;
unexpected CPU fallback fails rather than being reported as acceleration.

History comes from detector boxes, calibrated depth and declared camera/ego
odometry. No target game handle, position or velocity enters inference. This
geometry assumes a stationary approximately flat near-center scene; full camera
extrinsic/field qualification remains pending. All25 per-mode measured future
errors are retained. The best future-matching mode is not selected as a driving
oracle, and a static example cannot establish future-motion accuracy.

Five negative controls cover corrupted/unpinned input, empty/peripheral detection,
zero/NaN/missing depth and output outside the dedicated run. The actual adapter
also produces zero modes for empty perception. Workers share a550s deadline and
charge the original grant. Source and protected inputs were unchanged. No
training was started.

Retained [summary](evidence/gta_vision_20261031/vision-result.json),
[detector/track](evidence/gta_vision_20261031/detector.json),
[forecast/all mode errors](evidence/gta_vision_20261031/forecast.json), and
[input identities](evidence/gta_vision_20261031/input-manifest.json) support only
these observations. Full raw images remain local, out of Git.

Next required native work is off-axis/360-degree coverage and timing, moving
CV tracks and future labels, clean scenario state and simultaneous capture/
inference performance. Provider/scenarios, MaskablePPO pilots and training,
untouched evaluation, original600–800m/density/three-pass goals, UI integration
and conditional CARLA retirement remain open.
