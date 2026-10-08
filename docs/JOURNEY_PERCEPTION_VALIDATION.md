# Keyboard, destination journeys and camera analysis — 8 October 2026

This is the later user-authorized extension of Gate 4 checkpoint `bede5a0`.
The historical Gate 4 manual-only report remains a record of that checkpoint.
CARLA/API are both 0.9.16. No Three.js world, RL, Egyptian map, hazard scenarios,
or perception-based vehicle decisions were added.

## Delivered behavior

- Physical WASD only; the on-screen pedal buttons and their handlers are removed.
  W requests 55% throttle; Shift+W requests 100%. Shift alone does not move the car
  or cancel an automatic journey. S brakes before reverse; Space is handbrake.
  Inputs and open dialogs cannot send driving keys. Focus loss stops driving.
- Destination selection is separate from motion. **انطلق إلى الوجهة** explicitly
  starts the official CARLA 0.9.16 BasicAgent, using the complete native route and
  `stop_waypoint_creation=True`. The controller uses the actual fixed simulation
  delta. Target speed is 5–30 km/h and the lower real road limit takes precedence.
  Changing the speed while running updates the same journey without renewing its
  browser heartbeat lease or changing modes.
- Manual intervention stops automatic control and retains the exact destination
  ID/name/map/coordinates. **استكمال الرحلة إلى الوجهة** explicitly replans from
  the live ego position. Stopping does not erase the goal; **إلغاء المسار** does.
  Arrival, collision, emergency, lost focus and the independent 350 ms browser
  heartbeat remain governed by the existing safety architecture. No auto resume.
- The circular map sits at the bottom-left of the real RGB view. It follows the
  ego and route, and opens the native road map. This is a 2D topology map with a
  small CSS perspective effect. List/map selection, ×, Escape and outside click
  work. The full map fits its real road bounds on narrow screens.
- The adjacent image is real YOLOv8n inference on a native RGB frame. Its boxes,
  text polygons, frame, timestamp and session belong to that image. Its visible
  frame age distinguishes it from the faster direct RGB feed.
  A replacement image is decoded before publishing its matching metadata; an
  unavailable JPEG cannot relabel the previous frame. This race has a regression test.

Both manual and navigation commands follow:

`Browser → WebSocket → ControlSafetyLayer → CommandArbiter → CarlaProvider → VehicleControl`.

BasicAgent output uses canonical right-positive steering. The existing legacy
browser left-positive steering conversion is confined to the manual adapter.
AI/ASSISTED driving modes remain disabled. No ego `set_autopilot` shortcut exists.

## Live evidence

[Tracked evidence summary and hashes](evidence/journey-perception-summary.json)
preserve the results; full local traces are in `output/native-validation/`.

| Check | Result / evidence |
|---|---|
| Physical W, Shift+W, A/D, S and Space | PASS; 180.06 s browser-controlled trace, 1,570 samples plus handbrake trace |
| Change automatic speed during driving | PASS; real keyboard edit updated the running request to 12 km/h |
| Straight arrival and stopping | PASS, final native verifier |
| Turning arrival | PASS, earlier live `destination-journey-native.json`; same steering/controller pipeline |
| Manual intervention and exact goal retention | PASS; new route ID, identical destination, origin waypoint within 3 m of live ego |
| Heartbeat expiry / emergency without auto resume | PASS, final native verifier |
| Seven sensors / RGB-depth same frame and mount | PASS, final native verifier |
| Map selection, keyboard field exclusion, three modal close methods | Verified in actual in-app browser; typed `wasdw` while car remained stopped |
| Display-only model inference on real camera | PASS; two 180 s runs and a populated 90 s run after the Windows fix |
| Real signage OCR accuracy | **NOT VALIDATED**; see below |
| Record / Replay | PASS; real camera and telemetry, native journey request rejected in Replay |
| Final actor count / bounded image cache | PASS; one ego + 25 NPC vehicles, 25 walkers/controllers, seven sensors, four cached images |

Regression results: **126 Python passes, 1 skip; 24 JavaScript passes**.
These tests do not establish native gate status.

The genuine browser Go button also drove 54.72 m after list selection. A separate
map-selected route reached `ARRIVED / destination_reached`, speed zero. Earlier
failed native traces are retained; only the later passing artifacts count.

## Model worker and OCR limitation

Run `scripts/setup_perception.ps1` once. It installs pinned CPU PyTorch and the
model packages in `.venv-perception`, separate from CARLA's environment. Official
model assets are stored under ignored `models/`. Runtime downloads are disabled.
The worker imports no CARLA client, control WebSocket, planner or control layer;
it reads native camera/telemetry HTTP data only. It uses two CPU threads and
processes the newest frame, with no queue of old images. Four immutable JPEGs
are retained. Replay disables this live worker panel; processed results are not
currently recorded or replayed.

