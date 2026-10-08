# CARLA dashboard native validation — 8 October 2026

The approved dashboard plan is implemented on the existing application core.
Native keyboard/pointer controls, explicit conventional destination navigation,
settings, actor lifecycle, sensor synchronization, recording and engine-off Replay
were exercised against CARLA. Epic startup failed and rolled back; its one-minute
quality benchmark did not pass. OS-specific input checks listed below remain open.

## Native installation and final session

| Item | Observed value |
| --- | --- |
| Server / Python API | 0.9.16 / 0.9.16, exact equality required |
| Installation | C:\CARLA\CARLA_0.9.16 |
| Launcher | C:\CARLA\CARLA_0.9.16\CarlaUE4.exe |
| Engine executable | C:\CARLA\CARLA_0.9.16\CarlaUE4\Binaries\Win64\CarlaUE4-Win64-Shipping.exe |
| Python | Project .venv-carla, Python 3.12.10 x64 |
| Map | Carla/Maps/Town10HD_Opt |
| Ego | vehicle.lincoln.mkz_2020; actor ID retained in final-state evidence |
| Actual launch | Low, DX12, 1280×720, RenderOffScreen |
| Camera | 800×450, 90° FOV, JPEG 95, RGB postprocessing/motion blur/bloom off |
| World step | Synchronous, 0.05 s = 20 simulation Hz |
| Final state | One ego, seven attached sensors, PAUSED, zero speed, safety brake |
| Hardware | RTX 3060 Laptop GPU, 6144 MiB VRAM; Windows detects 16 GiB RAM, user reports 32 GB |

The Quadro notes remain obsolete. Native connection confirms world/map, blueprint
library, Traffic Manager availability and matching versions. Traffic Manager is
configured consistently with synchronous mode, but no traffic actors are created.
Local evidence: `output/native-validation/dashboard-v2-final-state.json`.

## Gates and live checks

Gates 1, 2 and 3 remain **PASS from the real 7 October measurements** in
[LIVE_NATIVE_VALIDATION.md](LIVE_NATIVE_VALIDATION.md). This report adds the
approved dashboard/navigation work; it does not relabel unit tests as native gates.

| Check | Native evidence/result |
| --- | --- |
| Real keyboard and held dashboard buttons | 502 captured samples; peak 14.8667 km/h, throttle/brake 1, steer −1/+1, reverse and handbrake true; dashboard-v2-browser-controls-extended.json |
| Writing in search | Arabic/Latin WASD text left throttle 0 and the vehicle stopped; dashboard-v2-ui-proof.json |
| Explicit route selection | Preview left the car stationary; all 155 valid native spawn destinations exposed, plus six anchors/two saved places; 1603 native road segments |
| Native map click | Vehicle marker selects a real Driving waypoint; remote map click rejects points beyond 10 m, clears old plan and disables automatic start |
| Straight and turning journeys | Actual arrival and stop on straight ~25 m route and ~119 m route containing a left turn; dashboard-v2-navigation.json |
| Manual intervention / emergency | NAVIGATION gives way to MANUAL; emergency acknowledgement never resumes the journey; full and short navigation proofs |
| Independent 350 ms lease | Pauses when browser heartbeat expires even while the controller could generate commands; dashboard-v2-navigation-short.json |
| Page closure while moving | Browser started real navigation, then closed; native vehicle stopped with brake 1, mode PAUSED, reason focus_lost, with no resumption; dashboard-v2-page-close-result.json |
| Controlled collision during navigation | Real static.prop.streetbarrier fixture produced a collision and cancelled navigation; impulse magnitude 4662.213 N·s in the recorded run; temporary fixture destroyed |
| Camera/settings/reset/reconnect | Existing native verify_dashboard passed five actual camera mounts, aligned camera changes, 10/20 Hz, vehicle replacement, full cleanup and one-ego/seven-sensor reconnect; dashboard-operations.json |
| New clean image profile | Applied from UI, confirmed via native settings and actual 800×450 image; final-state.json and UI proof |
| Phone/settings usability | ×, backdrop and Escape close both; native current-position origin, searchable groups, persisted favorite point 136 |
| Responsive UI | 390×844 and 800×900 viewport overrides at existing browser zoom, no horizontal overflow; camera precedes controls at mobile width; overrides reset afterward |
| Fresh browser console | No error entries on final tab |

`output/native-validation/dashboard-v2-ui-proof.json` stores the browser checks.
Final desktop/mobile/Replay screenshots are `dashboard-v2-final.png`,
`dashboard-v2-mobile.png` and `dashboard-v2-replay.png` in the same folder.

## Control architecture and measured limits

Manual path: Browser → WebSocket → ControlSafetyLayer → CommandArbiter →
CarlaProvider → carla.VehicleControl → native ego. Physical event.code is used,
not locale-dependent letters. Editable fields and open drawers cannot send pedals.

