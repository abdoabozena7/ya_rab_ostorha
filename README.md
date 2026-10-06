# Ya Rab Ostorha — BeamNG Simulation Control Center

BeamNG.tech is the simulator. This project provides the application HUD, controls, telemetry and debugging interface.

**BEAMNG BLOCKER:** no licensed simulator/package or `tech.key` was found on this device. Architecture preparation is complete; the real driving/sensor milestones have not passed.

## Run the dashboard now

```powershell
.\.venv\Scripts\python.exe -m backend.server
```

Open http://127.0.0.1:8000/. Without BeamNG it shows unavailable readings and disables driving controls. There is no production mock physics or Three.js renderer.

## Continue with a licensed installation

Provide the official package's local path, licensed `tech.key` path, installation directory and version. Confirm matching BeamNGpy first; the current pin is 1.34.1 for BeamNG.tech 0.37.

```powershell
.\.venv\Scripts\python.exe -m backend.server --beamng-home 'C:\BeamNG.tech' --beamng-user 'C:\BeamNG.user' --traffic-count 0
```

Expected files: `C:\BeamNG.tech\Bin64\BeamNG.tech.x64.exe` and `C:\BeamNG.tech\tech.key`.

The backend launches one physical vehicle. Focus the dashboard to send W/A/S/D controls; view the car in BeamNG. Extra sensors and traffic are disabled for the first milestone.

See [migration status, installation route, architecture and acceptance gates](docs/BEAMNG_MIGRATION.md).

## Verify the preparation

```powershell
npm test
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
npm run test:legacy
```

## Preserved Three.js archive

The previous implementation is safely retained under `legacy/threejs-simulator/` and on `codex/threejs-simulator-archive` (commit `e51bfb3`). Production does not load it.

For an explicit historical preview only, run a separate server:

```powershell
.\.venv\Scripts\python.exe -m backend.server --port 8002 --enable-legacy-preview
```

Open http://127.0.0.1:8002/legacy/threejs-simulator/. It is labeled archived/development-only and uses separate `/api/legacy/` observation endpoints. The legacy flag cannot be combined with BeamNG mode. Existing GLBs remain at `assets/`; [asset credits/licenses](public/assets/ATTRIBUTION.md) are preserved.
