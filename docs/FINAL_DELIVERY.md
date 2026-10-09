# YA RAB OSTORHA — final prototype

RULE remains the always-on default for forward manual and normal BasicAgent
driving. The compact, genuinely trained behavior-cloning model can propose
braking in experimental HYBRID mode. Its independent RULE guard enforces both
protective braking and safe release. Standalone LEARNED failed progress tests
and cannot be selected in normal driving. Imitation is **not reinforcement
learning**, and the hybrid pilot does not demonstrate learned safety improvement.

## Start and drive

From the existing Windows checkout:

```powershell
.\Start-YA-RAB-OSTORHA.ps1
```

This uses the verified `C:\CARLA\CARLA_0.9.16` installation and existing
`.venv-carla`, reuses a connected project host, or launches CARLA and the backend
with seven sensors. The dashboard is at http://127.0.0.1:8000/. Startup is paused,
with RULE enabled. No installation or training happens during startup. Logs are
under `output/final-delivery/`.

Take control in Settings; enable manual driving and focus the dashboard. W/A/S/D
retain their existing behavior, Shift+W increases throttle and Space handbrakes.
For autonomous driving select a destination and Start Journey. BasicAgent's
normal native hazard handling remains enabled. Stop driving brakes the vehicle;
resuming requires an explicit request. Traffic, walkers, navigation, cameras,
recording and Replay retain their existing interfaces.
Use the existing population settings to apply BALANCED traffic/walkers; startup
and controlled comparisons use zero background population. A disconnected stalled
project host is restarted with the same graphics profile by the startup command;
an already connected driving session is reused.

Settings offers RULE, experimental HYBRID, and an at-rest safety-disable research
comparison. Standalone LEARNED is unavailable in normal driving. The live status
shows mode, risk, reason, model availability/acceptance and actual generator:
`LEARNED_BC`, `RULE_GUARD`, `RULE_FALLBACK`, `RULE` or `BASE_DRIVER`.
Rule-enforced release is identified explicitly. Model failure, low confidence,
missing foreground radar or unsupported speed/turning uses measured RULE
fallback. Stale/malformed required sensors still stop driving through the
existing watchdog. All proposals pass feasibility admission and the existing
command arbiter. No second tick owner, learned steering or neural vision worker
is introduced. OCR/YOLO remain independent display tools.

## Repeatable real demonstration

With the dashboard/backend running, these commands use the existing controlled
front-obstacle scenario and production WebSocket controls. Run sequentially;
each ends stopped, clears scenario actors and restores RULE. The scripted
manual command uses the same service interface as WASD. Do not drive from the
dashboard concurrently with the demonstration owner.

```powershell
# Manual constant-throttle comparison: actual collision without safety.
.\.venv-carla\Scripts\python.exe -m scripts.native.verify_final_delivery --demo BASE --manual
# Matched RULE braking, safe release and progress.
.\.venv-carla\Scripts\python.exe -m scripts.native.verify_final_delivery --demo RULE --manual
# Normal BasicAgent with RULE, then separately identified experimental HYBRID.
.\.venv-carla\Scripts\python.exe -m scripts.native.verify_final_delivery --demo RULE
.\.venv-carla\Scripts\python.exe -m scripts.native.verify_final_delivery --demo HYBRID
```

These commands do not train anything. The controlled hazard vehicle physically
resumes after seven simulation seconds to demonstrate recovery. That actor
schedule is scenario control only, never a policy input. A permanent obstacle
without a safe passage must cause a stop; continuing through it is not success.
BasicAgent alone avoided collisions in this autonomous pilot, so the collision
contrast is demonstrated by the **manual** comparison, not falsely attributed
to an autonomous improvement. Full recordings can be opened with
`python -m backend.server --replay <recording-path>` using `.venv-carla`.

## Learned model and training

Weights, configuration, curves and provenance are committed under
`artifacts/learned_safety/v1/`. `checkpoint.pt` is the learned PyTorch checkpoint;
`weights.npz` is the checked, pickle-free NumPy inference export. Runtime needs
neither PyTorch nor CUDA and adds approximately 0.1 ms median inference.

