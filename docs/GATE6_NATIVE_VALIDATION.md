# Gate 6 native validation — 8 October 2026

Gate 6 passes for the two controlled CARLA prototypes. No neural network was
trained and no YA RAB OSTORHA policy was activated. The normal driving service
remains usable. The environment protocol and exact spaces are documented in
[GATE6_RL_ENVIRONMENT.md](GATE6_RL_ENVIRONMENT.md).

## 1. Git state and preserved work

Work began on `codex/live-native-validation` at `5ffdb4b9cee3a125b88f6d47be58f28486cf3f48`,
with existing population/urban changes, native verifier updates and an untracked
Gate 5 regression script. A recovery patch and copy of the untracked verifier
were saved under `output/gate6-preserved`. A new branch, `codex/gate6-real-rl`, was
created without resetting, stashing away or discarding work.

The shared checkout subsequently advanced to `3ed6205`, a native scenario
collision fix from concurrent work. It is retained, including the event-driven
collision path. The existing scenario manager, provider, research contracts,
sensor-only safety boundary, control contracts and normal service behavior were
reviewed and reused. The milestone commit stages Gate 6 files explicitly;
unrelated pre-existing modifications remain in the working tree.

## 2. Environment structure

`backend/rl/env.py` supplies `YaRabOstorhaEnv(gymnasium.Env)`. Gymnasium 1.2.3 was
installed legitimately in `.venv-carla` and pinned in `requirements-rl.txt`.
`runtime.py` executes requests on the existing SimulationService worker;
`observations.py`, `actions.py`, `scenarios.py`, `reward.py`, `baselines.py` and
`evaluation.py` separate their responsibilities. No second CARLA tick client,
replacement physics, trainer or deployed safety model was introduced.

## 3. Observation and action spaces

The lightweight Dict has four-frame ego speed/angular velocity, IMU, previous
applied actions, 32 radar points, validity masks and frame/time pairs. Multimodal
adds 160×90 RGB/depth and 512 LiDAR points; evaluation uses 320×180 images and
2048 points. Units, saturation ranges, padding and dtypes are explicit.

The continuous Box is `[steering, throttle, brake]`, bounded from `[-1,0,0]` to
`[1,1,1]`. Named dictionaries are accepted. Nonfinite/boolean/malformed actions
are rejected; finite outliers are clipped, braking suppresses throttle, steering
changes are limited to 1.5 normalized units/s, and gear stays forward. Existing
ControlCommand, ControlSafetyLayer and CommandArbiter enforce admission/freshness.

## 4. Reset and step semantics

An exclusive lease is acquired atomically on the existing worker. It disables
normal driving mutations and navigation commands. Idle RL sessions withhold ticks.
Reset compiles seeded native geometry, cleans previous actors, resets ego/sensors,
warms up 30 physical ticks, captures settled configuration, initializes velocities
once and collects a complete initial sensor frame. Each subsequent step advances
exactly one 50 ms CARLA frame and waits for matching complete sensors.

New sensors can omit startup frames during warm-up. Those are excluded from the
policy and episode recordings. No missing episode observation is replaced with
a neighboring frame. Close restores the original normal-city configuration and
keeps driving safely paused. Acquisition, mutation guards and queued operations
have explicit ownership checks. An idle lease expires after 120 wall seconds.

## 5. Reward implementation

The modular evaluator logs collision, native impulse severity, unsafe clearance,
signed forward progress, delay, control smoothness, unnecessary braking and success
components. Weights are configurable hypotheses, not validated optima. Stationary
behavior has a continuing time penalty and cannot satisfy success. Positive
progress is gated by valid clearance, TTC, lane support and absence of collision.
Reward-only geometry never enters observation assembly.

## 6. Termination and truncation

SUCCESS and COLLISION terminate; departure from the supported lane terminates
with ABORTED. Time/step limits truncate with TIMEOUT. Operator/reset/close/lease
abort truncates with ABORTED. Infrastructure errors truncate with SIMULATOR_FAILURE.
Reasons, flags and validity are explicit. A lost backend preserves an unknown
attempted-action status instead of claiming that braking or physics occurred.

## 7. Native scenario results

The main matrix completed 12 episodes on real CARLA 0.9.16 / Town10HD_Opt:
two scenarios × seeds 42/43 × success/collision/timeout. All expected outcomes
matched. There were 716 complete recorded frames, zero episode synchronization
issues, and zero incomplete episode frames.

| Scenario | Seed | Success progress | Success time | Minimum clearance on success | Collision peak impulse |
|---|---:|---:|---:|---:|---:|
| Front Obstacle | 42 | 14.4409 m | 4.00 s | 4.3944 m | 8439.27 N·s |
| Front Obstacle | 43 | 14.4621 m | 4.00 s | 4.3749 m | 8325.39 N·s |
| Sudden Braking | 42 | 11.9980 m | 3.40 s | 9.6158 m | 8530.08 N·s |
| Sudden Braking | 43 | 12.0002 m | 3.40 s | 6.4829 m | 8482.95 N·s |

Timeout probes were 0.30 simulation seconds and had no collisions. A final
six-episode rerun passed after the last ownership changes. Native scripts also
validated Gymnasium's checker, all observation profiles, maximum-step truncation,
VALIDATION seed 1042, TEST seed 2042 and operator emergency-stop recovery.

