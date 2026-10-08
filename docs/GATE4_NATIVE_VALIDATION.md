# Gate 4 — Normal living city

Validation date: 8 October 2026, Africa/Cairo. **GATE 4: PASS**, based on the native endurance, population/lifecycle, settings/navigation, recording and offline Replay evidence below. This report never substitutes unit tests for native evidence.

## Verified installation and scope

CARLA server/Python API **0.9.16 / 0.9.16**, Python **3.12.10 x64**. Installation: `C:\CARLA\CARLA_0.9.16`; executable: `C:\CARLA\CARLA_0.9.16\CarlaUE4.exe`. Native map: `Carla/Maps/Town10HD_Opt`; ego: `vehicle.lincoln.mkz_2020`. The dashboard uses HTTP 8000, WebSocket 8001, CARLA RPC 2000 and Traffic Manager 8050.

GPU: **NVIDIA GeForce RTX 3060 Laptop GPU, 6144 MiB VRAM**. Windows detects **16 GiB installed RAM**, two 8 GiB modules, versus the user's reported 32 GB. Measurements belong to the detected machine; obsolete Quadro assumptions are not used.

Ego driving is manual. Native Traffic Manager controls NPC vehicles, and CARLA's native walker controllers control pedestrians. There is no AI model, autonomous ego admission, deliberate dangerous behavior, chaos, Egyptian environment or Three.js simulator dependency.

## Stability evidence

The required first run preceded population activation. It used one ego, seven native sensors, the actual browser dashboard and telemetry, recording disabled. A shorter recording run followed before expansion.

| Run | Wall duration | Median actual ticks/s | New incomplete / sensor issues | Largest WebSocket gap |
|---|---:|---:|---:|---:|
| Baseline, recording off | 1200.000 s | 18.049 | 0 / 0 | 0.094 s |
| Baseline, recording on | 120.063 s | 17.405 | 0 / 0 | 0.094 s |

Baseline private memory medians, excluding warm-up: backend **684.295 → 684.031 MiB**, peak 689.625; CARLA **9449.457 → 9449.402 MiB**, peak 9449.531. VRAM remained **5884 MiB**. Actor inventory remained **one vehicle, seven sensors, zero walkers/controllers**. RGB/depth and four other periodic callbacks remained around 18 Hz wall rate; collision is event-driven and has no periodic rate.

Recording follow-up private memory: backend **684.703 → 685.574 MiB**, CARLA **9452.348 → 9449.605 MiB**. No new synchronization issues or accumulation of sensor actors occurred. Its actual run is `runs/normal_city/run_c02c6bcaaf16419f9a788a6b46b1b05d`, 2649 frames over 132.400 simulation seconds; recording started before the monitor and stopped after it.

Evidence: `output/native-validation/gate4-stability-20min.json`, corresponding JSONL samples, and `gate4-stability-recording-2min.json`. Startup/reconfiguration missing frames are retained in cumulative diagnostics; the table reports **new issues during each measured interval**.

An additional **1200.000 s** run with **25 NPC vehicles / 25 pedestrians** passed: **20,265 newly completed synchronized frames**, zero new incomplete/missing/late/duplicate/out-of-order frames, **16.897 actual ticks/s**, periodic sensor wall medians **16.855 Hz**, 15,106 WebSocket messages and maximum gap **0.141 s**. Native inventory stayed at 26 total vehicles (one ego plus 25 NPCs), 25 walkers and seven sensors; controllers varied 24–25 briefly during native removal/replacement and ended at 25. Evidence: `output/native-validation/gate4-city-stability-20min.json` and JSONL samples.

