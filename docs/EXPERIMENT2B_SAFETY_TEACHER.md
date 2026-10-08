**YA RAB OSTORHA — Experiment 2B: native safety teacher pilot**

The separately identified diagnostic teacher completed **4/4 changed VALIDATION
conditions and 4/4 fresh TEST conditions without collision**, while making useful
forward progress. Matched TEST BasicAgent runs collided 4/4; the existing
conservative rule timed out 4/4 while nearly stationary. This is a small native
CARLA pilot, not trained-policy performance or evidence of general reliability.
Brief brake/release chatter and radar retention gaps remain unresolved.

**1. Repository preservation**

Starting HEAD was `4a52b8139dbfe1d8b846ca484b090b5dbfb118a7`. Experiment 1.1
`3d3684f7` remains an ancestor. Work is on `codex/experiment2b-safety-teacher`.
Nine existing modified files and the untracked Gate 5 regression script were
preserved, excluded from this experiment's commit, and checked against the
pre-experiment recovery copy under `output/experiment2b-preserved/`.

The production provider, scenarios, contracts, service, control, safety policy,
research module, RL runtime/reward/environment, action decoder, radar selector
and observation assembler are unchanged from Experiment 2A (allowing Windows
checkout line endings). Success conditions, physics and reward weights are
unchanged. Frozen SAC was neither loaded nor overwritten; its SHA256 remains
`9b3bceb0c77aaea8a6cad71600d36f90b1dfbf2277ffad94ea6b91f42f5ac679`.

**2. Teacher architecture and states**

`backend/rl/teacher.py` defines `YaRabOstorhaSafetyTeacher`, a rule-based
additional-braking supervisor. It receives only the existing `SensorObservation`
and current BasicAgent `ControlCommand`. It does not receive a scenario, route,
actor identity/transform, goal odometer, reward, seed or future trigger.

The stationary-target stopping envelope is
`R_required = clearance + speed * reaction_allowance + speed² / (2 * assumed_deceleration)`.
Range is measured from the calibrated radar origin, not a privileged vehicle
bounding box. The margin also covers uncertainty in that geometric offset.
The radial motion estimate is `speed*cos(azimuth)*cos(altitude) + radar_velocity`,
with a three-measurement median. It is an uncertain straight-lane approximation;
it only names approach states and does not predict future lead braking.

| State | Physical condition and output |
|---|---|
| MONITORING | Outside the envelope: NO_INTERVENTION. Inside it with closing motion or proposed throttle: BRAKE_INTERVENTION. |
| PROTECTIVE_BRAKING | Hold braking through a full protective stop, including temporary opening range. Missing foreground also enters this state. |
| SAFE_RELEASE | At ego speed <=0.2 m/s and measured range >5 m, RELEASE_TO_BASE_DRIVER; subsequent frames are monitored again. |
| FINAL_APPROACH | Protective braking with estimated target motion <=0.5 m/s. No memorized final-stop timestamp. |
| SAFE_STOP | Stopped near the observed object, range <=5 m. Hold until measured range opens beyond 5 m. |

The three public decisions are NO_INTERVENTION, BRAKE_INTERVENTION and
RELEASE_TO_BASE_DRIVER. Brake proposals remove throttle, increase braking,
preserve the base steering/gearing, and pass the existing experimental
`TrainingRadarFeasibilityValidator` implementation of the safety-validator
protocol, `admit_proposal`, control safety layer and `CommandArbiter`.
Steering space is not certified; the teacher never proposes a steering change.
Missing detections cause protective braking, never a clear-road assertion.

The CLI selects the existing controlled scenario Gymnasium environment explicitly.
The service's simulation worker remains the only tick owner. It applies, ticks,
captures and records the real world. The CLI reads the flushed current frame from
the existing Recorder and projects it through `sensor_observation`; it creates
no CARLA client and reads no camera/depth/LiDAR image bytes for decisions.
The unchanged 47-feature projection is recorded for future supervised learning.

**3. Parameters and calibration evidence**

Versioned configuration: `backend/rl/teacher_config_v1.json`,
`YA_RAB_OSTORHA_TEACHER_V1`.

