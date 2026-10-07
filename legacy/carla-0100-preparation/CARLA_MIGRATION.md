# CARLA migration: preparation complete, native gates blocked

Updated 7 October 2026. CARLA owns the rendered world, actors, physics and sensors.
The application owns the existing dashboard, control transport, observations and
experiment interfaces. Production has no Three.js renderer or mock physics.

## Status and short implementation plan

1. Audit the repository/machine and preserve the previous work — completed.
2. Obtain the official precompiled Windows package and a matching Python API — blocked.
3. Connect one ego vehicle, validate browser controls and native telemetry — prepared, not run.
4. Only after gate 1: validate physical vehicle behavior/collisions, then enable sensors.
5. Only after vehicle/sensor gates: normal traffic/walkers, then Egyptian environment planning.

No native migration gate or physics acceptance test has passed. Offline tests
exercise SDK contracts and safety; their fixtures are not a production simulator.

## Machine inspection

| Item | Observed |
| --- | --- |
| OS | Windows 11 Pro x64, build 26200 |
| CPU | Intel i7-9850H, 6 cores / 12 threads; Dell Precision 5540 |
| GPU | NVIDIA Quadro T1000, 4 GiB dedicated VRAM; Intel UHD 630 also present |
| NVIDIA driver | 581.95 |
| RAM | 31.73 GiB (32 GB installed) |
| C: free space before download | 185.92 GiB |
| Python | Project `.venv`: 3.13.5; system 3.13 and 3.14; no 3.12 |
| VC++ x64 runtime | Installed, 14.44.35211.00 |

