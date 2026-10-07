# Ya Rab Ostorha — CARLA Simulation Control Center

**CARLA is the simulator.** This project provides the existing HUD, dashboard,
keyboard controls, telemetry/debugging and experiment interfaces. Production
does not render a duplicate driving world or run mock physics.

**Target: CARLA 0.9.16 (UE4), official precompiled Windows package.**

**Current work: live native validation of the existing offline core.** CARLA 0.9.16
is installed at `C:\CARLA\CARLA_0.9.16`, with the matching packaged CPython 3.12
API in `.venv-carla` (Python 3.12.10). Native boot and connection are verified.
Gate evidence is tracked in [LIVE_NATIVE_VALIDATION.md](docs/LIVE_NATIVE_VALIDATION.md).

Hardware: RTX 3060 Laptop GPU, **6144 MiB VRAM**. The user reports 32 GB RAM;
Windows currently enumerates **two 8 GiB modules (16 GiB installed)** and 15.25 GiB
usable. The previous Quadro T1000 notes describe obsolete hardware.

## Dashboard now

```powershell
.\.venv\Scripts\python.exe -m backend.server
```

Open http://127.0.0.1:8000/. It shows **CARLA — DISCONNECTED**, unavailable
observations, and disabled driving controls. Use `.venv-carla` for the native API and all current verification.

## Replay an existing real run

```powershell
.\.venv\Scripts\python.exe -m backend.server --replay runs\REAL_RUN_ID
```

Replay shows **MODE: REPLAY** and recorded observations with driving controls
disabled. It never connects to a simulator. No real run exists yet, and test
fixture recordings are refused by the production reader. Future native recording
uses `--record-run runs`; the old `--record-log` is a compatibility JSONL sink.

Strict configuration example: `experiments/offline-preparation.json`.
Optional dashboard-only startup: add `--experiment-config` with that file path.

## Installed runtime and launch

```powershell
py -3.12 --version
.\scripts\prepare_carla.ps1
```

The script inspects the official package, checks its exact wheel ABI, downloads
and verifies the archive, extracts into `C:\CARLA\CARLA_0.9.16\`, and installs
the shipped cp312 Windows x64 wheel and project dependencies into `.venv-carla`.
An incompatible existing environment is archived. It does not install Python
or build CARLA from source. Inspection without installation:

```powershell
.\scripts\prepare_carla.ps1 -InspectOnly
```

Launch in a separate terminal, using the detected package executable and a
conservative development profile (Low, windowed 1280x720):

```powershell
.\scripts\launch_carla.ps1
```

Before spawning:

Stop the dashboard-only backend before reusing port 8000, or add
`--port 8002 --websocket-port 8003` to the production command and open port 8002.

```powershell
.\.venv-carla\Scripts\python.exe -m backend.carla.preflight
.\.venv-carla\Scripts\python.exe -m backend.server --carla
```

Focus the dashboard for W/A/S/D/Space; observe the actual car in CARLA.
First validate native boot, connection and one vehicle (Gate 1), then controls
and collision (Gate 2), then real sensors (Gate 3). Normal traffic/pedestrians
follow Gate 4. Egypt, AI, accident avoidance and randomized chaos are Gates 5–8
and are not implemented in this offline preparation.
No fake RPM, fuel, or component damage is displayed. Native RPM/per-wheel APIs
exist in 0.9.16; mapping and validation are deferred until Gate 1.

See [0.9.16 migration, package evidence, blocker and gate procedures](docs/CARLA_0916_MIGRATION.md).

## Offline verification

```powershell
npm test
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
npm run test:legacy
.\.venv\Scripts\python.exe -m unittest discover -s legacy/threejs-simulator/tests -p 'test_*.py'
```

SDK fixtures test contracts and cleanup only. They do not pass native physics gates.

## Preserved work

- Three.js: `legacy/threejs-simulator/`, branch `codex/threejs-simulator-archive`, snapshot `e51bfb3`.
- BeamNG: `legacy/beamng-integration/`, branch `codex/beamng-migration-archive`, snapshot `7a6a777`.
- Previous CARLA 0.10.0 preparation: `legacy/carla-0100-preparation/`, branch `codex/carla-0100-preparation-archive`, snapshot `4d5b8ad`.
- Reused: branding, CSS/HUD, Phone/Route/Debug, camera panel, controls and transport.
- Assets and [license notices](public/assets/ATTRIBUTION.md) remain preserved.

For an explicit historical Three.js preview, use a separate server:

```powershell
.\.venv\Scripts\python.exe -m backend.server --port 8002 --enable-legacy-preview
```

Open http://127.0.0.1:8002/legacy/threejs-simulator/. Legacy preview and CARLA
production mode cannot run together in one server.