| Parameter | Frozen value | Rationale and uncertainty |
|---|---:|---|
| Minimum range margin | 3 m | Above the existing 2 m evaluation clearance requirement; radar range and footprint clearance differ. |
| Reaction allowance | 0.35 s | Existing interpretable starting allowance; not measured production end-to-end reaction time. |
| Assumed deceleration | 5 m/s² | Historical VALIDATION full-brake stroke: 8.027→0.018 m/s, 3.659 m, energy-equivalent 8.805 m/s². Retain a lower assumption; not a wet-road or universal physical bound. |
| Additional brake | 1.0 | Existing validated full-braking action; aggressive, not comfort-optimized. |
| Release hysteresis | 2 m | Release only after a stop and range >3+2 m, allowing a subsequent cautious approach. |
| Stopped speed | 0.2 m/s | Existing low-speed measurement threshold. |
| Estimated stationary lead | 0.5 m/s | State naming only; not the success evaluator's ground-truth leader threshold. |
| Maximum observation age | 0.10 s | Simulation-clock guard; native observations were exactly current. |

Only existing VALIDATION trajectories informed calibration. Three targeted
offline checks compared deceleration 4 and 6 m/s² and release hysteresis 1.5 m
against the nominal configuration. Decisions differed on respectively 10/610,
17/610 and 0/610 observations. There was no grid search, parameter change after
these checks, native calibration iteration, reward tuning or neural training.

**4. Historical offline verification**

Replay used 610 real pre-action VALIDATION frames: 272 collision-trajectory
frames, 240 stationary frames and 98 successful-script frames. Counterfactual
actions were validated and arbitrated, but recorded rewards/next states still
belong to the historical actions; offline replay does not simulate their outcomes.

| Recorded group | NO_INTERVENTION | BRAKE_INTERVENTION | RELEASE | Rejected proposals |
|---|---:|---:|---:|---:|
| Four collision trajectories | 128 | 144 | 0 | 0 |
| Stationary trajectory | 232 | 4 | 4 | 0 |
| Successful script, seed 1042 | 82 | 14 | 2 | 0 |

**28/98 decisions differ from the successful script**, deliberately allowing
initial progress instead of copying its timed initial brake. The collision
replays first request braking at 1.60 s, before the recorded 3.40 s impact; this
alone is not proof of avoidance. The stationary replay's four brake/release
pairs are triggered by absent foreground returns and expose a chatter risk.
The successful replay has one absent-foreground brake.

All 610 frame decisions were invariant when actor and ground-truth channels were
removed. Existing feasibility/arbitration accepted every braking proposal and
retained base steering. Contract tests reject duplicate/backwards frames,
stale sensors, mismatched base commands, excessive age and invalid parameters.
These are contract tests, not mock vehicle physics.

**5. Native VALIDATION**

Four previously unused VALIDATION seeds were chosen before execution, scanning
only stored metadata seed IDs. Lead initial speed was 5 m/s and time limit 12 s.
All use the real existing Sudden Braking scenario on CARLA 0.9.16,
Town10HD_Opt, fixed timestep 0.05 s. Configured speeds are target initialization;
post-warmup measured speeds differ and are recorded separately.

| Seed | Ego m/s | Following m | Trigger s | Lead brake | Outcome | Progress m | Minimum clearance m | Average m/s | Duration s | Intervention bouts |
|---|---:|---:|---:|---:|---|---:|---:|---:|---:|---:|
| 1200 | 6.0 | 20 | 1.4 | 0.7 | SUCCESS | 16.829 | 4.043 | 3.366 | 5.00 | 2 |
| 1285 | 7.5 | 22 | 2.6 | 1.0 | SUCCESS | 22.852 | 4.221 | 4.081 | 5.60 | 2 |
| 1297 | 9.0 | 18 | 1.6 | 1.0 | SUCCESS | 15.141 | 4.223 | 3.403 | 4.45 | 2 |
| 1105 | 10.0 | 24 | 1.1 | 0.8 | SUCCESS | 18.932 | 4.011 | 2.913 | 6.50 | 4 |

