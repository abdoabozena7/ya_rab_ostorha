# Live native validation: CARLA 0.9.16

Measured on 7 October 2026. Gates 1, 2 and 3 PASS against the real native simulator.
The existing offline core, safety layer, arbitration, synchronizer and recorder
are retained. The obsolete Three.js game and its launch/mock routes are deleted.
No traffic population, pedestrians, custom map, AI or random accidents were added.

## Installation

| Item | Verified observation |
| --- | --- |
| Server / Python API | 0.9.16 / 0.9.16; exact equality required |
| Install | `C:\CARLA\CARLA_0.9.16` |
| Launcher | `C:\CARLA\CARLA_0.9.16\CarlaUE4.exe` |
| Actual process | `CarlaUE4\Binaries\Win64\CarlaUE4-Win64-Shipping.exe` |
| Python | CPython 3.12.10 x64 in project `.venv-carla` |
| Map | `Carla/Maps/Town10HD_Opt` |
| Ego blueprint | `vehicle.lincoln.mkz_2020`, role `ostorha_ego` |
| GPU | RTX 3060 Laptop GPU, 6144 MiB VRAM, driver 617.14 |
| CPU | Ryzen 7 6800H, 8 cores / 16 logical processors |
| RAM | Windows detects two 8 GiB modules: 16 GiB installed, 15.25 GiB usable. User reports 32 GB; discrepancy unresolved. |
| Catalog | 214 blueprints / 41 vehicle blueprints; real Traffic Manager connection on 8003, no traffic |

Old Quadro T1000/Dell hardware and installation blockers are obsolete.
Installation audit: `output/native-validation/installation.json`.

## Gate 1: PASS

Real localhost connection, server response, get_world, map, blueprints and matching
versions passed. One ego spawned, falling back to other valid map spawn points
when needed. Owned actors are removed before replacement.

Browser -> WebSocket -> ControlSafetyLayer -> CommandArbiter -> CarlaProvider ->
native VehicleControl -> real vehicle was demonstrated with actual held keys.
W reached 8.1024 m/s (29.1685 km/h); A/D reached native steer -1/+1; S reached brake
1.0; reverse and Space handbrake were observed. Position changed from
(-64.645,24.471,-0.005) to (-58.390,28.424,-0.004) m. Dashboard speed, pedals,
steering, position and native frame/time updated. Reset replaced actor 33 with 34.
Disconnect disabled controls; reconnect and cleanup passed with zero owned actors
and original world settings restored. Evidence is in `browser-controls.jsonl`,
`browser-summary.json`, connection/spawn/control/cleanup TXT files and Gate 1 PNGs
under `output/native-validation`.

Native telemetry: frame_id, simulation_timestamp, transform/location x/y/z,
rotation pitch/yaw/roll, velocity x/y/z, acceleration x/y/z, angular_velocity,
throttle, brake, steer, gear, reverse and handbrake. Derived fields: speed_mps =
velocity magnitude; speed_kmh = speed_mps * 3.6; signed longitudinal speed and
acceleration = projection on native forward vector; Euler radians and angular
rad/s are native degree conversions. RPM, fuel, engine temperature and mechanical
engine/component damage are not fabricated or exposed as validated data.

## Gate 2: PASS

Repeatable native baseline on valid map spawn 152: location
(57.568340,-67.849854,0.6), yaw 179.976562 degrees. CARLA physics is unchanged.

| Target speed | Acceleration time | Brake initial speed | Stopping distance | Mean deceleration |
| --- | --- | --- | --- | --- |
| 5 m/s | 2.15 s | 5.140 m/s | 0.964 m | 17.048 m/s^2 |
| 10 m/s | 3.75 s | 10.084 m/s | 6.806 m | 10.610 m/s^2 |

These are simulator baseline observations, not real-car safety predictions.
Maximum steering inputs -1/+1 changed yaw -50.423/+50.379 degrees; native visual
wheel steer and pitch APIs confirmed steering/rotation animation. Reverse reached
-3.433 m/s and handbrake stopped the vehicle. Road contact, orientation, roll/pitch
and road-edge body response were recorded. This is not a detailed curb/suspension
mesh characterization.

Controlled collision fixtures were removed after testing:

| Case | Measured approach | Peak native impulse magnitude |
| --- | --- | --- |
| Low-speed static | 2.062 m/s | 4242.812 N s |
| Higher-speed static | 7.087 m/s | 15417.729 N s |
| Stationary Audi A2 fixture | 3.014 m/s | 6836.990 N s |

Real collision sensor events carry actual frame/time, other actor ID/type and
normal impulse x/y/z. Magnitude is derived as the vector norm. CollisionEvent
enters EventBus as CollisionDetected and RunRecorder stored 35 collision events in
`runs/gate2_1791399137`. Delayed callbacks keep their original frame/time. Reset
and cleanup passed. Evidence: `gate2.json`, `gate2-vehicle-samples.json`,
`gate2-collision-entrypoint.txt`, `gate2-clean-audit.txt`.

## Gate 3: PASS

All seven sensors attached to the real ego and produced valid native data:

| Sensor | Native measurements / configuration |
| --- | --- |
| RGB | 640x360, FOV 90 degrees, front mount (1.5,0,1.6) m; native BGRA converted to compressed RGB JPEG; actual dashboard feed |
| Depth | Same mount/resolution/FOV as RGB; float32 metre depth in .npy asset |
| Radar | Range, azimuth, altitude, velocity; front (2.5,0,0.65) m, range 50 m, 1500 points/s |
| LiDAR | Native local x/y/z/intensity float32 .bin; roof (0,0,1.9) m, 16 channels, 32000 points/s, 50 m, 20 Hz rotation |
| IMU | Native accelerometer m/s^2, gyro rad/s, compass radians |
| GNSS | Native latitude/longitude degrees and altitude metres; world transform separate |
| Collision | Event-driven native frame/time/other actor/normal impulse; available through canonical events |

Each sensor has an ID, native actor ID, relative mount, world transform,
frame/time, requested update rate and latest valid data. Native callback errors
and bounded-queue overflow are explicit. Collision is event-driven, so absence of
an impact is not a missing periodic sensor.

