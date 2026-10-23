# Failed-gates recovery — 23 October 2026

Branch `repair/failed-gates-20261023` (from `ae7e9e1`). Six sequential tasks
followed reproduce → identify cause → fix → test → compare → record. Evidence
is in [evidence/failed-gates-recovery-20261023](evidence/failed-gates-recovery-20261023/),
compiled by `scripts/report_failed_gates_recovery.py` from ignored native
outputs under `output/`. Raw outputs, failed attempts and superseded runs are
retained under their own folder names; none were overwritten.

Production behavior is unchanged: the ordinary RULE path (Ya Rab Ostorha) and
Normal produce the same offline replay digest as `ae7e9e1`
(see Task 6). New behavior is limited to harness evaluation journeys
(`journey.evaluation`), the evaluation-only decision layers (C/D/E), and
opt-in runtimes. Learned control and RL stay disabled.

## Task 1 — corner and turn deadlocks

**Reproduce.** With the previous evaluation steering (`--route-tracker off`)
the three failing routes failed again: Town02 spawn 25 (route-end turn) and
Town01 spawn 51 (90° corner) timed out at 45 s, and Town10HD spawn 63 needed
44 s. Stop-frame dumps (LiDAR, route, probe paths) were classified by
`scripts/classify_route_stalls.py`.

**Cause.** Two defects, both in evaluation navigation:

* *Off-route alignment.* The 6 m low-speed pursuit with a saturating PID cut
  corners by up to 1.3 m (offline replay) and commanded only 0.05–0.15
  steering while the route turned 32–89° within 5–15 m. In Town02 the car
  ended 3.18 m inside the turn against the curb.
* *Artificial probe deadlock.* The supervisor checked coverage along a
  constant-steering arc. On a corner that arc leaves the road: 0 m measured
  coverage, a permanent hold, while the actual route path had 13 m of measured
  free space (Town01 spawn 51).

**Fix.** `backend/core/route_tracking.py`: a pure-pursuit tracker on a 0.5 m
densified route (speed-dependent look-ahead 2.5 + 0.25 v + 0.035 v², ≤ 16 m;
steering-rate limit) with a rear-axle kinematic forward simulation. The
provider publishes a frame-bound route probe (frame, timestamp, steering,
path). The supervisor checks coverage along that path only if frame,
timestamp and steering match the current command exactly; otherwise it uses
the steering arc as before. Clearances, occupancy and unknown-space handling
are unchanged; the map is never used as evidence of free space.

**Failed attempt.** The first verification run stopped every episode with a
sensor fault at 0.2 s: projecting the 200-row path costs 690–845 ms per frame.
`PathCorridorIndex` (raster prefilter + windowed exact projection) is
exactness-tested against the original projection; the supervisor now costs
+7 ms against the arc probe. That run is kept as
`task1-after-20261023-failed-processing-deadline`.

**Compare.** Verification (`task1-after-20261023c`, configuration B, 9
episodes, 3 per route): 8 arrived, 0 collisions — Town02 spawn 25 3/3
(15.4–18.2 s; previously every configuration stopped about 18 m short),
Town01 spawn 51 3/3 (18.2–28.5 s), Town10HD spawn 63 2/3 (20.4, 23.1 s). The
remaining timeout waited 13.8 s behind a queue of stationary vehicles in the
lane (classified `LEGITIMATE_TRAFFIC_BLOCKAGE`). Unit tests cover the tracker,
probe coverage on a synthetic L-street (with obstacle and unobserved space),
index exactness, densification and probe selection.

## Task 2 — unnecessary pedestrian braking (configuration D)

**Reproduce / cause.** D's earlier static stop-before-zone rule braked for
every curbside person whose speculative start would reach the corridor. The
first time-indexed version (V2, below) still produced more stops than B on
VALIDATION (CPU run, re-scored: 39 vs 24 unnecessary full stops, 50.8 vs
22.5 s unnecessary stationary time). Frame traces showed three D-only causes:

1. The pedestrian layer armed its release (0.4 s) and raise (0.5 s) holds
   after *measured-obstacle* brakes that involved no person; each obstacle
   flicker became a ~1 s full stop. RULE already has its own obstacle
   hysteresis.
2. After a person-related RULE brake, the holds continued in frames where no
   person conflict remained (`NO_SPECULATIVE_CONFLICT`). In the 13-episode CPU
   run, person-triggered holds kept the car stationary for 356 frames (17.8 s);
   most hold frames had no remaining person conflict.
3. During holds D kept 0 m/s even when RULE's own verified crawl (what B does)
   allowed 4 m/s; short-lived depth-person tracks re-armed the holds, so D
   was more restrictive than the B baseline.

**Fix.** `EVIDENCE_BUDGETED_PEDESTRIAN_V2` (`backend/core/evidence_budget.py`,
`decision_layers.py`) replaces the static zone with a time-indexed check.
Candidate speed plans are tested against every physically reachable
alternative of each verified-stationary person, including starting, retreating
and running now. A plan passes if it is conflict-free before the person can
reach the path, or if braking after the full detection delay is conflict-free.
The layer chooses the highest verified plan, or RULE's verified crawl, and
otherwise brakes. Risk ≥ 0.5 only lengthens the delay. Hysteresis now:
hazard-only frames leave the layer's state untouched; holds apply only while
the layer is still evaluating people; holds never go below RULE's verified
crawl for the frame. Measured motion, unverified stationarity, people inside
the corridor margin, measured obstacles and stale data keep RULE's protective
response.

**Test.** Unit tests cover plan profiles, pass-before-reach and
brake-after-detection, the crawl fallback, risk-only caution, bounded
hysteresis, the RULE-crawl floor, hazard frames and an offline replay sweep in
which a waiting person sprints at every possible moment with confirmation,
latency and reaction delays. No collisions occur in the sweep.

**Compare (VALIDATION, same 13 specs, DML detector, corrected metrics;
`task2-pedestrian-braking.json`).**

| Metric | B | D |
|---|---|---|
| Collisions / missed hazards | 0 / 0 | 0 / 0 |
| Minimum separation (min / median) | 2.37 / 4.92 m | 2.51 / 4.93 m |
| Arrivals (valid episodes) | 12 / 12 | 11 / 12 (one 24.9 s red-light wait at the 45 s limit) |
| Unnecessary braking events | 76 | 55 |
| — of which pedestrian forecast | 32 | 11 |
| Unnecessary full stops | 24 | 16 |
| Unnecessary stationary time | 29.8 s | 13.2 s |
| Brake/release oscillations | 173 | 153 |
| Median journey time (arrived) | 18.6 s | 16.3 s |

Both configurations had one EMERGE_FROM_PARKED construction failure (the
parked occluder could not be spawned; the episode is counted and failed
explicitly). The WAIT_AT_CURB episode shows the intended change: 13.7 s
instead of 23.6 s with one stop instead of three. The evaluator's formal
superiority rule fails only on arrivals (11 vs 12), so no superiority is
claimed from VALIDATION. The superseded intermediate runs are kept (see the
evidence file).

## Task 3 — sensor timing and processing stalls

**Reproduce / cause.** Frames before processing-deadline holds (phase-7 TEST)
had scene builds of 121 ms against 42 ms normally (semantic association and
freezing 56 vs 13 ms, tracking 42 vs 20 ms), a sensor-arrival spread of 63 vs
38 ms and safety steps of 43 vs 32 ms. The CPU detector worker (≈ 420–500 ms
per image) competes with the control pipeline for the same cores. Holds
became `SENSOR_FAULT` stops after the 1 s recovery window.

**Fixes.**

* *GPU detector (opt-in).* `RoadDetector(execution_provider='DML')` runs the
  same ONNX model and decoder on DirectML with serialized runs and an explicit
  CPU fallback; the profile records the provider. Setup:
  `scripts/setup_perception_directml.ps1` (pinned in
  `backend/requirements-perception-directml.txt`); enable with
  `YRO_DETECTOR_EXECUTION_PROVIDER=DML`. The production default stays CPU.
