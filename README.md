# Ya Rab Ostorha: CARLA Simulation Control Center

CARLA owns the world, vehicle physics and sensors. This project retains the
existing dashboard, controls, safety/core architecture, synchronization and recording.
The obsolete Three.js game and all preview/mock launch routes are deleted.

CARLA server/API **0.9.16 / 0.9.16**, Python **3.12.10 x64**, install
`C:\CARLA\CARLA_0.9.16`, map `Town10HD_Opt`, ego `vehicle.lincoln.mkz_2020`.
**Gates 1-3 PASS live**, including real sensors, recording and Replay with CARLA
stopped. Evidence and limits: [live validation report](docs/LIVE_NATIVE_VALIDATION.md).

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

Open http://127.0.0.1:8000/. **تفعيل القيادة اليدوية** arms dashboard WASD and held
on-screen pedals; it does not start motion. W throttle, S brake/reverse, A/D steer,
Space handbrake. Typing in fields never drives. **إيقاف القيادة** brakes while
keeping the vehicle and cameras. Keep the dashboard focused; resumption is explicit.

For experimental conventional navigation, select a destination from the searchable
native list or 2D road map, select **رحلة تلقائية**, then **ابدأ الرحلة التلقائية**.
The official CARLA BasicAgent follows the explicit route through the existing
safety/arbitration pipeline. Manual input, emergency, collision or expired 350 ms
browser heartbeat stops navigation. This does not enable AI/model modes or traffic.

The Arabic RTL dashboard has a native 800x450 RGB feed, five camera views, live
telemetry, automatic current-position origin and persisted favorites. Settings
apply camera, weather, vehicle/spawn and 10/20 Hz timing. A separate graphics button
cleans up and restarts CARLA, verifies the new session and rolls back failed profiles.
Saved preferences are displayed separately from actual settings and never activate
traffic. DX12 RenderOffScreen passed native RGB/depth checks on this Windows machine;
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
# Explicit navigation/lease/emergency/sensor verification against the live backend:
.\.venv-carla\Scripts\python.exe -m scripts.native.verify_dashboard_v2
# Include a temporary controlled collision fixture:
.\.venv-carla\Scripts\python.exe -m scripts.native.verify_dashboard_v2 --short --collision
```

Current regression checks: 103 Python passes / 1 skip and 21 JavaScript passes.
Native gate status comes from live measurements, never unit tests.

[Architecture](docs/OFFLINE_CORE.md), [migration/package evidence](docs/CARLA_0916_MIGRATION.md),
[asset licenses](public/assets/ATTRIBUTION.md). BeamNG history is preserved in
`legacy/beamng-integration`; 0.10.0 preparation in `legacy/carla-0100-preparation`.
Traffic populations, pedestrians, Egypt maps and AI are not active.