Warm private-memory medians: backend **721.471 → 726.180 MiB**, peak **731.719**; CARLA **9613.619 → 9714.313 MiB**, peak **9714.609**. CARLA grew during material/cache warming and native replacements, then plateaued near 9714.3 MiB in the final four minutes. Backend memory fluctuated rather than growing monotonically. This interval shows no actor/sensor accumulation or unbounded growth; it does not establish indefinite stability or zero memory growth. Whole-GPU VRAM was **5641–5852 MiB**. Mean CPU utilization normalized to the whole machine was **9.40% backend / 16.69% CARLA**.

The final population was 25/25; native Traffic Manager removed **11 cars**, and native navigation removed **11 walkers** during this run. Bounded replacement restored the requested population and retained seven sensor actors. These counters are visible in the dashboard, not hidden as perfect traffic behavior.

## Performance matrix and profiles

All rows used the real running backend, seven sensor actors, 60 steady wall seconds per population, a fixed 0.05 s simulation step, Low/DX12/RenderOffScreen at 1280×720, aligned 800×450 RGB/depth and JPEG quality 95. The observer never owned ticks or issued VehicleControl directly.

| Requested NPC / walkers | Actual at end | Median ticks/s | Periodic sensor wall Hz | VRAM MiB | New incomplete / issues |
|---|---|---:|---|---|---|
| 0 / 0 | 0 / 0 | 18.049 | 17.991–18.057 | 5716–5719 | 0 / 0 |
| 10 / 10 | 10 / 10 | 17.314 | 17.31–17.37 | 5796 | 0 / 0 |
| 25 / 25 | 25 / 25 | 16.203 | 16.205 | 5812 | 0 / 0 |
| 50 / 25 | 50 / 25 | 17.359 | 17.37–17.44 | 5812–5818 | 0 / 0 |
| 50 / 50 | 50 / 50 | 17.408 | 17.374 | 5818 | 0 / 0 |

Backend step median / p95 in the same row order: **0/16, 15/16, 16/16, 16/32, 31/32 ms**. These measure backend step duration, not browser round-trip latency or renderer FPS. The measured WebSocket maximum gap stayed at or below 0.11 s across the matrix.

**Renderer FPS is unavailable**, not inferred from simulation ticks. Sensor simulation frequency is 20 Hz; wall time runs more slowly when the machine cannot maintain that rate. Matrix wall rates are not monotonic because traffic-light/world state and native scheduling differ; these short rows are not guarantees of long-term performance.

Measured profiles are stored in `config/normal-city-profiles.json`: LIGHT **10/10**, BALANCED **25/25**, DENSE **50/50**. Eligibility required no new synchronization issues and at least 85% of baseline throughput. **BALANCED** is recommended to preserve population headroom; DENSE is an explicit experiment rather than the automatic default. Connecting starts with **zero population**, regardless of saved preferences.

Evidence: `output/native-validation/gate4-city-acceptance.json` contains sensor-specific rates, backend latency, process memory, movement distances, configuration and all lifecycle checks. All rows passed; this is the authoritative successful matrix, distinct from preserved failed diagnostic attempts.

## Normal behavior and lifecycle

Traffic uses passenger blueprints from the installed library, native road spawn points, full physics, three-metre reference following distance, automatic lane changes disabled and zero percent intentional ignoring of vehicles, walkers, lights or signs. Speed mapping is explicit: SLOW **30% below** road speed limit, NORMAL **15% below**, FAST **0% below**. These are TM desired-speed modifiers, not arbitrary absolute/random speeds.

All sampled walkers moved more than two metres. In the dense row, 49/50 sampled traffic vehicles moved; one remained blocked. Native behavior probes observed vehicles stopped at red signals with brake 1/throttle 0 and no sampled pedestrians occupying a driving lane. These samples verify ordinary behavior, not collision-free behavior everywhere.

The native matrix observed one removed walker during 25/25 and one removed TM car during 50/50. These are exposed rather than hidden. Authoritative absence in two successive native snapshots prunes stale SDK actor descriptions; only the missing count is replaced, at a valid position at least 45 metres from the ego, with a minimum five simulation seconds between replenishment attempts.

