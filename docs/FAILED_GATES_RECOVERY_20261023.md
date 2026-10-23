# Failed-gates recovery — 23 October 2026

Branch `repair/failed-gates-20261023` (from `ae7e9e1`). Six sequential tasks
followed reproduce → identify cause → fix → test → compare → record. Evidence
is in [evidence/failed-gates-recovery-20261023](evidence/failed-gates-recovery-20261023/),
compiled by `scripts/report_failed_gates_recovery.py` from ignored native
outputs under `output/`. Raw outputs, failed attempts and superseded runs are
retained under their own folder names; none were overwritten.

Production decision code is unchanged on replay. Two offline replays through
the scene builder and the RULE supervisor (the Ya Rab Ostorha decision path)
give the same output digests as `ae7e9e1`. The other production-reachable
changes are attribute writes, an unused argument, or evaluation-only
branches, according to a review of the diff `ae7e9e1..HEAD`. That review is
a code review, not part of the evidence files. Native crossing pairs show
run-to-run variance in the predictive-braking review (Task 6). New behavior
is limited to harness evaluation journeys
(`journey.evaluation`), the evaluation-only decision layers (C/D/E), and
opt-in runtimes. Learned control and RL stay disabled.

## Task 1 — corner and turn deadlocks

**Reproduce.** With the previous evaluation steering (`--route-tracker off`)
the three failing routes failed again: Town02 spawn 25 (route-end turn) and
Town01 spawn 51 (90° corner) timed out at 45 s, and Town10HD spawn 63 needed
44 s. Stop-frame dumps (LiDAR, route, probe paths) were classified by
`scripts/classify_route_stalls.py`.

**Cause.** Two defects, both in evaluation navigation:

* *Off-route alignment.* The previous low-speed pursuit and PID did not follow
  sharp turns. At the stall the applied steering was 0.22–0.23 (limit 0.35)
  while the route turned 43–89° within the next 5–15 m (`geometry_at_stop`).
  In Town02 and Town01 the rear axle ended 3.0–3.2 m off the route line; in
  Town02 the car stood against the inside curb of the turn.
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
exactness-tested against the original projection. With it, the verification
run below had no processing faults. That run is kept as
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
22.5 s unnecessary stationary time). Frame traces of that run (a diagnostic
inspection, not part of the evidence files) showed three D-only causes:

1. The pedestrian layer armed its release (0.4 s) and raise (0.5 s) holds
   after *measured-obstacle* brakes that involved no person; each obstacle
   flicker became a ~1 s full stop. RULE already has its own obstacle
   hysteresis.
2. After a person-related RULE brake, the holds continued in frames where no
   person conflict remained (`NO_SPECULATIVE_CONFLICT`); most hold frames in
   the stationary periods had no remaining person conflict.
3. During holds D kept 0 m/s even when RULE's own verified crawl (what B does)
   allowed a higher speed; short-lived depth-person tracks re-armed the holds,
   so D was more restrictive than the B baseline.

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
latency and reaction delays (`tests/test_evidence_budget_replay.py`,
`test_sudden_sprint_at_any_moment_never_collides`). No collisions occur in the
sweep.

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

Both configurations had one EMERGE_FROM_PARKED construction failure (worker
log: "Invalid parked occluder spawn; no geometry substitution"; the episode is
counted and failed explicitly). The WAIT_AT_CURB episode shows the intended change: 13.7 s
instead of 23.6 s with one stop instead of three. The evaluator's formal
superiority rule fails only on arrivals (11 vs 12), so no superiority is
claimed from VALIDATION. The superseded intermediate runs are kept (see the
evidence file).

## Task 3 — sensor timing and processing stalls

**Reproduce / cause.** In the phase-7 TEST logs, the frames immediately
before processing-deadline holds had median scene builds of 122.5 ms against
41.6 ms for other frames: semantic association and freezing took 67.2 vs
12.7 ms and tracking 40.9 vs 20.0 ms. Their sensor-arrival spread was 61.7 vs
38.0 ms and their safety steps 42.0 vs 32.3 ms (`phase7_test_hold_frame_profile`).
The CPU detector worker (≈ 420–500 ms per image) competes with the control
pipeline for the same cores. Holds became `SENSOR_FAULT` stops after the 1 s
recovery window.

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
| Safety step median / p95 (all frames) | 39 / 60 ms | 33 / 47 ms |
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
| Decision-layer time, median of per-episode median / p95 | 3.96 / 7.51 ms | 0.13 / 1.73 ms |
| Safety step median / p95 (all frames) | 37.8 / 52.8 ms | 39.4 / 55.1 ms |
| Same-frame risk results, of frames carrying a risk status | 5,012 of 5,024 | 4,977 of 4,995 (6 over budget) |
| Arrivals / collisions | 11 / 0 | 11 / 0 |
| Unnecessary braking / full stops | 58 / 17 | 55 / 16 |

