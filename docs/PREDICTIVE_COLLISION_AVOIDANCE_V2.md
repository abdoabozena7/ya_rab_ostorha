# Predictive collision avoidance v2

This is an **experimental implementation**, disabled as the startup policy. The
original RULE controller remains the default. The full native RULE/MODEL,
waiting-time, harsh-braking and calibrated-risk gates have not passed. A subsequent
[journey repair](NATIVE_JOURNEY_REPAIR_20261011.md) verified two completed RULE
journeys for one persisted regression seed; it does not establish MODEL acceptance. Fewer
braking events while spending longer stopped is not evidence of better driving.

## Using the comparison

Start the normal dashboard with `Start-YA-RAB-OSTORHA.ps1` and press
**Rules driving** or **YA RAB OSTORHA Model** above the camera. Each button prepares
the scenario, destination, route, 40 vehicles and 30 pedestrians, then drives and
records. A valid RUN claims dashboard control after admission. Nothing trains or
installs when a button is pressed. **Stop comparison**
ends the attempt; sensor/communication failures still require explicit resumption.

The first side persists a `pair_id`, TEST seed, complete scenario recipe, weather,
behaviors, hazard schedules, destination, route and approved initial actor poses.
The other side repeats those starts. Actor poses must agree within 5 cm, velocity
within 0.1 m/s and orientation within 0.01 rad. The final implementation also
resets and holds signal groups during setup, audits their initial state/timing,
then releases normal signal cycles when driving begins. Traffic can react
differently after the initial state. Neither identical future traffic nor model
superiority is claimed.

An occupied walker start can receive a bounded deterministic sidewalk offset
before the first physical approval. The admitted position and correction are
persisted in the pair recipe. After approval, the other side must spawn that exact
position; it cannot silently repair or substitute an approved start.

Lead braking, lateral cut-in, pedestrian crossing and reversing from the curb
come from the existing native Urban Chaos compiler. Scripted vehicle holds release
after five seconds. A persisted schedule is not proof that the ego encountered
every event, or that reactive traffic cannot block the road.

`comparison_v2` accepts these WebSocket messages through the existing control
owner and simulation worker:

```json
{"type":"comparison_v2","sequence":1,"value":{"operation":"RUN","side":"RULE"}}
{"type":"comparison_v2","sequence":2,"value":{"operation":"RUN","side":"MODEL"}}
{"type":"comparison_v2","sequence":3,"value":{"operation":"STOP"}}
```

Concurrent starts are rejected. Interrupted attempts retain their pair and can
repeat. After both sides have terminal results, the next RUN creates a new pair.
Arrival requires native ego position within 5 m of the destination and speed below
0.15 m/s. Collision, 180 simulation seconds, inference failure or bounded wall
time also ends a run. Historical WITHOUT/WITH comparisons retain their old policy,
timeout and result semantics in the expandable historical comparison section.

## Sensor processing, prediction and control

`backend/core/prediction.py` only accepts canonical sensor observations. Measured
speed and IMU yaw rate integrate a fixed odometry frame; no native actor position,
actor identifier, navigation event plan or ground-truth future enters prediction.
LiDAR surface association maintains local IDs, measured dimensions, velocity,
acceleration, history and quality. Three consecutive observations confirm a track.
Occluded tracks expire after 0.3 s and gain uncertainty while retained. Stable
surface sampling avoids inventing motion when cell traversal order changes.
Merged surfaces exceeding 7 m are excluded from object tracking and remain the
responsibility of measured corridor checks; object identity through merged or
ambiguous occlusions is not guaranteed.

The corridor follows a steering-derived bicycle curve with the ego footprint and
a speed margin. Radar consensus estimates ground slope; foreground height filtering
removes ground and low curbs. Weak, isolated forward returns beyond 2 m require
three consistent readings. Clear nearby returns remain immediate. This does not
certify unseen or occluded free space.

