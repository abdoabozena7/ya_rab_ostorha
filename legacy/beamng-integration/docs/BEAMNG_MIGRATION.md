# BeamNG migration — preparation checkpoint

## Status

**BEAMNG BLOCKER.** Architecture preparation is complete. BeamNG.tech is not installed in the checked locations, and no `tech.key` or official package was found. No real vehicle was launched, controlled, or physically validated. Checkpoints 1–4 remain open.

BeamNG.tech owns the rendered game, environment, physics, drivetrain, damage, cameras, sensors and simulation clock. The web application owns controls, custom HUD, telemetry and debug tools. It has no production renderer, local vehicle physics, mock fallback, or world synchronization.

```text
Browser dashboard / keyboard
           ↕ HTTP + WebSocket
Python server → single SDK worker → BeamNGpy → licensed BeamNG.tech
           ↑ cached native telemetry + independently timestamped sensor frames
```

## Audit and migration plan

The entire application source, backend, tests, configuration, asset metadata and existing audit were inspected before this migration. The initial Three.js foundation audit is preserved in [the historical report](../legacy/threejs-simulator/docs/PHASE_1_FOUNDATION.md). Its dual-world proposal is superseded by this document.

| System | Existing implementation | New production responsibility |
| --- | --- | --- |
| Rendering/environment | Three.js 0.152, procedural Egyptian city and GLBs | BeamNG renders its native world; old city archived |
| Vehicle/wheels/steering | Fixed 60 Hz scalar/bicycle approximations and procedural wheel/interior meshes | BeamNG physical vehicle and visible wheel state |
| Acceleration/brakes/fuel/engine | Simplified browser equations and development estimates | BeamNG drivetrain/electrics; measured derivatives only |
| Collision/damage | Swept clearance, rejected motion, estimated component damage | Native contacts, soft-body deformation and native damage |
| NPCs | Kinematic lane follower, approximate wheel animation | Deferred native normal traffic; default count zero |
| Pedestrians | GLB animations and sidewalk targets | Archived; native capabilities need investigation later |
| Cameras | Browser chase/cockpit/hood and scene render target | BeamNG camera modes; real sensor RGB displayed separately |
| Sensors | Seven geometry rays and projected labels; prepared SDK adapters | BeamNG sensors; prepared suite disabled for checkpoint 1 |
| Frontend/backend | Browser owned simulation, HTTP received browser observations | WebSocket sends pedals; SDK worker supplies authoritative telemetry |
| Physical fidelity | No rigid/soft-body vehicle solver in the browser | BeamNG alone; live executable not yet available |

Plan executed incrementally: preserve previous state, establish a legacy boundary, reuse application styling/transport, switch the default entry point, make the first scenario minimal, test disconnected behavior, document the licensed dependency. No map, traffic, pedestrian, AI or chaos development was continued.

## REUSED / ARCHIVED / REPLACED

| Classification | Files / components |
| --- | --- |
| REUSED | `frontend/styles.css` moved from the existing CSS; title, colors, Free Drive, Phone/Route/Debug, speed/gear, camera card, minimap concept and button styling |
| REUSED | `frontend/telemetry.js`, WebSocket adapter in `frontend/beamng-provider.js`, Python telemetry mapper, SDK provider, worker and transport |
| ARCHIVED | `legacy/threejs-simulator/src/`: entire Three.js scene, car/interior, physics estimates, traffic, pedestrian, route follower, proximity rays and game loop |
| ARCHIVED | Prior page, README, historical docs/screenshots, JS tests and browser-observation API tests under `legacy/threejs-simulator/` |
| ARCHIVED | GLBs and their licenses remain at `assets/` and `public/assets/` so the archived page can reference the same files; production loads none of them |
| REPLACED | Root `index.html` now loads only `frontend/dashboard.js`; no Three.js import map or duplicate ego/world rendering |
| REPLACED | Production `/api/state` and `/api/frame` read BeamNG state/camera only; browser-written legacy observations moved to opt-in `/api/legacy/` |
| REPLACED | Mock/default startup with disconnected dashboard startup; explicit BeamNG configuration is required for controls |

