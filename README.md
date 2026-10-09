# YA RAB OSTORHA: CARLA Collision-Avoidance Prototype

Always-on sensor-derived **RULE** safety protects forward manual and BasicAgent
driving through the existing feasibility validator and command arbiter. A compact
recurrent **behavior-cloned** safety model is supplied as an explicit research
comparison, with visible rule fallback and an optional hybrid guard. This is
supervised imitation, not a successful RL policy. RULE remains the startup default.

```powershell
.\Start-YA-RAB-OSTORHA.ps1
```

The presentation dashboard defaults to **Urban Chaos**: 40 traffic vehicles,
30 pedestrians, four native vehicle hazards and two scripted physical crossings.
**WITHOUT SAFETY** and **WITH YA RAB OSTORHA** reset the same seeded manifest
and start recording automatically for 60 simulation seconds. RULE protects the
second arm; BasicAgent research checks are configured equally in both arms.
**Validated Front Obstacle** remains available. **Stop / Reset** restores a
populated city with the ego stopped and RULE enabled.

See [presentation actions and module guides](docs/URBAN_CHAOS_PRESENTATION.md)
and [actual final rehearsal](docs/URBAN_CHAOS_REHEARSAL.md). The white dashboard
keeps the camera visible, uses Setup → Drive → Results, and offers four actual
graphics presets. Scene/text analysis is bounded CPU work; no training starts.

This reuses or starts the verified CARLA 0.9.16 installation and dashboard,
with seven sensors and the vehicle paused. Open Settings to take control;
enable manual driving for WASD, or select a map destination and Start Journey.
Safety/controller comparisons require a stopped vehicle. Controller availability
reflects native validation; the live **Generator** field identifies learned,
rule-guard or fallback control. Nothing trains during startup or driving.

The saved model, results, repeatable demonstration commands and limits are in
[final delivery](docs/FINAL_DELIVERY.md). Historical checkpoints, the frozen SAC,
demonstrations and Gymnasium environment are retained. No steering avoidance or
general pedestrian/rear-collision guarantee is claimed.

CARLA owns the world, vehicle physics and sensors. This project retains the
existing dashboard, controls, safety/core architecture, synchronization and recording.
The obsolete Three.js game and all preview/mock launch routes are deleted.

CARLA server/API **0.9.16 / 0.9.16**, Python **3.12.10 x64**, install
`C:\CARLA\CARLA_0.9.16`, map `Town10HD_Opt`, ego `vehicle.lincoln.mkz_2020`.
**Gates 1-3 PASS live**, including real sensors, recording and Replay with CARLA
stopped. Evidence and limits: [live validation report](docs/LIVE_NATIVE_VALIDATION.md).

**Gate 4 PASS live**: normal traffic/walkers, two 20-minute endurance runs,
real settings/manual topology navigation and populated recording/offline Replay.
Measured default profile: BALANCED 25 NPCs / 25 walkers, Low, 20 simulation Hz;
the populated endurance median was 16.90 actual ticks/s (renderer FPS unavailable).
[Gate 4 native evidence and limitations](docs/GATE4_NATIVE_VALIDATION.md).

**Gate 5 world foundation** adds stable urban driver profiles, local density,
native pedestrian activity, separate Living City/Training modes, two native
scenario prototypes and sensor-only future safety-policy/research contracts.
The current suggested BALANCED profile is 25 NPCs / 20 walkers. The interface
was originally prepared without a policy; the final prototype now adds the
explicit rule-based and experimental learned safety modes described above.
[Gate 5 report](docs/GATE5_WORLD_FOUNDATION.md) ·
[environment contracts](docs/GATE5_ENVIRONMENT_CONTRACTS.md).

Hardware: RTX 3060 Laptop GPU, 6144 MiB VRAM. Windows detects 16 GiB installed RAM
(two 8 GiB modules), 15.25 GiB usable; the user reports 32 GB. Former Quadro T1000
hardware notes are obsolete. Full-suite native throughput measured 19.69 frames/s
at 20 simulation Hz, 5868 MiB VRAM in the conservative development profile.

## Run the native dashboard

```powershell
.\scripts\launch_carla.ps1
# In another terminal, from the project folder:
.\.venv-carla\Scripts\python.exe -m backend.carla.preflight
.\.venv-carla\Scripts\python.exe -m backend.server --carla --sensors --spawn-index 152 --start-paused
```

Open http://127.0.0.1:8000/. **Enable manual driving** arms dashboard WASD, using the
physical keyboard only; it does not start motion. W throttle (55%), Shift+W full throttle, S brake/reverse, A/D steer,
Space handbrake. Typing in fields never drives. **Stop driving** brakes while
keeping the vehicle and cameras. Keep the dashboard focused; resumption is explicit.

The checked-in `frontend/dashboard.bundle.js` is the browser entry point. After
editing frontend modules, regenerate it with `npm ci` and `npm run build:dashboard`.
The single classic bundle avoids intermittent embedded-browser module-fetch failures;
the source modules and existing control architecture remain unchanged.