Pedestrians use native sidewalk/navmesh positions, an extra 1.25-metre road-edge buffer, zero crossing factor, same-sidewalk destinations, varying 0.9–1.9 m/s walking speed and staggered starts. Destination changes on arrival or prolonged lack of position progress use the native controller and never teleport existing pedestrians. Native walker velocity can report zero despite position motion; the raw value remains available, and movement validation uses position changes.

Live lifecycle checks passed: incremental 10→5 retains remaining NPC IDs; respawn replaces owned NPC/walker IDs; clear traffic and pedestrians leaves zero actors of each population type; population-only changes retain ego/seven sensor IDs. Vehicle/spawn reset cleans population, old ego and sensors before restoring one ego and seven sensors.

Managed world reset passed after retiring the old Windows SDK process and restarting CARLA. The new session starts paused, without population. Disconnect left **zero project vehicles/walkers/controllers/sensors**, and reconnect restored **one ego/seven sensors**, paused. Evidence: `output/native-validation/gate4-reset.json` and managed runtime tickets in `output/native-runtime`.

## Settings, camera and navigation acceptance

`output/native-validation/gate4-settings.json` records the following native checks:

- Toyota Prius/Spawn 01 and Lincoln/Spawn 153 selections really changed actor/blueprint/transform and cleaned the previous populations/sensors.
- The five views front/hood/chase/rear/top reuse the RGB/depth actors and preserve aligned transforms. Switching creates no new sensor/callback. Vehicle change and world reset restore the native cameras.
- ClearNoon, CloudyNoon and HardRainNoon match the actual CARLA weather parameters. Native presets also apply their deposit, wind, fog and scattering parameters.
- 10/20 Hz changes set the actual fixed delta to 0.1/0.05 s and recreate seven sensors with matching rates. Higher development rates are intentionally unavailable on this measured hardware.
- List and map destinations produce ordered official GlobalRoutePlanner waypoints from the live ego. Saved places contain map ID, name and world transform; another map's saved location is rejected. Route selection does not apply throttle. Autonomous start is rejected live.
- Debug actor radius 100 m returns native actor IDs/types, distance, ego-relative position and raw velocity. Traffic-light state is simulator ground truth, reported when CARLA marks it relevant to the ego; distance is to its actor origin, not a stopping-distance estimate.
- Seeded normal scenes A (10/10/clear), B (25/25/cloudy), C (50/50/rain) produced the requested actual counts and retained all seven sensors.

The complete visible-settings audit is in [NORMAL_CITY_OPERATION.md](NORMAL_CITY_OPERATION.md). Vehicle, spawn, weather, camera and population controls are LIVE on explicit apply; sensitive sensor/timing changes require the ego to stop. Graphics are NEXT-LAUNCH with a separate verified restart button. Enlarge and debug/performance displays are DISPLAY-ONLY. Renderer FPS is explicitly NOT IMPLEMENTED. No visible control silently pretends to change CARLA.

The existing Arabic RTL dashboard retains a dark grey/blue theme and native RGB workspace. Browser checks covered desktop and small layout, 800×450 intrinsic camera dimensions, no horizontal overflow and actual 25/25 counters. Temporary viewport overrides were removed. Screenshot evidence: `output/native-validation/gate4-dashboard-dark.png`, `gate4-dashboard-small.png`.

## Recorder and Replay

The populated native run is **`runs/normal_city/run_d252d723675c461bbdf42725c31b3259`**: **4981 frames**, **249.000 simulation seconds**, **7724.43 MiB** on disk. Native metadata identifies server/API 0.9.16, Town10HD_Opt, Lincoln ego, 25 NPCs/25 walkers, actual launch/camera settings and population seed 42. The existing Recorder stores canonical telemetry, controls, population and nearby ground truth with separate RGB/depth/LiDAR assets.

