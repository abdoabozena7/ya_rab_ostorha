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
.\.venv-carla\Scripts\python.exe -m backend.server --carla --sensors --spawn-index 152
```

Open http://127.0.0.1:8000/. Keep the dashboard focused to drive; resume explicitly
if the safety watchdog paused controls. W throttle, S brake/reverse, A/D steer,
Space handbrake. The native CARLA window has its own spectator keyboard controls.
Do not run a second synchronous tick owner or verification script while the backend
owns the session. Ctrl+C in an interactive backend terminal performs actor cleanup.
`--session-duration 30` provides clean timed validation runs.

Record a new native session with `--record-run runs`. Large sensor data is kept
as separate binary assets. No RPM, fuel, temperature or component damage is invented.

## Replay the verified real run

```powershell
.\.venv-carla\Scripts\python.exe -m backend.server --replay runs\gate3_1791400336
```

Stop the current backend before reusing its ports. Replay never connects to CARLA,
shows MODE: REPLAY, displays recorded telemetry/camera and refuses native controls.
The verified run contains 534 frames over 26.65 simulation seconds (~550.32 MB).
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
```

Current regression checks: 85 Python passes / 1 skip and 15 JavaScript passes.
Native gate status comes from live measurements, never unit tests.

[Architecture](docs/OFFLINE_CORE.md), [migration/package evidence](docs/CARLA_0916_MIGRATION.md),
[asset licenses](public/assets/ATTRIBUTION.md). BeamNG history is preserved in
`legacy/beamng-integration`; 0.10.0 preparation in `legacy/carla-0100-preparation`.
Traffic populations, pedestrians, Egypt maps and AI are not active.
