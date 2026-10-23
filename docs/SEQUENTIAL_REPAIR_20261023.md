# Sequential system repair — 23 October 2026

This delivery adds a measured pedestrian behavior suite, a calibrated
path-entry risk predictor, an evidence-budgeted decision layer, driving and
RL-reward repairs, pipeline instrumentation and a five-configuration
closed-loop evaluation. **The validated Normal / Ya Rab Ostorha comparison is
unchanged**: ordinary and guided journeys keep the original RULE
(`decision_layer=None`) and identical driver profiles. New layers run only in
explicitly admitted evaluation journeys. Native CARLA 0.9.16 was available and
every native number below comes from live runs on the local RTX 3060 Laptop.

Evidence: [`docs/evidence/sequential-repair-20261023/`](evidence/sequential-repair-20261023/).
Raw episode logs and datasets stay in ignored `output/`.

## Phase 1 — baseline

[phase1-baseline.json](evidence/sequential-repair-20261023/phase1-baseline.json)
records the starting commit, 759 Python tests (2 documented skips), 178 JS tests,
controller identities (`NORMAL_REACTIVE_SENSORS_V1`, `ROBOSPHERE_PREDICTIVE_RULE_V1`),
historical native metrics and the failed learning experiments (both Maneuver-v1
PPO checkpoints: 0/10 completions with a stationary HOLD policy; the residual-MLP
endpoint predictor: failed admission).

## Phase 2 — scenarios and datasets

`backend/core/pedestrian_behaviors.py` (catalogue, walker scripts, labels,
realization checks) and `backend/carla/pedestrian_world.py` (native
construction) implement the ten behaviors: waiting, parallel walking, normal
crossing, sudden run, hesitate-then-cross, hesitate-then-retreat,
start-and-return, emerging from a parked vehicle, multiple pedestrians and mixed
traffic, plus counterfactual pairs and ordinary city journeys. Parameters vary
start position, curb offset, trigger distance, walking/running speed,
hesitation, incursion, target speed (30/40/50 km/h), occluder and traffic.
Locations come from a static OpenDRIVE probe (sidewalks on both sides, no
junction 20–100 m along the route). Splits are disjoint by location, seed and
scenario identity; Town02_Opt is held out entirely for TEST
(`config/pedestrian-behavior-suite.json`). Unsupported constructions fail
explicitly (for example a parked van that would intrude into the corridor on a
narrow Town01 road); a bounded, recorded ±2.4 m sidewalk displacement search
handles street furniture without changing the behavior or route segment.

The label `PEDESTRIAN_ENTERING_EGO_PATH_WITHIN_H_SECONDS` (H = 1, 2, 3 s) uses
the planned route corridor fixed at decision time (ego front to +60 m, ego half
width + 0.25 m + measured walker extent). Every relevant walker-frame keeps a
status (`LABELED`, `IN_PATH_AT_DECISION`, `MISSING_FUTURE`, `POST_CONTACT`,
unobserved, ambiguous, scene mismatch). Model inputs come only from published
ControlScene tracks, measured ego speed and commanded steering through the same
`path_entry_features.py` used at runtime; a unit test proves features are
identical when only the future native truth changes.

[phase2-collection.json](evidence/sequential-repair-20261023/phase2-collection.json):

| Split | Episodes | Samples | Prediction coverage | Positives 1/2/3 s |
| --- | ---: | ---: | ---: | --- |
| TRAIN (Town10HD, Town01) | 70 | 15,047 | 73.0 % | 405 / 799 / 1,123 |
| VALIDATION (disjoint spawns) | 30 | 6,924 | 78.7 % | 204 / 417 / 620 |
| TEST (Town02 held out + disjoint Town10 spawns) | 36 | 7,799 | 74.1 % | — (used once) |

Data collection used configuration B and, for dataset purposes only, ended an
episode 10 m after the ego passed every scripted walker
(`COLLECTION_END_PASSED_PEDESTRIANS`, never counted as an arrival). Several
crossings were therefore truncated before completion; the realization table in
the evidence separates truncation from physical failure. Native construction
failures (6) and one native fast-fail crash in an earlier, superseded run are
retained. Counterfactual pairs share construction and a waiting pose until a
simulation-clock decision point: one TEST pair had an identical observable
prefix, one diverged before the decision (asynchronous camera inference changed
an earlier brake) and one had identical ego commands but different measured
tracks. Native observable histories are therefore not guaranteed identical.