The network is `torch.nn.GRU(13,32) → Linear(32,3)`, 4,611 parameters. Inputs are
onboard speed, longitudinal IMU acceleration, yaw rate, previous applied controls,
screened radar range/radial velocity/TTC/validity and the proposed base controls.
The recurrent state carries ordered history across steps, resets on mode/session
changes and sensor gaps, and never contains teacher state or ground truth.
Acceleration uses a separate ±20 m/s² scale instead of the historical clipped
±10 scale. The original Gym/SAC **47-dimensional** contract is unchanged.
Outputs are NO_INTERVENTION, BRAKE_INTERVENTION or RELEASE_TO_BASE_DRIVER.
Braking remains bounded and feasibility validated; steering adjustment is zero.

One supervised training run used all 11 TRAIN episodes / 1,202 transitions and
four separate historical VALIDATION episodes / 448 transitions. No final TEST
data trained/calibrated the network. Whole episodes remain separate and ordered;
no duplicated frames or synthetic labels were added. Class-weighted cross entropy
uses square-root inverse-frequency weights for counts 803 / 385 / 14. Adam uses
learning rate 0.003, weight decay 1e-5 and gradient norm clipping 1.0. Best epoch
305; early stopping at 455. Seed 20261009; model weights remain frozen thereafter.

RTX 3060 Laptop, driver 617.14; an isolated PyTorch 2.11.0+cu128 / CUDA 12.8
environment reused the cached official CUDA wheel. Existing environments were
preserved. CARLA was cleanly disconnected/stopped for training and restored with
the same graphics settings. Actual batch benchmark: CPU 28.38 ms, GPU 2.07 ms.
Optimization took **1.375 s**, total script 4.89 s; a tiny dataset converged well
before the 30-minute ceiling. Peak Torch allocation 30.33 MiB (excludes CUDA
context/driver memory), training process RSS 1,155 MiB; CPU time 6.20 s.
Validation decision accuracy 98.66%, macro F1 0.9897, five of five rare release
labels correct. NumPy/PyTorch maximum probability error 1.49e-6.

Optional reproducibility, never needed to run the saved model:

```powershell
.\.venv-carla\Scripts\python.exe -m scripts.prepare_learned_data
# With the isolated CUDA environment and CARLA resources released:
.\.venv-learned\Scripts\python.exe -m scripts.train_learned_safety --output artifacts/learned_safety/reproduction
```

The training script refuses to overwrite an existing artifact directory. This
machine's isolated environment imports existing non-Torch dependencies through
a local `.pth`; another checkout can install Torch 2.11.0 from the official cu128
index plus NumPy and psutil in a separate virtual environment. Training metadata
contains dataset paths and hashes; the underlying recordings remain local.

## Real comparison and acceptance

The initial frozen pilot used two predeclared TEST seeds, 2473 and 2589. All four
automatic arms used exactly matched compiled scenario specifications, native
physics, normal BasicAgent hazard handling and unchanged success conditions
(at least 10 m forward progress and no collision). Conditions altered following
distance, leader speed, braking intensity/trigger and included physical recovery.
These normal-driving probes were operator-stopped after the fixed observation
horizon. Completion counts below mean those progress/collision criteria were
met; they do not mean BasicAgent arrived at its navigation destination.

| Automatic controller | Collisions | Progress completions | Sudden / front progress | Resumed after hazard |
|---|---:|---:|---|---|
| BasicAgent alone | 0/2 | 2/2 | 26.28 / 30.42 m | 2/2 |
| RULE | 0/2 | 2/2 | 19.87 / 22.94 m | 2/2 |
| LEARNED | 0/2 | 0/2 | 7.91 / 9.73 m | 0/2 |
| HYBRID V1 (minimum-brake guard only) | 0/2 | 1/2 | 7.57 / 11.38 m | 0/2 |

Manual matched front obstacle: without safety **one collision**, impulse proxy
13,966 N·s; RULE **zero collisions**, 21.70 m progress, 3.96 m minimum planar
clearance, two interventions and resumed driving. AUTO RULE clearance was
4.48 / 4.66 m versus BasicAgent's 2.86 / 2.95 m; average speeds 1.63 / 1.89 m/s
versus 2.05 / 2.40 m/s. This pilot shows a clearance/progress tradeoff, not a
statistically established collision-rate improvement for autonomous driving.

Observed learned failure: strong repeated BRAKE predictions after the scene
became safe; all 11 TRAIN episodes end with BRAKE and cover only 4–7.1 s, whereas
the native recovery test extends beyond that coverage. Rare release labels and
closed-loop distribution shift are plausible causes; training accuracy alone
does not prove recovery. No weights, rewards or thresholds were retuned on TEST.

