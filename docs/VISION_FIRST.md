# Vision-first Egyptian-street prototype

The active application remains the local Three.js game. No external simulator,
new model download, model-client delegation or training job is required.

## What makes a visual brake

The prediction path accepts real front-camera JPEG pixels, camera calibration,
frame identity/time and the vehicle's own odometry. It does **not** accept other
actors, simulator coordinates for people, future paths, scenario names or
scripted crossing flags.

The installed detector produces image boxes. A lightweight temporal tracker
projects observed footpoints onto the flat road, estimates motion and uncertainty,
and tests whether an incoming lateral trajectory conflicts with the car's lane
and arrival time. A confident fresh visual conflict can reduce requested speed
to zero. The ordinary independent safety controller can still brake separately.
Its intervention is never counted as a visual prediction.

A genuinely qualified hazard starts a bounded stopping episode. Slowing the
car changes its arrival time; that alone must not cancel the original brake
before the physical stop completes. Fresh associated observations support the
stop, and release requires positive observed clearance. Original qualification,
current confidence, actual braking progress and finite expiry remain distinct.
Stale or lost evidence is explicitly unavailable, not a confirmed visual stop
or a clear-road result.

This predicts a continuation of **visible motion**, not a person's private
intention before any evidence exists. A person waiting at a curb is not proof
that they will cross. The test matrix therefore includes similar noncrossing
scenes and missing/stale-camera controls, not only convenient positive examples.

Ground truth is used only after a run to compare the forecast with later actual
movement and proximity-trigger timing. It is not fed back into the detector or
prediction decision. Saved visual observations are replay data, not a new live
inference.

## Existing models: selection and limits

The local capability probe actually executed both existing CPU adapters on
retained rendered pixels:

| Existing candidate | Observed retained-pixel latency | Decision |
| --- | --- | --- |
| YOLOX-Tiny, 416 input, CPU, two threads | Front inset median 38.5 ms, p95 43.7 ms | Lightweight current candidate |
| YOLOv8s-640, existing multi-view adapter | Roughly 300-416 ms median across tested views | Not selected for this low-latency path |

These are installed **pipeline** measurements, not equal-FLOP model benchmarks,
current live-camera guarantees or recall/precision certification. The first
actual full-frame live attempt detected the approaching person too late and
**failed** predictive-braking acceptance. A measured refinement now evaluates
the whole image plus one fixed central half-width/half-height road view, maps
real findings back to the original pixels and applies ordinary duplicate NMS.
The same weights and score threshold are retained; no scene label, actor data,
clothing marker or invented confidence enters the detector.

On clean retained current camera JPEGs this added a real 0.638 person finding
at three seconds that the full-frame-only view missed; the one/two-second
images were still missed. Its measured median/p95 processing was 84.3/99.8 ms,
versus 42.1/45.3 ms for the single view. These are development measurements, not
a substitute for the complete current public positive/noncrossing matrix.
YOLOX still misses some traffic/small people. A missed or stale result is not
a guaranteed clear road.

The selected local file is `.cache/models/cv/yolox_tiny.onnx`, SHA-256
`427cc366d34e27ff7a03e2899b5e3671425c262ea2291f88bb942bc1cc70b0f7`.
The existing `.venv-perception` provides OpenCV, NumPy and ONNX Runtime. The
ordinary Python HTTP server stays standard-library-safe; the explicitly started
perception worker uses that existing interpreter and owns its process lifecycle.
No replacement weights or packages are fetched automatically.

The saved tabular Q policy and GRU safety export take range/state features,
not raw camera pixels. Existing Trajectron++ **does run** on CPU: three explicitly
synthetic one/two-object API calls measured 175 ms cold, then 33/25 ms warm,
after roughly seven seconds of adapter loading. It returns 25 unranked
alternatives per object, with no calibrated mode probabilities. Those calls
used four seconds of metric history; they do not prove accuracy on short,
noisy, pixel-derived tracks or that a crossing alternative will actually occur.
Metric input alone is not a reason to reject a learned forecaster, but neither
runtime compatibility nor selecting a convenient mode establishes a safe stop.

The current transparent temporal conflict decision avoids a new training/data/
sim-to-real claim and explains the observed evidence for each stop. The existing
learned forecaster remains a candidate for a separately measured camera-track
comparison. This is **not** a claim of universal superiority over RL or
Trajectron++, nor a fresh validation of historical learned-policy results.

## Public experiment

Open **Vision lab**, choose a case and the vision-first or reactive/sensors-only
mode, then run it. The physical scene is recreated without replacing the saved
city. Both modes retain independent collision safety. Run/reset/return controls
and model/frame-age/track/forecast/brake-reason feedback make availability and
the decision path explicit.

The finite cases include crossings from both sides, a parallel walker, a
stationary curb person and an empty scene. The important comparison is the
**actual applied brake time and completed physical stop** versus later actual
lane entry, the independent reactive intervention and proximity-trigger time.
A short brake pulse, a later reactive stop or stopping at the terminal goal
cannot pass as an anticipatory stop. Neither mode disables safety or invents a
counterfactual crash. An unavailable camera cannot earn a vision-first success.
Reading the ready scene until its first observation expires is allowed: Run
requests a new camera epoch and waits for a fresh matching result before motion.

The five front, three rear and two side proximity units remain auxiliary
virtual geometry measurements. Rear-camera selection changes the user-visible
rendered feed but never swaps the dedicated front RGB inference input.

## Appearance and car scope

The original unbranded faceted SUV follows the user's tall boxy off-road
direction, not the rejected reflective sports car. Its steering/running gear,
cabin instruments, actual bounded contact damage and pristine repair are retained.
Egyptian street appearance is locally authored from registered building sites:
plaster/brick facades, Arabic shopfronts and supported balconies/roof details.
Visual decoration must not alter navigation or introduce invisible lane blockers.

## Verification

```powershell
npm run build:dashboard
npm test
python -S -m unittest discover -s tests -p 'test_threejs_*.py' -v
node tools/evaluate-core.mjs
python scripts\verify_vision_egypt.py --browser
python scripts\verify_vision_egypt.py --models
python scripts\verify_vision_egypt.py --browser --negative-control
```

The model check uses an actual current camera sample retained by the public
journey. The negative control intentionally returns exit code 3 after detecting
the injected visual-input failure. Private raw frames, traces, failed attempts
and independent reviews remain under `.runtime-proof/`; they are not model
weights or assets to publish.

Acceptance covers declared local cases, source, settings and measured timing,
not universal intent prediction, real-world crashworthiness, hardware sensor
calibration or public-road autonomous-driving safety. The installed HarrTest
native-rollout reader is Codex-specific; its inability to authenticate this
Copilot SDK host is reported separately from actual native worker execution and
the explicit product-evidence gate.