## Phase 3 — pedestrian path-entry risk

`PEDESTRIAN_PATH_ENTRY_RISK_GRU_V1`: linear encoder (23→32, ReLU), one-layer GRU
(32), three sigmoid heads; masked BCE with class weighting; checkpoint selected
by VALIDATION AUPRC; per-horizon Platt calibration on VALIDATION; thresholds
from VALIDATION; one-time TEST evaluation. Inference is an exact numpy
implementation (max |Δ| to torch 2.3e-7), so the control environment needs no
new dependency. Outputs are horizon-monotone, frame-bound and rejected when
stale; failures and time-budget overruns yield no risk.

[phase3-predictor.json](evidence/sequential-repair-20261023/phase3-predictor.json), TEST:

| Horizon | AUROC | AUPRC | Brier | ECE | Missed entering walkers | Best kinematic AUPRC | Existing unranked alternatives AUPRC (FPR) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| 1 s | 0.973 | 0.738 | 0.018 | 0.011 | 0 / 15 | 0.578 | 0.164 (6.0 %) |
| 2 s | 0.953 | 0.732 | 0.037 | 0.018 | 0 / 15 | 0.526 | 0.146 (17.4 %) |
| 3 s | 0.930 | 0.740 | 0.056 | 0.024 | 0 / 15 | 0.484 | 0.158 (32.2 %) |

All pre-registered gates passed (AUROC ≥ 0.85, ECE ≤ 0.06, AUPRC ≥ best
baseline + 0.05, Brier ≤ 0.8 × constant, missed entries ≤ 15 %). Sample-level
recall at the VALIDATION threshold is only 0.49–0.56: many positive frames are
below threshold even though every entering walker is flagged at least once.
Coverage (74 %) is a perception limit, not a model property. The first
training attempt's calibration overflowed and is retained as a failed attempt.
Prediction admission is separate from driving acceptance:
`config/path-entry-risk.json` keeps `enabled: false`.

Learned trajectory validation (`rank_learned_modes`) now rejects misaligned
starts and speed/acceleration violations, and accepts motion from rest that is
reachable within the physical sprint bounds, instead of rejecting any motion of
a currently stationary track. Accepted learned modes remain supplementary
(`certifies_free_space: false`).

## Phase 4 — evidence-budgeted pedestrian decisions

`backend/core/evidence_budget.py` and `backend/core/decision_layers.py` add an
evaluation-only decision layer inside the existing RULE supervisor. RULE's own
teacher, envelope, LiDAR path conflicts, coverage limits, freshness checks and
emergency handling run first and unchanged. Only conflicts that come
exclusively from the *speculative* alternatives (possible start/retreat/run) of
a person measured stationary for at least 0.6 s, outside the corridor margin,
may defer braking:

    D_stop = v · T_delay + v² / (2 · a) + margin
    T_delay = observation age + measured processing latency + 0.35 s reaction
              + 0.3 s motion confirmation + one observation interval

`a` is the existing validated 5 m/s² (hard limit) and a comfortable
2.5 m/s² (cautious cap); `margin` is the existing 3 m clearance. Each person's
conflict zone is shortened by size, measured uncertainty and a 0.5 m/m
diagonal-reach allowance. Responses:

* **CONTINUE** while another observation is affordable and the vehicle can still
  stop before the zone.
* **CAUTIOUS_APPROACH** with the highest verified speed (bounded brake ≤ 0.4,
  throttle ≤ 0.5), taking the maximum of the stop-before-zone cap and RULE's
  verified crawl; beside a closer curbside person the identical RULE crawl check
  is also tried at 0.5 m/s.
* **PROTECTIVE_BRAKING** for any measured motion conflict, unverified
  stationarity, a person within the corridor margin, unknown/stale scenes or a
  speed above the hard stop-before-zone limit.