The later user-authorized extension adds an explicit **Go to destination** journey
using CARLA 0.9.16's official BasicAgent. Commands remain behind the canonical
safety/arbitration pipeline; AI/ASSISTED control modes stay disabled. Choose a
5–30 km/h target speed, adjustable during the journey and capped by the road limit.
WASD intervention stops automatic control while retaining the destination. Explicit
**Resume journey to destination** replans from the live current position. Only
**Clear route** clears that goal. A floating minimap opens the full native road map.

A separate read-only CPU worker runs real YOLOv8n detection and EasyOCR Arabic/English
on native RGB images. Each processed image, boxes and text share one frame/session
identity; their age is visible. These results never issue vehicle commands. Setup:

```powershell
.\scripts\setup_perception.ps1
```

Model assets live in ignored `models/`; dependencies in isolated `.venv-perception`.
Missing models produce an explicit unavailable state. Live analysis is off in Replay.
See [extension validation](docs/JOURNEY_PERCEPTION_VALIDATION.md) for measured limits.

The English LTR dashboard has a native 800x450 RGB feed, five camera views, live
telemetry, automatic current-position origin and persisted favorites. Settings
apply camera, weather, vehicle/spawn and 10/20 Hz timing. A separate graphics button
cleans up and restarts CARLA, verifies the new session and rolls back failed profiles.
Saved preferences are displayed separately from actual settings. Population is
created only after explicit application. Normal traffic/walkers, measured profiles,
seeded scenes, ground-truth debug and live recording are described in the
[normal city operation guide](docs/NORMAL_CITY_OPERATION.md).
DX12 RenderOffScreen passed native RGB/depth checks on this Windows machine;
Low/1280x720 is the verified default. Epic/1920x1080 failed startup and rolled back.
[Operation guide](docs/DASHBOARD_NATIVE_CONTROLS.md) ·
[8 October native evidence and limitations](docs/DASHBOARD_V2_VALIDATION.md).
Do not run a second synchronous tick owner or verification script while the backend
owns the session. Ctrl+C in an interactive backend terminal performs actor cleanup.
`--session-duration 30` provides clean timed validation runs.

Record a new native session with `--record-run runs`. Large sensor data is kept
as separate binary assets. No RPM, fuel, temperature or component damage is invented.

## Replay the verified real run

```powershell
.\.venv-carla\Scripts\python.exe -m backend.server --replay runs\gate3_1791400336
# New real manual/navigation/collision run:
.\.venv-carla\Scripts\python.exe -m backend.server --replay runs\dashboard_v2_20261008_live\run_ba0335c155e445f698708ff9969ac7d2
# Gate 4 real populated/manual run, verified with CARLA stopped:
.\.venv-carla\Scripts\python.exe -m backend.server --replay runs\normal_city\run_d252d723675c461bbdf42725c31b3259
```

Stop the current backend before reusing its ports. Replay never connects to CARLA,
shows MODE: REPLAY, displays recorded telemetry/camera and refuses native controls.
The Gate 3 run contains 534 frames over 26.65 simulation seconds (~550.32 MB).
The new run contains 1531 frames over 76.5 simulation seconds (2473.08 MB); it includes
NAVIGATION/MANUAL/SAFETY commands, mode changes and one real collision event.
Test-fixture recordings are refused by production Replay.

Dashboard only, with disabled controls and unavailable telemetry:

```powershell
.\.venv-carla\Scripts\python.exe -m backend.server
```

## Validation

```powershell
.\.venv-carla\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
npm test
# Run only with a free native simulator / no active backend:
.\.venv-carla\Scripts\python.exe -m scripts.native.vehicle_baseline
.\.venv-carla\Scripts\python.exe -m scripts.native.sensor_validation
# This dashboard-only verifier uses an already running backend; it never ticks CARLA:
.\.venv-carla\Scripts\python.exe -m scripts.native.verify_dashboard
# Gate 4 read-only endurance collector, with the real dashboard connected:
.\.venv-carla\Scripts\python.exe -m scripts.native.stability_run --duration 1200
# Normal-city matrix/lifecycle verification through the running backend WebSocket:
.\.venv-carla\Scripts\python.exe -m scripts.native.verify_normal_city --duration 75
```

The dashboard-v2 verifier exercises the explicit traditional journey extension.
Use normal-city verification scripts for population lifecycle and performance.
See the latest extension report for current regression and native checks.
Native gate status comes from live measurements, never unit tests.

[Architecture](docs/OFFLINE_CORE.md), [migration/package evidence](docs/CARLA_0916_MIGRATION.md),
[asset licenses](public/assets/ATTRIBUTION.md). BeamNG history is preserved in
`legacy/beamng-integration`; 0.10.0 preparation in `legacy/carla-0100-preparation`.
Traffic populations and pedestrians activate only by explicit dashboard application. Egypt maps, RL and perception-based driving remain deferred. Read-only detection/OCR is user-authorized.