Collision count/impulse were zero throughout. Initial braking began at 2.10,
2.55, 1.40 and 0.10 s respectively, rather than a fixed time. Seed 1105's early
braking was caused by eight missing foreground selections. It had a brief
0.05 s release followed by another brake; this is an observed imperfection,
not a clean oscillation-free pass. No episode remained stopped indefinitely.

**6. Freeze and fresh TEST protocol**

Protocol was written before native execution. Python `random.Random(314159)`
sampled four unused seeds from VALIDATION 1000–1999; `random.Random(271828)`
sampled four unused seeds from TEST 2000–2999. No trajectory data informed the
draw. Historical TEST 2042–2049 was excluded. The protocol records previously
used seeds, parameter assignment and counterbalanced controller order.

After all four VALIDATION successes, configuration and source were frozen at
`2026-10-08T21:32:26.223563+00:00`, before any TEST reset:

- Config SHA256: `f3bf24d3b1be242fa2654510e78a3ad3af66c7cf7d9f2cbff035f3a8eda16388`.
- Teacher source SHA256: `2b4f28e2be17ced5fd588828c4db0bc45a5df51654abf43a3481c4fcbc494124`.

Both hashes still match after TEST. No TEST-driven changes were made.

| Fresh TEST seed | Ego m/s | Following m | Trigger s | Lead brake |
|---|---:|---:|---:|---:|
| 2709 | 6.5 | 19 | 1.3 | 0.80 |
| 2835 | 8.5 | 21 | 2.1 | 1.00 |
| 2164 | 9.5 | 23 | 1.7 | 0.65 |
| 2938 | 7.0 | 20 | 2.8 | 0.90 |

**7–8. Matched held-out comparison and metrics**

A is BasicAgent with Experiment 1's existing hazard settings
(`ignore_vehicles`, `ignore_traffic_lights`, `ignore_stop_signs`: true; target
28 km/h). This is deliberately that baseline, not all possible BasicAgent
configurations. B is the unchanged conservative rule, including its original
raw nearest-radar threshold. B does not silently inherit the new teacher's radar
selection or release logic. C is the frozen teacher plus the same BasicAgent.

All four matched triplets had identical scenario specs, map, ego blueprint,
timestep, intended positions and velocity initialization. Maximum recorded
position/initialized-velocity difference was **0.000 m / 0.000 m/s**. This does
not claim bit-identical CARLA sensor sampling or physics thereafter.

| TEST metric (four episodes per controller) | A: BasicAgent | B: existing rule | C: teacher |
|---|---:|---:|---:|
| Collisions | 4/4 | 0/4 | **0/4** |
| Successes | 0/4 | 0/4 | **4/4** |
| Timeouts | 0/4 | 4/4 | 0/4 |
| Mean peak collision impulse N*s | 15,240.48 | 0 | 0 |
| Mean forward progress m | 24.017 | 0.795 | **20.140** |
| Mean distance traveled m | 24.017 | 0.797 | 20.143 |
| Mean average speed m/s | 6.367 | 0.066 | **3.250** |
| Mean minimum clearance m | 0 | 15.500 | 3.810 |
| Smallest clearance m | 0 | 14.016 | **3.727** |
| Minimum valid evaluation TTC s | 0 | 3.964 | 1.181 |
| Mean episode duration s | 3.763 (failure) | 12 (timeout) | **6.20 (completion)** |
| Mean intervention bouts | 0 | 8 | 3 |
| Mean unnecessary-intervention steps | 0 | 231.5 | 2.5 |
| Mean hard-braking events | 4.75 | 1.00 | 5.75 |

Intervention bouts count transitions into accepted safety control; they are
different from intervention steps. "Unnecessary" is the unchanged evaluation
heuristic: accepted braking with ground-truth clearance >12 m and TTC >5 s or
undefined. It is not proof that braking with uncertain radar is unjustified.
Hard braking counts entry into measured longitudinal deceleration <=-4 m/s²,
including base-driver behavior. Ground-truth clearance/TTC are evaluation only.