* *Equivalence.* Idle-engine benchmark on 40 recorded frames: DML 73.5 ms vs
  CPU 498 ms median, identical detection sets (646/646), maximum confidence
  difference 2e-6, maximum box difference 1e-4 px.
* *Learned risk off the safety path.* `AsyncRiskEstimator` takes a detached
  snapshot of the frame's measured tracks when the safety step starts and runs
  the unchanged estimator on one background thread. The decision layer uses a
  result only for the same frame and within 15 ms of submission. Otherwise
  that frame runs physics-only; risk can only add caution. Snapshot or model
  failures fail closed. The first native attempt raised on read-only native
  track fields and stopped D episodes at 0.25 s
  (`task2b-…-failed-async-snapshot`); the snapshot now copies plain values
  and cannot raise into the safety step.
* *Duplicate forecast removed.* Evaluation layers compute the pedestrian
  conflict list once; RULE's conflict is its first element.
* *Bounded recovery.* Evaluation journeys tolerate stale data for 3 s instead
  of 1 s before ending. Every stale frame is still a full-brake hold, and stale
  data never authorizes motion. Production keeps 1 s.

**Compare (configuration B, same 13 VALIDATION specs, same code; CPU vs DML
detector; `task3-timing.json`).**

| Measure | CPU detector | DML detector |
|---|---|---|
| Detector time median / p95 | 422 / 485 ms | 63 / 93 ms |
| Detection age at control median / p95 | 5 / 9 frames | 3 / 4 frames |
| Scene build median / p95 | 48 / 108 ms | 40 / 81 ms |
| Sensor-arrival spread median / p95 | 45 / 63 ms | 21 / 41 ms |
| Safety step median / p95 | 40 / 59 ms | 33 / 44 ms |
| Harness step median / p95 | 162 / 238 ms | 129 / 175 ms |
| Observation→control median / p95 (Phase 6 definition) | 160 / 240 ms | 129 / 176 ms |
| Processing-deadline hold frames | 197 | 1 |
| Timing-deadline braking events | 125 | 0 |
| Fresh usable frames | 99.73 % | 100 % |
| Real-time factor (median) | 0.32 | 0.39 |
| Arrivals / collisions | 12 / 0 | 12 / 0 |

Real time is still not reached: the simulation advances at about 0.4× wall
time. The remaining step time is the scene build, safety step and native tick.
Observation→control is sensor receipt to command submission
(`sensor_age_before_safety_ms + safety + actuator_submit`, as in
`scripts/summarize_native_performance.py`). For reference, the phase-7 TEST
run with the CPU detector measured B at 140 / 203 ms and RTF 0.35. On HOLDOUT
with DirectML, B measured 128 / 178 ms and RTF 0.39.

**Learned risk on vs off the safety path (configuration D, same 13 specs, DML).**

| Measure | In-step (synchronous) | Off-path (async, frame-bound) |
|---|---|---|
| Decision-layer time median / p95 | 3.96 / 7.51 ms | 0.13 / 1.73 ms |
| Safety step median / p95 | 38.7 / 50.8 ms | 42.0 / 54.5 ms |
| Frames with a same-frame risk result | 5,012 of 5,024 | 4,977 of 4,995 (6 over budget) |
| Arrivals / collisions | 11 / 0 | 11 / 0 |
| Unnecessary braking / full stops | 58 / 17 | 55 / 16 |

The inference left the layer's critical section, and its wait is now bounded
at 15 ms. The total safety step was not faster, however: in CPython the
background thread competes with the safety step for the interpreter lock.
Async is kept as the evaluation default because of the bound; a measured
latency gain is not claimed.

## Task 4 — mixed traffic and route completion

Every TEST failure in mixed-traffic and ordinary journeys was classified from
the logs; evaluator truth was used offline only
(`task4-route-completion.json`).

