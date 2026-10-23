# 720p / 60 Hz performance path -- 23 October 2026

## Release decision

`PERFORMANCE_60` is **opt-in and not accepted**. `LEGACY` remains the default.
Requested rates are not measured throughput. Software verification does not
establish 60 distinct displayed images per wall second, real-time simulation,
the 4608 MiB device-memory limit, or general driving acceptance.

The former `repair/failed-gates-20261023` tip (`56b7aa7`) was fast-forwarded into
`main` in the primary checkout, preserving its three commits and all prior
evidence. No additional branch or worktree was used.

The retained evidence index and final measurements below distinguish unchanged
baseline trials, failed exploratory trials and final instrumented trials.
Failures and missing measurements must not be read as successful acceptance.

## Implementation

### Separate simulation and observation clocks

The new profile requests:

| Surface | LEGACY | PERFORMANCE_60 |
| --- | --- | --- |
| Fixed native physics step | Existing 10 or 20 Hz | 1/60 s |
| Front perception RGB, depth, LiDAR, radar, IMU, GNSS | Existing physics rate | 20 Hz |
| Driving camera | Existing physics rate / comparison 800 x 450 | Native 1280 x 720, 60 Hz |
| Navigation and safety evaluation | Existing observation cadence | Once per new 20 Hz synchronized observation |
| Command arbitration and final application guard | Existing path | Every physics step |
| Exclusive RL episodes | Existing behavior | Explicitly requires switching to LEGACY |

One service worker owns native advancement. Delayed GPU sensor callbacks are
joined to their original native world/vehicle anchors, not to a neighboring
physics frame. Bounded anchor histories and stride-three sensor diagnostics
survive actor/camera rebuilding. No dummy safety packets are generated on the
two intermediate physics steps.

Commands retain their source frame, simulation timestamp and original receipt.
Intermediate steps do not renew a command lease. Existing 0.35 s command leases,
0.1 s scene simulation-age and 0.25 s wall-age bounds are not increased. The
split-rate application guard checks validity through the next physics interval.
Missing/slow observations produce braking, not permission to continue.
Emergency stop is applied immediately and rechecked before the next tick;
shutdown does not request an additional physics tick.

Both comparison manifests include runtime rates, native render-launch identity
and requested/applied sensor attributes. Mixed new/old profiles or different
render settings do not qualify as matching conditions. Historic manifests can
still match other historic manifests.

Implementation: [service](../backend/core/service.py),
[rates](../backend/core/performance.py),
[provider](../backend/carla/provider.py),
[world](../backend/carla/world.py),
[sensor synchronization](../backend/signals/timing.py),
[comparison matching](../backend/core/journey_comparison.py).

### Native sparse-sensor correctness (not just matching frame IDs)

Native inspection exposed a CARLA 0.9.16 detail that a mock-rate test cannot
establish: `PostPhysTick` receives the world step even when `sensor_tick` skips
world frames. With unchanged 20 Hz LiDAR attributes at 60 Hz physics, the actual
packet had only a 120-degree sector and about one third of the intended rays.
The retained sample had 1131 returns in four of twelve 30-degree azimuth bins;
the old 20 Hz native sample had 3476 returns across all twelve bins.

The corrected profile still delivers each driving sensor at 20 Hz:

- LiDAR native rotation is 60 rotations/s and native point budget is multiplied
  by three. One delivered packet again scans 360 degrees with the old per-sample
  ray budget; it does not increase the delivered sample frequency.
- Radar's ray budget is multiplied by three. Its native own-motion Doppler term
  is corrected from the actual interval between the sensor's own poses, leaving
  the target-motion contribution unchanged.
- IMU acceleration uses the same quadratic own-position derivative as the stock
  sensor, with three actual sample timestamps rather than three world-step
  intervals. Stock 9.81 m/s^2 IMU gravity and zero accelerometer noise are explicit.
  Gyroscope and compass remain native. Warm-up is explicit and does not invent a
  complete IMU packet.
- Adjacent native scheduling jitter uses actual intervals. Larger missing-sample
  gaps and out-of-order samples are rejected. Original native Doppler and
  acceleration values remain in metadata for audit. No other actor's pose,
  identity or future motion is used for these corrections.

