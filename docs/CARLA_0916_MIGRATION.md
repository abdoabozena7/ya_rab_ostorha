# CARLA 0.9.16 migration

Updated 7 October 2026. Branch: `codex/carla-control-center`.
Continues from `4d5b8ad`; this is a version migration, not a new simulator.

## Status and implementation plan

CARLA owns the rendered world, vehicle dynamics, actors and sensors. The web
application owns the existing HUD, control transport, observations, debugging
and recording boundary. It renders no duplicate driving world and has no mock
production provider.

1. Preserve 0.10.0 preparation and audit version assumptions — complete.
2. Inspect the official 0.9.16 Windows package and its exact wheel — complete.
3. Update target, preparation/launch scripts, runtime guards, labels and tests — complete.
4. Install compatible Python, download/extract CARLA, import matching API — blocked.
5. Native boot, read-only connection/catalog check, one ego and browser control — not run.
6. Only after Gate 1: validate vehicle behavior/collision, then the sensor suite.
7. Only after those gates: choose an urban map, normal traffic/walkers and Egypt planning.

**No native migration gate has passed.** Offline SDK fixtures verify contracts
and ownership only; they are never displayed as simulator observations.

## Why the target changed

The user selected CARLA 0.9.16 to reduce the hardware demands of the previous
0.10.0/UE5 target and use the established UE4 ecosystem. The
[official 0.9.16 release](https://github.com/carla-simulator/carla/releases/tag/0.9.16)
provides a Windows binary package, avoiding a source build or Unreal clone.

### Preserved migration boundary

| Disposition | Work |
| --- | --- |
| REUSED | Generic SimulationProvider/SimulationService, WebSocket control ownership, stale-data rejection, keyboard safety, snapshot schema, recording abstraction and simulator-independent tests |
| REUSED | HUD/CSS/branding, Phone/Route/Debug, front-camera panel, position/minimap concept and controls |
| UPDATED | CARLA version contract, package URL/install root, inspected wheel ABI, native executable discovery, runtime/API checks, dashboard labels, tests and documentation |
| ARCHIVED | 0.10.0 installer and notes: `legacy/carla-0100-preparation/`; full preparation branch `codex/carla-0100-preparation-archive` at `4d5b8ad` |
| ARCHIVED | Three.js world/dynamics/traffic/walkers: `legacy/threejs-simulator/`; branch `codex/threejs-simulator-archive` at `e51bfb3` |
| ARCHIVED | BeamNG provider/license checks/adapters: `legacy/beamng-integration/`; branch `codex/beamng-migration-archive` at `7a6a777` |

The earlier Three.js implementation used local longitudinal/bicycle dynamics,
distance/radius wheel animation and approximate powertrain/suspension/damage.
Those visual systems remain historical material. The earlier repository audit
is retained in `legacy/threejs-simulator/docs/PHASE_1_FOUNDATION.md`.
Licensed assets and attribution remain preserved. No new vehicle physics, AI,
chaos, traffic or pedestrian behavior has been implemented during this downgrade.

## Machine audit

| Item | Observed on this machine |
| --- | --- |
| Windows | Windows 11 Pro x64, build 26200 |
| Machine / CPU | Dell Precision 5540; Intel i7-9850H, 6 cores / 12 threads |
| Dedicated GPU | NVIDIA Quadro T1000, 4096 MiB VRAM; driver 581.95 |
| Other GPU | Intel UHD 630 |
| RAM | 31.73 GiB usable, 32 GB installed |
| C: available space | Approximately 183.64 GiB at this audit |
| Python | Project `.venv`: 3.13.5; system 3.13 and 3.14; no 3.12 |
| `.venv-carla` | Not created |
| Visual C++ x64 runtime | Installed, 14.44.35211.00 |

The [0.9.16 quick start](https://carla.readthedocs.io/en/0.9.16/start_quickstart/)
lists Windows 10/11 and recommends RTX 2070-equivalent graphics with 8 GB VRAM.
This T1000 has 4 GiB VRAM, below that recommendation. Boot/performance are
unverified; a low profile is prepared, without claiming compatibility from specs.
The actual machine is not an RTX 3060. Storage is sufficient for the inspected
archive plus extracted files; the installer rechecks free space before downloading.

## Official package inspection and exact Python compatibility

Source: [official Windows ZIP](https://downloads.carlasim.com/Windows/CARLA_0.9.16.zip),
linked by the official release. Normal curl HTTP ranges successfully returned
the ZIP directory and actual packaged API wheel. No authentication bypass,
unofficial mirror or source build was used.

| Inspected item | Actual result |
| --- | --- |
| Archive size | 7,812,252,810 bytes, about 7.28 GiB |
| Expanded size | 19,398,059,218 bytes, about 18.07 GiB |
| ZIP entries | 32,841 |
| Native launcher | `CarlaUE4.exe` at the package root |
| Windows API wheel | `PythonAPI/carla/dist/carla-0.9.16-cp312-cp312-win_amd64.whl` |
| Wheel internal ABI tag | `cp312-cp312-win_amd64` |
| Wheel internal metadata | Name: carla; Version: 0.9.16 |
| Wheel size / CRC32 | 5,037,187 bytes / `763ed9ae` |
| Wheel SHA256 | `b4700a1cfff8a9bda1018a233b25045ce6e00a7b180b8bd0edea6366c3f7c9eb` |

**The shipped Windows wheel requires CPython 3.12 x64.** This was determined
from the actual 0.9.16 package, not carried over from 0.10.0 or inferred from
the broader versions mentioned in documentation. Python 3.13/3.14 cannot load
this wheel. No arbitrary PyPI `carla` package is installed.

Inspection manifest: `C:\CARLA\downloads\CARLA_0.9.16.package.json`.
The inspected wheel is cached separately at
`C:\CARLA\downloads\CARLA_0.9.16-api\carla-0.9.16-cp312-cp312-win_amd64.whl`.
It is not installed. The full CARLA game has not been downloaded or extracted;
the native executable has been identified in the remote directory, not launched.

The older partial `C:\CARLA\downloads\Carla-0.10.0-Win64-Shipping.zip.part`
remains preserved at 185,249,792 bytes. It is never used by the new installer.

## CARLA 0.9.16 BLOCKER

**Required dependency: Python 3.12 x64, manually installed.**

Automatic approval review previously rejected executing its official installer,
with the stated reason **“blocked by policy.”** No installer was executed. That
rejection has not been retried through another execution method.

Required manual file:
`C:\CARLA\downloads\python-3.12.10-amd64.exe`.
Downloaded from the [official Python 3.12.10 release](https://www.python.org/downloads/release/python-31210/);
26,964,224 bytes; Authenticode signature Valid, signer Python Software Foundation.

Install that file manually, including Python launcher registration. The default
per-user executable is
`C:\Users\LAPSHOP\AppData\Local\Programs\Python\Python312\python.exe`.
If another location is used, ensure `py -3.12` selects that x64 executable.
No CARLA license key is needed.

From `C:\Users\LAPSHOP\Downloads\ya_rab_ostorha`, continue with:

```powershell
py -3.12 --version
.\scripts\prepare_carla.ps1
```

Do not proceed to native boot with the project's existing Python 3.13 environment.

## Installation and launch procedure

`scripts/prepare_carla.ps1`:

1. Inspects the official ZIP directory and wheel metadata with standard HTTP ranges.
2. Derives the required runtime from the wheel, validates its internal ABI/version,
   and requires that exact x64 Python before downloading the full game.
3. Checks storage, downloads/resumes only `C:\CARLA\downloads\CARLA_0.9.16.zip.part`,
   verifies length and ZIP/wheel integrity, then extracts into `C:\CARLA\CARLA_0.9.16\`.
4. Detects the actual launcher and verifies the extracted wheel's SHA256.
5. Preserves an incompatible `.venv-carla` by renaming it inside the project;
   creates a compatible environment and installs the shipped wheel plus backend dependencies.
6. Validates API import/client version, writes an installation marker and reports
   package/API success separately from unverified native boot/Gate 1.

A nonempty unverified installation folder is rejected for inspection rather
than overwritten. Failed downloads stay partial; extraction/runtime/API failures
stop with explicit errors. The script never executes Python installers or builds
CARLA. A complete downloaded archive can be inspected locally with `--archive`.
The CRC/SHA256 checks above are measured package integrity values, not a claim
of an independently published upstream archive checksum.

Inspection only, without installing or launching:

```powershell
.\scripts\prepare_carla.ps1 -InspectOnly
```

After successful preparation, launch the actual game in a separate terminal:

```powershell
.\scripts\launch_carla.ps1
```

The launcher reads the verified installation marker and invokes the detected
`C:\CARLA\CARLA_0.9.16\CarlaUE4.exe`, from its own folder. Confirm that the
world renders and server listens before starting the Python tick owner.

```powershell
.\.venv-carla\Scripts\python.exe -m backend.carla.preflight
.\.venv-carla\Scripts\python.exe -m backend.server --carla
```

Preflight requires exact client/server version agreement and checks `get_world()`,
current map/frame, available maps and vehicle blueprints. It does not spawn or tick.
Stop the dashboard-only backend before reusing port 8000. Alternatively use
`--port 8002 --websocket-port 8003` and open http://127.0.0.1:8002/.
Focus the dashboard for W/A/S/D/Space and observe the actual vehicle in CARLA.
Do not run another synchronous tick owner during Gate 1. Ctrl+C cleans owned actors.

## Development and evaluation performance profiles

Development launcher: `-quality-level=Low -windowed -ResX=1280 -ResY=720
-carla-rpc-port=2000`. One ego, no traffic, walkers or sensors during Gate 1.
No benchmark/artificial-time flags or no-rendering mode are used. The
[rendering documentation](https://carla.readthedocs.io/en/0.9.16/adv_rendering_options/)
supports Low/Epic quality; no-rendering mode would remove required camera output.

Final evaluation is separate and **deferred until native validation**. The
launcher rejects `-Profile Evaluation` until a validated profile exists. Later
freeze map/version, graphics, physics step, seed and each sensor's FOV, resolution,
range/rate in experiment metadata. Reduced development sensor resolution must
not silently become the calibration/evaluation configuration. Measure this GPU
before enabling additional actors or cameras; settings do not prove fidelity.

## Reused provider and telemetry architecture

Browser SimulationClient → WebSocket/HTTP → SimulationService → SimulationProvider
→ CarlaProvider → matching CARLA Python API → native vehicle/world.

One `vehicle.lincoln.mkz_2020` ego is requested on the current map. Missing
blueprint or occupied spawn is an explicit error; the native catalog is still
unverified. No map catalog or 0.10.0 map assumption is hardcoded. World loading
is optional and must use a name returned by native preflight.

W throttle, S brake then reverse after stopping, A/D steer, Space handbrake.
The generic input convention is positive left; the CARLA adapter converts it to
native positive right. The displayed steer is applied native input, not tire angle.
Native spectator follows the ego; cockpit/hood/interior inspection follows Gate 1.

### Telemetry classification for 0.9.16

| Measurement | Classification | Current handling |
| --- | --- | --- |
| Transform/position/rotation/velocity/acceleration/angular velocity | NATIVE | One ActorSnapshot from a WorldSnapshot; native frame/time |
| Speed magnitude / signed forward speed | DERIVABLE | Norm of native velocity / dot with native forward vector |
| Longitudinal acceleration | DERIVABLE | Native acceleration dotted with native forward vector |
| Throttle/brake/steer/gear/reverse/handbrake | NATIVE | Applied `Vehicle.get_control()` |
| Current engine RPM | NATIVE API | 0.9.16 `get_telemetry_data().engine_rpm`; mapping/validation pending after Gate 1; currently null |
| Per-wheel slip/omega/load/forces/friction | NATIVE API | WheelTelemetryData available; units and mapping must be validated after Gate 1 |
| Wheel steering angle | NATIVE API | `get_wheel_steer_angle()`; not yet mapped/validated |
| Wheel RPM | DERIVABLE once native omega is validated | `omega * 60 / (2*pi)` if radians/second is confirmed; no fabricated animation |
| Suspension compression / engine-running state | NOT AVAILABLE in current adapter | Null/unmapped; no estimate advertised as physical telemetry |
| Fuel/consumption/range | NOT AVAILABLE | No functional fuel model mapped; no decorative values |
| Detailed engine/cooling/transmission/wheel structural damage | NOT AVAILABLE at requested fidelity | No BeamNG-style mechanical damage or invented health |
| Collision actor/normal impulse/frame/time | NATIVE sensor | Activation/validation after Gate 1 |
| Exact collision contact point | NOT AVAILABLE in event | Sensor/ego transform is not a contact coordinate |

The tagged [VehicleTelemetryData source](https://github.com/carla-simulator/carla/blob/0.9.16/LibCarla/source/carla/rpc/VehicleTelemetryData.h)
and [WheelTelemetryData source](https://github.com/carla-simulator/carla/blob/0.9.16/LibCarla/source/carla/rpc/WheelTelemetryData.h)
define native RPM and wheel fields. Their presence is not a live validation claim.
Wheel bone pitch is a visual angle, not an angular velocity reading.

The generated API documentation has inconsistent angular-velocity unit labels.
The tagged [WorldObserver.cpp](https://github.com/carla-simulator/carla/blob/0.9.16/Unreal/CarlaUE4/Plugins/Carla/Source/Carla/Sensor/WorldObserver.cpp)
emits degrees/second. The adapter preserves raw `angularVelocityWorldDegps` and
normalizes `angularVelocityWorldRadps = raw * pi / 180`; validate native signs/units
during Gate 1. No fuel or damage is inferred from RPM or enum names.

### Clock, disconnect, cleanup and recording

The existing worker remains the sole synchronous tick owner: fixed step 0.05 s,
physics substep 0.01 s, maximum 10 substeps. Existing synchronous ownership is
rejected. See [synchronous timestep requirements](https://carla.readthedocs.io/en/0.9.16/adv_synchrony_timestep/).
ActorSnapshot motion is frame-matched; applied controls follow the native tick.

Controls expire after 350 ms; browser blur/hide/disconnect releases throttle and
applies brake. Observations older than 750 ms are rejected. A disconnected/error
state hides measurements and disables commands; there is no mock fallback.
Browser reconnect uses bounded backoff and does not replay prior controls.
Native server failure stops the worker and attempts cleanup. Restart the backend
explicitly after native recovery; automatic respawn is not implemented.

Owned sensors are destroyed before the ego, then spectator/world settings are
restored. Unrelated actors are preserved. If CARLA has died, cleanup cannot be
confirmed until it returns. Reconnection and cleanup have offline contract tests;
Gate 1 requires their actual native verification too.

The generic FrameRecorder preserves frame/time, ego state/control and sensor
references. It groups only matching frame IDs and lists missing/mismatched frames.
Native RGB/depth/point-cloud file exporters and dataset generation remain deferred.

## Sensors: API audit only, no activation yet

The [0.9.16 sensor reference](https://carla.readthedocs.io/en/0.9.16/ref_sensors/)
lists RGB/depth, ray-cast LiDAR, radar, IMU, GNSS and collision; semantic/instance
segmentation and lane invasion are available optional blueprints. The existing
CarlaSensorManager owns registration, callbacks, transform/frame/timestamp/rate
metadata and cleanup. **No suite is mounted or decoded in production yet.**

After vehicle/collision validation, implement real RGB frames in the preserved
front-camera panel. Decode depth in meters, LiDAR x/y/z/intensity, radar
depth/azimuth/altitude/velocity, IMU accelerometer/gyroscope/compass and GNSS
latitude/longitude/altitude plus world transform. Sensor frames must be matched
to simulation frames or explicitly marked stale/missing. Simulator ground truth
must remain separate from future AI predictions.

## Gate ledger and acceptance checks

| Gate | Required native evidence | Result |
| --- | --- | --- |
| 1 | Install/boot/render/listen/connect, one ego, browser W/A/D/S, live telemetry, reconnect and actor cleanup | BLOCKED: Python 3.12 dependency; native tests not run |
| 2 | Normal acceleration/braking/reverse/handbrake, physical wheel/body/contact/curb/slope behavior and collision sensing | NOT RUN |
| 3 | Calibrated RGB/depth/radar/LiDAR/IMU/GNSS/collision, frame/time tracking | NOT RUN |
| 4 | Stable built-in urban map, deterministic normal traffic and navigable walkers | DEFERRED |

Gate 1: preflight the native catalog; start exactly one ego. Verify W increases
native speed, A/D turn the real wheels/vehicle, S decreases speed before reverse,
Space brakes, and telemetry carries CARLA frame/time and applied controls.
Verify blur/disconnect stops commands, browser reconnect resumes fresh input,
backend shutdown removes the owned ego, and restarting creates only one actor.
Record this evidence before committing a Gate 1 checkpoint.

Gate 2: compare stopping distances at multiple speeds and observe actual wheels,
body movement, road/curb/slope contact. Attach collision sensing and record low/
high-speed barrier, side and rear vehicle impacts with frame/time/other actor/
impulse/ego state. Do not label unavailable component damage as physical damage.

Gate 3: compare depth to known visible surfaces at 5/10/20/30 m and report error;
validate radar stationary/approaching/receding returns and sign convention,
repeatable static LiDAR points, hard acceleration/braking/turning IMU, GNSS/world
transform and real RGB camera mounting. SDK-fixture tests do not calibrate sensors.

Gate 4: inspect native maps first, choose an urban development map, seed normal
Traffic Manager behavior and walker navigation, then verify lanes/signals/spacing/
sidewalk travel. Egypt plan, custom vehicle workflows and extra camera modes are
deferred until preceding gates; no full Cairo map is built during this blocker.

## Offline verification and checkpoint scope

```powershell
npm test
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
npm run test:legacy
.\.venv\Scripts\python.exe -m unittest discover -s legacy/threejs-simulator/tests -p 'test_*.py'
```

Preparation tests cover runtime/version guards, actual ZIP-layout/wheel metadata
inspection, connection/world loading, vehicle ownership/control/cleanup, snapshot
units, sensor callbacks/cleanup, recording frame separation, WebSocket controller
ownership and dashboard stale/source checks. Archived simulator tests remain
separate. Verified this migration: **36 production Python tests, 8 dashboard
JavaScript tests, 33 archived JavaScript tests and 6 archived Python API tests
passed (83 total)**. Both PowerShell scripts parsed successfully. `-InspectOnly`
successfully inspected the real official package. Normal preparation, preflight
and native-backend startup correctly returned nonzero with the missing Python
3.12 blocker, leaving the game and `.venv-carla` uninstalled. Browser inspection
confirmed the 0.9.16 label, disconnected state, disabled controls and unavailable
telemetry/sensors; the Debug panel distinguishes native API availability from
pending validation. No blocked installer was executed.

A version-preparation commit is not a native Gate 1/2/3/4 checkpoint.

## Files changed in this version preparation

- `.gitignore`, `README.md`
- `backend/carla/target.py`, `connection.py`, `preflight.py`, `provider.py`, `telemetry.py`
- `backend/server.py`
- `frontend/telemetry.js`, `index.html`
- `scripts/inspect_carla_package.py`, `prepare_carla.ps1`, `launch_carla.ps1`
- `tests/test_carla_package.py`, `test_carla_provider.py`, `dashboard.test.js`
- `docs/CARLA_MIGRATION.md`, `docs/CARLA_0916_MIGRATION.md`
- `legacy/carla-0100-preparation/README.md`, `CARLA_MIGRATION.md`, `prepare_carla.ps1`

Generic simulation service, WebSocket transport, control implementation,
recording abstraction and sensor manager were reused without rewriting them.
Download manifests/wheel caches remain outside Git under `C:\CARLA\downloads\`;
the dashboard verification image is in the ignored `output/` folder.
