**YA RAB OSTORHA — Experiment 3A: Efficient Demonstration Collection**

Collected 11 new native TRAIN episodes, all successful and collision-free, with
1,202 verified transitions. No neural network was trained or loaded by the
experiment. This is a small supervised-imitation preparation dataset, not
evidence of a learned safety policy or its generalization.

**Repository and frozen behavior**

Started at `27cea1f46350fb0dd15ef6e842cbd1c413796b34` and created
`codex/experiment3a-demonstrations`. The nine existing modified files and
untracked `scripts/native/verify_gate5_regression.py` were preserved; the original
binary Git patch and script were copied to `output/experiment3a-preserved/`.
The dirty patch and untracked script remained byte-identical. Preservation
evidence is in `docs/evidence/experiment3a/preservation.json`.

Teacher source/configuration, radar screening/retention, observation assembler,
supervisory decoder/gate/validator, rewards and Experiment 1 SAC checkpoint
SHA256 remained unchanged. SAC SHA256:
`9b3bceb0c77aaea8a6cad71600d36f90b1dfbf2277ffad94ea6b91f42f5ac679`.
No production driving module or default controller was changed.

**Collection protocol and outcomes**

CARLA server/API 0.9.16, Town10HD_Opt, 0.05-second steps, existing Sudden Braking
scenario, existing BasicAgent with Experiment 1 hazard handling disabled, and
the unchanged `YaRabOstorhaSafetyTeacher` v1. The existing worker alone applied,
ticked and synchronized the simulator. The teacher proposed braking through
the existing feasibility validator, safety layer and command arbitration.
Steering stayed with BasicAgent; no safety steering was proposed.

Before execution, RNG seed 314161 selected 12 distinct unused seeds from TRAIN
0–999, excluding existing TRAIN metadata seed IDs. No historical held-out
outcomes were opened for selection or calibration. All new episodes remain
TRAIN; no frame-based split was made. VALIDATION 1000–1999 and TEST 2000–2999
were not used. Conditions and frozen hashes were written before the first reset
in `docs/evidence/experiment3a/protocol.json`.

| Seed | Configured ego/lead speed m/s | Gap m | Trigger s | Lead brake | Steps | Progress m | Min clearance m | Avg speed m/s |
|---|---|---:|---:|---:|---:|---:|---:|---:|
| 766 | 8 / 5 | 20 | 2.0 | 1.00 | 125 | 19.92 | 3.69 | 3.19 |
| 356 | 9 / 5 | 23 | 1.4 | 0.80 | 100 | 19.49 | 4.07 | 3.90 |
| 274 | 7 / 4 | 18 | 1.2 | 0.90 | 80 | 11.89 | 3.80 | 2.97 |
| 471 | 10 / 5.5 | 26 | 2.4 | 0.75 | 116 | 26.83 | 3.99 | 4.63 |
| 812 | 8.5 / 6 | 22 | 1.8 | 0.65 | 102 | 20.52 | 4.04 | 4.02 |
| 681 | 7.5 / 5.5 | 19 | 2.6 | 1.00 | 130 | 21.22 | 3.76 | 3.26 |
| 56 | 9.5 / 4.5 | 24 | 1.0 | 0.90 | 93 | 17.11 | 3.68 | 3.68 |
| 104 | 6.5 / 5.5 | 20 | 1.6 | 0.80 | 105 | 18.70 | 4.13 | 3.56 |
| 831 | 8 / 4 | 25 | 2.2 | 0.70 | 112 | 23.43 | 4.36 | 4.18 |
| 980 | 9 / 6 | 21 | 1.3 | 1.00 | 97 | 18.53 | 4.22 | 3.82 |
| 799 | 7.25 / 4.75 | 22 | 2.8 | 0.75 | 142 | 26.25 | 3.83 | 3.70 |

All 11 outcomes were SUCCESS under the existing criteria: useful forward
progress, correct lane, collision-free clearance and verified stopping behind
the stationary leader. Collision counts, callbacks and impulse were zero;
there were no TIMEOUT, ABORTED or SIMULATOR_FAILURE outcomes. Total distance was
223.92 m over 60.10 simulated seconds, with weighted average speed 3.73 m/s.
Completion times ranged from 4.00 to 7.10 simulated seconds.

Configured initialization is distinct from the first sensor observation. The
first observed ego speeds were 5.12–8.62 m/s despite configured speeds of
6.5–10 m/s. Initial intended states and native velocity-initialization metadata
are retained, as are the actual first sensor measurements. Labels use measured
speed, not configured speed; no simulator physics or reset behavior was changed.
Configured relative ego-minus-lead speeds ranged from 1 to 5 m/s.