| TEST teacher seed | Progress m | Minimum clearance m | Average m/s | Completion s | Bouts | Unnecessary steps | Hard-braking events |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2709 | 15.251 | 3.927 | 3.245 | 4.70 | 2 | 0 | 4 |
| 2835 | 21.411 | 3.727 | 3.320 | 6.45 | 3 | 0 | 9 |
| 2164 | 21.604 | 3.825 | 3.178 | 6.80 | 4 | 10 | 5 |
| 2938 | 22.292 | 3.760 | 3.255 | 6.85 | 3 | 0 | 5 |

For example, seed 2709 first brakes at 1.90 s: measured speed 7.197 m/s,
range 10.452 m, envelope 10.699 m, closing velocity 6.052 m/s. At 2.55 s it
releases at measured speed 0.010 m/s and range 7.079 m. It brakes again at
3.70 s: speed 3.498 m/s, range 5.312 m, envelope 5.448 m. These times are
observed consequences of physical conditions, not inputs to a timed script.

**9. Resources and recordings**

Exactly **16 native episodes / 2,188 physics actions / 223.062 s wall time**,
including resets and restoration, were executed. Limits were 16 / 900 s;
the episode budget is exhausted. Native runner CPU was 24.766 process-seconds.
Offline replay used 14.138 s wall / 11.781 process CPU seconds; post-run evidence
audit used 24.856 s wall / 21.328 process CPU seconds. These exclude imports,
development, tests and backend/CARLA CPU; total system CPU was not instrumented.

Native runner private memory rose 30.34→43.05 MiB (sampled maximum 43.05).
Backend private memory fell 708.45→584.98 MiB. CARLA rose
9507.10→9563.38 MiB (+56.28 MiB), without actor growth. These short-run samples
do not establish long-term memory stability. Offline replay's measured peak
working set was 52.21 MiB; private memory at exit was 520.41 MiB, including the
scientific runtime's reservations. Native execution capped OpenBLAS/OMP threads
at one and used far less private memory.

No neural model was loaded, no new model GPU allocation occurred, and no
graphics settings were increased. Read-only post-run GPU snapshot: RTX 3060
Laptop, 5871/6144 MiB in use by existing workloads; this is not incremental
experiment VRAM. No YOLO/OCR inference is needed by the teacher.

Teacher decision timing includes a second isolation-check teacher invocation:
median **2.127 ms**, p95 **3.632 ms**, max **5.422 ms**. It is not a pure inference
benchmark. Median step/capture/HTTP/recording response was 80.518 ms, p95
111.555 ms, max 231.057 ms. Sensor age at decision was 0 s on the simulation
clock. This controlled stepping result does not establish real-time 20 Hz
production readiness or wall-clock freshness under a continuously ticking world.

Run: `runs/diagnostics/experiment2b_20261008T213139Z/`, with protocol, frozen
source/configuration, budget ledger, scalar decision/action/reward traces and
asset references. The original Recorder holds each episode under
`runs/rl/VALIDATION/` or `runs/rl/TEST/`. There are 2,204 complete frames and
6,612 original sensor asset references totaling 166.87 MiB; binaries were not
copied into the experiment traces. All frame references were audited; 144 asset
checksums were sampled at initial, penultimate and terminal frames.
Every reward component is logged independently and sums to the recorded outcome.

**10. Sensor, command and runtime verification**

All 2,188 steps had the single `simulation-worker` tick owner, consecutive
frame IDs and 0.05 s increments. Every expected admitted command matched both
reported and acknowledged native applied axes (absolute tolerance 1e-5) and
source. All **308 teacher brake proposals were accepted**, with no rejection
or steering adjustment. Ground-truth removal preserved all **927 native
teacher decisions**. Recorded 47-feature vectors were finite and bounded.

Every reset verified prior-episode cleanup with 2 vehicles / 7 sensors /
0 walkers / 0 controllers; every close restored 1 vehicle / 7 sensors /
0 walkers / 0 controllers. The existing manager safely recreated sensor actors
on reset/restore; actor IDs changed rather than accumulating. Callback/channel IDs were
unique, sensor errors were empty, and stale/duplicate/out-of-order/timestamp
mismatch counters did not increase. The service's warmup/close process did
increase incomplete-frame counters by 32 and missing-channel counters by 192
(two warmup frames per episode). Those incomplete frames never entered the
teacher or its 2,204 recorded episode observations.

