**YA RAB OSTORHA — Experiment 2C: radar retention reliability**

All sixteen historical teacher dropouts were resolved using actual radar
measurements. Four new native VALIDATION episodes completed safely with useful
progress, no missing foreground and no brief brake/release chatter. The verified
Experiment 2B teacher source/configuration are byte-preserved. No neural safety model
was loaded or trained, and no production driving policy was changed.

**1. Exact root cause**

Starting HEAD: `61c9ea98b87039325935d693939db4b86c820415`.
Branch: `codex/experiment2c-radar-retention`. Nine existing modified paths and
the untracked Gate 5 regression script were preserved against a binary patch
and file copy under `output/experiment2c-preserved/`; none enter this commit.

The native decoder `backend/carla/sensor_decoders.py:decode_sensor` iterates
**every** current radar detection. `sensor_observation` preserves those measured
fields while removing privileged context. Neither truncates the raw returns.
Two independent experimental consumers then did a stable range sort and top-32
slice: `ObservationAssembler.append` and `YaRabOstorhaSafetyTeacher.propose`.
The foreground screen runs after those slices and cannot recover discarded points.

Each of the sixteen frames had 53–72 raw returns, including 5–24 geometrically
associated lead returns. The first lead return ranked **33–45** by distance;
no lead return survived either top-K operation. The retained low returns supported
the existing ground-plane screen and produced foreground validity zero. This
was retention loss, not raw sensor blindness or a fabricated missing measurement.
[Per-frame source/measurement evidence](evidence/experiment2c/root-cause.json)
includes all sixteen frames. Actor boxes/world poses were used only to evaluate
these associations, never to select or modify sensor observations.

**2. Smallest accepted fix and changed files**

`backend/rl/radar_retention.py`, version `RADAR_RETENTION_V1`, implements the
shared selection and an explicit sensor-input adapter for the unchanged teacher.
`observations.py` replaces its nearest-only slice with that shared selector.
`radar.py` factors the existing V2 consensus plane into reusable pure helpers;
the calibration, thresholds and foreground rule are unchanged. Original versus
refactored foreground indices matched on **all 2,204 historical frames**.

The selector first preserves a working nearest-32 set exactly when it already
contains a forward foreground candidate. Otherwise, when measured foreground
exists outside that set, it reserves half the capacity for foreground returns,
protecting a nearest candidate in each central/left/right bearing sector before
filling that quota nearest-first. It retains six spanning ground-plane inliers
when a supported plane exists, then fills remaining slots with nearest returns.
Output remains range ordered, unique and drawn entirely from current raw values.
The selector uses calibrated local geometry, elevation, bearing and range. It
does not need temporal tracking or radial-velocity extrapolation; measured radial
velocities are preserved exactly. No target is hard-coded as the lead vehicle.

Why preserve a working set: an initial always-reserve candidate recovered the
sixteen drops but changed ground-plane consensus voters and created four new
missing-foreground frames, including VALIDATION 1200/1297. That failed candidate
is preserved in [candidate evidence](evidence/experiment2c/candidate-half-quota-offline.json).
The accepted conditional selector resolves the source-level subset-consensus
problem without changing height thresholds or teacher behavior. Historical TEST
sensor records were diagnostic evidence, not a fresh evaluation set; TEST outcome,
reward and driving scores were not used to calibrate parameters.

The teacher still performs its original internal sort/screen, but the explicit
2C adapter supplies the shared retained set, so that sort cannot discard further
raw detections. Original 2B runs remain reproducible through their recorded
source/inputs and unmodified script; direct unadapted teacher calls retain their
original nearest-32 behavior. No teacher state transition, brake/release threshold,
reward weight, action decoder, success criterion, physics or SAC weight changed.
The observation fields, masks, shapes and **47 policy features** remain unchanged.

Other new files are seven meaningful retention contract tests and the
experiment-only inspection, replay, native, temporary-host/reload and audit
scripts under `scripts/native/`, plus this report and `docs/evidence/experiment2c/`.
The temporary host suppresses only display perception initialization. CARLA
physics, sensors, safety admission, service synchronization and arbitration are
the existing implementations. The normal backend was restored afterward.