A separate CPU YOLO Nano process receives at most one pending image, targeting
5 Hz. It does not share the OCR queue. Detection-to-track association projects
measured track centers into that sensor's calibrated image. Unknown classes retain
geometric motion; classification errors are visible in prediction quality metrics.
Center-in-box association is deliberately modest and remains unvalidated for
dense overlapping detections.

Occupied rectangles are compared at matching times on 31 samples from 0 to 3 s
at 0.1 s intervals. Continue, brake and throttle-requested launch paths are all
logged. A stopped ego evaluates launch risk so a crossing does not disappear at
zero speed. The selected conflict follows the current motion intent; a safe launch
away from a stationary rear object is not vetoed by its stationary-hold overlap.
Distinct prediction modes stay distinct. There is no averaged path between modes.

RULE uses constant velocity, measured distance/TTC and a physics speed target.
MODEL uses the frozen speed head and lightweight learned motion hypotheses for
up to 16 confirmed classified tracks. Others retain geometric prediction. Motion
constraints and measured static regions reject impossible learned paths without
removing the measured object. Steering, navigation, traffic lights, stop signs,
speed caps and pedal conversion are shared. The MODEL supervisor never invokes
the complete RULE supervisor. Missing or invalid model output is fatal.

Both sides share a narrowly scoped emergency brake for measured hazards inside
`3 + 0.15*speed + speed²/(2*5)` metres and insufficient measured stopping coverage.
This can stop a run for unknown space. Three clear readings, the existing minimum
hold and existing brake-release rate govern release. The existing 0.1 s simulation
and 0.25 s wall sensor freshness limits are unchanged.

## Ghost, diagnostics and Replay

The Canvas overlay draws the selected hypothesis, its transparent occupied Ghost,
time until first overlap, amber deceleration/red stopping and a small measured
surroundings map. The map includes observed rear/side objects outside the camera
view; its sensor coverage is approximately x=-10..30 m and y=±9 m. It is not a
complete map of all actors.

Every layer transforms from its evaluation ego frame, through the recorded render
reference, into the **decoded displayed camera** pose and dimensions. Native ego
pose is used for rendering and destination evaluation only. Five camera poses,
session changes and stale image metadata have projection tests. Viewport checks
cover 1366, 900 and 430 px with no page errors or horizontal overflow.

`safetySystem.prediction` carries version, session, evaluation/source frame and time,
odometry reference, trajectories, quality, conflict point and decision source.
`stopDiagnostics` records applied command, braking sources, reason, measured sensor
ages and the safety snapshot, including hold/release counters. Shared navigation
brakes, additional MODEL/RULE brakes, emergency protection, model failure and
communication/sensor faults are distinguished.

Recordings add optional `telemetry/safety-v2.jsonl`. Replay indexes it by exact
evaluation frame; old recordings need no migration. `comparison-controls.jsonl`
also records pre-protection command, applied command, actual native controls and
both weight checksums. Each side has `comparison-v2-result.json`; pair manifests
and attempt history are under `output/comparison_v2/`. Bounded writer errors or
drops mark a recording incomplete rather than silently declaring a valid Replay.

## Models and reproducibility