EasyOCR CRAFT detection feeds separate English and Arabic/English recognizers.
Only real model transcriptions with confidence ≥0.45 and at least two characters
are shown. A detected stop-sign text crop removes the octagonal border before
recognition; the detector class is never substituted for recognized text.

The live Town10HD STOP sign was detected by YOLO. English OCR on one real frame
returned `(STOPE` at confidence **0.2227**, so it was correctly suppressed. No
accepted transcription appeared in the endurance samples. A later controlled
stationary pose on a real road, approximately 10.6 m from the sign actor, produced
`ISTop` at confidence **0.4704–0.6872**, visible in the real dashboard. A closer
pose did not produce accepted text. Both exact-STOP calibration checks failed;
the ego pose was restored in `finally` without sending direct VehicleControl.
OCR is installed and executing on real pixels, but reliable reading of CARLA
signage has **not** been demonstrated.
Arabic text accuracy has not been tested against native Arabic signs; the current
CARLA map does not supply that calibration target. Boxes are also experimental:
COCO classes do not cover every object and incorrect classes/misses are possible.

A Windows file-sharing race originally killed the worker when `latest.json` was
read during atomic replacement. Bounded replacement retries now retain the last
complete result instead of publishing partial JSON or crashing. Session changes
reject old results, stale results are explicit, and expected unavailable camera
frames during reset produce WAITING. Worker shutdown errors cannot prevent native
actor cleanup. The browser entry point is a checked-in esbuild classic bundle,
which resolves the observed embedded-browser ES-module reload failures. The source
modules remain independently testable. Startup errors are visible instead of leaving
controls apparently usable. Reload was verified on desktop and narrow viewports.

## Measured performance

Low / DX12 RenderOffScreen, 800×450, JPEG 95, postprocess/motion blur off,
20 simulation Hz (`fixed_delta_seconds=0.05`), all required sensors active.

| Population | Collection | Actual simulation ticks/s, median | Processed frames/s | Model time, median |
|---|---:|---:|---:|---:|
| 0 / 0 | 180.17 s | 16.54 | 0.844 | 1,125 ms |
| 25 / 25 | 90.38 s | 14.63 | 0.808 | 1,187 ms |

VRAM stayed at approximately **5,873 / 6,144 MiB**. Renderer FPS remains unavailable;
neither simulation Hz nor callback rates are labeled renderer FPS. The populated
worker RSS ranged **854–1,178 MiB**, finishing at 910 MiB versus 914 MiB initially.
The empty run reached 1,191 MiB during initialization; these short runs establish
bounded image storage and recovery, not a new 20-minute AI-worker endurance claim.
No new late, duplicate, out-of-order or timestamp-mismatched sensor data appeared
in the empty 180 s interval. Initial/reset missing frames remain explicitly counted.

The earlier measured BALANCED 25/25 city remains usable with the display worker,
with reduced actual throughput. Choose LIGHT 10/10 for more headroom; it has not
been rebenchmarked with this extension. Windows still reports 16 GiB RAM despite
the user's 32 GB specification; see the original hardware audit.

## Recording

`runs/normal_city/run_fc201f13dbf6473a88cf112f0c413529`

1,620 frames, **80.95 simulation seconds**, **2,625.91 MB**. Recorded command sources
include NAVIGATION, MANUAL and SAFETY. RGB/depth/LiDAR remain separate assets.
Replay on ports 8004/8005 showed real recorded images and telemetry, `mode=REPLAY`,
`connected=false`, disabled dashboard driving and the explicit error
`Replay has no native connection or control sink` for a journey request. This
extension Replay test ran alongside the live server; the earlier Gate 3/4 tests
already verified Replay with CARLA stopped.

## Files and reproduction

Backend: CARLA provider/dashboard routing, core journey speed handling, WebSocket
admission, HTTP model endpoints, `perception.py` and `perception_worker.py`.
Frontend: keyboard controls, input policy, simulation client, tools, dashboard,
bootstrap, perception view, CSS and HTML. Setup/dependencies: isolated model install
script, model preparation, pinned requirements and ignore rules. Native/regression
verification and README/operation/evidence documentation were updated.

```powershell
# After editing frontend source modules:
npm ci
npm run build:dashboard
# Against the running backend; these collectors never own CARLA ticks:
.\.venv-carla\Scripts\python.exe -m scripts.native.verify_dashboard_v2 --short --output output/native-validation/journey-final-native.json
.\.venv-perception\Scripts\python.exe -m scripts.native.verify_perception --duration 180
```

BasicAgent is experimental conventional navigation and does not guarantee handling
every obstacle or stop sign. The display models do not change that behavior.
Improve and calibrate OCR next, then perform a longer model-worker endurance run
before increasing inference resolution/rate. No further AI-driving phase starts
automatically.