A subsequent **native comparison rig** sample had 3453 returns across all twelve
azimuth bins with 32 channels, 384000 native points/s, native rotation 60 Hz and
`sensor_tick=0.05`. The smaller ordinary rig was also checked natively across all
twelve sectors. Original 10/20 Hz decoding is unchanged.

Earlier new-profile trials with the incomplete LiDAR packet are exploratory
only, not valid driving comparisons or proof that this corrected rig meets
acceptance. The fixed profile still needs the complete performance, moving-drive
and resource gates.

Implementation: [sparse sensor timing](../backend/signals/multirate.py).

### JPEG and recording off the tick wait

In the new profile each RGB camera has one encoding worker, one in-flight
native image and one replaceable pending image. Superseded pending images are
counted. Native callbacks enqueue rather than compressing JPEG on the callback
that the decision owner waits for. Physics does not wait for the encoder:
decisions use completed synchronized observations subject to unchanged age
limits. JPEG quality remains 95.

The BGRX-to-RGB conversion uses Pillow's native conversion instead of NumPy
advanced indexing followed by an additional pixel copy. The regression compares
the actual JPEG bytes and diagnostic RGB pixels against the previous conversion.
The sensor asset cache is bounded to 64 MiB as well as its existing item limit.

The existing bounded recording writer keeps disk writes, JSON serialization,
prediction compression and MP4 export outside command application. Driving
camera frames are drained at the physics cadence, independently of 20 Hz
observation recording. Finalization allows the original terminal camera frame
to arrive without blocking physics; a missing terminal frame is an explicit
incomplete recording, not a successful complete video.

Video PTS/durations use original simulation timestamps, including gaps. The last
image hold uses the recorded camera period (1/60 s for the new driving camera);
old recordings without that calibration retain their historical 0.05 s hold.
Annotations retain calibration and use simulation-time forecast selection.
The exported source-image count is not a browser/render FPS measurement.

Implementation: [encoder](../backend/signals/image_encoding.py),
[decoders](../backend/signals/decoders.py),
[recording](../backend/core/recording.py),
[video export](../backend/core/driving_video.py).

### Independent image transport and presentation

The control socket stays at the existing WebSocket root. A separate socket at
`/images` carries length-prefixed JSON metadata plus the original JPEG bytes.
An image connection cannot acquire/release vehicle ownership, submit commands,
renew driving intent, or disable the control watchdog.

Every packet identifies session, camera, native frame, simulation time, native
dimensions, capture/receipt/encoding/send clocks and original image checksum.
The capture wall clock is the **native tick-request time**, not an invented
hardware exposure timestamp. Startup samples without that anchor are explicitly
labelled `SENSOR_RECEIPT_PROXY`. The browser clock handshake records RTT
uncertainty; image age means tick request to RAF presentation.

There is at most one unacknowledged image per connection, with an acknowledgement
deadline, eight image connections and a 4 MiB payload limit. The browser has one
decode job, one replaceable compressed slot and one replaceable decoded bitmap.
Only decoded bitmaps are drawn, at `requestAnimationFrame`; replaced/expired
bitmaps are closed. Session/camera switches invalidate old work. Late,
superseded, out-of-order and wrong-session images are counted. A stale image is
hidden even if telemetry is healthy.

The legacy JPEG HTTP endpoint remains available for inference, diagnostics and
old recordings/replay. Native image streaming no longer depends on the 50 ms
dashboard layout/telemetry refresh. The 50 ms loop remains for non-image UI and
read-only legacy/replay compatibility.

The distinct-presentation meter evaluates complete ten-second windows:
58--60 frames/s, simulation/wall ratio 0.95--1.05, and p95 intervals <=25 ms.
No-frame windows fail instead of remaining indefinitely unevaluated. Its
acceptance scope excludes GPU memory, which is measured independently.
Native engine renderer FPS remains **unmeasured**; neither sensor Hz nor browser
FPS is relabelled as Unreal renderer FPS.