The inference left the layer's critical section, and its wait is now bounded
at 15 ms. The total safety step was not faster, however. A likely cause (not
measured) is that, in CPython, the background thread competes with the safety
step for the interpreter lock. Async is kept as the evaluation default because
of the bound; a measured latency gain is not claimed.

## Task 4 — mixed traffic and route completion

Every TEST failure in mixed-traffic and ordinary journeys was classified from
the logs; evaluator truth was used offline only
(`task4-route-completion.json`).

| Failure | Configurations | Verified cause | Action |
|---|---|---|---|
| MIXED_TRAFFIC Town10HD:143 timeout ~9 m short | A, B, C | Stationary lead vehicle in the lane, 8 m ahead, stationary 91–96 % of a 13–24 s stop. The lead vehicle started moving at 42.85 s and the car followed (queue near the route end) | Not a controller defect. The 45 s limit was too short for this queue; the HOLDOUT allows 90 s |
| Same scenario, D and E stop 28 m short | D, E | The earlier (V1) evidence-budget layer behind the same queue. Final reasons: D "bounded approach below verified 0.0 m/s", E "advancing below verified 4.0 m/s crossing limit" | Layer replaced by V2 (Task 2); D still failed on HOLDOUT |
| Ordinary Town10HD:63 timeout 8.0 m (B) / 13.8 m (C) short | B, C | RULE braked for a "person" 21.5–23.5 m ahead in the lane. That track is 0.3 m from a stopped vehicle and 40 m from the nearest walker: a camera person label on the queued vehicle | Perception false positive; not fixed (suppressing person labels near vehicles could hide real people) |
| Ordinary Town02:31 (B, E) and Town02:21 (E) sensor-fault stops | B, E | Processing-deadline holds exceeded the 1 s recovery window | Task 3 (DML detector, bounded 3 s evaluation recovery) |
| Ordinary Town02:21 (D) and Town10HD:63 (D, E) timeouts | D, E | Repeated short protective holds from the earlier V1 D/E layer (longest single stops 2.0–3.9 s) | Layer replaced by V2 (Task 2) |
| D START_AND_RETURN (VALIDATION) timeout 10 m short | D | Red traffic light on the planned route from 20.2 s to the 45 s limit | Legitimate; HOLDOUT allows 90 s |

Resumption: in the queue episodes the car exceeded 0.5 m/s 0.8–1.15 s after
the lead vehicle started moving (A, B 0.8 s; E 0.9 s; C 1.15 s;
`ego_response_after_lead_s`). D's 0.05 s is excluded: D had already started
creeping before the lead moved. No false arrivals: every ARRIVED episode ends
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
applied commands and ego positions were identical to log precision (1 mm,
0.001) until the decision point (5.72 s, 114 frames) in both runs. The walker
gap was 0.0. The measured track sets were not identical (first differences at
0.45 s and 5.15 s), but no difference reached the commands. B: the arms still
diverge. In the retained lockstep attempt before the signal reset, B's ego
gap was 16.0 m with a full-brake command difference
(`before_signal_reset_attempt`). After the signal reset it is 0.55 m with a
0.75 command difference, above the 0.25 m / 0.05 tolerance. In both runs the ego positions differ by
7 mm at 0.65 s while every logged command so far was equal. The logged gear
differs at 0.70 s (one arm still in neutral, the other in first). Commands
differ from 0.70 s, by more than 0.05 from 1.85 s. The gaps repeat exactly in
both runs (`counterfactual_prefixes.first_divergence`).