Release from protection waits 0.4 s and raising a cap waits 0.5 s; entering
protection is immediate. Calibrated risk (when admitted) can only lower the
selected speed: a person with P(enter ≤ 3 s) ≥ 0.5 adds 1.5 s of observation
margin, including people without a RULE conflict. `LEARNED_RISK` (C) keeps all
RULE braking and only adds that calibrated caution. A unit/replay suite covers
the stopping inverse, hysteresis, risk monotonicity, supervisor integration and
a kinematic sweep in which a curbside person may sprint (6 m/s², 3.5 m/s) at
any moment with measured motion appearing only after 0.3 s: 0 collisions in all
sweeps (a naive continue-until-motion policy collides in 54 of 360 cases). The
same sweep shows the physical limit: a person about 0.9 m from the swept path
cannot be passed with a verified stop guarantee even at 0.5 m/s, so the layer
holds rather than guess.

## Phase 5 — driving and RL repairs

Harness-driven evaluation journeys (`EvaluationAdmission`, harness-only) use the
guided arms' route controller (0.9 throttle, 0.35 steering ceiling) and log the
requested target, OpenDRIVE posted limit, route-curvature limit, controller
target, safety caps, achieved speed and the restriction reason per frame.
Arrival comes only from the service's `ARRIVED` state; timeouts, stops and
collection ends are separate outcomes. Ordinary journeys and the guided
comparison keep their previous navigation path. Repairs found natively:

* **Stuck at launch.** A 0.38 m spawn offset made the route PID command 0.247
  steering at standstill; RULE then measured only 2 m of coverage along that
  tight arc and held for the whole episode. Below 1.5 m/s the base driver now
  steers by a 6 m-lookahead pure pursuit of the planned lane (falling back to a
  straight launch when aligned). Native: the same Town01 spawn-26 episodes that
  were held at 0.0 m afterwards passed their pedestrians (57.5 m and 47.7 m).
* **Corner stall (partly repaired).** At a non-junction 90° Town01 corner the PID
  saturated at 0.35 (≈6 m radius) after a stop. Pursuit steering and a
  route-curvature speed limit `v ≤ √(2.5·R + 2·2.5·d)` were added. The corner
  still stalls intermittently: before steering, RULE's straight probe can see
  the building across the corner and brake; once stopped, certified coverage
  along the turning arc flickers below the 3 m clearance. The safety probe and
  clearance were not relaxed.
* **Maneuver-v1 reward (version 3).** Launching at 1.5 m/s² cost −0.005 per
  0.1 s step in "discomfort" while earning +0.0019 progress on a 40 m route, and
  holding with a verified forward candidate cost only −0.002, so HOLD dominated
  (both checkpoints selected HOLD on every audited decision). Comfortable
  acceleration (≤ 2 m/s²) is no longer penalized, standing still while a verified
  forward candidate exists costs −0.3/s, and progress lost by reversing cannot
  be re-credited. Collision and near-miss penalties and the independent shield
  are unchanged. Applied versus proposed candidates were already recorded.
  **Not retrained**: retraining needs the pilot RL ticket and was gated on
  physical route acceptance, which did not pass (below). Maneuver-v1 stays
  disabled; no learned driving control is active.

### Native VALIDATION check of Phases 4–5

[phase45-validation.json](evidence/sequential-repair-20261023/phase45-validation.json):
13 VALIDATION scenarios (Town01 and Town10HD) × B/D/E, full episodes, 45 s
simulated limit. One construction (`EMERGE_FROM_PARKED`) failed in all three
configurations and is counted as a failure.

| Config | Arrived | Collisions | Unnecessary braking events | Unnecessary stationary | Brake/release oscillations | Fresh frames |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| B physical predictive | 12 / 13 | 0 | 77 | 46.0 s | 196 | 99.91 % |
| D evidence-budgeted | 9 / 13 | 0 | 82 | 89.5 s | 172 | 99.84 % |
| E physical ablation | 9 / 13 | 0 | 56 | 141.6 s | 146 | 99.84 % |

The layer is **not** an improvement on VALIDATION. It shortened a
hesitate-then-retreat journey (27.0 s vs 44.9 s) and reduced oscillations, but
slowed journeys past a waiting walker (14.3 s → 26.7 s), multiple walkers and
mixed traffic. Cause: RULE's forecast lets the car pass a curbside person
when no possible start can reach the path before the car has passed. The
layer instead keeps a stop-before-zone guarantee, so it slows early. After a
brief gap in the forecast conflict it accelerates again, and when the conflict
returns the car can no longer stop gently, so it brakes fully. D/E also
timed out at the Town01 corner (approach speed is higher than B), and two D
journeys stopped on sensor-freshness faults during host-load spikes (steps of
350–400 ms; one overlapped a concurrent log analysis). Learned risk inference
adds 6.8 ms median (p95 10.3 ms) to D's safety step. These findings were not
tuned away before TEST; the layer remains evaluation-only.

