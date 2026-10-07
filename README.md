# Ya Rab Ostorha — CARLA Simulation Control Center

**CARLA is the simulator.** This project provides the existing HUD, dashboard,
keyboard controls, telemetry/debugging and experiment interfaces. Production
does not render a duplicate driving world or run mock physics.

**CARLA BLOCKER:** installation is incomplete. Python 3.12 x64 must be installed
manually; automatic approval review rejected running its official installer
(“blocked by policy”). The signed installer is downloaded at:

`C:\CARLA\downloads\python-3.12.10-amd64.exe`

The official CARLA 0.10.0 Windows ZIP is partially downloaded and preserved.
No native migration gate has passed. The Quadro T1000's 4 GB VRAM is below
CARLA UE5's recommended GPU capacity; native boot remains untested.

## Dashboard now

```powershell
.\.venv\Scripts\python.exe -m backend.server
```

Open http://127.0.0.1:8000/. It shows **CARLA — DISCONNECTED**, unavailable
observations, and disabled driving controls. The current Python 3.13 environment
is suitable for this dashboard/offline tests, not the CARLA 0.10.0 API.

## Continue after installing Python 3.12 x64

```powershell
py -3.12 --version
.\scripts\prepare_carla.ps1
```

The script resumes the official precompiled package into
`C:\CARLA\CARLA_0.10.0\` and installs its matching cp312 Windows x64 wheel
into `.venv-carla`. It does not install Python or build CARLA from source.

Then launch `CarlaUnreal.exe` from its installation folder. Before spawning:

Stop the dashboard-only backend before reusing port 8000, or add
`--port 8002 --websocket-port 8003` to the production command and open port 8002.

```powershell
.\.venv-carla\Scripts\python.exe -m backend.carla.preflight
.\.venv-carla\Scripts\python.exe -m backend.server --carla
```

Focus the dashboard for W/A/S/D/Space; observe the actual car in CARLA.
First validate one vehicle, native controls and telemetry. Sensors, collisions,
traffic/walkers and custom environment work follow their required gates.
No fake RPM, fuel, or component damage is displayed.

See [machine audit, installation blocker, architecture, limitations and gate procedures](docs/CARLA_MIGRATION.md).

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
- Reused: branding, CSS/HUD, Phone/Route/Debug, camera panel, controls and transport.
- Assets and [license notices](public/assets/ATTRIBUTION.md) remain preserved.

For an explicit historical Three.js preview, use a separate server:

```powershell
.\.venv\Scripts\python.exe -m backend.server --port 8002 --enable-legacy-preview
```

Open http://127.0.0.1:8002/legacy/threejs-simulator/. Legacy preview and CARLA
production mode cannot run together in one server.