**Cause of B's divergence (found after the HOLDOUT run).** The ego is
respawned for every episode. The harness's first control step after the
respawn is chosen before the new vehicle's first reading arrives, from the
destroyed vehicle's last reading. `SimulationService._choose` copies that
reading's gear into the fallback safety command. A previous car that ended in
neutral therefore gives one tick of manual neutral; one that ended stopped in
first gear gives one tick of automatic drive. First gear then engages one
50 ms tick earlier or later, depending only on how the *previous* episode
ended. In a diagnostic analysis of the run logs (not part of the evidence
files), a rule based on the previous episode's ending predicts the launch
frame in 122 of 122 episodes of the three runs above, and in 364 of 376 older
episodes. In these runs only B's two arms followed episodes that ended
differently; the other configurations' arms followed matching endings. The
harness now
resets that carried-over reading to neutral after every respawn
(`reset_ego`; unit-tested), so every episode starts from the same first
command. Production journeys are unaffected.

**Verification of the respawn fix (VALIDATION pair 0, B and D, lockstep,
DML; same command as before; `respawn_gear_fix_verification`).** In two
independent runs, both B and D kept identical observable prefixes until the
decision point (5.72 s, 114 frames). The ego, command and walker gaps were
0.0; before the fix, B had 0.55 m and 0.75. In both runs B's stationary arm
had an incomplete lockstep prefix (`lockstep_complete_before_decision`)
without any change to the prefix.
All eight episodes arrived. The measured track sets still differ between the
arms, but the differences no longer reach the commands. The perception-input
divergence of C–E on HOLDOUT is a separate mechanism and was not re-tested
(the only HOLDOUT run is `holdout-final-20261023`).

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
counterfactual pair only, 90 s limit. It was evaluated with
`scripts/evaluate_closed_loop.py`. No controller or evaluation code was changed
in response to its results. The one later change, the harness respawn gear
fix, addresses a determinism defect seen on VALIDATION and HOLDOUT alike; it
was verified on VALIDATION only, and HOLDOUT was not rerun. The findings
below are reported, not fixed: fixing them would tune on HOLDOUT.

**Validity of the run.**

* *Construction.* 23 of 24 specs were built identically for all five
  configurations (ego and scripted-walker initial spread 0.0 m). The condition
  hash of EMERGE_FROM_PARKED Town03:216 differs only in native actor IDs
  (`condition_hash_differences`: walker and occluder `id` fields).
  EMERGE_FROM_PARKED Town05:300 failed construction in every configuration.
  The worker logged "Parked occluder would intrude into the planned
  corridor" (`worker_logged_failures`). It is counted as a failed episode.
* *Background.* No walker or vehicle placement differs between configurations
  in the four specs with background traffic (6–13 walkers, 9–18 vehicles). The
  Task 5 fix holds at unseen locations.
* *Script realization.* In three specs a scripted walker never performed its
  script in any configuration: START_AND_RETURN Town03:216, CROSS_NORMAL
  Town05:300 and MULTI_PEDESTRIAN Town02:4. In MULTI_PEDESTRIAN two scripted
  walkers (`ped_0`, `ped_2`) never performed their scripts, and every
  configuration timed out. These episodes stay in every denominator, but
  they are not evidence for those behaviors.
* *Simulator failure.* One E ordinary journey is INVALID. The worker logged
  "time-out of 30000ms while waiting for the simulator"
  (`worker_logged_failures`). It is counted and was not repeated.

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
targets were 30, 40 or 50 km/h per spec. A's two collisions were SUDDEN_RUN
Town01:182 and the
sudden-crossing arm of the counterfactual pair (Town01:91). "Missed hazards"
counts corridor-ingress events with contact or with neither a prediction nor
a braking lead. A's SUDDEN_RUN contact has no recorded corridor-ingress event,
so it appears only as a collision.

**Outcome.** No superiority claim holds: D over B, E over B and D over E all
fail the evaluator's rule. B–E had no collisions; C had one missed hazard (an
ingress without a prediction or braking lead), B, D and E none. Efficiency and
the acceptance gates fail. **D failed on HOLDOUT.** Paired with B over 23
episodes, it had +136 unnecessary braking events, +48 full stops, +168 s
unnecessary stationary time and −2 arrivals; it also failed the
ordinary-journey gate. The VALIDATION improvement of Task 2 did not
generalize. The excess is concentrated (`paired_d_minus_b_by_episode`); 20
of the 23 paired episodes differ by at most two braking events.

* *Braking events.* MULTI_PEDESTRIAN Town02:4 accounts for +109 (D 113 vs
  B 4). There, two scripted walkers never performed their scripts and every
  configuration timed out (see *Script realization*). MIXED_TRAFFIC Town01:118 adds +40
  events and +31 full stops (37.5 s stationary vs E 2.0 s; learned risk was
  used in 49 frames).