AUTOMATIC and NAVIGATION are independent of the disabled AI/ASSISTED modes.
The official installed BasicAgent 0.9.16 receives the entire deterministic native
route, disables random waypoint generation, and uses the actual fixed step for
PID controllers. Its output becomes a canonical NAVIGATION command admitted by
the existing safety layer and arbiter; there is no direct apply_control or
set_autopilot path from the agent. Manual messages keep their old compatibility
format. Buffered manual samples wait for the normal admission interval instead
of waiving the rate guard.

Default requested speed is 20 km/h, selectable 5–30. The controller target is the
lesser of the requested speed and CARLA's native road limit. A browser automatic
run peaked at 22.2242 km/h with a 20 km/h target. This is measured PID overshoot,
not a hard speed cap. Arrival requires an exhausted plan, distance ≤5 m and speed
<0.15 m/s; a plan ending elsewhere reports ERROR. Resume recalculates from the
new native location and requires another explicit start.

This experimental conventional controller does not guarantee safe handling of
every obstacle or stop sign. Its scope is defined by the
[official BasicAgent source](https://github.com/carla-simulator/carla/blob/0.9.16/PythonAPI/carla/agents/navigation/basic_agent.py).
No traffic population, pedestrians, Egyptian map, custom vehicles, chaos/scenarios,
YOLO, tracking, fusion, TTC model, RL or accident-avoidance model was added.
Three.js remains deleted.

## Telemetry, sensors and image diagnosis

Verified native telemetry includes frame_id, simulation timestamp, vehicle actor
ID, location x/y/z, pitch/yaw/roll, velocity x/y/z, acceleration x/y/z, angular
velocity, throttle, brake, steer, gear, reverse and handbrake. Speed magnitude is
derived as sqrt(vx²+vy²+vz²); km/h is magnitude×3.6. Signed longitudinal speed
is the native forward-vector projection and is labelled separately. Angular
velocity is converted from CARLA degrees/s to canonical radians/s; headings/Euler
angles are converted and retain their declared coordinate frames. RPM, fuel,
engine temperature and mechanical/component damage remain unavailable, not invented.

All seven attached native sensors were verified: RGB, Depth, Radar, LiDAR, IMU,
GNSS and event-driven Collision. Six periodic sensors reported approximately
20 Hz in simulation time, and matched RGB/depth/vehicle frame IDs were checked.
SensorSynchronizer remains the sole join point; missing startup frames are explicit,
not filled by unrelated frames. Sensors expose actor IDs, transforms, frame/time,
configured ticks and their latest real data. GNSS geographic values remain separate
from native world XYZ; radar measurements and LiDAR XYZ/intensity remain raw.

Latest same-frame raw RGB versus displayed JPEG95 comparison: stationary mean
absolute channel error **1.84377/255**, moving **1.80206/255**. The raw PNG is encoded
on diagnostic request, not on every sensor callback. Screenshot scaling can enlarge
the 800×450 native pixels. Low's rendering limits remain visible in the raw frame;
the JPEG comparison does not prove the renderer's visual quality is ideal.
[CARLA rendering reference](https://carla.readthedocs.io/en/0.9.16/adv_rendering_options/).

Historic numerical calibration is retained, not rerun or invented for this phase:

| Approximate depth target | Native surface distance | Decoded depth | Error |
| --- | --- | --- | --- |
| 5 m | 5.002893 m | 5.118669 m | +0.115775 m |
| 10 m | 10.005585 m | 10.118605 m | +0.113020 m |
| 20 m | 20.010963 m | 20.118298 m | +0.107334 m |
| 30 m | 30.016352 m | 30.117811 m | +0.101460 m |

Depth follows the packed native BGRA decoding formula; no RGB postprocessing
attributes are applied to depth. Radar historic stationary/approaching/receding
medians were −0.008040 / −3.004230 / +2.986340 m/s versus native radial velocities
0 / −2.999791 / +2.999791 m/s. Details and tolerances are in the original Gate 3
report. [Official sensor definitions](https://carla.readthedocs.io/en/0.9.16/ref_sensors/).

## Graphics restart and performance

Low/1280×720/DX12 RenderOffScreen passed a real restart, RGB/depth continued and
one ego plus all seven sensors returned stopped. On Windows, restarting Unreal
while an old libcarla process still exists can abort that interpreter. The restart
helper now waits for SDK process exit before retiring the verified engine process;
readiness is probed in disposable Python processes. Settings/sensor restoration
and rollback are managed by a new backend, not reused dead SDK handles.

Epic/1920×1080 actually attempted launch but returned no native world within 90 s.
The helper automatically restored the previously verified Low profile and tested
its sensor suite for five seconds. **Epic one-minute test: FAIL/unavailable due to
startup failure. Rollback: PASS native.** No unsupported VRAM-cause diagnosis is
asserted. Requested Epic/1920×1080 preferences remain saved separately; a regular
launch uses verified conservative defaults rather than activating them silently.
Evidence: dashboard-v2-low.json and dashboard-v2-epic-rollback.json.

| Metric | Actual observation |
| --- | --- |
| Rendering FPS | Unavailable; never substituted with simulation throughput |
| Fixed simulation frequency | 20 Hz (0.05 s) |
| Keyboard run throughput | Median 17.8991 native steps/s; six-sensor receipt rates ~17.8652/s |
| Browser journey throughput | Median 18.1020 steps/s; RGB/depth ~18.2532/s wall time |
| Recorded collision/navigation sample | 16.0819 steps/s; RGB/depth/radar/LiDAR receipts 16.21/16.15/16.26/16.26 per wall second |
| Paused native sample | 19.4959 steps/s; RGB/depth/radar/LiDAR 19.37/19.37/19.37/19.44 per wall second |
| VRAM | 5859 MiB in control/journey runs, 5862 MiB recording, 5884 MiB paused sample out of 6144 MiB |
| Backend CPU | 5.5 CPU seconds over 5.018 wall seconds, 6.85% of 16-logical-processor machine; short paused sample, not a benchmark |
| Backend working set | 235.55 MiB in that CPU sample |

Wall rates are based on actual unique frames/callback receipts; simulation rates
use native timestamps. Short rolling windows can transiently exceed 20 wall steps/s
after a slower tick. Do not interpret that as render FPS or a sustained speedup.
CPU evidence: dashboard-v2-cpu.json. Conservative settings remain recommended.

## Real recording and engine-off Replay

Run: `runs/dashboard_v2_20261008_live/run_ba0335c155e445f698708ff9969ac7d2`.
Metadata provenance REAL_SIMULATION, exact versions/map/ego/settings, no traffic.
1531 monotonic frames, 481066–482596, **76.500001 simulation seconds**.
1527 RGB JPEGs, 1528 depth assets, 1528 LiDAR assets; initial missing sensor frames
remain explicitly absent. Total **2,473,084,994 bytes (2473.08 decimal MB)**.
JSON contains asset references rather than duplicated binary arrays.

Telemetry control samples: SAFETY 1284, NAVIGATION 245, MANUAL 1; 256 ControlChanged
events include mode changes. One actual CollisionDetected event is recorded.
Sensor values, raw radar, IMU/GNSS, control commands and RGB/depth/LiDAR references
are stored by the existing Recorder. Summary: dashboard-v2-recording-summary.json.

After recording, native inspection confirmed **zero vehicle/sensor actors** and
synchronous_mode false. Then CARLA was actually stopped. Replay loaded the real
run, showed an 800×450 recorded image and telemetry, said REPLAY, never CONNECTED,
and rejected take_control/start_driving/start_journey/reconnect/manual controls.
No CARLA processes existed during this test. **Replay: PASS.** Evidence:
dashboard-v2-final-cleanup.json and dashboard-v2-replay.json. CARLA was subsequently
restarted and the final live one-ego/seven-sensor session confirmed.

## Regression, files and checkpoint

Latest project checks: **104 Python tests: 103 pass, 1 skip; 21 JavaScript pass**.
They cover navigation admission, heartbeat/session isolation, manual override,
emergency behavior, rejected-destination plan clearing, camera validation,
physical-key/editable-field policy, reconnect frame identity and replay isolation.
Native acceptance comes from the evidence above, not those policy tests.

Changed areas:

- backend/core contracts, control and service: modes/commands, leases, operation results, recording/performance.
- backend/carla provider, dashboard tools, sensor decoders/manager; new runtime/restart helper.
- backend/server and websocket bridge; pinned Shapely 2.1.2 dependency.
- index.html and frontend dashboard, destination/settings, input policy and simulation client.
- CARLA launcher, native dashboard monitor and new verify_dashboard_v2 script.
- Python/JavaScript policy tests and README/core/operation/validation documentation.

Checkpoint on codex/live-native-validation: `feat: native CARLA dashboard controls and destination navigation`.
Binary recordings, local preferences, runtime tickets and output evidence remain
ignored local artifacts; this report is committed so the result is reviewable.

## Remaining limitations and next phase

Epic stability is not verified. Low's visible aliasing/drawing quality remains a
native-renderer limitation. BasicAgent's speed target is not a hard limiter and
does not provide comprehensive autonomous-driving safety. Actual Windows switching
to an Arabic keyboard layout and OS-level Alt-Tab focus loss were not automated;
physical-code policy, Arabic field typing, heartbeat expiry and page-close focus
release were verified as described. Unreachable points are rejected by native route
validation, but no exhaustive all-pairs reachability sweep was performed.

The next recommended phase is longer reproducible dashboard/navigation stability
testing, targeted speed-controller characterization and investigation of Epic
startup on this machine. Traffic and scenario/model phases remain deferred.