| Failure | Configurations | Verified cause | Action |
|---|---|---|---|
| MIXED_TRAFFIC Town10HD:143 timeout ~9 m short | A, B, C | Stationary lead vehicle in the lane, 8 m ahead, stationary 91–96 % of a 13–24 s stop; traffic and the car resumed at 43.4–43.9 s (signal queue at the destination) | Not a controller defect. The 45 s limit is shorter than a signal cycle; the HOLDOUT allows 90 s |
| Same scenario, D and E stop 28 m short | D, E | Earlier D/E release hysteresis plus the same queue | Fixed in Task 2 |
| Ordinary Town10HD:63 timeout 8.0 m (B) / 13.8 m (C) short | B, C | RULE braked for a "person" 21.5–23.5 m ahead in the lane. That track is 0.3 m from a stopped vehicle and 40 m from the nearest walker: a camera person label on the queued vehicle | Perception false positive; not fixed (suppressing person labels near vehicles could hide real people) |
| Ordinary Town02:31 / Town02:21 sensor-fault stops | B, E | Processing-deadline holds exceeded the 1 s recovery window | Task 3 (DML detector, bounded 3 s evaluation recovery) |
| Ordinary Town02:21 / Town10HD:63 timeouts | D, E | Repeated short protective holds from the earlier D/E hysteresis (longest single stops 2.0–3.9 s) | Fixed in Task 2 |
| D START_AND_RETURN (VALIDATION) timeout 10 m short | D | Red traffic light on the planned route from 20.2 s to the 45 s limit | Legitimate; HOLDOUT allows 90 s |

Resumption: in the signal-queue episodes the car was moving (> 0.5 m/s)
0.8–1.15 s after the lead vehicle started moving (A, B 0.8 s; C 1.15 s). No
false arrivals: every ARRIVED episode ends
within 4.8 m of the destination (arrival radius 5 m), now checked per episode
(`false_arrival`). The stationary-time metric no longer counts red-light
waits or waits behind a vehicle within 15 m in the planned corridor; those are
reported as `legitimate_wait_s`. This applies to every configuration.

## Task 5 — experimental validity

**Deterministic construction.** In TEST, configuration A's background
population differed from B–E in all four scenarios with background traffic,
including vehicle placements. Cause: the population was applied before the
episode's first tick, while the provider publishes the route to the population
only on ticks. Placement scoring therefore used the *previous* episode's
route. A ran first in each scenario, so only A differed; B–E inherited the
correct route from the preceding run of the same scenario. In addition, the
navmesh sidewalk cache and the recycle/replacement timers carried over between
episodes. `PedestrianBehaviorWorld.prepare_background` now publishes this
episode's route, rebuilds the sidewalk cache after this episode's pedestrian
seed and restarts the timers before the population is applied. The evaluator
now compares background vehicles as well as walkers across configurations.

**Counterfactual prefixes.** Native prefixes diverged because asynchronous
camera inference delivers detections to control at wall-clock-dependent
frames. The harness option `--lockstep-perception counterfactual` (evaluation
only) waits before the native tick after every second frame for the detector
result for exactly that frame and exposes only those results to control: a
fixed one-frame semantic delay at a fixed cadence. The simulation is paused
while waiting, and no control gate changes. Both arms must use the same
timing mode (`verify_pair` rejects mixed pairs). Pairs that still diverge stay
marked by `verify_pair`.

Four native attempts are retained as failures (`task5-lockstep-*-failed-*`,
`-first-frame-miss`, `-stopped-before-light-reset`). Lockstep first waited
during
the vehicle respawn's internal tick, for a frame that no longer existed. It
then let a wait exceed the service's 1 s telemetry-liveness window: the
worker saw "disconnected", nothing could be delivered and the service faulted.
Finally, the first wait could follow route planning that took more than
1 s. The final version waits only inside the service's own control steps of a
running journey. Through a request file, the worker processes every new frame
while a lockstep episode runs; without the file the worker is unchanged. Each
wait is bounded at 0.6 s, and a frame without a result in time is recorded
(`missed_at_s`) rather than stalling the service. Lockstep starts after the
journey's first control step, with labels and depth-person tracks restarted
(track IDs never reused).