Final read-only state check: connected, PAUSED, RL lease inactive, policy inactive,
no pending requests, seven current actors from the existing sensor suite, normal RGB restored to
800×450. The final cached TIMEOUT belongs to baseline B, not the teacher.
Manual and Start Journey source paths are unchanged; their ownership/mode
regressions passed. A new live manual/Start Journey drive after this pilot was
not performed, because the native episode budget was already exhausted.

**11. Regressions**

Python: **169 run, 168 passed, 1 skipped**, 4.066 s. The skip is the absent-CARLA-SDK
test, inapplicable with CARLA installed. JavaScript: **24/24 passed**, 0.319 s.
The seven new teacher tests cover the physical state transitions, missing radar,
existing admission, preserved steering, stop/release hysteresis, clock-shift
invariance, freshness and forbidden input types. Existing tests cover observation
isolation, action bounds, exclusivity, replay/recording, navigation and UI behavior.

**12. Changed files and evidence**

Only the new teacher/configuration, teacher contract tests, experiment-only
replay/native/audit/plot helpers, this report, dataset specification and
`docs/evidence/experiment2b/` are included in the experiment commit. The commit
hash is reported in the task's final response.

- [Offline replay](evidence/experiment2b/offline.json) and [decisions](evidence/experiment2b/offline-decisions.jsonl).
- [Predeclared protocol](evidence/experiment2b/protocol.json) and [freeze lock](evidence/experiment2b/frozen-config.json).
- [Native episode outcomes](evidence/experiment2b/native.json), [evidence audit](evidence/experiment2b/analysis.json) and [preservation/restoration verification](evidence/experiment2b/verification.json).
- [Matched comparison figure](evidence/experiment2b/comparison.png).
- [Future imitation dataset specification](EXPERIMENT2B_DATASET_SPEC.md).

**13. Proven findings and limits**

Proven within this pilot: safe completion and useful progress on eight changed
conditions, including four fresh TEST seeds, with existing admission/application,
sensor-only decisions and correct cleanup. No collision or persistent stopping
deadlock occurred. No new policy steering occurred.

Remaining issue: **16 teacher frames had no foreground because all lead-associated
raw radar returns lay outside the nearest 32 retained points**: eight on VALIDATION
1105, seven on TEST 2164, one on TEST 2938. Diagnostic association uses ground truth
only in the separate audit. Raw sensing saw the lead; bounded retention lost it.
The missing-data brake guard prevented an unsafe clear-road assumption but caused
extra braking. Both 1105 and 2164 include a brief 0.05 s brake/release cycle. The
teacher therefore is not cleanly free of control chatter, despite completing.

Eight runs on one straight-lane prototype, one map, vehicle and weather, with
limited speed/gap variation do not establish reliability across real traffic,
curves, slopes, low obstacles or low grip. Seeds are fresh, but parameter ranges
and scenario structure are close to historical demonstrations. The lead brakes
and remains stopped; native lead-resumption behavior was not tested. Full braking
and stop-then-release can be inefficient or uncomfortable. Complete absence of
foreground on a clear road would keep this teacher braking; absence is unresolved
uncertainty, not proof of clearance. Its near-object stopping behavior should not
be generalized to an always-on production supervisor.

**14. Recommendation for Experiment 3**

First address bounded radar retention and dropout-driven release chatter using
VALIDATION-only offline evidence and a newly authorized small native check. Keep
this TEST set sealed against retuning; any revised teacher needs a newly designated
TEST set. Improve retention using legitimate radar geometry/measurements rather
than actor labels, without treating a missing return as clear space. Then collect
separate TRAIN demonstrations under a frozen revised teacher and review rare
states before a small CPU behavior-cloning feasibility study. Behavior cloning
would be supervised imitation, not new reinforcement learning; any later RL
fine-tuning requires separate authorization and fresh matched evaluation.
No training, further episodes or production activation was performed or scheduled.