**3. Offline before/after measurements**

Replay covers every Experiment 2B recorded frame, including terminal observations.
"Retained lead" means at least one raw geometrically associated return survives
top-K. "Selected lead" means the downstream foreground selector chooses such a
return. These evaluation labels are not a semantic detector or policy input.

| Historical group | Frames | Retained lead before → after | Selected lead before → after | Missing foreground before → after | Ground selected before → after |
|---|---:|---:|---:|---:|---:|
| VALIDATION teacher | 435 | 427 → 435 | 427 → 435 | 8 → 0 | 0 → 0 |
| Historical TEST teacher | 500 | 492 → 500 | 492 → 500 | 8 → 0 | 0 → 0 |
| Historical TEST BasicAgent | 305 | 303 → 305 | 297 → 299 | 5 → 3 | 0 → 0 |
| Historical TEST existing rule | 964 | 901 → 964 | 901 → 964 | 63 → 0 | 0 → 0 |
| Total | 2,204 | **2,123 → 2,204** | **2,117 → 2,198** | **84 → 3** | **0 → 0** |

Raw target-return exclusion fell **81→0 frames**. All sixteen previously identified
teacher frames retain and select the lead after the fix. Teacher recordings alone
improve **919/935→935/935** retained/selected lead frames, with missing foreground
**16→0**. Ground selection uses the existing diagnostic world-height threshold
<0.25 m, distinct from the sensor-only screen.

Three foreground-missing observations remain in historical BasicAgent collision
records even though raw body returns are retained; their returns do not pass the
existing downstream foreground eligibility rule. Three other observations select
non-lead foreground. Neither is force-labeled as a lead or replaced with an
invented measurement. The retained masks identify real measurements; foreground
validity remains separate. Missing foreground still triggers the unchanged
teacher's conservative braking guard, not a clear-road assertion.

All 927 pre-action teacher replay observations satisfy the unchanged space and
47-feature contract. [Offline evidence](evidence/experiment2c/offline.json) records
selection metrics, timing, decisions and transitions. This is observational
replay: changing a decision does not change its historical recorded next state
or reward. No offline collision-avoidance improvement is claimed.

**4–5. Teacher decisions and chatter**

The exact original teacher replay matches every saved 2B teacher decision before
the new adapter is applied. After adaptation, **29/927 decision enums differ**:
14 on VALIDATION 1105, 13 on historical TEST 2164, and two on historical TEST 2938.
The other five teacher episodes have zero differences. Stateful changes can
continue beyond the individual missing frame; no policy threshold was tuned.

| Historical teacher seed | Split | Decision differences | Brake/release edges before → after | Brief intervals before → after |
|---|---|---:|---:|---:|
| 1105 | VALIDATION | 14 | 7 → 3 | 2 → 0 |
| 2164 | Historical TEST | 13 | 7 → 3 | 2 → 0 |
| 2938 | Historical TEST | 2 | 5 → 5 | 0 → 0 |

"Brief interval" is an adjacent brake/release edge interval <=0.15 s, including
brief braking bouts or releases; it is a diagnostic chatter measure, not a tuned
control parameter. All other historical teacher episodes remain at zero. Total
brief intervals decline **4→0** on the same recorded sensor trajectories. This
does not predict the counterfactual closed-loop outcome of those changed actions.

**6. Bounded native VALIDATION**

The protocol was recorded before testing, after the offline gate passed and the
retention/source hashes were frozen. `random.Random(314160)` sampled four unused
VALIDATION seeds from 1000–1999 using only metadata seed IDs. No new TEST seed was
used. All runs use real CARLA 0.9.16, the existing Sudden Braking scenario,
Town10HD_Opt, existing vehicle/sensors, fixed timestep 0.05 s, initial lead target
speed 5 m/s and episode limit 12 s.