Three comparison controllers ran on matched seed-42 specifications in both
scenarios. Constant-throttle diagnostic and BasicAgent with hazard handling
disabled collided in both. Conservative sensor-only radar braking had no collision
and timed out in both. These are six measured baseline runs, not RL improvement
results or evidence of generalization.

## 8. Reproducibility measurements

Twenty-four repeated-reset comparisons reproduced the intended scenario
specifications. Maximum measured settled-position deviation was 0.0 m and
settled-velocity deviation 0.0 m/s in this sample. Seed 42 selected spawn 49 and
seed 43 selected spawn 22. Old/new owned actor IDs were disjoint and global native
inventory remained exactly two vehicles, seven sensors, no walkers/controllers.

Absolute frames/timestamps, reused-world physics and sensor binaries are not
claimed bitwise deterministic. Initial velocity setters can be followed by native
drivetrain/physics transients; both intended and actual initialized states are saved.

## 9. Recording evidence

Every episode uses the existing RunRecorder and is readable with ReplayReader.
Artifacts are separated under `runs/rl/TRAIN`, `VALIDATION` and `TEST`.
Metadata, native frames/assets, proposed/applied actions, component rewards,
collision events, reasons, metrics and `outcome.json` are retained. Exactly one
RGB/depth/LiDAR binary is stored per corresponding recorded native frame; action
events reference assets rather than duplicating them.

Examples from the main matrix:

- Front-obstacle success: `runs/rl/TRAIN/rl_4494273d500247f7b058406894c69711`.
- Sudden-braking success: `runs/rl/TRAIN/rl_9361c12cea6f45f08cd85a2cb944a838`.
- Sudden-braking collision: `runs/rl/TRAIN/rl_70173de843bc4ac9a0b974aabfefb84a`.

Raw evidence is in `output/native-validation/gate6-rl.json`,
`gate6-final-smoke.json`, `gate6-interfaces.json` and `gate6-final-abort.json`.
Failed experiments are retained, including a concurrent native shutdown that
interrupted earlier acceptance attempts. That interruption was not counted as
an accepted episode. Durable summaries are committed in `docs/evidence`.

## 10. Privileged-information isolation

Automated tests reject SimulationFrame at the assembler boundary, reject unknown
transport fields, enforce the audited sensor channel allowlists, and prove that
changing privileged actors/ground truth does not change any policy array. History
is bounded and stale channels fail. Native recordings verify exact sensor frame
and timestamp association. Rewards and diagnostic info may contain evaluation
measurements; they are not members of the policy observation space.

## 11. Performance and memory

The main 12-episode matrix measured 94 ms median / 250 ms maximum HTTP step time,
0.8515 s median reset, and backend private memory 545.03–550.55 MiB. The final
six-episode rerun measured 78 ms median / 219 ms maximum step time, 0.742 s median
reset, and 544.70–547.05 MiB backend private memory. Simulation timestep stayed
50 ms; wall throughput is slower than simulation time. These are local samples,
not universal latency guarantees or a long endurance claim.

Observation history stayed at four entries, frame caches at 32 and asset cache
at 256. No queue overflow, duplicate callbacks, stale episode frames or growing
actor inventory was observed in the accepted matrix. Recording disk usage grows
intentionally. A later snapshot measured CARLA private memory about 9693 MiB and
GPU use 5780/6144 MiB; it is a point observation, not an engine-memory trend.

YOLO/OCR display work remains outside episode stepping. The prior CPU/OCR latency
and roughly 1 FPS schedule do not qualify as active collision-avoidance perception.
No privileged actor geometry replaced production perception.

## 12. Regression results

152 Python tests ran: 151 passed, one native-API absence test was inapplicable
because CARLA is installed. All 24 JavaScript tests passed. Real normal-city
regression passed vehicle cleanup, aligned camera views, native weather and
10/20 Hz settings, manual movement, traffic/pedestrian operation, route planning,
recording/replay assets, scenario metadata/outcomes and cleanup.

Native journey regression passed destination selection without movement, verified
arrival, dashboard lease, manual intervention, resume/replan, emergency behavior,
collision stopping and exact RGB/depth alignment. Ordinary reconfiguration still
has explicitly incomplete startup frames, as in the preserved application;
those are distinct from the complete recorded RL episode frames.

## 13. Commit

The Gate 6 commit is created only after these native and regression checks pass.
Its hash is reported in the final delivery and available in the branch log.
Pre-existing unrelated working-tree changes remain preserved.

## 14. Remaining issues

Reward tuning, wider held-out corpora, long endurance and stronger sensor-loss/
lease-expiry fault campaigns remain research work. Clearance is a planar box
proxy, TTC supports aligned closing traffic, and native impulse is not injury
severity. These tasks validate safe approach-and-stop episodes; they are not
urban avoidance, off-road recovery or autonomous navigation benchmarks. The
conservative baseline's low progress demonstrates the need to evaluate both
safety and useful progress. GPU headroom remains limited. A general learned
maneuver feasibility validator and production perception optimizations do not
exist yet.

## 15. Readiness

The validated two-scenario environment is ready for a separately authorized first
RL baseline experiment. The next milestone must introduce explicit trained-policy
identity/provenance, training configuration and held-out evaluation; tune reward
hypotheses and inspect failure records. Training and production activation were
not started by Gate 6.