* *Stationary time.* CROSS_NORMAL Town02:7 (+76.8 s), ORDINARY Town02:41
  (+65.3 s) and MIXED_TRAFFIC Town01:118 (+34.9 s) account for the excess.
  D timed out in the first two, while B arrived.
* *CROSS_NORMAL Town02:7* (diagnostic analysis of the frame log and the 74
  stop dumps; not part of the evidence files). The stall is a deadlock of
  the shared RULE coverage check, not of D's layer. D's layer reported
  "continue, no speculative conflict" in 1,530 of 1,545 frames at the stall
  position. D slowed sharply in the middle of a 90° right turn (radius about
  8 m) and stopped about 17° behind the road heading, close to the inside
  curb. There, the supervised coverage flickered from frame to frame: 3.0 m
  in 47 % of frames, 5.0 m in 21 %, 6.5–7.5 m in 32 %. The probe always
  failed on unobserved cells, never on occupied ones. Road cells next to the
  inside-corner curb lost their free status whenever the curb cells were
  marked occupied, which happened intermittently, plausibly through the
  per-frame ground fit around the 0.12 m obstacle threshold. The front depth
  camera does not see those cells (53–68° to the right), and the free-space
  map has no memory. The release needs 7 consecutive clean frames. D's four
  restart attempts crept the car further into the turn, where 3.0 m frames
  were more frequent. B passed the spot at 5.9–7.2 m/s. C and E passed slowly
  and stopped where coverage stayed at 3.5 m or more. The stall classifier
  uses the median coverage (5.0 m) and therefore reports UNCLASSIFIED. This
  is a coverage-model limitation that any configuration can hit when stopped
  close to an inside curb; it is reported, not tuned on HOLDOUT.
* *ORDINARY Town02:41.* D's braking events were coverage 25, pedestrian
  forecast 11, timing deadline 6, measured obstacle 1 and other 1, with 70
  processing-deadline hold frames and learned risk used in 234 frames. The
  journey timed out at 90 s; the logs do not isolate a single cause.

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
  while every logged command so far was equal. The logged gear differs at
  0.70 s; this is the respawn first-gear effect described above. Here B's
  sudden-crossing arm followed A's collision episode, while every other arm
  followed an episode that ended stopped in first gear.
* *C–E, perception.* Commands and ego positions stayed identical to log
  precision until 2.15 s (C) and 2.35 s (D, E). The measured track sets
  differ first, from 0.95 s; in D a camera depth-person track 57 m ahead
  exists in only one arm. C and D had incomplete lockstep prefixes before the
  decision; E's was complete (`lockstep_complete_before_decision`). The
  perception input itself differed, not only its
  timing. Camera post-processing carries render state across episodes and is
  one candidate, but it is not verified.

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

The constant-prevalence baseline has AUROC 0.5 and AUPRC 0.013–0.039. The
measured calibration error is low (ECE 0.006–0.038), and the model ranks
better than constant-velocity kinematics. At 1–2 s, however, it is no better
in Brier score or at its operating threshold, and recall is below 0.5. It
stays disabled in production and is not evidence for learned control.

## Task 6 — final admission and integration

**Offline regression.** Python 853 tests OK (4 skipped: optional
environments), JavaScript 180/180, detector decode and execution-provider
tests OK (2/2) in both the CPU and DirectML perception environments. The
frontend was not changed.

**Production paths.** Offline replays through the scene builder and RULE
supervisor give identical output digests with the `ae7e9e1` modules and
with this branch. That holds for a recorded production run
(`run_55f3028020ae4f449f4dceaaf9b7efc3`, 150 frames:
`439ab4f0f8b2bd7dc87472177a8e6183ea0894b3d30668a3268c1de4b1737ccc`) and for
the Ya Rab Ostorha arm of a native crossing pair recorded in this task
(`run_84c1fa1a0a304ec9adb3d51c929146fd`, 709 frames:
`cc7d0b9e8cce07793e6766a47878f649f06983115980abefe6c1085eee074174`). The
replays cover the Ya Rab Ostorha decision path only; Normal's reactive
driver, the detector process and the stale-data window were not replayed. A
code review of the diff (this task; not part of the evidence files) found
that their production-reachable changes are attribute writes, an unused
argument or evaluation-only branches.