Seed 464/condition 12 was predeclared but never attempted: the collector reserved
time for episode completion, cleanup and restoration instead of starting it.
There was one native campaign, with 11 attempts total. No extra native tests or
automatic collection expansion followed.

**Dataset layout, dimensions and storage**

Dataset: `runs/demonstrations/experiment3a_20261009T031432Z/`.
Each `TRAIN_<seed>/` contains:

- `transitions.jsonl`: sensor-only inputs/provenance, labels and verified controls.
- `evaluation.jsonl`: separately stored ground truth, collision events, outcome,
  individual rewards and reward measurements, joined only by sample/frame IDs.
- `context.json`: split/seed, full initial configuration, versions, timestep,
  Recorder reference and source hashes. Context is excluded from model inputs.
- `episode.json`: completed outcome, counts, timing and transition diagnostics.

Existing Recorder directories under `runs/rl/TRAIN/<episode_id>/` retain original
assets, complete native telemetry and control/outcome events. Source assets are
referenced, never copied into the demonstration dataset. There are 3,606 unique
pre-action RGB/depth/LiDAR references; terminal sensor assets also remain in the
Recorder. The collection files occupy 34,474,740 bytes (32.88 MiB), with small
additional derived audit/manifest files. Recorder storage is 121,485,380 bytes
(115.86 MiB); combined storage is approximately 148.8 MiB.

The existing `EXPERIMENT2B_DATASET_SPEC.md` is implemented through the strict
`backend/rl/demonstrations.py` loader. Model inputs are exactly 47 finite float32
values: four 11-element onboard/radar/control histories plus current BasicAgent
steering/throttle/brake. The intervention target has three values: gate,
additional braking and steering adjustment. BRAKE is `[1,1,0]`; both
NO_INTERVENTION and RELEASE are `[-1,0,0]`. Final vehicle controls are separately
recorded `[steering,throttle,brake]`, with native acknowledgement.

Each transition retains the full lightweight arrays/masks/history timestamps,
current SensorObservation and local calibration, proposed base ControlCommand,
teacher decision/state/diagnostics and proposed safety action, admission result,
final command and native applied action. Teacher state is diagnostic, not an
input. Absolute timestamps, identifiers, seed, scenario parameters, route,
world poses, actor identity, rewards and outcomes do not enter the 47 values.
The strict loader rejects undeclared model channels and contradictory targets.

**Label balance and examples**

| Decision | Transitions | Percentage |
|---|---:|---:|
| NO_INTERVENTION | 803 | 66.81% |
| BRAKE_INTERVENTION | 385 | 32.03% |
| RELEASE_TO_BASE_DRIVER | 14 | 1.16% |

There are 25 distinct braking bouts across all 11 episodes. All 385 brake
proposals were accepted and applied; the other 817 actions retained the base
driver command. There were zero brief adjacent brake/release edges at or below
150 ms. No teacher steering adjustments occurred. The reward heuristic flagged
five unnecessary-braking steps, all from BasicAgent during NO_INTERVENTION;
zero accepted teacher actions were flagged by that heuristic. This heuristic
does not prove that every intervention was necessary or optimal.

For seed 104, braking began at observed speed 7.99 m/s and radar range 12.03 m
(step 42). At step 56, speed was 0.009 m/s and range 8.64 m, permitting release
through the unchanged hysteresis rule. Final braking began at step 83, speed
4.34 m/s and range 6.10 m. The episode completed with 18.70 m progress and
4.13 m minimum evaluation clearance. These timestamps describe the resulting
trajectory; they were not used to trigger decisions.

**Alignment, isolation and history audit**

All 1,202 actions were paired with the current pre-action observation and the
next native physics frame, exactly one frame/0.05 s later. Full source frames
were durably read through the existing Recorder. Sensor timestamps matched the
source frame, masks matched real retained returns, and previous actions matched
the preceding applied command. Ground-truth/actor removal left the assembled
arrays, 47 features and teacher decisions unchanged at every step.

The audit found zero duplicate source frames, stale sensor channels, missing
required channels, privileged input fields, label inconsistencies, feasibility
rejections or native application mismatches. Asset references exist with the
recorded byte counts; the original Recorder also validates their SHA256 during
capture. `dataset-manifest.json` hashes the immutable collection files and
excludes derived audit/manifest files to avoid recursive checksums.