| Seed | Ego target m/s | Following m | Trigger s | Lead brake | Outcome | Progress m | Min clearance m | Avg speed m/s | Completion s | Bouts |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|
| 1004 | 10.00 | 23.0 | 1.4 | 0.80 | SUCCESS | 19.336 | 4.249 | 3.907 | 4.95 | 2 |
| 1877 | 9.25 | 25.0 | 2.2 | 0.75 | SUCCESS | 25.677 | 4.427 | 4.316 | 5.95 | 2 |
| 1256 | 7.25 | 18.0 | 1.0 | 1.00 | SUCCESS | 11.929 | 3.795 | 2.946 | 4.05 | 2 |
| 1364 | 8.75 | 21.5 | 3.0 | 0.65 | SUCCESS | 27.562 | 3.832 | 3.700 | 7.45 | 3 |

All four had zero collisions/impulse, zero unnecessary-intervention steps under
the existing heuristic, and zero brief intervals. Braking remains aggressive:
hard-braking event counts were 9, 8, 4 and 10, including BasicAgent behavior.
Existing success criteria were unchanged: collision-free, in-lane progress >=10 m,
clearance >=2 m, ego and lead stopped for >=0.5 s after the trigger.

All **448 actions** had a single simulation-worker tick owner, consecutive frames
and exact 0.05 s simulation increments. All **146 brake proposals** were admitted
and matched native applied axes/source (absolute tolerance 1e-5). No steering
adjustments were proposed. The server's returned retained radar arrays matched
the local shared selector exactly before each decision: the new assembly code
was exercised in the native service, not merely in a local replay.

Every reset verified cleanup and inventory 2 vehicles / 7 sensors / no walkers
or walker controllers; every close restored 1 vehicle / 7 sensors. All **452 native
recorded frames** retained and selected the lead, with no missing foreground or
ground selections. Camera/depth/LiDAR assets are original Recorder references:
1,356 references / 34.25 MiB, with 36 sampled checksum validations, no duplicated
binary recordings. Complete frames and independent reward components were saved.

An unadapted legacy teacher shadow on the *new* trajectories missed foreground
on five pre-action frames; the adapted teacher missed none. The shadow had one
brief interval versus none for applied control. These shadows are not old-policy
closed-loop runs, and the four changed conditions are not matched 2B re-runs.

Native synchronization had no increases in stale, duplicate, out-of-order, late
or timestamp-mismatch counters. Eight incomplete warmup frames / 48 missing
warmup channels were recorded by the existing reset/close mechanism; none entered
the policy or the 452 episode frames. Normal backend restoration was verified:
connected, PAUSED, seven sensors, RGB 800×450, RL inactive and no active teacher.
No separate live manual/Start Journey drive was performed after the four-episode
budget; production source and ownership regressions are unchanged/passing.

[Native outcomes](evidence/experiment2c/native.json),
[predeclared protocol](evidence/experiment2c/protocol.json) and
[verification](evidence/experiment2c/verification.json) provide the durable evidence.
Full scalar/action traces and original assets remain under
`runs/diagnostics/experiment2c_20261008T223734Z/` and referenced `runs/rl/VALIDATION/` runs.

**7. Observation isolation and preserved behavior**

Ground-truth/actor removal leaves all **927 offline** and **448 native** teacher
decisions unchanged. Offline 47-feature vectors are also unchanged by removing
those channels. Contract tests reject a SimulationFrame at the adapter boundary,
privileged radar fields and invalid/nonfinite measurements. Multi-bearing fixtures
verify recovery can preserve other foreground hazards rather than a designated
lead return. Measurements, timestamps, calibration and masks are preserved.

Teacher SHA256: `2b4f28e2be17ced5fd588828c4db0bc45a5df51654abf43a3481c4fcbc494124`.
Config SHA256: `f3bf24d3b1be242fa2654510e78a3ad3af66c7cf7d9f2cbff035f3a8eda16388`.
SAC SHA256: `9b3bceb0c77aaea8a6cad71600d36f90b1dfbf2277ffad94ea6b91f42f5ac679`.
Production modules, sensor decoding, admission/arbitration, scenario success,
reward, action gates and model normalization are unchanged. No policy is active
in manual or normal autonomous driving.

**8. CPU/GPU/memory/runtime costs**