Implementation: [image protocol](../backend/image_stream.py),
[socket bridge](../backend/websocket_bridge.py),
[browser transport](../frontend/image-stream.js),
[presentation meter](../frontend/camera-performance.js),
[dashboard](../frontend/dashboard.js).

### Exact hot-path reuse

The implementation caches static contract type metadata, calibrated depth pixel
rays, occupancy body masks, footprint sampling grids and ray sampling fractions.
Depth values, scene measurements, occupied/free/unknown results and decisions
are not reused across frames. Arrays in geometry-template caches are read-only
and cache sizes are bounded.

Repeated corridor projections within one forward-space assessment reuse exact
results for the same input arrays. No point decimation, unknown-space clearance
shortcut, prediction-age extension or learned-policy promotion was introduced.

Eighty preserved native frames were evaluated before/after using exported
original modules and the same sensor bytes. The combined published-track and
safety-decision digest is identical:

```text
9bafff08325b8a594631b20300fb1c4a2eda09adf54597b17a2b7ebf28826a97
```

Replay timings taken while native workloads were also running are not controlled
native speedup evidence. The digest establishes scoped software equivalence,
not driving superiority.

### Resources and render verification

Diagnostics separate:

- Requested physics/capture/decision Hz from measured wall throughput.
- Native physics real-time factor from distinct browser presentation FPS.
- Sensor receipt/decode/queue, scene, navigation/safety, actuator and image
  decode/presentation measurements.
- Whole-device NVIDIA memory/utilization from process counters.
- NVML process memory (`N/A` on this WDDM host) from available Windows WDDM
  dedicated/shared process allocations. WDDM all-adapter allocations are not
  mislabelled as residency on the NVIDIA device.
- System CPU utilization, process CPU seconds/one-core and machine-normalized
  percentages, working set and private memory.

The proposed render profile requests Epic at a native 720p camera, streaming
textures without the prior global mip bias, temporal AA, reduced shadows and
disabled expensive reflection/bloom effects. Its 768 MiB texture pool is **not**
a whole-device memory cap. The 4608 MiB acceptance gate uses observed total
device memory, including other applications when present.

The launcher requests engine-console CVar readback in a dedicated log. The
installed shipping engine did not produce that log in the measured attempts:
the audit explicitly reports unverified/missing, rather than treating the
written INI or command line as proof of applied CVars. Native actor attributes,
native JPEG dimensions and decoded bitmap dimensions are separately checked.
Full render-setting admission therefore remains open.

Implementation: [render requests](../backend/graphics.py),
[native runtime/audit](../backend/carla/runtime.py),
[Windows counters](../backend/core/resources.py).

### Native regressions found during measurement

1. A presentation-specific sensor rebuild discarded stride-three timing. It
   produced false `MISSING` diagnostics at the new sensor cadence. All normal
   rebuild paths now share the rate-aware reset helper.
2. An observing page opened during managed preparation could see temporarily
   unavailable observations and automatically request a new engine. The existing
   native host then retired and the replacement reverted to legacy timing.
   Startup is now unavailable while an unclosed native world exists, including
   stale/reconfiguring states. The page also does not auto-start over an active
   presentation.
3. An acknowledged observational preload could leave a page waiting forever for
   ownership that it had not requested. The page now resolves that acknowledgement
   as observation, without replacing the other driver's scenario.
4. A missing arm in a later failed comparison could retain an earlier download
   link after the media root was cleared. Missing arms now clear the video and
   link, show "No recorded attempt", and do not masquerade as a pending export.
   This was reproduced and rechecked in the actual native browser results.

Each has offline regressions; the native failed attempts are retained.

## Reproduction

Use the existing primary checkout. Do not run a second native tick owner.
To select the profile in the dashboard, stop the vehicle, choose
`PERFORMANCE_60` under Camera and image, and Apply. The corresponding graphics
restart is explicit; it never resumes driving automatically.

For bounded native measurements after explicitly freeing the previous engine:

```powershell
.\.venv-carla\Scripts\python.exe -m scripts.native.run_performance_dashboard `
  --port 8060 --ws-port 8061 --seconds 3600 --run-profile PERFORMANCE_60 `
  --render-profile PERFORMANCE_60 --renderer D3D12 --detector CPU

# A separate observer uses the existing owner, never client.world.tick().
.\.venv-carla\Scripts\python.exe -m scripts.native.measure_performance `
  --http-port 8060 --ws-port 8061 --pairs 3 --first NORMAL `
  --label normal-first --out output\performance-60
```

Use `--first ROBOSPHERE` for protected-first repeats if a safely aborted first arm
prevents the second arm from starting. An abort is not a valid completed pair.
`--max-arm-seconds 40` explicitly bounds a performance-only window and stops it
through the normal control channel; that interrupted recording is never counted
as route completion. This is useful when a drive remains held on unverified
coverage. It does not shorten the production automatic comparison behavior.
The V2 observer waits for exports and a three-second quiet interval before the
next attempt. It records unavailable-observation intervals rather than silently
deleting them.

For the provider-only comparison, install the optional environment using
[setup](../scripts/setup_perception_directml.ps1), and point
`YRO_PERCEPTION_PYTHON` to its absolute interpreter path for **both** CPU and DML
runs. Both then use ONNX Runtime 1.24.4, the same model, preprocessing and decoding.
`--detector DML` selects the actual DirectML worker. Production CPU setup/defaults
are not changed by the validation environment.

The SDK-free measurement launcher owns a child backend. It waits for that SDK
host to exit before stopping UE, preserving the Windows streaming lifecycle.
Raw runs, environments, model weights, logs and local settings stay ignored.

## Software verification

- `npm run build:dashboard`: passed; checked-in JavaScript and CSS regenerated.
- `npm test`: 191 passed.
- Python discovery: 884 tests, successful with four optional skips.
- Timing tests cover sixty native packet steps/twenty decision cycles,
  delayed sensor anchors, no lease refresh on intermediate steps, next-interval
  expiry, transport loss, immediate emergency stop, shutdown, session rebuilding,
  mixed-profile comparisons and startup ownership.
- Transport tests cover protocol identity/dimensions, bounded slow decoding,
  supersession, disconnect/reconnect, session switches, bitmap disposal, stale
  image removal and actual image/control socket ownership separation.
- Regression tests cover byte-identical JPEG conversion, exact geometry
  templates, ten-second acceptance boundaries, missing-window failure,
  legacy/60 Hz video timing and explicit resource/audit availability.

## Native acceptance and retained evidence

The original unmodified low-quality 20 Hz dense-scene baseline ran three
comparison attempts, including one partial safe abort; a fourth supplied the
third protected attempt. Additional failures and a visible-HTTP observation
attempt remain recorded. Some baseline arms hit sensor/command deadlines.
The initial observer did not obtain valid displayed-frame evidence because of
the preload observation race; missing baseline browser FPS is not reconstructed
from sensor/native tick rates.

An early PERFORMANCE_60 D3D12 exploration measured 17 complete displayed windows:
9.9--14.0 distinct RAF frames/s, per-window p95 intervals 104.3--139 ms,
approximately 0.21x real time, and total device memory 5318--5884 MiB.
All three normal-first attempts aborted safely before a valid full pair; these
are not three successful Normal/protected comparisons.

An alternate D3D11 attempt terminated its SDK host with native exit code
3221226505 before acceptance measurement. It was retired and is not adopted.
The subsequent page-start race and its legacy replacement were also retained
as invalid attempts, not counted as PERFORMANCE_60 measurements.

Final quiet CPU/DirectML and endurance measurements are indexed with their
explicit scope in the accompanying evidence. The performance, memory,
render-setting verification and full moving-driving acceptance gates remain
open unless those measurements establish every required bound. No GTA-derived
FPS number or configured sampling frequency is an acceptance result.

### Corrected-rig DirectML results

Three explicitly bounded 40-second performance trials were run per driver on
the corrected full-scan rig. These are interrupted measurement windows, not
completed matched arrival/contact pairs.