## Phase 6 — performance

Every harness frame records sensor arrival and decode, scene-build stages,
safety, navigation, actuator submission, detector age and learned-risk latency
(`scripts/summarize_native_performance.py`,
[phase6-native-latency.json](evidence/sequential-repair-20261023/phase6-native-latency.json)).
Native TEST frames (configuration B unless noted, median / p95):

| Stage | Median | p95 |
| --- | ---: | ---: |
| Last sensor (depth) after first sensor in a frame | 39.8 ms | 55.3 ms |
| Input wait before scene build | 54.2 ms | 72.2 ms |
| Scene build (tracking + forecasts 22.5, semantics + freezing 12.5, depth fusion 8.9) | 45.4 ms | 87.3 ms |
| Safety decision | 30.6 ms | 47.6 ms |
| Learned risk inference (C/D) | 4.4 ms | 8.8 ms (max 14.9) |
| Observation → applied control: A / B / C / D / E | 86 / 140 / 146 / 146 / 138 ms | 116 / 203 / 224 / 225 / 207 ms |
| YOLO three views on CPU (separate process) | 421 ms | 469 ms |
| Detection age when used | 0.30 s (6 frames) | 0.40 s |

The simulation real-time factor (median) is 0.53 for A, 0.35 for B and E, and
0.33–0.34 for C and D. **Real time is not achieved.** The predictive pipeline
processes about 7 observations per wall-clock second against a 20 Hz simulation.
Processing-deadline holds affect 0.72 % of B frames and 1.9–2.2 % of C/D frames
(C/D also run an all-conflicts forecast and risk inference in the safety step).
Fresh usable scenes stay at 99.77–99.96 % in every configuration.

Verified optimizations (equivalent settings, alternated on the same host):

* `freeze_json` numeric-row fast path:
  [phase6-offline-profile.json](evidence/sequential-repair-20261023/phase6-offline-profile.json).
  Replayed outputs are identical (digest `83388172…`). The steady-state
  scene-build median went from 33.9 to 32.8–33.5 ms and p95 from 45.7 to
  42.4–43.2 ms. End-to-end frame time did not change measurably.
* YOLO output decoding: a vectorized prefilter, then the unchanged per-row
  arithmetic on surviving rows:
  [phase6-detector-decode.json](evidence/sequential-repair-20261023/phase6-detector-decode.json).
  Detections are identical on 40 recorded frames and in a randomized
  equivalence test. One-view decode went from 7.4 to 1.7 ms, and three-view
  detection from 525.7 to 489.5 ms (−6.9 %).

These mechanisms already existed and stay unchanged: asynchronous detection in
its own process, cached detections with a 0.75 s semantic freshness limit,
frame-bound rejection of stale model output, and a learned-risk time budget
that falls back to physical-only control. No physical check was skipped, and
sensor coverage was not reduced. The remaining bottlenecks are sensor
rendering and arrival, Python scene building, and CPU-only detection. GPU
inference would need a new runtime dependency and was not added.

## Phase 7 — independent closed-loop TEST evaluation

[phase7-evaluation.json](evidence/sequential-repair-20261023/phase7-evaluation.json),
[phase7-prediction.json](evidence/sequential-repair-20261023/phase7-prediction.json).
TEST used 17 scenarios: all ten behaviors, two counterfactual pairs and three
ordinary city journeys, in held-out Town02 and disjoint Town10HD locations.
Each scenario ran once in each of five configurations (85 full native
episodes, 45 s simulated limit, every outcome included). Every scenario had
identical physical construction and initial ego and scripted-walker poses in
all five configurations. Scripted walker actions were physically realized in
every episode except four whose drive ended first: A's two collisions and two
early C/D stops before a trigger.

