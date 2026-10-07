# Live native validation — CARLA 0.9.16

Measured on 7 October 2026. Existing offline-core architecture retained. Scope
ends after Gate 3; no traffic population, walkers, custom map, AI or random scenarios.

## Installation and machine

| Item | Native/local observation |
| --- | --- |
| Runtime / Python API | **0.9.16 / 0.9.16**, exact equality checked before connection |
| Installation | `C:\CARLA\CARLA_0.9.16` |
| Launcher | `C:\CARLA\CARLA_0.9.16\CarlaUE4.exe` |
| Native executable | `CarlaUE4\Binaries\Win64\CarlaUE4-Win64-Shipping.exe` within installation |
| Python | CPython 3.12.10 x64, project `.venv-carla` |
| Map | `Carla/Maps/Town10HD_Opt` |
| Ego | `vehicle.lincoln.mkz_2020`, role `ostorha_ego`, map spawn index 0 |
| GPU | RTX 3060 Laptop GPU, 6144 MiB VRAM, driver 617.14 |
| CPU | Ryzen 7 6800H, 8 cores / 16 threads |
| RAM | Windows enumerates 2 × 8 GiB modules; 15.25 GiB usable. User reports 32 GB; discrepancy unresolved. |
| Native catalog | 214 blueprints, 41 vehicle blueprints; Traffic Manager connects on 8003 without adding traffic |

The previous Quadro T1000/Dell audit and installation blockers are obsolete.
Fresh audit: `.venv-carla\Scripts\python.exe -m scripts.native.audit_installation`.

## Gate 1 — PASS, live

Native connection/spawn/control/cleanup entry points all passed against the actual
running simulator. Browser keyboard operations traversed WebSocket, the existing
ControlSafetyLayer and CommandArbiter, CarlaProvider and native VehicleControl.
The browser dashboard displayed CONNECTED only after native observations.

| Observation | Live result |
| --- | --- |
| W acceleration | Peak 8.1024 m/s, **29.1685 km/h** |
| A / D | Native applied steer reached **−1 / +1** |
| S braking | Native brake reached **1.0**, vehicle slowed |
| Reverse / Space | Native reverse=true and handbrake=true observed |
| Position | Changed from (−64.645, 24.471, −0.005) to (−58.390, 28.424, −0.004) m |
| Native frame range captured | 67566–68392 in initial browser session |
| Reset / reconnect | Browser reset replaced owned actor; fresh server session reconnected to native CARLA |
| Disconnect / cleanup | Dashboard became DISCONNECTED with disabled controls; live actor enumeration contained 0 vehicles / 0 sensors; original asynchronous world settings restored |

Evidence: `output/native-validation/browser-controls.jsonl`, `browser-summary.json`,
`connection.txt`, `spawn.txt`, `control.txt`, `cleanup.txt`, `gate1-reconnect.log`,
`gate1-clean-audit.txt`, and dashboard/reset/disconnected PNGs. These generated
artifacts are intentionally ignored by Git. Initial cleanup assertions failed
because `get_actor()` retains a cached Python proxy after actor destruction in
0.9.16. Checks now require absence from both native snapshots and actor enumeration.
A console interruption ended an early native session; restarted sessions completed
cleanly using finite `--session-duration` and normal application cleanup.

Native telemetry verified: frame/time; position x/y/z; pitch/yaw/roll; velocity
x/y/z; acceleration x/y/z; angular velocity; throttle/brake/steer; native gear,
reverse and handbrake. **Derived:** speed magnitude from velocity norm, km/h =
norm × 3.6, signed longitudinal speed/acceleration from forward-vector projection,
Euler radians and angular rad/s from native degrees. RPM/fuel/engine temperature
and mechanical damage remain unavailable; no values are invented.

Development synchronous mode uses **0.05 s fixed delta / 20 simulation Hz**,
with physics substeps up to 0.01 s. One tick owner is enforced. Traffic Manager
must use the same synchronous mode when traffic is eventually enabled.

Gate 1 regression check: 80 Python tests, 79 passed / 1 skipped. Unit tests
support the code changes; native observations above establish the gate.

## Gate 2 — pending

Baseline physics, collision sensor, canonical event recording and reset are next.

## Gate 3 — pending

Real sensors, numerical validation, synchronizer, recording and offline replay
remain to be verified. No sensor PASS is inferred from blueprint availability.