| DirectML, actual native load | Normal | Ya Rab Ostorha |
| --- | --- | --- |
| Median distinct displayed FPS across complete 10 s windows | 13.6 | 9.75 |
| Median native simulation/wall ratio | 0.229x | 0.166x |
| Observed total NVIDIA memory | 5844--5888 MiB | 5818--5867 MiB |
| Median detector time | 62 ms | 62 ms |
| Actual provider / runtime | DmlExecutionProvider / 1.24.4 | DmlExecutionProvider / 1.24.4 |
| Full valid completed pairs | 0 | 0 |

The detector being faster is not overall acceptance. DirectML is not made the
default: display, real-time and whole-device memory gates still fail. WDDM
separately observed about 219 MiB allocated by the DirectML worker and about
5605 MiB by UE in one retained sample; those process allocations are not used
in place of the observed total-device budget.

The final CPU trials use the same optional 1.24.4 environment for provider
comparison. They also include the subsequent startup-jitter/recovery handling
and preservation of the original ten-observation settling interval. The
measurements therefore do not establish a strict provider-only causal speedup
claim. Original production CPU dependencies/defaults remain unchanged.

### Final corrected-rig CPU results

Three trials were recorded per driver, with a 40-second wall-time ceiling and
normal safe-stop/export handling. No age limit was relaxed to keep a trial
running.

| CPU, actual native load | Normal | Ya Rab Ostorha |
| --- | --- | --- |
| Complete 10 s display windows | 6 | None: every trial stopped before ten seconds |
| Distinct displayed FPS | 10.7--12.0 (median 11.45) | Unmeasured, not zero and not a pass |
| Per-window p95 interval | 118.0--145.9 ms | Insufficient complete windows |
| Native simulation/wall ratio | 0.180--0.227 (median 0.189) | Insufficient complete windows |
| Total NVIDIA memory | 5855--5892 MiB | 5855--5863 MiB |
| Median detector time | 578 ms | 555 ms |
| Full valid completed pairs | 0 | 0 |

Normal had two explicit window stops and one runtime-freshness failure. All
three protected trials failed runtime freshness/command application before a
complete ten-second window. Their original recordings and stop diagnostics are
retained. This is a driving regression/open gate for the new profile, not a
claim of collision avoidance, route completion or protected-driver superiority.

Native tick requests in the measured dense scene were commonly much longer
than the 16.67 ms physics/display budget. Protected scene construction plus
safety evaluation also consumed the 50 ms decision-cycle budget and sometimes
the unchanged wall-age limit. Faster JPEG and detector processing alone do not
remove those bottlenecks. A causal decomposition needs further controlled
engine/CPU work; the measurements do not prove that a texture-pool setting caps
all GPU allocation.

### Visual evidence scope

The original [800 x 450 main-camera start](evidence/performance-60-20261023/baseline-main-start.png)
and the native [1280 x 720 performance start](evidence/performance-60-20261023/performance-main-start.png)
retain decoded, unscaled camera pixels. Road-line edges and the pavement are
visibly less aliased in the latter. This is qualitative, scoped evidence:
ego color and some participant settling/poses differ, so these are not
pixel-identical counterfactual frames or a complete matched video-quality
acceptance review. The actual 720p camera is verified; the complete quality
gate remains open.

### Actual 30-minute warmed resource soak

The final corrected CPU host was observed for **1800 wall seconds after a
60-second warm-up** (1860.078 s total; measurement samples at wall seconds
60.0--1860.0). The post-comparison ego/world was held. This is deliberately **not**
moving-drive or browser-presentation endurance acceptance.

- Density stayed at 60 vehicles / 100 pedestrians. Ninety-one native walker
  controllers were present; the scripted participants retain separate ownership.
- Total NVIDIA memory stayed at **5830--5860 MiB**, p95 **5835 MiB**:
  stable, but above the **4608 MiB** limit throughout.
- Native simulation/wall ratio was **0.256--0.365**, median **0.350x**.
- Total system CPU was 66.5--95.0%, median 72.9%. These are actual shared-host
  observations, not a claim of exclusive benchmark-machine CPU availability.
- There were no observation outages or reported sensor errors during this soak,
  no image-encoder failures and at most one pending image per encoder.