Final offline pass: **51.94 s wall / 45.55 process CPU seconds**, private memory
75.30 MiB, peak working set 59.44 MiB. The preserved failed candidate audit used
50.36 s wall / 45.44 CPU seconds; an earlier failed diagnostic pass was not fully
resource-instrumented. These are separate development passes, not a training run;
they were needed to reject the subset-consensus defect before native testing.

Across 2,204 frames, old foreground screening median/p95 was **0.599/1.613 ms**;
new retention plus foreground screening **0.901/2.253 ms**. Retention alone was
0.461/1.173 ms. Original sort/conversion and sensor capture are outside these
microbenchmarks; no claim of a production end-to-end latency gain is made.

Exactly **four native episodes / 448 actions / 45.657 s** including episode
reset/close were executed. Backend reload and normal-host restoration took
21.453 + 16.797 s, bringing native-associated elapsed time to **83.907 s**.
Runner CPU was 6.422 s; sampled backend and CARLA process CPU deltas were
40.078 and 101.000 s, respectively (CPU time can exceed wall time across cores).
These deltas exclude host-reload CPU and unrelated system processes.

Native runner private memory rose 30.39→38.20 MiB; backend 90.59→97.48 MiB;
CARLA 9549.39→9593.98 MiB (+44.59 MiB). Actor counts remained stable, but short
samples do not establish long-term memory stability. Native teacher timing,
including retention and a second isolation-check invocation, had per-episode
medians 3.46–3.57 ms and maximum 6.81 ms. Step/capture/HTTP/recording median was
67.94–70.56 ms; this controlled stepping is not real-time 20 Hz readiness.

No new model GPU allocation, OCR/YOLO dependency or graphics change occurred.
Display inference was disabled on the temporary native host, then normal display
service startup was restored. The post-restoration GPU snapshot was
5865/6144 MiB, existing RTX 3060 Laptop workloads; this is not incremental model
VRAM. Scientific runtime threads were capped at one for replay/native CLI work.

**9. Regressions and known environment limitation**

Correct project CARLA runtime: **176 tests run, 175 passed, one inapplicable
absent-SDK test skipped**, 7.365 s. Seven new retention tests cover recovery,
multi-bearing coverage, working-set preservation, ground support, actual value
preservation, missing/invalid measurements and contract isolation. Existing
teacher, supervisor, observation, ownership, recording/replay and driving tests
also pass. JavaScript **24/24 passed**, 0.331 s. Compilation/diff checks pass.

An initial full-suite probe in the SDK-absent RL-only interpreter failed seven
absence-check subtests and skipped seven tests: native sensor/collision entry
points returned exit code 1 instead of the required absent-SDK exit code 2.
The existing entry-point sources were not changed; this separate preflight limitation remains
outside 2C. [Failed probe log](evidence/experiment2c/regression-runtime-probe.txt)
is preserved rather than hidden. No dependency installation or unrelated entry
point fix was performed.

**10–11. Commit and behavior-cloning readiness**

The final task response records the scoped commit hash. Pre-existing dirty work
remains outside it. The four-episode authorization is exhausted; no more episodes
were run or scheduled, and no fresh final TEST data was consumed.

The evidence supports collecting a **small, reviewed TRAIN demonstration dataset
for this same controlled scenario**, under separately authorized collection and
the existing [dataset specification](EXPERIMENT2B_DATASET_SPEC.md). Record retention
version/source hash alongside teacher version, observation masks, proposed base
control, admitted/applied actions and outcome/reward diagnostics. Do not turn
these VALIDATION or historical TEST episodes into TRAIN samples.

Readiness is bounded: the selector preserves a working nearest set, so it does
not guarantee every secondary hazard outside its capacity is retained. Sparse
returns, angular/elevation limits, steep slopes, low obstacles and erroneous
ground-plane hypotheses remain risks. Genuine no-foreground data still causes
conservative braking and could deadlock on an unobserved clear road. Review
aggressive braking and state-dependent labels before imitation. This pilot
establishes observation reliability/progress evidence on one prototype, not
general collision prevention, new RL learning or production readiness.
No behavior cloning, RL training or production activation was started.