**Native crossing regression (original Normal vs Ya Rab Ostorha comparison;
`scripts/native/validate_crossing_pair.py`, unchanged; `task6-integration.json`).**
Each attempt runs a full production pair: guided presentation, CPU detector,
natural terminal events, Finish, cleanup and engine exit. Source files were
checked against `ae7e9e1` from each run's source archive; run conditions
(host load, interruptions, pre-registration) are recorded per run as `note`.

| Seed, first arm | Backend | Runs | Scenario validation* | Pre-ingress speculative forecast† | Lifecycle gates‡ | Strict first-motion acceptance |
|---|---|---|---|---|---|---|
| 1701, Normal first | branch | 7 | 7 | 2 | 6 | 0 |
| 1701, Normal first | `ae7e9e1` | 5 | 5 | 3 | 3 | 0 |
| 1701, Normal first | bisection variants | 3 | 3 | 1 | 0 (1 not evaluable: parent interrupted) | 0 |
| 1702, Ya Rab Ostorha first | branch | 2 | 1 | 1 | 0 | 0 |
| 1703, Normal first | branch | 1 | 1 | 1 | 1 | 1 |

\* Normal collides with the critical walker, Ya Rab Ostorha arrives without
contact, verified initial conditions, same detector and requested speed.
† `scripts/crossing_user_acceptance.py`: an applied speculative person brake
from ≥ 20 km/h, ≥ 0.5 s before path ingress and before Normal's contact.
‡ complete recordings, Finish waited for exports, cleanup, independent
cleanup probe, engine exit, three playable videos, source unchanged.

* *Outcomes.* 18 attempts gave 17 complete pairs. In all 17, Normal hit the
  walker (5.95–6.0 s) and Ya Rab Ostorha arrived without contact
  (30.4–69.9 s; the longer arrivals contain later stops). 10 of 18 attempts
  passed all lifecycle gates. The incomplete attempt is the first seed-1702
  run. There, the Ya Rab Ostorha arm stopped fail-closed at 3.9 s on the
  0.25 s sensor-freshness deadline, so Normal was not run. A diagnostic
  analysis (not part of the evidence files) found the deadline missed in
  four consecutive frames. An offline replay of those frames on branch code
  tracked in 12 ms instead of 115 ms live, so the stage times were host
  stalls. Runs on 23 October were 10–20 % slower than on 20 October, and
  fifteen earlier seed-1702 pairs had no such fault. The repeat passed the
  scenario. The fault is classified as intermittent and recorded as a
  failure.
* *Seed 1703* passed every gate, including the strict first-motion audit:
  forecast and brake at 4.65 s, before the walker's first motion at 4.85 s,
  1.2 s before path ingress.
* *The pre-ingress forecast is a timing race in both versions* (diagnostic
  analysis of the recorded runs; not part of the evidence files). On seed
  1701 it can fire only in a one-to-two-frame window around 4.9 s. The
  walker's depth-person track must carry a ≥ 0.65 camera person label with
  valid torso depth while the walker is still below 0.3 m/s. Only the camera
  frames at about 4.70–4.80 s qualify; offline YOLO on the recorded images
  reproduced all 41 worker detections exactly. Passing runs happened to
  process one of those frames; failing runs processed the neighbouring
  frames. The asynchronous CPU worker picks frames by wall clock.
* *No reproducible version effect.* A first, unplanned bisection appeared to
  separate the versions: 3 passes with the `ae7e9e1` service/provider and 0
  of 5 without. Several of those runs ran under concurrent analysis load. A
  pre-registered, interleaved replication on an idle host then gave branch
  2 of 3 and `ae7e9e1` 1 of 3. Over all seed-1701 runs the rates are 2 of 7
  (29 %, branch) and 3 of 5 (60 %, `ae7e9e1`), 5 of 12 (42 %) combined. This
  sample is too small to show equivalence. Together with the identical
  replay digests and the code review, the difference is attributed to
  run-to-run variance, not to the branch. The forecast came 0.9–1.5 s before
  path ingress in all six historical pairs of 20 October
  (`docs/evidence/sequential-repair-20261023/phase8-crossing-regression.json`)
  but in fewer than half of the seed-1701 runs on 23 October. Its reliability
  therefore depends on host timing; this is a remaining limitation of
  production.
* *Lifecycle.* Export and finalization failures occurred with both versions
  and are recorded per run: a Windows "Permission denied" on a recording's
  `video-status.json`, Finish not waiting for exports, and one native crash
  of the validator worker during finalization (0xC00000FD, after both arms
  had finished).