- The observed asset-cache maximum was **67,108,823 bytes**, below its
  67,108,864-byte limit.

The resource/queue run completed. It did not pass performance/memory admission
and does not close the open full moving-driving and visible-browser 30-minute
gates.

### Final acceptance disposition

| Gate | Result |
| --- | --- |
| Actual native 1280 x 720 camera and decoded bitmap dimensions | Verified |
| Nominal 60/20 Hz ownership, synchronization and expiry software contracts | Verified offline; native scans additionally calibrated |
| 58--60 distinct displayed images/s in every 10 s window | **Failed** |
| Native real-time factor 0.95--1.05 | **Failed** |
| p95 displayed-image interval <=25 ms | **Failed** |
| Stable total device memory <=4608 MiB | **Failed** |
| Applied render-CVar readback and complete matched visual review | **Open / unverified** |
| Three complete valid new-profile Normal/protected pairs | **Not achieved**; all partial/failing trials retained |
| Full moving/visible-browser 30-minute acceptance | **Open**; held resource soak is separate |
| Promotion to default / DirectML selection | **Not authorized by these results**; LEGACY and CPU stay default |

The remaining work is substantive engine/control-pipeline performance and native
admission, not renaming requested Hz as achieved FPS or increasing safety ages.

### Evidence index

- [Software verification and exact-output digest](evidence/performance-60-20261023/software-verification.json).
- [Native incomplete-scan discovery](evidence/performance-60-20261023/lidar-cadence-before.json).
- [Corrected ordinary rig](evidence/performance-60-20261023/lidar-cadence-corrected-initial.json)
  and [corrected comparison rig](evidence/performance-60-20261023/lidar-cadence-corrected-comparison.json).
- [Native emergency application](evidence/performance-60-20261023/native-emergency.json):
  the ego was already held; this is not a moving stopping-distance claim.
- [Unchanged baseline trials](evidence/performance-60-20261023/native-baseline.json),
  [corrected CPU trials](evidence/performance-60-20261023/native-cpu.json) and
  [corrected DirectML trials](evidence/performance-60-20261023/native-directml.json).
- [Retained invalid/failed exploration](evidence/performance-60-20261023/retained-failures.json).
- [Actual 30-minute warmed resource soak](evidence/performance-60-20261023/native-stability.json).
- [Native raw-video checksum/head/tail checks](evidence/performance-60-20261023/native-video-checks.json):
  both old recordings and new 1/60 s final-image holds were verified.
- Raw local measurements, original videos, failure logs and the equivalence input
  subset remain in ignored `output\performance-60` and `runs\normal_city`.

## References

- [CARLA 0.9.16 synchrony/time-step](https://carla.readthedocs.io/en/0.9.16/adv_synchrony_timestep/):
  one synchronous tick owner, fixed steps and delayed GPU sensors.
- [Unreal 4.27 texture streaming configuration](https://dev.epicgames.com/documentation/en-us/unreal-engine/texture-streaming-configuration?application_version=4.27):
  texture-pool controls do not bound every GPU allocation.
- CARLA 0.9.16 source: [sensor tick dispatch](https://github.com/carla-simulator/carla/blob/0.9.16/Unreal/CarlaUE4/Plugins/Carla/Source/Carla/Sensor/Sensor.cpp),
  [LiDAR per-step rays/angle](https://github.com/carla-simulator/carla/blob/0.9.16/Unreal/CarlaUE4/Plugins/Carla/Source/Carla/Sensor/RayCastSemanticLidar.cpp),
  [radar own-motion](https://github.com/carla-simulator/carla/blob/0.9.16/Unreal/CarlaUE4/Plugins/Carla/Source/Carla/Sensor/Radar.cpp),
  [IMU derivative](https://github.com/carla-simulator/carla/blob/0.9.16/Unreal/CarlaUE4/Plugins/Carla/Source/Carla/Sensor/InertialMeasurementUnit.cpp).
- [Consolidated workflow and evidence index](CONSOLIDATED_DELIVERY_20261014.md).
- [Prior failed-gates recovery](FAILED_GATES_RECOVERY_20261023.md).