Depth decoding follows CARLA's packed RGB formula:
`metres = (R + 256*G + 65536*B) / 16777215 * 1000` from native BGRA bytes.
[Official sensor reference](https://carla.readthedocs.io/en/0.9.16/ref_sensors/).

| Approximate target | Native raycast surface distance | Decoded depth | Error |
| --- | --- | --- | --- |
| 5 m | 5.002893 m | 5.118669 m | +0.115775 m |
| 10 m | 10.005585 m | 10.118605 m | +0.113020 m |
| 20 m | 20.010963 m | 20.118298 m | +0.107334 m |
| 30 m | 30.016352 m | 30.117811 m | +0.101460 m |

All errors are within the declared 0.25 m development tolerance. An opaque patch
just below the horizon was used because the fixture lid does not cover the optical
centre. Geometry/rendered-surface differences can explain part of this offset;
this is an inference, not a correction applied to native depth.

Radar uses a temporary controlled native vehicle fixture; raw detections remain
recorded. Measured velocity sign: negative approaching, positive receding.

| Target | Native radial velocity | Median raw radar velocity |
| --- | --- | --- |
| Stationary | 0.000000 m/s | -0.008040 m/s |
| Approaching | -2.999791 m/s | -3.004230 m/s |
| Receding | +2.999791 m/s | +2.986340 m/s |

LiDAR: 18 road-plane points, maximum height error 0.000200 m; 12 planar static
facade comparisons against native raycasts, median distance error 0.008939 m.
Sparse small-object coverage is not fully characterized.
IMU stationary acceleration (0,0,9.81) includes gravity; acceleration x reached
12.184, hard braking x -26.806 m/s^2, left/right gyro z -0.573/+1.075 rad/s.
Right-turn sequence included road-edge contact; this is not isolated motion capture.
GNSS matched the map's native georeference conversion; this map uses synthetic
coordinates near zero, not Egyptian geographic coordinates.

## Synchronization, recording and Replay

One tick owner, synchronous fixed delta 0.05 s = 20 simulation Hz, with physics
substeps up to 0.01 s. Future Traffic Manager must use consistent synchronous
settings. [Official synchrony reference](https://carla.readthedocs.io/en/0.9.16/adv_synchrony_timestep/).

The existing SensorSynchronizer joins VehicleState and six continuous sensors only
at identical native frames/timestamps. The real run has 534 frames, 532 complete
six-sensor frames and two explicitly incomplete cold-start/reset frames. Live
late/duplicate/out-of-order/timestamp mismatch counts were zero. Missing samples
are diagnosed, never replaced with unrelated frames. Replay tests deliberately
reordered/duplicated/withheld real recorded packets and confirmed diagnostics.

REAL_SIMULATION recording: `runs/gate3_1791400336`, 26.650000 s simulation duration,
frames 263888-264421, 550321191 bytes (550.32 MB). Metadata, vehicle state, applied
control commands, RGB/depth/LiDAR asset references, radar, IMU, GNSS and collision
events are stored. Large binary data is kept outside JSON; assets have length/hash
validation. Reset drains pending data before sensor asset caches are cleared.

Replay PASS with CARLA actually stopped: no native process or port 2000 listener.
The browser displayed MODE: REPLAY, recorded telemetry and actual recorded RGB.
Driving controls were disabled; HTTP control requests returned 503. CONNECTED
was false throughout. CLI evidence: `replay.json`; browser/API evidence:
`replay-dashboard.json`, `gate3-replay-dashboard.png`.

Sensor cleanup removed ego and all seven actors (226-233), and native enumeration
confirmed no surviving owned sensors/vehicles. CARLA was restarted after Replay;
a fresh full suite connected, RGB passed again, all eight owned actors (24-31)
were removed, and the dashboard reconnected. Final same-frame HTTP checks retrieved
RGB plus depth shape (360,640) and LiDAR shape (756,4), frame 2223.
Evidence: `gate3-sensors.json`, selected sensor JSON/TXT files,
`gate3-clean-audit.txt`, `gate3-final-reconnect.txt`, `gate3-final-dashboard.json`,
`gate3-live-dashboard.png`.

## Performance and limitations

Conservative Low / 1280x720 native window and 640x360 sensors, no traffic:

| Measurement | Observed |
| --- | --- |
| Native world frame production | 19.6915 frames per wall-clock second, over 120 frames / 6.094 s |
| Fixed simulation rate | 20 Hz |
| RGB / Depth / Radar / LiDAR / IMU / GNSS rate | 20 Hz in simulation time |
| Backend step | Mean 30.483 ms, max 47.000 ms |
| Backend CPU | 100.509% of one core, approximately 6.28% of 16 logical processors |
| GPU memory / utilization | 5868 / 6144 MiB, 40% at sample |
| Unreal window render FPS | Uninstrumented; unavailable. World tick throughput above is not a separate renderer FPS counter. |

VRAM headroom is small; retain conservative settings. RAM discrepancy remains.
No artificial RPM/fuel/temperature/component damage. No suspension rewrite or
real-world stopping-distance guarantee. The baseline sensor configuration and
0.10-0.12 m depth offset are development characterization, not final calibration.

## Tests, files and commits

Existing native entry points: connection, spawn, control, collision, cleanup,
RGB, depth, radar, LiDAR, IMU and GNSS all passed against native CARLA. Full
`vehicle_baseline`, `sensor_validation` and simulator-stopped `verify_replay`
passed. Regression: 86 Python tests, 85 passed / 1 skipped (missing-API test does
not apply in the installed native environment); 15 JavaScript tests passed.
Unit tests are supporting evidence only.

Files changed across checkpoints: CARLA provider/vehicle/telemetry/sensor manager
and native decoders; core contracts/service/dashboard; server/WebSocket transport;
Replay service; frontend dashboard/telemetry; native scripts and install/launch
scripts; tests; dependencies; README and current architecture/migration reports.
Three.js game files, preview launcher and mock routes removed in a separate commit.
Use `git diff 8dab36e..HEAD --name-status` for the complete manifest.

Checkpoint commits: Gate 1 `9b3170d`; Three.js removal `1267860`; Gate 2 `9731ecd`;
Gate 3 `6c35175`.

Subsequent dashboard controls, camera/settings, prepared traffic preferences and
manual named destinations are described in [the dashboard report](DASHBOARD_NATIVE_CONTROLS.md).
Latest regression: 95 Python tests, 94 passes / 1 skip; 18 JavaScript passes.
The original Gate 3 measurements above retain their original validation date/run.

Next recommended phase: longer native stability runs with the dashboard, then
separately approve/validate controlled normal traffic. Egypt/custom maps,
models, autonomous driving and accident-avoidance work remain outside this report.