**Gating.** Learned control and RL stay disabled. The path-entry predictor
stays admitted for prediction but disabled in production
(`config/path-entry-risk.json`, `enabled: false`). Configurations C, D and E,
the route tracker, the route probe, async risk, lockstep and the 3 s recovery
window apply only to harness evaluation journeys. The DirectML detector is
opt-in.

## Summary

| Task | Status | Exact remaining criterion |
|---|---|---|
| 1 Corner/turn deadlocks | Implemented and verified on the reproduced routes | HOLDOUT: one D stall mid-turn near an inside curb (shared RULE coverage limitation, Task 5) |
| 2 Unnecessary pedestrian braking (D) | Implemented; verified on VALIDATION; **failed on HOLDOUT** | HOLDOUT D vs B: +136 braking events, +48 full stops, +168 s stationary, −2 arrivals; ordinary gate 1/2 |
| 3 Sensor timing / processing stalls | Implemented and verified (opt-in DirectML) | Real time not reached (RTF 0.39); async risk gave no net latency gain |
| 4 Mixed traffic / route completion | Failures classified; metrics corrected; B and C pass the ordinary gate on HOLDOUT | D and E fail the ordinary gate on HOLDOUT; camera person false positive on a queued vehicle not fixed |
| 5 Experimental validity | Implemented: deterministic background, signal reset, lockstep, comfort check, HOLDOUT partition built and evaluated (single run), respawn first-gear fix (B and D VALIDATION prefixes identical in 2 of 2 runs) | C–E HOLDOUT counterfactual prefixes still differ through perception input |
| 6 Integration | Offline suites pass; RULE replay digests identical; 18 native crossing attempts (17 complete pairs) recorded | Pre-ingress forecast is a timing race (seed 1701: 5 of 12 runs, no reproducible version effect); one intermittent fail-closed sensor fault; export/finalization failures in both versions (10 of 18 attempts passed all lifecycle gates) |

**Before and after.** "Before" is the phase-7 TEST evaluation at `ae7e9e1`
(17 specs, 45 s limit, CPU detector). "After" is this branch on VALIDATION (13
specs, DirectML) and on the new HOLDOUT (24 specs, 90 s, DirectML). The
partitions differ, so cross-partition comparisons are indicative only. The
CPU-vs-DML VALIDATION comparison in Task 3 is the controlled timing
comparison.

| Measure | Before (TEST) | After (VALIDATION) | After (HOLDOUT) |
|---|---|---|---|
| Route completion B / D | 8/17 / 8/17 | 12/12 / 11/12 valid | 22/24 / 20/24 |
| Ordinary journeys B / D | 1/3 / 1/3 | 2/2 / 2/2 | 2/2 / 1/2 |
| Corner deadlocks (reproduced routes; Task 1 diagnostic runs, configuration B) | 2 timeouts + one 44 s journey (TEST: all configurations ~18 m short at Town02:25) | 8/9 arrived, 0 corner stalls | 1 D mid-turn coverage stall |
| Unnecessary full stops B / D | 35 / 69 | 24 / 16 | 38 / 86 |
| Pedestrian collisions (A) | B–E 0 (A 2) | B, D 0 | B–E 0 (A 2) |
| Brake/release oscillations B / D | 237 / 327 | 173 / 153 | 293 / 466 |
| Observation→control B, median / p95 | 140 / 203 ms | 129 / 176 ms | 128 / 178 ms |
| Real-time factor B (median) | 0.35 | 0.39 | 0.39 |

**Production status.** On replay, the Ya Rab Ostorha decision path on this
branch is decision-identical to `ae7e9e1`. The other production components
have only no-op changes (code review): the Normal reactive driver, the CPU
YOLO detector, the guided crossing comparison and the 1 s stale window.
Experimental and evaluation-only:

* decision layers C, D (V2) and E;
* route tracker and route probe;
* async frame-bound risk;
* lockstep perception;
* the 3 s evaluation stale window;
* respawn gear normalization;
* the DirectML detector (opt-in by environment variable).

The path-entry predictor stays admitted for prediction but disabled in
production. On HOLDOUT it is no better than constant-velocity kinematics in
Brier score at 1–2 s. Learned control and RL stay disabled; RL was not
retrained. The branch is not merged into `main`.
