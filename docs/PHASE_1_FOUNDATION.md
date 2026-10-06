# Phase 1 foundation: audit and open acceptance gates

**Phase 1 is not finished.** This device has no licensed BeamNG.tech installation. None of the fifteen physical acceptance tests has been passed against BeamNG. Repository test results do not replace those physical tests.

## 1. Audit before modifying

| System | Already working | Approximation / missing system |
| --- | --- | --- |
| Rendering | Three.js 0.152, Egyptian low-poly district, procedural sedan, licensed GLBs, HUD/minimap | Mesh rendering has no general rigid/soft body physics |
| Ego vehicle | Fixed 60 Hz stepping, scalar speed and bicycle steering | No full mass, tire or suspension force solver |
| Wheels | Four ego wheel pivots with front steering | Spin previously integrated in renderer; traffic wheels merged into body meshes |
| Steering | Speed/grip limits, wheelbase yaw, reverse response | No measured tire slip or alignment |
| Acceleration/braking | Pedals, coast resistance, surface grip, reverse delay | Simplified longitudinal model without authoritative drivetrain |
| Collision | Swept actor clearance, road boundaries and static AABB rejection | Rejected motion rather than physical impulse resolution; no component deformation |
| NPC traffic | Lane paths, signals, following, speed changes and turns | Kinematic motion; no drivetrain/contact solver |
| Pedestrians | Walk/idle GLB clips and sidewalk targets | Random crossings, endpoint teleporting, abrupt facing and unsafe skeleton cloning |
| Cameras | Chase and mounted front camera with cached 20 Hz render target | Browser scene view rather than physical backend sensor; cockpit incomplete |
| Sensors | Seven geometric proximity rays and projected scene labels | No physical depth/LiDAR/radar/IMU/GPS |
| Powertrain/fuel | Speed, gear and fuel HUD | Decorative gear/fuel approximations, no complete telemetry state |
| Architecture | Browser owns simulation; Python HTTP server receives observations | No authoritative backend control/telemetry stream |
| Environment | Static buildings, collision envelopes and road conditions | Cones/props/barriers have no mass, restitution or friction solver |

No complete rigid body vehicle simulation existed in the repository. The existing clock, braking equations and bicycle steering remain useful development approximations.

The short implementation plan was: preserve working rendering/UI; introduce providers and telemetry; bind wheels/dashboard to that state; add BeamNG server/sensors; register the two worlds; validate with live measurements. The last two stages remain open.

## 2. What was replaced or improved

- Added browser `SimulationProvider`, explicit `DevelopmentMockProvider`, and a WebSocket `BeamNGProvider`. A BeamNG connection failure displays unavailable telemetry and never substitutes mock physics.
- Added a Python BeamNGpy provider, SensorManager, telemetry mapper and single SDK worker. HTTP reads cached observations. One WebSocket connection owns control; others are read only. Missing commands release throttle and request braking after 350 ms. A blocked SDK call can delay delivery; live latency must be measured.
- Bound speed, gear, fuel, pedals and Debug to provider telemetry. Missing values remain null/unavailable. BeamNG aggregate damage stays in SDK units, without invented component percentages.
- Bound ego wheel angles/RPM to fixed-step provider state. Development angular velocity is `v / 0.35`, and rendered front/steering-wheel angles share the steering state. Rejected motion stops wheel spin.
- Added explicitly estimated development RPM/gears, load-dependent fuel and component damage. Fixed accumulating engine temperature and empty-tank reverse power. These are development estimates, not replacements for BeamNG dynamics.
- Corrected geometry merging to exclude parent world transforms, preventing attached parts from receiving the vehicle's world position twice.
- Added driver-seat cockpit, hood and front-sensor camera modes. The solid exterior shell is hidden only for the cockpit render pass. Added simple seats, steering wheel and telemetry instruments to the existing procedural car. Mirrors remain decorative landmarks.
- Preserved named wheel parts in traffic assets. Development wheel spin uses distance travelled divided by radius; front steering follows turn curvature. `microbus.glb`, `motorcycle.glb` and fallback traffic still need independently moving wheel parts. Traffic motion remains kinematic in development mode.
- Fixed pedestrian skeleton cloning, smooth turns, sidewalk turnarounds and short idle stops. Disabled random crossings, incident controls and cinematic time scaling for this phase. Richer shop/group/crossing navigation remains open.
- Preserved the project title, Free Drive, Phone/Route/Debug, front camera panel, speed/gear, minimap, driving controls and Egyptian visual style. Added source/availability diagnostics within those panels.