| | A reactive | B physical predictive | C learned risk | D evidence-budgeted | E physical ablation |
| --- | ---: | ---: | ---: | ---: | ---: |
| Arrived | 10 / 17 | 8 / 17 | 9 / 17 | 8 / 17 | 7 / 17 |
| Timeouts / other stops | 5 / 2 | 8 / 1 | 7 / 1 | 8 / 1 | 8 / 2 |
| Walker collisions | **2** | 0 | 0 | 0 | 0 |
| Minimum separation | −0.13 m | 1.87 m | 2.29 m | 1.32 m | 2.53 m |
| Missed hazards | 3 | 0 | 0 | 0 | 0 |
| Unnecessary braking events | 47 | 88 | 95 | 96 | 89 |
| Unnecessary full stops | 24 | 35 | 42 | 69 | 63 |
| Unnecessary stationary time | 170.2 s | 243.9 s | 209.8 s | 228.9 s | 245.8 s |
| Median journey time (arrived) | 17.4 s | 20.7 s | 21.2 s | 21.8 s | 19.7 s |
| Mean route progress | 0.89 | 0.85 | 0.88 | 0.89 | 0.80 |
| Brake/release oscillations | 200 | 237 | 326 | 327 | 209 |
| Max deceleration (median per episode) | 18.8 m/s² | 25.5 m/s² | 24.8 m/s² | 24.0 m/s² | 25.0 m/s² |
| Max lateral acceleration | 3.87 m/s² | 3.05 m/s² | 3.00 m/s² | 2.16 m/s² | 3.12 m/s² |
| Max achieved speed | 14.1 m/s | 14.1 m/s | 14.1 m/s | 14.1 m/s | 14.0 m/s |
| Fresh usable frames (gate 99 %) | 99.96 % | 99.83 % | 99.82 % | 99.77 % | 99.84 % |
| Ordinary journeys arrived (gate: all) | 3 / 3 | **1 / 3** | **2 / 3** | **1 / 3** | **0 / 3** |

* **Safety.** Both of A's collisions were the sudden-crossing arms of the
  counterfactual pairs. B–E avoided both of these walkers and had no
  collisions. Median braking lead before actual corridor entry was 5.35 s (B),
  5.25 s (C), 4.25 s (D) and 3.7 s (E).
* **Efficiency.** Paired with B on the same scenarios, C had +1 arrival, −0.25 s
  median journey time, +7 unnecessary braking events, −34 s unnecessary
  stationary time and +89 oscillations. D had 0 arrivals difference, +1.0 s,
  +8 events, −15 s and +90 oscillations. E had −1 arrival, +0.55 s, +1 event and
  +2 s. **No superiority claim is supported.** No configuration is safer than
  B with better efficiency, and B–E all fail the ordinary-completion gate.
* **Common route failures.** All five configurations, including A, stopped
  about 18 m short on the four Town02 spawn-25 routes, which end in a turn. The
  same RULE coverage hold stops them, so those episodes dominate
  "unnecessary stationary time" in every column. All five also timed out in
  `MIXED_TRAFFIC`. B–E timed out 6–13 m before the end of one Town10HD ordinary
  journey that A completed. Five other episodes ended early: sensor-freshness
  stops in B (1), C (1) and E (2), and one D runtime stop when no synchronized
  scene arrived for 1 s.
* **Counterfactual pairs.** Only A's first pair had an identical observable
  prefix within tolerance. In B–E the prefixes diverged before the decision
  point (measured track gaps 0.3–9.8 m, different brake commands). Native
  closed-loop runs therefore cannot prove identical behavior when histories are
  indistinguishable. A background-walker population (mixed traffic and ordinary
  journeys) differed for A in four scenarios. B–E shared identical populations.
* **Prediction in closed loop.** The admitted model was scored offline on the
  tracks each controller actually saw, without being retuned. On B's logs it
  reached AUROC 0.986 / 0.950 / 0.918 and ECE 0.009 / 0.015 / 0.026 for
  1 / 2 / 3 s. Entering walkers missed: 0 / 7. Non-entering walkers that
  received at least one above-threshold alarm: 9 / 17 / 25 of 45. Sample-level
  false-positive rate was 0.4–2.1 %, false-negative rate 37–48 %, and coverage
  73 %. On D's own logs, 3 s AUROC fell to 0.846 and ECE rose to 0.052 (a
  distribution shift from D's slower driving). The soft kinematic baseline
  reached AUPRC 0.673 / 0.581 / 0.494 on B's logs, against the model's
  0.702 / 0.602 / 0.546.

## Phase 8 — integration and regression