The old working state is also preserved in commit `e51bfb3` on `codex/threejs-simulator-archive`. Migration work is on `codex/beamng-control-center`. A preparation commit is **not** a passed live checkpoint.

Phone opens session information. Route opens a notice for future BeamNG road integration. The minimap region currently shows native position/heading when available, with unavailable road geometry clearly labeled. These controls do not invoke the archived route AI or display the old city's roads as BeamNG geometry.

## Phase A: availability and legitimate installation

Checked project configuration, `BEAMNG`/`BNG` environment variables, Windows installed-program registry entries, running processes, Program Files, the usual Steam location, Downloads, Desktop, Documents, Local AppData and `C:\BeamNG.tech` / `C:\BeamNG`. Only the C: physical drive was present. No installer/package, executable or key was found in those searches; this is not a claim that every folder on disk was exhaustively searched.

The [official installation guide](https://documentation.beamng.com/beamng_tech/install/) directs users to acquire a license and extract the supplied archive. The [official support page](https://www.beamng.tech/support/) says approval supplies download instructions and a license key. The inspected public route provides no unauthenticated installer download. No account application or licensing message was submitted.

For eligible academic/research access, use the [official registration route](https://register.beamng.tech/). Commercial access is arranged through BeamNG's support/licensing contacts. Complete any required registration/authentication yourself, then provide the approved files' **local paths**.

### Exactly what to provide

1. The absolute local path to your official BeamNG.tech archive/installer, for example `C:\Users\LAPSHOP\Downloads\BeamNG.tech.<version>.zip`.
2. The absolute local path to the supplied, licensed `tech.key`, for example `C:\Users\LAPSHOP\Downloads\tech.key`. Do not paste its contents or commit it.
3. The desired installation directory, recommended `C:\BeamNG.tech`, and the supplied build version.

If already extracted, provide its installation folder instead of the archive. With the recommended folder, the required files are:

```text
C:\BeamNG.tech\Bin64\BeamNG.tech.x64.exe
C:\BeamNG.tech\tech.key
```

The key belongs in the **installation directory**, not the user directory. Presence/nonempty checks cannot validate a license: startup additionally requires the SDK's native `tech_enabled` result to be true. The SDK is given the explicit `.tech` binary and will not select `.drive` as a substitute.

### Version compatibility

The existing environment and requirements are pinned to the previously audited **BeamNGpy 1.34.1 / BeamNG.tech 0.37** pair. The official table checked on 2026-10-06 also lists **0.39 / 1.36** and **0.38 / 1.35.1**. When the actual package is provided, match and audit the SDK before launching a different build. Do not assume the installed Python package works with every simulator version.

## Running now: disconnected dashboard

From the project directory:

```powershell
.\.venv\Scripts\python.exe -m backend.server
```

Open `http://127.0.0.1:8000/`. It must show **BEAMNG NOT AVAILABLE**, unavailable speed/RPM/gear/sensors, and disabled driving/reset/pause controls. Starting this server is not launching BeamNG. The prepared `.venv` contains BeamNGpy and WebSockets; fresh environments can use:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements-beamng.txt
```

## Command to continue after the licensed installation is supplied

After confirming SDK/build compatibility, stop the dashboard-only server and run:

```powershell
.\.venv\Scripts\python.exe -m backend.server --beamng-home 'C:\BeamNG.tech' --beamng-user 'C:\BeamNG.user' --traffic-count 0
```

BeamNGpy launches the actual BeamNG window, creates one ETK800 on West Coast USA, attaches State/Electrics/Damage/Timer, starts the scenario and selects realistic automatic shifting. The scenario location is prepared from the existing SDK example and still needs live placement validation. The default suite intentionally excludes traffic and GPU/advanced sensors. Python is the launcher; no second browser scene exists.

For a correctly configured existing instance, add `--beamng-connect` and ensure its BeamNGpy server listens on port 25252. This mode attaches without terminating that user's BeamNG process on shutdown. HTTP uses 8000; telemetry/control WebSocket uses 8001. Bind defaults to localhost.

### Controls and connection behavior

- Focus the dashboard for W/A/S/D. Observe the physical car in the BeamNG window, ideally beside the dashboard/on another display. Clicking BeamNG takes keyboard focus away from the web controls.
- W sends throttle. A/D send native steering. S brakes forward motion; after stopping and holding S for 300 ms it requests reverse and sends throttle. W brakes reverse motion before requesting forward. Reverse direction threshold is 0.35 m/s.
- Transmission selector prepares D/N/R commands; neutral does not apply throttle. Space sends handbrake and braking. No steering/tire/engine simulation runs in JavaScript.
- Blur, hidden tab, disconnect and stale telemetry clear keyboard state. A new key press is required after restoring focus/connection. Do not retain a held W key across reconnection.
- Browser commands require fresh telemetry and controller ownership. One WebSocket connection owns controls; additional dashboards are read only. HTTP controls/reset respect that ownership.
- The backend releases throttle and requests braking after 350 ms without commands. A blocking SDK call or unreachable simulator can delay/prevent physical delivery; this is not a guarantee that a stopped process can brake a car.
- WebSocket/status reconnection uses bounded backoff, without replaying stored throttle. A closed/restarted native simulator currently requires relaunching the backend; it is not automatically respawned or reset.

## Telemetry: source and limits

No live values currently come from physics on this device. With the executable connected, the mapper uses native State/Electrics/Damage/Timer for position, velocity, forward/up orientation vectors, signed longitudinal speed, steering-wheel angle, pedals, RPM, gear, engine-running state, fuel volume/capacity where provided, and aggregate/raw damage. Acceleration and fuel consumption are explicitly derived from consecutive **simulator-time** samples.

Missing fields remain null. A quaternion may be unavailable while native orientation vectors are present. Road-wheel angle, individual wheel RPM/compression/slip, component damage, collision impulse, physics tick and physics rate are not yet mapped. The application does not invent them. The debug panel distinguishes steering-wheel angle from road-wheel angle, raw SDK damage from percentages, and sensor poll rates from acquisition/physics rates.

## Preserved sensor preparation — not live validated

The existing Python `SensorManager` remains prepared, disabled for checkpoint 1. After checkpoint 1 and physics validation, the optional `--enable-sensors --sensor-config backend/sensors.example.json` switches it on for supervised validation. It is not evidence of a passed sensor checkpoint.

| Sensor | Prepared output | Open validation |
| --- | --- | --- |
| Front RGB / depth | One native mounted Camera; 480×270 RGB JPEG and full precision depth array | Mount/FOV/latency; depth is normalized buffer, not calibrated metres |
| Radar | Native range, azimuth/elevation, Doppler, RCS/SNR/weight | Range and velocity sign; object ID unavailable unless simulator supplies it |
| Roof LiDAR | Native x/y/z point cloud, intensity only when supplied | Transform, static-object consistency and timestamps |
| IMU | Native buffered acceleration, angular velocity, orientation basis | Axes, gravity convention, braking/turning response |
| GPS | Native buffered world X/Y, virtual latitude/longitude | Origin and heading/velocity association |
| Ultrasonic / powertrain | Preserved native adapters | Capability/field mapping and live performance |

Sensor metadata preserves ID/name, vehicle-relative position/direction/up, requested rate, FOV/range where applicable, sensor timestamp if supplied, simulator time at polling and local receipt time. Camera RGB and depth share a poll; other sensors are asynchronous. A polling-time stamp is never substituted for an absent acquisition timestamp. Camera UI uses the real JPEG endpoint and its paired headers, with no synthetic boxes. No point-cloud or radar data is fabricated.

## Validation and checkpoint gates

### Offline checks

```powershell
npm test
.\.venv\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
npm run test:legacy
.\.venv\Scripts\python.exe -m unittest discover -s legacy/threejs-simulator/tests -p 'test_*.py'
```

These validate API separation, absent-installation behavior, source/freshness gating, command expiry/ownership, pedal-to-gear policy, SDK sensor argument compatibility, telemetry normalization and archive preservation. Unit fixtures are used only inside tests. They do not satisfy native acceptance criteria.

Verification on this device: **7 application JavaScript tests, 29 Python tests, 33 archived JavaScript tests and 6 archived API tests passed.** Browser inspection confirmed the disconnected dashboard, disabled controls and functional Phone/Route/Debug panels. A browser timer-binding error found during inspection was repaired and the page reloaded successfully. The missing-installation CLI exits with `BEAMNG BLOCKER` before opening a simulation connection.

### Checkpoint 1 — OPEN, blocked by licensed executable

1. Supply and install the matching licensed package/key. Launch with the continuation command above.
2. Confirm BeamNG's own `.tech` license indication and one physical ETK800 with no traffic.
3. Open the dashboard. Confirm **BEAMNG CONNECTED** and native timestamps/position/RPM/gear.
4. Focus the dashboard and hold W. Observe the real BeamNG car accelerate and its wheels turn while speed/RPM change in the application.
5. Test A/D, S braking then reverse, N/R/D, blur release, pause/reset, stale telemetry, disconnect and reconnect. Confirm controls never switch to archived physics.
6. Record build, SDK, vehicle config and evidence. Commit the passed milestone only after these live steps succeed.

### Checkpoint 2 — OPEN, depends on checkpoint 1

Validate wheel speed vs measured travel/radius at several speeds; steering-wheel/front-wheel correspondence; stop distance from several initial speeds; pitch/compression under acceleration/braking; RPM/gear/tire behavior; load-dependent fuel use. Perform controlled front/rear/side/wheel/high-speed impacts in BeamNG. Capture raw damage and actual behavior/deformation, then map supported components without invented health. Existing individual wheel/component telemetry gaps must be resolved before claiming those tests passed.

### Checkpoint 3 — OPEN, depends on physics validation

Enable the sensor suite. Verify the front camera mount/FOV and timestamp. Place targets at known distances (including 10 m) and calibrate depth against known geometry. Check radar with stationary, approaching and receding targets. Check stable LiDAR returns against static surfaces. Verify IMU axes during acceleration/braking/turning and GPS/world positions. Preserve separate acquisition timestamps and document units/sign conventions. Sensor agreement/calibration cannot be tested without the executable.

### Checkpoint 4 and later — DEFERRED

Only after vehicle and sensors pass: evaluate BeamNG World Editor/native road tools, OpenDRIVE/OSM and licensed static assets for an Egyptian urban map, then normal traffic and pedestrian support. Investigate pedestrian limitations before proposing extensions. Separate browser dashboard is the current presentation mode; overlay/BeamNG UI-app options can be investigated later. No AI driving, detection, risk decisions, chaos, scenario randomization or RL is implemented by this migration.

## Files changed

- `index.html`, `package.json`, `.gitignore`, `README.md`: production entry point, test commands, ignored key/user data and run instructions.
- `frontend/{provider,beamng-provider,controls,dashboard,telemetry}.js`, `frontend/{styles,dashboard}.css`: reused visual identity, application transport, controls and telemetry.
- `backend/{installation,server,beamng_provider,simulation_service,telemetry,websocket_bridge}.py`: dependency/license gates, minimal startup, isolated APIs and freshness/ownership safety.
- `tests/dashboard.test.js`, `tests/test_{api,installation,beamng_provider,simulation_service,websocket_bridge}.py`: application boundary tests.
- `legacy/threejs-simulator/`: preserved source/page/tests/documentation; imports and legacy observation URLs adjusted for isolation. Historical reports are marked superseded.
- `docs/BEAMNG_MIGRATION.md`: current migration status, installation dependency and all remaining gates.