The previous route follower remains available in development mode. No new AI/perception policy or scenario generator was added.

## 3. What now comes from real physics

**Today on this device: no live BeamNG observations.** Development mode is explicitly labelled and unvalidated.

With a compatible licensed BeamNG.tech build running, BeamNG owns the tires, mass, drivetrain, suspension, fuel, contact and deformation. The adapter reads actual world state, electrics, RPM, gear, steering wheel angle, fuel volume/capacity and raw/aggregate damage. Acceleration and fuel flow are derived from successive simulator velocity/fuel samples using simulator time.

Road wheel steering angle is different from steering wheel angle. Individual wheel speed/angle, suspension compression, collision impulse and component damage remain unavailable until a verified vehicle-specific telemetry mapping is added. Raw damage and powertrain data are preserved for that work. The browser does not invent these readings.

## 4. Sensors

| Sensor | Adapter output | Remaining work |
| --- | --- | --- |
| Front RGB | Mounted BeamNG Camera, 480×270 JPEG in existing panel | Live mount/FOV/latency validation |
| Depth | Full precision array from same Camera poll | Normalized 0–1 buffer is not calibrated metres |
| Roof LiDAR | `{x,y,z}` world point cloud; configurable channels, range, horizontal/vertical FOV and frequency | Mount/repeatability validation; intensity only if supplied |
| Radar | Range m, Doppler m/s, azimuth/elevation rad, RCS, SNR, optional weight | Sign/range calibration; no promised object ID |
| IMU | Buffered acceleration/angular velocity/orientation axes with each sample's time | Axis/timing calibration; configured without gravity |
| GPS | Buffered world X/Y and SDK latitude/longitude with sample times | Virtual geographic origin is not Cairo geolocation |
| Ultrasonic | Raw physical sensor poll plus mounted transform metadata | Range/occlusion calibration and measurement normalization |
| Powertrain | Raw simulator samples | Vehicle-specific interpretation |
| Collision sensor | Unavailable; raw Damage is separate | Measured impulse, direction/location and component mapping |

Sensor envelopes include position, forward/up vectors, transform frame, requested rate, FOV/range, acquisition time when supplied, scenario time at poll and monotonic receipt time. Those clocks are distinct. Missing acquisition time is never replaced with a guessed time. JPEG headers identify the exact cached frame's timestamps. Measured polling frequency is not physics FPS or necessarily acquisition FPS. IMU/GPS retain individual buffered sample times.

Development mode provides mounted browser RGB and geometric proximity references, with no fabricated depth/radar/LiDAR/IMU/GPS. Debug camera labels show development class/ID and distance to the actor origin. They are approximate scene geometry, not BeamNG observations or AI predictions. BeamNG ground truth object overlays and relative positions remain open.

## 5. Installing BeamNG.tech

BeamNGpy 1.34.1 and WebSockets have been installed in the project's `.venv`. The simulator itself is not installed because its licensed download and key are unavailable.