The Trajectron++ candidate follows the
[original paper](https://arxiv.org/abs/2001.03093) and the official
[int_ee configuration](https://github.com/StanfordASL/Trajectron-plus-plus/blob/ef0165a93ee5ba8cdc14f9b999b3e00070cd8588/experiments/nuScenes/models/int_ee/config.json).
The exact lock is `config/trajectron-lock.json`:

| Artifact | Revision / SHA-256 |
|---|---|
| eccv2020 source | `ef0165a93ee5ba8cdc14f9b999b3e00070cd8588` |
| int_ee config | `3538638ef65601e80dd2ac146d1a3f7ca87fa28fc2936bae2cb2adea2b18923d` |
| model_registrar-12.pt | `3fcc65cd8f48b70fce4965813e503e03c664e027f1f83f8a27d317773a138028` |
| Original frozen GRU | `5b3b793565bb54836d06e450732d4ac75fcb0656bf57810693656ec706c7e629` |
| New trained heads | `511a67dce5a0370f3cdfb2150e4abc74cce103be531aa9d48c96989ddb78a29e` |

`scripts/setup_predictive_v2.ps1` prepares an isolated `.venv-trajectron`, pinned
legacy dependencies and a verified source/asset cache. It exposes existing CPU
Torch libraries read-only; it does not install into CARLA or perception environments.
Compatibility aliases and trusted-pickle loading stay inside the worker. Source
HEAD and tracked modifications are checked before loading. The candidate uses the
official standardization, no map encoder and no robot/future-ego node. Histories
sample at 0.5 s; six future steps cover 3 s. Control-grid interpolation adds no
learned temporal detail. Its 25 modes per object have explicitly uncalibrated
uniform conservative weights.

Inference and IPC run asynchronously with a latest-only queue. Responses from a
different session, future source, source older than 0.75 simulation seconds or
older than one wall second are rejected. The benchmark excludes the cold load
from warm P95 and reports cold load separately. Trajectron++ **is excluded from
live release control** because the complete native gate has not passed. The tiny
NumPy lightweight branch runs with current measurements in the controller;
Trajectron++ remains an independently benchmarked candidate.

The original 13-feature GRU and its weights are preserved. New speed (38→32→1)
and motion (6→16→4) heads were actually trained, exported and frozen. The fit used
1,202 transitions from eleven TRAIN trips, 448 VALIDATION transitions, 10,000
synthetic TRAIN and 2,000 synthetic VALIDATION examples. Metadata distinguishes
original inputs, physics-generated labels and synthetic motion. TEST did not enter
fitting or checkpoint selection. Validation selected epoch 3980 with combined
MSE 0.00138372. The 4,000-epoch fit finished in 16.079 s within its 360 s allowance;
it did not consume the 5–8 minute target unnecessarily. This loss measures offline
label fit, not collision risk calibration or real prediction accuracy.

`--output` must name a new directory for retraining; existing weights are protected.
No retraining occurred after TEST began. Disabling the heads changes both speed
and motion outputs in the ablation. A live ablation demonstrating a causal driving
benefit is still missing.

## Evidence and acceptance

The compact checked-in evidence is under [evidence/predictive_v2](evidence/predictive_v2).
Raw reports, native recordings and screenshots remain in `output/predictive-v2`,
`runs/normal_city` and `output/playwright` respectively.

The first native pilot found a collision in RULE and a later degenerate-bounding-box
division by zero in native diagnostics during MODEL. The pilot and incomplete
recording were preserved. The diagnostic edge case is repaired and unit tested.
Subsequent tests found prolonged stops and destination timeouts. Complete results
and their scope are in [the acceptance record](evidence/predictive_v2/acceptance.json).

All three pairs have six terminal sides: **zero destination arrivals, five
timeouts and one RULE collision**. The interrupted MODEL attempt is retained
separately and was repeated with unchanged weights.

| Pair | RULE result | MODEL result | Waiting proxy RULE / MODEL | Harsh brakes RULE / MODEL |
|---|---|---|---|---|
| 84fe4e0c | Timeout, 180.0 s | Timeout, 180.0 s | 6.2 / 54.8 s | 118 / 21 |
| 1012481b | Timeout, 180.0 s | Timeout, 180.0 s | 3.2 / 9.2 s | 105 / 6 |
| 5973a3b2 | Collision, 124.4 s | Timeout, 180.0 s | 4.1 / 46.6 s | 29 / 17 |

All six terminal recordings finalized without dropped frames/events/trace rows.
Their 15,355 braking diagnostic rows each have a source and reason. This is an
auditability check, not proof that each intervention was necessary. The two earlier
pairs precede the final sensor/signal implementation, so their aggregate is not a
controlled estimate of a learned improvement.

| Gate | Current disposition |
|---|---|
| Pinned pedestrian/vehicle inference and reproducibility | Passed synthetic 16-object workload |
| Warm end-to-end Trajectron++ P95 ≤200 ms | Passed measured workload; cold load separately reported |
| Geometry P95 ≤10 ms | Optimized synthetic workload 9.48 ms; final native pair RULE 7.28 ms / MODEL 7.52 ms. Earlier versions measured 10.94–11.62 ms |
| Native rate degradation ≤10% | Not established against a matched geometric baseline |
| No extra false stops and calibrated VALIDATION risk | Not established |
| Destination completion and meaningful learned benefit | Failed/unproven; timeout and waiting evidence retained |
| Three independent frozen TEST pairs, all hazards encountered | See actual completion/coverage record; recipe inclusion alone is insufficient |
| Learned weights affect speed and predictions | Passed offline ablation; live causal benefit unproven |
| Unit and browser checks | 255 Python tests, one skipped; 59 frontend tests; three viewports |

Waiting is a **proxy**: stopped below 0.2 m/s, safety active, predicted risk CLEAR,
and no base navigation brake. False predicted conflicts can therefore cause waits
outside this counter. Harsh braking counts episode entries below -3 m/s² measured
longitudinal acceleration. Trip duration is simulation time, excluding setup.
No waiting or harsh-braking difference is attributed exclusively to learning.

The final source includes additional diagnostics, signal admission, weak-return
confirmation and stable surface-sampling repairs made after the initial native
runs began. Those earlier runs do not validate every final source change. Complete
empty-road/curb/wall/parked-vehicle/manual-drive validation, native occlusion/ID
switch coverage, measured VALIDATION calibration and all-camera native Replay
rehearsals remain necessary before enabling v2 by default.

The initial matrix observer also suffered a dashboard-heartbeat timeout and reached
its 1,500 s wall allowance. Its partial results are preserved; the resumable runner
continues the missing side with unchanged weights. Heartbeats now have a separate
timer so receiving a slow snapshot does not itself expire the control lease.

## Bounded experiment workflow

The persistent SQLite ledger at `output/predictive-v2/budget.sqlite` enforces the
1,800 s target and 5,400 s hard cap for training and expensive experiments. Training
reserves at most 900 s; each comparison attempt reserves 600 s and stops before
that allowance. Crashed reservations remain charged. Code development and small
unit/browser checks are excluded. An older observer's overlapping matrix/run
reservation was corrected with an explicit accounting record; new observers only
use server-owned per-run reservations. The ledger must not be deleted to extend
this experiment's allowance. Progress and incomplete results are durable.

Final charged time is 3,893.953 s (64.9 minutes), including the full 1,500 s
reservation retained for the crashed pilot. The 30-minute target was exceeded;
the 90-minute hard cap was respected. No further expensive experiments were run
after packaging the results.

```powershell
# Uses the trained frozen heads; never trains during driving.
.\.venv-carla\Scripts\python.exe -m scripts.benchmark_predictive_v2
.\.venv-carla\Scripts\python.exe -m scripts.native.evaluate_predictive_v2 --pairs 3 --wall-cap 1500
# Continue an interrupted matrix with the same frozen weights and missing side.
.\.venv-carla\Scripts\python.exe -m scripts.native.evaluate_predictive_v2 --pairs 3 --wall-cap 1200 --resume

# A separate future TRAIN/VALIDATION fit; protect the frozen TEST artifact.
.\.venv-learned\Scripts\python.exe -m scripts.train_predictive_v2 --seconds 360 --output artifacts/learned_safety/predictive_v2_next

.\.venv-carla\Scripts\python.exe -m unittest discover -s tests -q
npm test
npm run build:dashboard
```

`config/predictive-v2.json` is the release-status manifest, not a hot-reload tuning
API. Admission remains explicitly experimental until the unmet gates above have
measured evidence.