Nothing new is enabled in production. Ordinary and guided journeys keep
`decision_layer=None` and the unchanged driver profiles.
`config/path-entry-risk.json` keeps the admitted predictor `enabled: false`.
C/D/E and evaluation navigation run only through the harness-only
`EvaluationAdmission` (≤ 60 km/h, no raw recording, no journey comparison).
Two optimizations are active everywhere: the `freeze_json` fast path and the
YOLO decode prefilter. Both have output-identity evidence.

The prediction overlay shows the layer readout only when the supervisor
publishes it: response, verified speed limit, calibrated 3 s crossing risk
(only when `READY`, marked "experimental" when not admitted), tracking
uncertainty and the reason. The existing stop diagnostic still shows the
braking source, reason and sensor age.

Regression results:

* Python (`.venv-carla`): 813 tests OK, 3 skipped. The skips are the two
  documented skips and the OpenCV-only decode-equivalence test.
* `.venv-perception` detector tests: 4 OK, including decode equivalence.
* JavaScript: 180 / 180. Rebuilding the dashboard leaves the checked-in
  bundle byte-identical.
* Native comparison regression
  ([phase8-crossing-regression.json](evidence/sequential-repair-20261023/phase8-crossing-regression.json)):
  seed 1701, Normal first, unshortened production pair with the changed
  sources. All scenario gates passed: Normal hit the walker at 5.95 s with a
  64.05 km/h peak, and Ya Rab Ostorha arrived without contact in 30.55 s with
  a 58.58 km/h peak (historical: 5.90–5.95 s, 63.81–64.05 km/h,
  32.95–36.90 s, 58.34–60.91 km/h). Conditions matched, Finish completed, cleanup
  and engine exit were confirmed, and all three videos played after exit. The
  documented before-ingress review passes: a predictive brake 0.9 s before
  path ingress and 1.05 s before Normal's contact. The strict first-motion
  audit fails, as it did in 3 of the 6 historical pairs. The other five
  historical pairs were not re-run.

## Before vs. after

"Before" is the existing production predictive RULE (B); "after" is the new
evidence-budgeted candidate (D) on the same 17 TEST scenarios, unless noted.

| Metric | Before | After |
| --- | --- | --- |
| Walker collisions (TEST episodes) | 0 / 17 (Normal A: 2 / 17) | 0 / 17 |
| Unnecessary braking events per episode | 5.2 | 5.6 |
| Unnecessary full stops | 35 | 69 |
| Arrival rate | 8 / 17 | 8 / 17 |
| Path-entry prediction (TEST AUPRC 1/2/3 s) | best existing kinematic 0.578 / 0.526 / 0.484 | GRU 0.738 / 0.732 / 0.740 (ECE ≤ 0.024) |
| Maximum achieved speed | 14.1 m/s | 14.1 m/s |
| Observation → control (median / p95) | 140 / 203 ms | 146 / 225 ms |
| YOLO three-view detection (offline, same frames) | 525.7 ms | 489.5 ms |
| Real-time factor (median) | 0.35 | 0.34 |

## Remaining issues

* The evidence-budgeted layer (D/E) is not better than B on VALIDATION or TEST:
  it makes more full stops and oscillations, and no superiority claim holds.
* Ordinary-route completion fails for B–E on TEST (B 1/3, C 2/3, D 1/3,
  E 0/3; A 3/3).
* Turn and corner stalls: the RULE coverage hold stops every configuration
  before a route-end turn (Town02 spawn 25) and at a Town01 corner.
  `MIXED_TRAFFIC` times out in all configurations.
* Sensor-freshness or scene-availability stops ended 5 TEST episodes and
  2 VALIDATION episodes. Processing-deadline holds affect 0.7–2.2 % of frames.
* Real time is not achieved: RTF 0.33–0.53 and CPU-only detection at
  about 420 ms.
* Prediction covers 73–77 % of eligible frames. Up to 55 % of non-entering
  walkers receive at least one false alarm. Under D's driving the 3 s AUROC
  drops to 0.846.
* Counterfactual observable prefixes diverge natively. A's background walkers
  differed in four TEST scenarios.
* Maneuver-v1 was not retrained (gated on route acceptance and the pilot
  ticket). The learned-risk and evidence-budget layers stay evaluation-only.
* Each of the 17 TEST scenarios ran once, so statistical power is limited.
  Town03 and Town05 had too few qualifying locations. One VALIDATION
  construction failed.