1. Apply for eligible academic/non-commercial access at [register.beamng.tech](https://register.beamng.tech/), or use commercial licensing contacts on [BeamNG support](https://www.beamng.tech/support/).
2. BeamNG supplies download instructions and `tech.key` after approval. Extract the official archive to a chosen installation folder and put the key in that folder, not the user folder. See the [official installation guide](https://documentation.beamng.com/beamng_tech/install/).
3. The pinned SDK's packaged compatibility table pairs **BeamNGpy 1.34.1 with BeamNG.tech 0.37**. Confirm the approved build. A different simulator version can require a matching SDK and another adapter audit; see [compatibility](https://github.com/BeamNG/BeamNGpy/blob/master/COMPATIBILITY.md).

No application, license acceptance or purchase was submitted for the user. Once the official ZIP and key exist locally, installation can proceed from their file paths.

## 6. How to run

Development mode, from this repository:

```powershell
python -m backend.server
```

Open `http://127.0.0.1:8000/`. WASD/arrows drive; S brakes then reverses; Space brakes. C cycles chase/cockpit/hood/front sensor. Debug displays telemetry. Existing Phone/Route behavior remains available.

Reproduce the optional Python environment:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements-beamng.txt
```

Stop the development server before starting BeamNG mode:

```powershell
.\.venv\Scripts\python.exe -m backend.server --beamng-home 'C:\BeamNG.tech' --beamng-user 'C:\BeamNG.user' --sensor-config backend/sensors.example.json
```

Open `http://127.0.0.1:8000/?provider=beamng`. Ports: HTTP 8000, WebSocket 8001, BeamNGpy 25252; command flags can change them. `--beamng-connect` attaches to a running simulator but loads the foundation scenario, so preserve current simulator work first. Closing an attached provider disconnects rather than shutting down that simulator.

This starts an ETK800 on `west_coast_usa` with five normal BeamNG traffic vehicles. `--traffic-count 0` isolates the ego car for tests. W accelerates, S brakes, A/D steer, Space applies parking brake; R reverse, N neutral, G drive. Pause/Reset send simulator commands. Browser route driving is disabled in this mode.

**The Egyptian city and minimap are an explicitly unregistered preview in BeamNG mode.** City actors/car are frozen. HUD/front RGB use BeamNG data. C changes preview cameras; BeamNG's window remains the authoritative vehicle/world visualization. Never compare preview geometry distances with BeamNG sensors. World/actor registration and authoritative pose/deformation rendering remain required work.

Sensor API:

```powershell
Invoke-RestMethod http://127.0.0.1:8000/api/simulation/status
Invoke-RestMethod http://127.0.0.1:8000/api/simulation/state
Invoke-RestMethod 'http://127.0.0.1:8000/api/simulation/sensor?name=lidarRoof'
Invoke-RestMethod 'http://127.0.0.1:8000/api/simulation/sensor?name=radarFront'
Invoke-WebRequest http://127.0.0.1:8000/api/simulation/camera.jpg -OutFile front.jpg
```

State returns a snapshot containing `vehicle`, sensor metadata/rates/errors and sequence. Sensor names: `frontCamera`, `lidarRoof`, `radarFront`, `imu`, `gps`, `ultrasonicFront`, `powertrain`. Point clouds are JSON arrays usable by Python. Missing backend returns 503. Older sensor frames retain receipt times and must be checked for age.

HTTP `POST /api/simulation/control` accepts validated throttle/brake/steering/parkingbrake/gear; refresh within 350 ms. It returns 409 while a browser owns control. A one-shot throttle command will expire. WebSocket commands: `{type:'controls', sequence, controls:{...}}`; snapshots acknowledge accepted sequences. Reset/pause: `{type:'reset'}` and `{type:'pause',paused:true}`.

## 7. What still needs work

- Licensed simulator installation and live compatibility checks.
- Egyptian collision map export, coordinate/actor registration and authoritative rendering/minimap.
- Verified individual wheel/suspension/alignment, component damage and collision telemetry.
- Metric depth and acquisition timing calibration, simulator ground truth object labels.
- Authoritative deformation/cameras, hollow cabin and reflective mirrors.
- Remaining traffic wheel assets; richer pedestrian destinations/groups; selected road props in the physical world. Browser props currently have no mass/restitution/friction simulation.
- All fifteen physical acceptance gates below.

## 8. Verify every acceptance test

Use one vehicle/build/configuration and a dry flat road for comparable runs. Save raw data with simulator times, build/config and video. Reset between destructive runs. Tolerances below are starting proposals, not measured results.

| Test | How to verify | Current gate |
| --- | --- | --- |
| 1 Wheel physics | Hold 10/30/60 km/h; compare individual wheel rad/s with speed/radius under low slip and integrated angle with travelled distance. Allow physical slip/contact effects | Development identity test passes; individual BeamNG wheels unavailable; live gate open |
| 2 Steering | Sweep steering at rest and 20/60 km/h; compare measured road wheel angle, model yaw and steering wheel including reverse; proposed visual mismatch <1° | Development binding implemented; real road wheel bridge pending |
| 3 Braking | Brake from 30/60/90 km/h on same surface/pedals; measure displacement from command to speed <0.1 m/s, repeat three times | Simplified tests pass; live distances unmeasured |
| 4 Suspension | Record four compression values and pitch/roll during hard acceleration/braking; confirm load transfer and recovery | Development pitch visual only; physical bridge pending |
| 5 Collision | Disable traffic and strike a barrier at documented speed; inspect measured position/direction/impulse, part damage and physical deformation | Development estimate only; collision extension/live test pending |
| 6 Engine | Compare idle, neutral throttle, drive shifts/reverse and dashboard RPM/load/gear with same-time electrics/powertrain | Mapping tested; live behavior pending |
| 7 Fuel | Compare actual litres over equal-duration idle/cruise/high-load runs; derive L/h; drain tank and verify zero power in both directions | Development load/empty-tank tests pass; real validation pending |
| 8 Camera | Survey mount/direction/up/FOV and project a landmark; read JPEG timestamp headers from the same frame | Adapter mounted; live transform/FOV test pending |
| 9 Depth | Calibrate depth buffer first; survey a flat target at 5/10/20 m and compare centre pixels; proposed max(0.1 m, 2%) | Metric conversion unavailable; gate open |
| 10 Radar | Follow a target at known relative speed; compare range and signed line-of-sight Doppler; proposed 0.5 m / 0.5 m/s | Seven-column contract tested; live calibration pending |
| 11 LiDAR | Capture a fixed wall over ten sweeps; compare transformed plane position/repeatability; proposed RMS <0.1 m | Serialization tested; live point cloud pending |
| 12 IMU | Brake from 50 km/h; compare longitudinal sensor acceleration with velocity derivative projected into the same axis/time/filter; proposed median error <0.5 m/s² | Buffered samples tested; live axes/timing pending |
| 13 Damage | Compare undamaged performance with severe front and wheel crashes; confirm actual power/cooling/alignment/failure changes | Raw damage exposed; component/live test pending |
| 14 NPC | Observe ten ordinary turns/stops/queue releases and wheel rotations; verify vehicle↔vehicle/environment contact, then matching registered browser actors | Development improvements/native traffic startup added; physical/world gate open |
| 15 Pedestrians | Observe five minutes of sidewalks, walk/idle, smooth turns, destinations/groups/crossing waits; no teleports/random crossings | Baseline fixes implemented; richer navigation/physical registration pending |

## 9. Files changed

| Files | Purpose |
| --- | --- |
| `src/simulation/provider.js`, `beamng-provider.js` | Common contract, development state, remote client |
| `backend/beamng_provider.py`, `telemetry.py`, `simulation_service.py`, `websocket_bridge.py` | Sensors, telemetry, worker and control transport |
| `backend/server.py`, `requirements-beamng.txt`, `sensors.example.json` | API, dependencies, configurable mounts/rates/range/FOV/channels |
| `src/main.js`, `index.html`, `src/ui/styles.css`, `src/ui/telemetry.js` | Provider binding and small diagnostics |
| `src/render/detailed-sedan.js`, `chase-camera.js`, `camera-labels.js` | Ego wheels/interior/cameras/development labels |
| `src/render/traffic-visuals.js`, `visual-assets.js`, `src/simulation/traffic.js` | Traffic wheel preservation and transform correction |
| `src/simulation/pedestrians.js` | Sidewalk movement/animation |
| `tests/provider.test.js`, `test_beamng_provider.py`, `test_simulation_service.py`, `test_websocket_bridge.py`, `test_api.py` | Provider/sensor/transport checks |
| `.gitignore`, `README.md`, this document | Environment exclusions and run/status report |

## 10. Verification performed

```powershell
npm test
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
node --check src/main.js
git diff --check
```

35 JavaScript and 21 Python tests passed in the installed environment. These cover SDK constructor signatures, depth precision/shape, radar columns, buffered timestamps, unavailable values, fuel/reverse, initial gear delivery, real loopback WebSocket ownership and release. They do not launch BeamNG or validate vehicle dynamics.

Browser checks cover the existing city/HUD, Debug telemetry, cockpit view and missing-BeamNG behavior. Render performance varies with hardware/load; measured render and sensor polling rates appear in Debug.

References: [BeamNGpy 1.34.1](https://documentation.beamng.com/api/beamngpy/v1.34.1/beamngpy.html), [BeamNG.tech sensors](https://documentation.beamng.com/beamng_tech/sensors/). API settings were audited against installed SDK source; the matching simulator still needs live validation.