Foreground radar was present in all 1,202 current observations. Measured
foreground ranges spanned 3.63–20.94 m and closing velocity -5.05–7.92 m/s.
There are no dropout-guard demonstrations. The first three transitions of each
episode contain explicitly masked history padding: 33 transitions have fewer
than four valid rows; 1,169 have all four. This is reset padding, not stale data.
The unchanged acceleration normalization clipped the current longitudinal
feature in 135 transitions; full sensor values remain available for audit.

Ordered, stateful sensor-only replay reproduced all 1,202 decisions and actions.
There were zero identical or coarsened-history label conflicts. However, absence
of such conflicts in a small continuous dataset does not establish Markov
sufficiency. A fresh teacher using only the current frame disagreed on 186
actions. Resetting teacher state before replaying only the last four measured
frames disagreed on 111 actions and 125 decision enums. These counterfactuals
are diagnostics only, not replacement labels. Previous applied controls may
carry useful state clues, so this does not mathematically prove a 47-input model
cannot imitate the teacher. Preserve full episode order and investigate memory
rather than assuming an individual frame or four-frame window is sufficient.

**Resources, safety and regressions**

Native collection plus safe close: 122.81 s. Reload of the inference-free host:
20.44 s. Normal-host restoration: 16.70 s. Total native experimental wall time,
including these operations and instrumentation: 161.015 s, below 180 s.
Collector CPU: 18.34 CPU-seconds; inclusive backend CPU: 107.78 s; CARLA CPU:
279.38 s. These process CPU measurements include rendering/service work and are
not isolated marginal costs or machine-wide totals. Two offline audit passes
took 49.19 wall seconds / 42.20 CPU-seconds in total, outside native execution.

Collector sampled maximum working set was 58.24 MiB and private commit 521.26
MiB; private commit grew 8.76 MiB across the short campaign. A fresh import probe
already used 509.68 MiB private commit without Torch/SB3, so private commit is
not equivalent to resident dataset memory. The backend sampled 561.92–580.04
MiB private commit; CARLA sampled roughly 9,572–9,595 MiB. These are sampled
measurements, not continuous peak measurements or long-term leak proofs.

Existing GPU VRAM samples were 5,868 then 5,864 MiB of 6,144 MiB, with utilization
20% then 54%. No experiment CUDA/model allocation or training was used, and
collection did not use YOLO/OCR. Existing display inference alone was temporarily disabled
through the existing experiment host; native physics/sensor/control modules
were not substituted. Normal display/production host was restored afterward.
Median teacher-plus-retention latency was 1.14 ms (p95 1.56 ms); HTTP physics and
capture latency was 77.73 ms (p95 101.42 ms). Sensor freshness refers to exact
simulation timestamps, not a claim of real-world end-to-end latency.

Every reset verified retired-actor cleanup and two vehicles/seven sensors;
final close restored one vehicle/seven sensors with no walkers/controllers.
No callback/synchronization errors or competing tick owners were detected.
Normal backend was connected and PAUSED afterward, the tick lease released and
production safety policy inactive. No extra native journey was launched beyond
the collection budget; normal driving paths were covered by regressions and
their implementation was unchanged.

Regressions: 180 Python tests, 179 passed/one skipped, zero failures; 24 JavaScript
tests passed. The teacher/radar/dataset focused suite passed all 23 tests. After
strengthening provenance NaN rejection, all four loader tests passed again and
all 1,202 actual transitions passed the final loader. Exact commands and timings
are in `docs/evidence/experiment3a/regressions.json`.

**Changes and readiness**

Added only the strict demonstration loader, bounded collector, offline audit,
experiment host-reload wrapper with separate logs, four dataset contract tests,
this report and evidence JSON/manifest. Native data remains in ignored `runs/`
directories and is not embedded in Git. Existing checkpoints/reports were not
overwritten; the final scoped commit is reported with Experiment 3A completion.

The dataset is suitable for a first small, sequence-preserving CPU Behavior
Cloning feasibility pilot. Binary brake/retain-base action coverage is useful;
release enum coverage is sparse, full history sufficiency remains unproven,
and there are no sensor-dropout, failed-teacher or new-scenario examples. All
episodes end behind a permanently stopped leader, so they do not teach release
after a leader restarts. The teacher's full-brake actions are diagnostic labels,
not comfort-optimal actions or guaranteed expert choices.

A separately authorized next experiment should preserve ordered episodes and
the safety admission path, learn only supervisory intervention, retain release
labels for diagnostics, and evaluate on separate VALIDATION episodes before
fresh TEST evaluation. Previous actions and a small memory mechanism are
reasonable options to investigate; teacher state must not become an input
shortcut. Imitation accuracy alone will not prove native collision avoidance.
No Behavior Cloning, SAC/PPO training or production activation was started.