The run contains 899 MANUAL and 4082 SAFETY command frames. Actual vehicle telemetry reached **19.604 km/h**, throttle/brake **1.0**, steering **−1.0 to +1.0**, reverse and handbrake states, and maximum displacement **15.882 m**. Browser keyboard and held on-screen inputs used the existing safety/arbitrator/provider path. Typing `wasd` in destination search did not move the paused vehicle; Escape closed the phone. No autonomous ego command source appeared.

There are **420 collision callback events**, all contact with the same native Ford Crown NPC actor 463, across frames 38147–39866; these represent repeated contact, **not 420 distinct crashes**. Largest impulse was **1866.35 N·s**. No collision was deliberately scripted. This ordinary TM limitation remains in the raw data, canonical event stream and Recorder rather than being erased or converted into fictional component damage.

The steady recording follow-up passed **120.062 wall seconds**, 1395 new complete frames, zero new synchronization issues, maximum WebSocket gap **0.125 s**, median **11.888 actual ticks/s**, periodic sensor wall medians **11.925 Hz**, VRAM **5788 MiB** and constant 26 vehicles/25 walkers/25 controllers/seven sensors. Private-memory medians: backend **706.758 → 711.434 MiB**, CARLA **9649.418 → 9649.605 MiB**. Recording slows wall throughput; 20 simulation Hz does not promise real-time 20 Hz while writing these assets. Evidence: `gate4-city-recording-verified.json` and `gate4-recording-summary.json` in `output/native-validation`.

**Replay PASS with CARLA stopped and RPC 2000 closed.** Telemetry and real JPEGs from frames 37084/37085 replayed; recorded population was 25/25; canonical nearby ground truth retained the same frame ID. Duplicate/late/out-of-order/missing packet checks used actual recorded packets. Production Replay WebSocket rejected `start_driving`, `reconnect` and throttle commands, with paused telemetry unchanged. The real browser displayed **REPLAY — تسجيل حقيقي**, recorded RGB and 25/25 counts, disabled driving and no CARLA CONNECTED claim. Evidence: `gate4-replay.json`, `gate4-replay-dashboard.json`, `gate4-replay-dashboard.png`. Replay continues to read old recordings and does not construct a native client.

After recording, disconnect left zero project actors, then the Windows SDK backend retired and the engine stopped. Native launch after Replay restored one ego/seven sensors in PAUSED state. Population was applied explicitly again. Post-fix GUI route selection kept native connection availability, zero throttle and all seven sensor actors while producing CARLA_ROAD_GRAPH/MANUAL_GUIDANCE: `gate4-recording-cleanup.json` and `gate4-route-availability.json`.

## Tests and reproduction

Python regression: **115 passes / one inapplicable offline-API-absence skip** (116 total, CARLA is installed). JavaScript: **21 passes**. Ownership rejection, coarse Windows admission-clock pacing and read-only manual route actions have focused regressions. These checks cover contracts, cleanup/admission and offline boundaries; native acceptance comes from the above scripts and real CARLA observations.

```powershell
# Existing real backend, no second tick owner:
.\.venv-carla\Scripts\python.exe -m scripts.native.verify_normal_city --duration 60
.\.venv-carla\Scripts\python.exe -m scripts.native.verify_city_settings
# No other long-lived read-only SDK clients may span the engine restart:
.\.venv-carla\Scripts\python.exe -m scripts.native.verify_city_reset
# Actual browser must own the session; collector is an observer:
.\.venv-carla\Scripts\python.exe -m scripts.native.stability_run --duration 1200
# CARLA stopped, using the actual populated run path:
.\.venv-carla\Scripts\python.exe -m scripts.native.verify_replay <run> --require-population --output output/native-validation/gate4-replay.json
```

## Problems corrected and remaining CARLA limits