One integration repair added a **symmetric HYBRID V2 guard**: RULE supplies the
minimum necessary braking and vetoes unsupported learned braking beyond its
existing release envelope once measured risk is CLEAR. These are rule constraints,
not learned improvement. Frozen weights and first-pilot evidence were retained.
Two fresh VALIDATION conditions (1893 sudden / 1729 front) passed; then the
configuration was frozen for a fresh matched TEST condition, 2947:

| Final HYBRID V2 check | Collision | Progress | Minimum clearance | Average speed | Interventions |
|---|---:|---:|---:|---:|---:|
| VALIDATION sudden braking | 0 | 19.15 m | 4.68 m | 1.56 m/s | 4 |
| VALIDATION front obstacle | 0 | 23.54 m | 4.72 m | 1.93 m/s | 3 |
| Fresh TEST RULE | 0 | 19.1048 m | 4.713 m | 1.554 m/s | 3 |
| Fresh TEST HYBRID V2 | 0 | 19.1042 m | 4.713 m | 1.560 m/s | 3 |

All four resumed progress with matched accepted/applied commands. The final
hybrid test had 75 learned-generator, 22 rule-guard and seven rule-fallback command
frames. Its recovery explicitly required the rule release guard. HYBRID is
available only as an explicitly selected experimental option; RULE remains
default. Native HYBRID manual driving has not been separately demonstrated.

## Verification, resources and limits

Evidence: `docs/evidence/final_delivery/` contains original and repaired hybrid
protocols/results, audit and restoration. Raw recordings/traces are local under
`runs/normal_city/` and `output/final-delivery/native/`. There were 14 native
episodes: initial harness 264.42 s plus corrected hybrid harness 72.94 s. Initial
setup refused a not-yet-settled vehicle; adding a settling wait preserved the
stationary switch guard. The four repair checks used scalar/event traces and
avoided further image copies. The initial full Recorder evidence occupies 4.20 GB.
No further native campaign or neural training followed acceptance.

All driving observations were synchronized, with zero recorded duplicate or
incomplete frames, zero command/application mismatches and cleanup to one ego
plus seven sensors after every case. 136 recorded-frame projections were invariant
to removal of all actors and ground truth; strict input schemas also reject
privileged fields. The original SAC SHA-256 is unchanged. Sensor resets produced
12 transient incomplete setup frames outside driving; no stale, duplicate,
out-of-order or timestamp mismatch events occurred in the initial harness.
Backend working set rose 225.9→245.3 MiB over the first ten cases (short-run
measurement, not a proof of long-term bounded memory). The full-recording median
step was about 78 ms; scalar-only checks about 31 ms; inference ~0.094–0.102 ms
median. One brief RULE pedal-threshold pulse occurred in the initial sudden-braking
trace; broad oscillation elimination is not claimed. Existing driver watchdogs,
50 Hz command admission, RL-exclusive ownership and navigation are preserved.

This is a small forward-hazard pilot. Rear collisions, reverse protection,
lateral avoidance, steering around obstacles, complex pedestrian conflicts,
sharp curves, adverse weather and crowded Egyptian urban generalization remain
unvalidated. No side-space certificate is invented. Rule parameters remain in
`config/ya_rab_ostorha_safety.json`: 3 m clearance, 0.35 s reaction allowance,
5 m/s² assumed deceleration, brake 1.0, TTC trigger/release 2/3 s, 2 m hysteresis,
0.15 s hold, brake release ≤3/s, sensor freshness 0.10 s simulation / 0.25 s wall.
These are initial dry-road/default-vehicle assumptions, not physical guarantees.
The historical teacher, radar, demonstrations, rewards and SAC are unchanged.

Final normal-host verification found one observation receipt timeout after the
comparison/restoration. The existing watchdog stopped availability; its freshness
limit was not relaxed. A clean CARLA/backend restart with the same Low/1280×720
profile restored live cameras, seven sensors and the paused RULE default. VRAM
remained approximately 5.9/6 GB during normal rendering; the timeout's cause is
not established. CUDA training is never kept resident beside CARLA. This short
check does not establish long-duration stability under resource pressure.

Final related regressions: **115 Python tests and 25 JavaScript tests passed**.
The dashboard bundle rebuilt identically to the checked-in file. One attempt to
overwrite the live-served bundle encountered a Windows mapped-file lock; a build
to a temporary output verified byte equality. No source/build mismatch remains.
The original dirty city/population/verification work was preserved in checkpoint
`ad2a3f5` before the final delivery commit; no user changes were discarded.