The [official UE5 quick start](https://carla-ue5.readthedocs.io/en/latest/start_quickstart/)
requires Windows 11, Windows NVIDIA driver 560+, and 130 GB storage. Its GPU
recommendation is RTX 3000 or newer with at least 16 GB VRAM. OS, driver and
storage meet the listed conditions; this 4 GB T1000 is substantially below the
GPU recommendation. This is a compatibility/performance risk, not a verified
native boot failure. No GPU test has been run.

## Exact installation blocker

**CARLA BLOCKER: no supported Python client runtime installed.**

The official [0.10.0 release](https://github.com/carla-simulator/carla/releases/tag/0.10.0)
supports Python 3.8–3.12. The existing 3.13 environment cannot be used for its
Windows API wheel. Automatic approval review rejected executing the official
Python 3.12 installer with the stated reason **“blocked by policy.”** No installer
was executed and no alternative execution method was attempted.

Downloaded from Python.org:

`C:\CARLA\downloads\python-3.12.10-amd64.exe` — 26,964,224 bytes;
Authenticode **Valid**, signer **Python Software Foundation**.
The [official Python release page](https://www.python.org/downloads/release/python-31210/)
identifies this Windows installer. Install **Python 3.12 x64 manually**, then
verify `py -3.12 --version`. The expected default executable is
`C:\Users\LAPSHOP\AppData\Local\Programs\Python\Python312\python.exe`.
If a different folder is chosen, register it with the Python launcher or provide
that executable path. No CARLA license key is required.

CARLA's official Windows package returned HTTP 200 with range support:

[Official Windows ZIP](https://downloads.carlasim.com/Windows/Carla-0.10.0-Win64-Shipping.zip)
— observed package length **10,203,028,286 bytes**.

The partial download was stopped at the runtime dependency and preserved:

`C:\CARLA\downloads\Carla-0.10.0-Win64-Shipping.zip.part` — **185,249,792 bytes**.

**CARLA is not installed.** Intended extraction directory:
`C:\CARLA\CARLA_0.10.0\`. The simulator executable, shipped Python API and
rendered world have not been inspected locally because extraction has not happened.

After installing Python 3.12, from the repository root:

```powershell
py -3.12 --version
.\scripts\prepare_carla.ps1
```

The prepared script resumes only the official package, checks download length,
extracts into a clean directory, and installs **only its shipped 0.10.0 cp312
Windows x64 wheel** in `.venv-carla`. It does not install Python, compile Unreal,
install a random PyPI CARLA version, or claim native validation. If the archive
layout/wheel differs, it stops with the exact missing dependency. The script has
been syntax checked; download/extraction/API installation remain unexecuted.

## Repository audit and migration boundary

The earlier complete audit is retained in the Three.js archive under
`docs/PHASE_1_FOUNDATION.md`; its proposed BeamNG/two-world route is superseded.
The browser world used Three.js 0.152, procedural meshes and licensed GLBs.
Vehicle speed/yaw followed a local longitudinal/bicycle model. Wheels used
distance/radius rotation in the development provider; suspension/body pitch and
powertrain were approximations. Collision envelopes rejected/swept motion rather
than resolving a full rigid body contact system. NPC lane following and walking
animations were useful visual systems, not authoritative vehicle/pedestrian
physics. Cameras and geometric proximity/labels came from the browser scene.
The frontend originally owned motion and posted observations to Python.

| Disposition | Source/components |
| --- | --- |
| ARCHIVED | `legacy/threejs-simulator/`: Egyptian world, vehicle, wheels, traffic, walkers, browser camera/proximity and development dynamics |
| ARCHIVED | `legacy/beamng-integration/`: BeamNG provider, installation/license checks, telemetry/sensor adapters, previous dashboard/client and migration notes |
| ARCHIVED checkpoint | BeamNG full state: branch `codex/beamng-migration-archive`, commit `7a6a777`; Three.js snapshot: `codex/threejs-simulator-archive`, commit `e51bfb3` |
| REUSED | HUD/CSS/branding, Phone/Route/Debug, camera panel, position/minimap concept, D/N/R controls, exclusive WebSocket controller and generic HTTP endpoints |
| REUSED | Simulator-independent transport/control tests; original model assets and license notices |
| REPLACED | Active provider/transport source, BeamNG electrics/damage adapters and sensor polling clock with CARLA native API/snapshots/callback contract |
| PREPARED | Small JSONL recording interface; the prior project had no production dataset pipeline |

Archived files are reference material. To run the exact old BeamNG state, use
its archive branch; it is not an alternate provider in today's production app.
The Three.js historical preview is opt-in and mutually exclusive with CARLA:

```powershell
.\.venv\Scripts\python.exe -m backend.server --port 8002 --enable-legacy-preview
# http://127.0.0.1:8002/legacy/threejs-simulator/
```

## Application architecture

Browser `SimulationClient` → WebSocket/HTTP → `SimulationService` → generic
`SimulationProvider` contract → `CarlaProvider` → matching native CARLA Python API.

`backend/carla/` separates connection, world ownership, vehicle spawning,
control conversion, snapshot telemetry and sensor ownership. No native CARLA
classes cross the browser boundary. Initial scene uses the simulator's current
map and one explicit `vehicle.lincoln.mkz_2020` blueprint; missing blueprint or
occupied spawn point is an error, not a silent substitute.

Initial controls: W throttle, S brake then reverse after stopping, A/D steer,
Space handbrake, D/N/R selector. The input convention is positive **left**;
the adapter maps it to CARLA's positive **right** native control. The dashboard
reports CARLA's applied input, not an invented physical steering angle.

The native spectator follows the ego car in the CARLA window. Other views,
interior quality and mirrors require native inspection later. The browser has
no game canvas. CSS/layout is preserved; unavailable mechanical gauges were
replaced in place with native version/map/frame/reverse fields.

### Timing, disconnect and ownership

- One SDK worker and one native synchronous tick owner; default fixed delta 0.05 s.
- Existing synchronous ownership is rejected, not taken over.
- Vehicle motion uses the native `ActorSnapshot` from a single `WorldSnapshot`.
- Sensor callbacks preserve native frame, timestamp, mounting/world transforms
  and requested interval. Metadata marks whether a sensor frame matches the ego frame.
- Commands expire after 350 ms; blur/hide/socket loss release pedals and apply brake.
- Observations older than 750 ms are rejected by the browser; backend stale/error
  snapshots hide values and reject commands.
- Browser reconnect attempts have bounded backoff and never replay old controls.
  Native server failure stops the worker and attempts owned-actor cleanup. Restart
  the backend explicitly after recovery; automatic native respawn is deferred.
- Shutdown destroys owned sensors before the ego vehicle, restores spectator and
  world settings, and reports cleanup errors. Unrelated actors are not destroyed.
  If CARLA itself has died, cleanup cannot be confirmed until the server is restarted.
- `FrameRecorder` groups only matching frame IDs and explicitly lists missing or
  mismatched sensor frames. RGB/depth/point-cloud file exporters are deferred.

## Trustworthy telemetry classification

Based on the [CARLA UE5 Python API](https://carla-ue5.readthedocs.io/en/latest/python_api/).
API availability is not a claim that this machine's native tests have passed.

| Measurement | Classification | Handling |
| --- | --- | --- |
| Position/rotation/velocity/acceleration/angular velocity | NATIVE | Snapshot values; angular velocity converted degrees/s → radians/s |
| Signed longitudinal speed/acceleration | DERIVABLE | `dot(native vector, native forward vector)`; magnitude speed is Euclidean norm |
| Steering/pedals/reverse/handbrake/actual gear | NATIVE | `Vehicle.get_control()` from last native tick |
| Engine torque/idle/max RPM and gearbox ratios | NATIVE configuration | Physics parameters, not current engine readings; not dashboard telemetry |
| Current engine RPM/engine running state | NOT AVAILABLE in current adapter | No supported instantaneous reading mapped; null, no decorative estimate |
| Fuel level/consumption/range | NOT AVAILABLE | No functional fuel model mapped; null |
| Detailed engine/cooling/transmission/wheel damage/deformation | NOT AVAILABLE at requested fidelity | No BeamNG-style damage reconstruction; no health gauges |
| Vehicle failure state | NATIVE limited | Docs say only rollover is implemented; Engine/TirePuncture enum names do not prove implemented mechanics; not yet mapped |
| Physical per-wheel steering angle | NATIVE API, not yet mapped | `get_wheel_steer_angle()` returns degrees; validate after gate 1 |
| Wheel RPM/slip/suspension compression | NOT AVAILABLE in current adapter | Rendered native physics must be inspected; no fabricated per-wheel telemetry |
| Collision actor/normal impulse/frame/time | NATIVE sensor, pending activation | Planned `sensor.other.collision`; transform does not equal contact point |
| Exact collision contact position | NOT AVAILABLE from collision event | Do not relabel the sensor transform as a contact coordinate |

## Sensor activation gate

`CarlaSensorManager` currently implements native registration, callback metadata,
timestamps/rates and cleanup. **No suite is enabled and no sensor decoder has
been validated**. The front panel is preserved and deliberately empty. Required
later blueprints: RGB/depth cameras, ray-cast LiDAR, radar, IMU, GNSS and collision.
Semantic/instance/lane sensors remain optional later work.

When gate 1 passes, add each native decoder incrementally. Preserve depth as
metric data, radar depth/azimuth/altitude/velocity, LiDAR x/y/z/intensity, IMU
accelerometer/gyroscope/compass, GNSS lat/lon/alt plus native world coordinates.
Keep simulator ground truth separate from future AI estimates. No AI is present
in the production application.

## How to run after the dependency is resolved

1. Complete the prepared package/API installation above.
2. Launch `C:\CARLA\CARLA_0.10.0\CarlaUnreal.exe` from its folder. For the first
   hardware check, optionally try `-quality-level=Low -windowed -ResX=1280 -ResY=720`.
   Confirm Unreal renders and TCP ports 2000/2001 are listening. Failure on this
   4 GB GPU is a blocker to diagnose, not permission for a silent simulator swap.
3. Before starting the backend, run its read-only native preflight:

```powershell
.\.venv-carla\Scripts\python.exe -m backend.carla.preflight
```

It checks exact client/server version agreement, `get_world()`, map/frame,
available maps and vehicle blueprints. It does not spawn actors or tick the world.

4. Start the one-vehicle application:

Stop the dashboard-only backend before reusing port 8000. If keeping that preview
running, add `--port 8002 --websocket-port 8003` and open port 8002 instead.

```powershell
.\.venv-carla\Scripts\python.exe -m backend.server --carla
# optional --spawn-index N, --map MAP, --fixed-delta 0.05
# optional --record-log recordings\frames.jsonl (create parent folder first)
```

5. Open http://127.0.0.1:8000/ and focus the dashboard for W/A/S/D/Space.
   Observe the actual car in CARLA. Closing with Ctrl+C cleans owned actors.
   Do not run CARLA manual_control/generate_traffic or another tick owner during gate 1.

Dashboard-only preview works now using `.\.venv\Scripts\python.exe -m backend.server`.
It displays **CARLA — DISCONNECTED** and no measurements.

## Gate ledger and acceptance procedure

| Gate | Required live evidence | Current result |
| --- | --- | --- |
| 1 | Package installed, Unreal renders/listens, matching Python API connects, one ego spawned, browser W/A/D/S moves the real car, native telemetry updates | BLOCKED — no install/API/native boot |
| 2 | Acceleration/braking/reverse/handbrake, actual wheel steer/spin/body/road/slope/curb response; controlled low/high barrier, side and rear collisions with native impulse/frame/actor; no duplicate game | NOT RUN; browser duplicate renderer already removed |
| 3 | RGB/depth/radar/LiDAR/IMU/GNSS/collision all native and frame tracked | NOT RUN; no suite enabled |
| 4 | Stable urban map, deterministic normal Traffic Manager vehicles and navigable walkers | DEFERRED until prior gates |

For gate 1 log native frame/time, position, rotation, velocity, acceleration,
angular velocity and applied controls/gear. Verify W increases real speed,
A/D steering signs match, S reduces speed before reverse, blur releases throttle,
and backend exit removes the owned vehicle. Test disconnect/reconnect without
replaying throttle. Commit a gate checkpoint only after this evidence exists.

For gate 2 compare stopping distances at multiple initial speeds, inspect wheel
contact/body motion/slopes/curbs in CARLA, and capture each controlled collision's
real impulse. Report detailed mechanical damage as unavailable.

For gate 3 calibrate camera optical-frame geometry at 5/10/20/30 m against an
object surface (not its center); save depth error. Validate radar stationary,
approaching and receding returns with its documented velocity convention. Check
repeatable LiDAR returns, acceleration/braking/turning IMU, GNSS plus world
transform, and native collision events. Do not claim calibrated sensors from
SDK-fixture tests alone.

For gate 4 inspect available maps before choosing the urban map, then seed normal
traffic/walker navigation and validate spacing/signals/sidewalk travel. Cairo map
research, `EGYPT_ENVIRONMENT_PLAN.md`, custom vehicles and additional driving
cameras follow these gates; they are intentionally not built during this blocker.

## Offline tests and checkpoint scope

```powershell
npm test
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
npm run test:legacy
.\.venv\Scripts\python.exe -m unittest discover -s legacy/threejs-simulator/tests -p 'test_*.py'
```

Connection/version/runtime guards, vehicle ownership/spawning, native control
signs/gear mapping, world ticking/restoration, snapshot units, sensor callback
metadata/cleanup, recording frame separation, WebSocket ownership, TTL/staleness
and dashboard source rejection are tested offline. These are preparation tests.
The preparation commit is not Checkpoint 1, 2, 3 or 4.

Current verification: **33 production Python tests, 8 dashboard JavaScript tests,
33 archived JavaScript tests and 6 archived API tests passed**. The PowerShell
preparation script parsed successfully; native startup under the current Python
3.13 environment correctly exits with a CARLA BLOCKER. Browser inspection confirms
the CARLA disconnected label, disabled controls, unavailable gauges and debug
limitations. No native install/boot/physics/sensor results are included in these counts.