Live testing exposed stale SDK actor references after native removals, walker navmesh crossings despite zero crossing factor, delayed GPU callbacks during population changes, preset weather applied before it became observable, and a reconnect transition attempted before the first native frame. The implementation now uses authoritative native snapshots, constrained sidewalk destinations, a bounded 0.5 s synchronization wait, next-tick settings verification, and paused reconnect only after the first validated observation. Manual command expiry stays **350 ms**, independently of the sensor wait.

Buffered keyboard samples also exposed a coarse Windows monotonic-clock boundary: a single sleep could return before the existing safety interval elapsed. The bridge now rechecks the safety clock within a bounded wait; it still runs every admission/range/freshness check. Native browser W/A/D/S/Space and held on-screen pedals produced actual CARLA control states and vehicle movement after the correction. Manual route status explains that the user drives; read-only route/place/debug/recording operations no longer falsely declare native actor reconfiguration.

A recording monitor interrupted by a destination action in the older backend reported native unavailability during the unnecessary reconfiguration flag. That failed monitor is retained as `gate4-city-recording-final.json`; the uninterrupted recording monitor and post-fix GUI route-availability proof above are the successful evidence. A separate route observer expired before the GUI action and was rerun with a sufficient observation window. Neither failed attempt is used as a native PASS.

An earlier in-process world reload caused a DX12 `DXGI_ERROR_DEVICE_REMOVED / DEVICE_RESET` crash. Current reset uses full managed SDK-process retirement before engine restart, with native post-launch validation. A cold startup timeout also rolled back safely; connection/supervisor startup limits were increased to accommodate world initialization. Failed attempts remain in local diagnostic artifacts and are not reported as passed runs.

TM is ordinary simulator traffic, not a guarantee that collisions never occur. Native TM can remove blocked vehicles, and native walker navigation can remove actors/controllers. These behaviors are documented in [official Traffic Manager documentation](https://carla.readthedocs.io/en/0.9.16/adv_traffic_manager/), [ALSM source](https://github.com/carla-simulator/carla/blob/0.9.16/LibCarla/source/carla/trafficmanager/ALSM.cpp) and [WalkerNavigation source](https://github.com/carla-simulator/carla/blob/0.9.16/LibCarla/source/carla/client/detail/WalkerNavigation.cpp). Seeds improve repeatability; native navigation scheduling and changing world state prevent an unconditional bitwise determinism guarantee.

Low is the measured profile. The earlier Epic/1920×1080 attempt failed startup and rolled back; it is not certified by this Gate 4 matrix. All recorded VRAM values are whole-GPU usage including the desktop/browser, not a fictitious CARLA-only allocation.

## Checkpoint and next phase

Native acceptance checklist: **all passed** — initial 20-minute endurance; real traffic/walkers and actual dashboard counts; population and ego/sensor cleanup; real blueprint/spawn/weather/fixed-delta settings; stable five-view cameras; official topology/manual route visualization; seven native sensors after population; real recording/offline Replay; and clean reset/reconnect. No Three.js runtime dependency returned.

Checkpoint commit message: **`Complete Gate 4 with verified native normal city`**. The commit containing this report is the checkpoint; its SHA is returned in the handoff. A compact tracked evidence manifest preserves native summaries and hashes; large run/sensor/screenshot artifacts remain local under ignored `runs`/`output` directories.

Changed implementation: `backend/carla/{population,routes,ground_truth,provider,dashboard_tools,sensors,connection,runtime,restart_helper}.py`; `backend/core/{contracts,dashboard,service}.py`; `backend/{server,websocket_bridge}.py`; `frontend/{dashboard,dashboard-tools,simulation-client,appearance}.js`, `frontend/dashboard.css`, `index.html`; measured population profiles; native verification scripts and regression tests. Documentation includes this report, the normal-city operation guide, README, historical validation scope notices and local font attribution/licenses.

Stop after Gate 4. The next recommended work is a user-selected review of the normal-city baseline and recording/performance tradeoffs before approving another phase. No Egyptian environment, perception/RL/avoidance model or chaos work starts automatically.
