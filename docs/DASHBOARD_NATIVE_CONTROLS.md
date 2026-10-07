# Native dashboard controls and settings

Validated against CARLA server/API 0.9.16 on 7 October 2026. Existing dashboard,
ControlSafetyLayer, CommandArbiter, CarlaProvider and SensorSynchronizer retained.
Three.js remains deleted. No traffic population, driving AI or autonomous vehicle
controller is enabled. The user explicitly chose prepared traffic settings only.

## Driving from the dashboard

Open http://127.0.0.1:8000/ and select **Start driving / ابدأ القيادة**. If another
browser owns controls, the same button says **Take control / استلم القيادة** and
atomically transfers ownership. The previous dashboard can no longer send pedals.
Keep the dashboard focused; native CARLA-window WASD controls its spectator.

Hold W for throttle, A/D for steering, S for braking; after forward motion stops,
holding S selects reverse. Space applies handbrake. D/N/R selects transmission
mode. The on-screen accelerator, steering, brake/reverse and handbrake buttons
support held pointer/touch input. Pointer release/cancel, blur, stale telemetry
and command timeout release controls through the existing safety architecture.
Start/resume does not resume an old throttle command. Acknowledge emergency stop
before resuming. REPLAY cannot claim controls, reconnect or change native settings.

Disconnect vehicle destroys the owned ego and all seven sensors and restores
world settings. Reconnect CARLA rebuilds one native ego/suite without restarting
the backend. Select Start driving again after reconnect or a safety pause.

## Camera, Phone and Settings

Camera views: front, hood, follow car, rear and top. These move the actual attached
RGB and depth actors together. No additional GPU camera or substitute renderer is
created. Frame-aware mount history preserves extrinsics for late sensor callbacks.
Enlarge shows the native feed in a larger panel. At narrow widths the camera appears
before the long telemetry section.

Phone offers six named native road anchors and saved places. Enter a name in
Save current place to store the real ego position for the current map. Choose a
listed destination and Show route. The 2D route uses CARLA's packaged deterministic
GlobalRoutePlanner road graph and actual waypoints; no driving agent or autopilot
is instantiated. Routes provide manual guidance and remaining distance. Names such
as north/centre are project labels for native map coordinates, not real geographic
neighbourhoods or Egyptian POIs. Saved places are map-specific.

| Setting | Application |
| --- | --- |
| Vehicle / spawn index | Native blueprint catalog and current map spawn points; stop first, then owned actors are replaced |
| Camera resolution / FOV | 640x360 or 800x450; 60-120 degrees; stop first, RGB/depth recreated together |
| Simulation frequency | 10 or 20 Hz; old sensors destroyed before changing fixed delta, then full suite recreated |
| Weather | Native cloud, rain, wetness, fog, sun altitude and azimuth |
| Graphics / native window | Low or Epic and three window sizes; saved for next launch via launch_carla.ps1 |
| Vehicle count / speed range / seed | Prepared settings only; traffic_active is always false |

Operations release controls and may leave driving paused; resume explicitly after
applying settings. Sensor reconfiguration is refused during recording. Invalid
operator values are rejected before native mutations. There is no map selector or
claim to expose every Unreal engine setting in this development panel.

Prepared graphics/traffic preferences: `config/dashboard-preferences.json`.
Named places: `config/places-Town10HD_Opt.json`. Both are ignored local user data.
Camera/timing/vehicle options are live session settings; a new backend starts from
its CLI defaults. Weather stays in the native world until changed/reloaded.

## Native evidence

Evidence files live under `output/native-validation/`; these are actual simulator
observations, not unit-test fixtures.

| Check | Live result |
| --- | --- |
| Keyboard | 47.5047 km/h in dashboard-driving-proof.json; native throttle 1 and updated world position |
| Final control regression | 1209 live samples: 19.1756 km/h, throttle/brake 1, left steering -1, handbrake and 4.8825 m displacement; RGB/depth frame 123793 matched, six measured sensor rates 20 Hz, no sensor errors; dashboard-final-proof.json |
| Held dashboard buttons | 15.9623 km/h, throttle 1, right steering 1, brake 1 and handbrake; 3.6523 m net displacement, 546 samples in dashboard-pointer-controls.jsonl |
| Camera during motion | 20.7091 km/h reached; chase mount applied while ego moved, same RGB/depth actors retained |
| Five camera views | Native mounts verified with unchanged actor IDs and aligned RGB/depth metadata, frames 102072-102097 |
| Timing | Stable measured six-sensor rates 9.99999985 / 19.99999970 Hz in simulation time at native 0.1 / 0.05 s steps |
| Intrinsics | Actual RGB 800x450 and FOV 100, restored to 640x360 / 90 |
| Vehicle replacement | Tesla model3 actor 178, then Lincoln MKZ actor 186; seven sensors each |
| Cleanup / reconnect | Actors 186-193 removed; asynchronous settings restored; reconnect ego 194 with exactly one vehicle and seven sensors |
| Dashboard Disconnect button | Frame 104988: zero vehicle/sensor actors, synchronous_mode false; camera/control UI unavailable |
| Phone | Native route to north anchor, 443.7238 m, and saved current Arabic place name |
| Weather / prepared traffic | Native cloudiness/sun altitude 35 / 35 verified; plan 5 vehicles, 20-40 km/h, seed 42 saved with zero active traffic |

`dashboard-operations.json` contains the settings, cleanup and reconnect checks.
`dashboard-ui-disconnect.json`, `dashboard-route-proof.json`,
`dashboard-settings-proof.json` and browser screenshots provide supporting evidence.
Run `python -m scripts.native.verify_dashboard` only with a running native backend
and a stopped ego. It claims control, changes conservative settings, performs
cleanup/reconnect, and leaves one ego at 20 Hz; it never drives traffic or ticks
the world itself. Allow transient startup samples to settle before rate assertions;
missing startup frames remain explicitly diagnosed by the SensorSynchronizer.

Latest supporting regression: 95 Python tests, 94 pass / 1 skip, 18 JavaScript pass.
These protect transport ownership, reconnect/pause, malformed settings, delayed
camera extrinsics and replay isolation; they do not establish native gate PASS.

## Performance and remaining limitations

RTX 3060 Laptop GPU: 6144 MiB VRAM. Latest conservative full-suite sample was
5843 MiB used / 33% GPU utilization. Gate 3 throughput and calibration remain in
[the full native report](LIVE_NATIVE_VALIDATION.md). Keep Low, 1280x720 and 640x360;
VRAM headroom is limited. Windows detects 16 GiB RAM, while the user reports 32 GB.

During development an earlier D3D12 session reported a native fatal shader
compilation error while timing/weather were reconfigured with sensors active.
An attempted D3D11 fallback stalled with cameras and the Python SDK aborted during
timeout cleanup. D3D12 remains the default. Reconfiguration now stops sensors before
changing the native world step, and the revised sequence passed 10/20 Hz, camera
intrinsics, vehicle replacement and reconnect tests. This does not prove that the
native driver/renderer crash can never recur; longer stability runs are still needed.
Fresh native observation recovery leaves driving paused, never silently resumes
throttle. Successful image-request logging is suppressed to avoid console flooding.

Next phase: longer reproducible dashboard stability runs. Normal traffic requires
a separate subsequent phase; no pedestrians, Egyptian map, custom vehicles, random
events, models, autonomous driving or accident avoidance are introduced here.