A second, deterministic divergence remained: the two arms started about 32 s
apart in simulation time, so traffic-light phases differed (a light ahead can
change the route controller's decisions). Construction now resets all
signal cycles at route configuration, a fixed number of ticks before every
journey, for every configuration and arm (`traffic_lights` in the manifest).

**Result (VALIDATION pair 0, two independent runs, DML detector).** D:
applied commands and ego positions were bit-identical until the decision point
(5.72 s, 114 frames) in both runs, and the walker gap was 0.0. The measured
track sets were not bit-identical (first differences at 0.45 s and 5.15 s),
but no difference reached the commands. B: the arms still diverge. Before the
fixes, the ego gap was 16.0 m with a full-brake command difference. After the
fixes it is 0.55 m with a 0.75 command difference, above the 0.25 m / 0.05
tolerance. In both runs the ego positions differ by 7 mm at 0.65 s while
every command so far was identical; the commands differ from 0.70 s. Measured
track sets differ from 0.3 s (run 1) and 0.65 s (run 2). The ego and command
gaps repeat exactly in both runs. The physical divergence therefore depends on
episode order (simulator state carried across episodes), not on timing; its
source was not isolated. Pairs are therefore reported per configuration with
`verify_pair`, and only identical pairs support counterfactual conclusions
(first divergences per run: `counterfactual_prefixes.first_divergence`).

**Comfort metric.** Reported peak decelerations above 15 m/s² were
cross-checked with a deceleration derived only from positions. The two agree
(TEST medians, speed signal vs positions: A 18.8 vs 18.3, B 25.5 vs 24.2,
D 24.0 vs 24.2 m/s²). The peaks are therefore real CARLA full-brake events at
low speed (3.8–6.7 m/s with brake 1.0), not a measurement artifact. Episode
reports now add the 95th-percentile deceleration and the time above 4 m/s² as
robust comfort statistics.

**Metric corrections (all configurations).** Arrivals must end within the
arrival radius (`false_arrival`). Red-light and stop-sign waits, and waits
behind a vehicle within 15 m in the planned corridor, are reported as
`legitimate_wait_s` rather than unnecessary stationary time. Earlier reports
are not rewritten; re-scored values are labelled.

**New independent HOLDOUT partition.** `config/pedestrian-holdout-partition.json`
(`scripts/build_holdout_partition.py`): 17 locations in Town01, Town02,
Town03 and Town05 with no spawn and no road shared with TRAIN, VALIDATION or
TEST. One spawn is used per road and lane. The partition uses its own seed
namespace (3000–3999) and has 24 specs: each of the ten behaviors with two
seeds, one counterfactual pair and two ordinary journeys. Every spec allows
90 s, one full signal cycle. Red-light waits near route ends were verified to
cause 45 s timeouts on TEST and VALIDATION before the partition was run. The
partition was built once and was not used to tune anything.

### HOLDOUT A–E evaluation (run once, not used for tuning)

`output/pedestrian-suite/holdout-final-20261023`: 24 specs × 5
configurations = 120 episodes, DirectML detector, lockstep perception for the
counterfactual pair only, 90 s limit. It was evaluated once with
`scripts/evaluate_closed_loop.py`; nothing was changed afterwards. The
findings below are reported, not fixed: fixing them would tune on HOLDOUT.

**Validity of the run.**

* *Construction.* 23 of 24 specs were built identically for all five
  configurations (ego and scripted-walker initial spread 0.0 m). The condition
  hash of EMERGE_FROM_PARKED Town03:216 differs only by native actor IDs.
  EMERGE_FROM_PARKED Town05:300 failed construction in every configuration
  (the parked occluder could not be spawned). It is counted as a failed episode.
* *Background.* No walker or vehicle placement differs between configurations
  in the four specs with background traffic (6–13 walkers, 9–18 vehicles). The
  Task 5 fix holds at unseen locations.
* *Script realization.* In three specs a scripted walker never performed its
  script in any configuration: START_AND_RETURN Town03:216, CROSS_NORMAL
  Town05:300 and MULTI_PEDESTRIAN Town02:4. In MULTI_PEDESTRIAN two walkers
  stood in the lane and every configuration timed out. These episodes stay in
  every denominator, but they are not evidence for those behaviors.
* *Simulator failure.* One E ordinary journey is INVALID. The CARLA client
  timed out (30 s) after the Town02 worker crashed natively (0xC0000409). It
  is counted and was not repeated.

**Results (`task5-validity-and-holdout.json`).**

| Metric | A | B | C | D | E |
|---|---|---|---|---|---|
| Arrivals of 24 | 20 | 22 | 22 | 20 | 21 |
| Timeouts | 1 | 1 | 1 | 3 | 1 |
| Collision episodes (walker) | 2 | 0 | 0 | 0 | 0 |
| Missed hazards | 1 | 0 | 1 | 0 | 0 |
| Minimum separation, min / median (m) | −0.19 / 3.16 | 1.19 / 3.23 | 1.19 / 3.03 | 1.19 / 3.38 | 1.19 / 3.42 |
| Unnecessary braking events | 62 | 108 | 145 | 244 | 90 |
| — of which pedestrian forecast | 0 | 40 | 78 | 142 | 20 |
| Unnecessary full stops | 30 | 38 | 48 | 86 | 32 |
| Unnecessary stationary time (s) | 103.0 | 116.1 | 121.5 | 284.2 | 106.8 |
| Brake/release oscillations | 250 | 293 | 301 | 466 | 265 |
| Median journey time, arrived (s) | 17.7 | 22.4 | 23.6 | 20.6 | 20.7 |
| Ordinary journeys arrived | 2/2 | 2/2 | 2/2 | 1/2 | 1/2 (1 INVALID) |
| Fresh usable frames | 99.99 % | 100 % | 99.99 % | 99.91 % | 100 % |
| Observation→control median / p95 (ms) | 75 / 95 | 128 / 178 | 132 / 182 | 137 / 210 | 127 / 174 |
| Processing-deadline hold frames | 3 | 3 | 12 | 115 | 2 |
| Real-time factor (median) | 0.62 | 0.39 | 0.37 | 0.38 | 0.39 |
| p95 deceleration, median (m/s²) | 5.6 | 7.8 | 7.0 | 6.6 | 6.6 |

The highest speed was 14.1 m/s (51 km/h) in every configuration; the requested
target stayed 120 km/h. A's two collisions were SUDDEN_RUN Town01:182 and the
sudden-crossing arm of the counterfactual pair (Town01:91). "Missed hazards"
counts corridor-ingress events with contact or with neither a prediction nor
a braking lead. A's SUDDEN_RUN contact has no recorded corridor-ingress event,
so it appears only as a collision.

**Outcome.** No superiority claim holds: D over B, E over B and D over E all
fail the evaluator's rule. Safety was not worse (0 collisions for B–E), but
efficiency and the acceptance gates fail. **D failed on HOLDOUT.** Paired with
B, it had +136 unnecessary braking events, +168 s unnecessary stationary time
and −2 arrivals; it also failed the ordinary-journey gate. The VALIDATION
improvement of Task 2 did not generalize. Most of the excess comes from three
episodes:

1. CROSS_NORMAL Town02:7: a 77.8 s stall in which supervised coverage
   alternated between 3.0 and 7.5 m. The route-path probe first failed at an
   unobserved sample at (5.5, 7.0) m in the vehicle frame. The stall
   classifier leaves it UNCLASSIFIED; B, C and E arrived.
2. ORDINARY Town02:41: RULE measured-motion braking plus 70
   processing-deadline hold frames led to a timeout.
3. MIXED_TRAFFIC Town01:118: 37.5 s stationary (E: 2.0 s); learned risk was
   used in 49 frames.

E (the physics-only ablation) braked less than B (90 vs 108 events, 32 vs 38
full stops). However, one of E's two ordinary journeys is the INVALID
simulator failure, so the gates fail and nothing is claimed.

**Counterfactual pair (Town01:91).** Only A kept an identical observable
prefix (0.0 m and 0.0 command gaps). There, the reactive controller hit the
walker in the sudden-crossing arm and arrived in the stationary arm. In B–E
the arms diverged before the decision point at 4.19 s (ego 2.9–5.6 m, full
command difference), while scripted-walker truth was identical (0.0 m). There
are two mechanisms:

* *B, physical.* As on VALIDATION, the ego positions differ by 8 mm at 0.65 s
  while every command so far was identical; the commands differ from 0.70 s.
  The simulator's physical state differed between the arms (episode order).
* *C–E, perception.* Commands and ego positions stayed bit-identical until
  2.15 s (C) and 2.35 s (D, E). The measured track sets differ first, from
  0.95 s; in D a camera depth-person track 57 m ahead exists in only one arm.
  C and D each missed one lockstep frame before the decision; E missed none.
  The perception input itself differed, not only its timing. Camera
  post-processing (temporal auto-exposure) carries render state across
  episodes and is one candidate, but it is not verified.

No counterfactual conclusion is drawn for B–E.

**Path-entry predictor on HOLDOUT** (artifact `path_entry_risk_v1/714c4b86…`,
admitted for prediction, disabled in production; scored offline on each
configuration's own logs). In B's logs the predictor only observed, so B is
the clean comparison. Prediction coverage was 85.3 % (17,621 samples); missing
futures and in-path-at-decision samples are listed per horizon in the evidence.

| Horizon | Model AUROC / AUPRC | Kinematic CV AUROC / AUPRC | Model / kinematic Brier | Model ECE | Model / kinematic F1 at threshold | Model recall / FPR | Entering walkers missed at threshold |
|---|---|---|---|---|---|---|---|
| 1 s | 0.919 / 0.429 | 0.824 / 0.420 | 0.0098 / 0.0094 | 0.006 | 0.49 / 0.51 | 0.39 / 0.003 | 5 of 11 |
| 2 s | 0.907 / 0.398 | 0.759 / 0.356 | 0.0219 / 0.0217 | 0.020 | 0.47 / 0.48 | 0.46 / 0.015 | 2 of 12 |
| 3 s | 0.873 / 0.392 | 0.700 / 0.288 | 0.0349 / 0.0380 | 0.038 | 0.45 / 0.43 | 0.44 / 0.021 | 2 of 12 |

The constant-prevalence baseline has AUROC 0.5 and AUPRC 0.013–0.039.
Probabilities are calibrated (ECE ≤ 0.038), and the model ranks better than
constant-velocity kinematics. At 1–2 s, however, it is no better in Brier
score or at its operating threshold, and recall is below 0.5. It stays
disabled in production and is not evidence for learned control.

## Task 6 — final admission and integration

**Offline regression.** Python 852 tests OK (4 skipped: optional
environments), JavaScript 180/180, detector decode and execution-provider
tests OK (2/2) in both the CPU and DirectML perception environments. The
frontend was not changed.

**Production unchanged.** Offline replay of a recorded production run
(`run_55f3028020ae4f449f4dceaaf9b7efc3`, 150 frames, scene builder + RULE
supervisor) gives the same output digest with the `ae7e9e1` modules and with
this branch: `439ab4f0f8b2bd7dc87472177a8e6183ea0894b3d30668a3268c1de4b1737ccc`.

<!-- CROSSING_RESULTS -->

**Gating.** Learned control and RL stay disabled. The path-entry predictor
stays admitted for prediction but disabled in production
(`config/path-entry-risk.json`, `enabled: false`). Configurations C, D and E,
the route tracker, the route probe, async risk, lockstep and the 3 s recovery
window apply only to harness evaluation journeys. The DirectML detector is
opt-in.

<!-- SUMMARY -->
