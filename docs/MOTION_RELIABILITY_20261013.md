# Measured motion, maneuver prototype and acceptance — 13 October 2026

Normal journeys default to **30 km/h**, capped by the road limit. RULE remains
the ordinary sensor safety controller. The new planner, lateral avoidance,
rear-escape acceleration and learned control **have not been accepted** and are
disabled in normal driving. This delivery implements the pipeline and its
admission gates; it does not establish general collision avoidance.

The final ordinary RULE smoke journey (seed 7303, chaos 0%) **arrived and stopped**,
with zero recorded contacts and sensor errors. It reached 30.90 km/h. Three
additional 55-second journeys, at chaos 0/50/85% with seed 7301, recorded no
contacts but did not arrive inside their time windows. Red-light waiting was
observed; stopped time is not automatically an unnecessary-stop count.

## Implemented

- Fixed forward policy RGB and depth cameras, separate from the adjustable
  800×450 driving camera. Native checks changed the view to rear and verified
  that policy/depth mounts did not move. Policy images are 320×180, FOV 90°;
  the display camera retains the user's settings.
- Own ego bounding box, wheelbase and maximum steering angle come from native
  vehicle specifications. The same asymmetric footprint is used in the planner
  and RULE. Current physical wheel angle / speed-dependent steering response
  still needs native calibration; maximum steering angle alone is not a complete
  vehicle dynamics model.
- Right-positive, metric, timestamped odometry; compensated delayed scenes and
  conservative rotation of boxes. Finite ordered curved-path projections replace
  proximity to a straight infinite corridor.
- Registered surface anchors, one-to-one associations, temporary occlusion,
  stationary deadband and bounded acceleration/turn estimates. A regression
  found during TRAIN collection froze targets moving more than the 0.65 m
  registration radius between scans. A second displacement seed fixes that
  specific defect; it does not solve every identity switch or missed detection.
- Separate stationary, constant-velocity, acceleration and coordinated-turn
  hypotheses, **3 seconds at 0.1-second steps**. Uncertainty margins stay separate
  and are explicitly uncalibrated. Head/gaze direction is unknown.
- Trajectron's CARLA-to-nuScenes axis/heading conversion and measured-continuity
  ranking; selected hypothesis plus at most two alternatives, with rejection
  reasons. No continuity weight is presented as collision probability.
- Experimental candidate planner: continue, slow, brake, bounded acceleration,
  within-lane offset, legal same-direction lane change, pass and return states.
  Full rectangular body occupancy is checked at equal times. A LiDAR local map
  distinguishes free, occupied and unknown space; unknown/stale space cannot
  admit new lateral or acceleration maneuvers. Native target poses are confined
  to arranging/evaluating fixtures. Ordinary BasicAgent vehicle-truth avoidance
  is disabled; synchronized sensor RULE owns forward obstacle protection.
- Ten-Hz experimental planning with new path validation before existing control
  arbitration and RULE. Candidate comfort limits are 2/3/2 m/s² longitudinal
  acceleration, normal deceleration and lateral acceleration. Actual native
  comfort compliance was **not** established. Emergency braking has priority.
- Separate asynchronous display observer; inference does not wait inside the
  control loop. Display-only geometry is capped at 5 Hz when the planner is off;
  experimental planning retains 10 Hz. Camera and detector schedules are separate.
- Side-by-side driving/model views and the existing cars → randomness →
  destination → drive sequence. Numeric speed, gaps, TTC, acceleration, measurement
  age, inference/planner time, selected-object motion/clearance, decision reasons,
  ADE/FDE at 1/2/3 seconds, bounds, sample counts and missing coverage.
- Forecast V3, `motionQuality` and `maneuver` retain legacy fields. Image overlays
  require the image's own timestamp, frame and calibration; a matching forecast
  may be unavailable on skipped observation frames, in which case it is hidden.
  Live ADE/FDE measures consistency with subsequent sensor tracks, not independent
  truth. Offline evaluator labels are independent native motion.

## Retained results and limits

The nine-journey prototype matrix used three seeds (7301–7303) at 0/50/85% chaos.
It produced **0/9 arrivals**, poor progress/comfort and a recorded collision in
the 85%, seed 7302 run. Earlier invalid spawn/teleport attempts remain in `round1`
under `output/motion-reliability`; they were not silently counted as successes.

Eighteen native fixtures covered clear road, parked-side car, parallel and
crossing pedestrians, cut-in, sudden braking, rear approach, occupied adjacent
lane and pass/return, repeated as TRAIN/VALIDATION. Both rear-approach repeats
collided. Pass/return was never admitted because sufficient free space was not
verified. Two fixture runs also hit a test-harness heartbeat timeout. A separate
four-fixture tracker-fix retest removed that harness problem but **both rear
approaches still collided**. These failures keep the planner gate closed.

The frozen TEST selection is three complete recordings from the existing TEST
split, frozen by hash before replay. All three share seed 2589; this is limited
scenario diversity. The first 500 frames per file are the stated replay scope.
Unmatched, ambiguous, missing future labels and short horizons remain reported.

| Horizon | Paired samples | Old ADE / FDE (m) | New ADE / FDE (m) |
|---|---:|---:|---:|
| 1 s | 9 | 1.79 / 3.59 | 0.82 / 1.73 |
| 2 s | 8 | 3.86 / 7.80 | 1.56 / 3.23 |
| 3 s | 7 | 6.13 / 12.17 | 2.66 / 5.26 |

Those pairs match recording, query frame, independently associated actor and
horizon. Three duplicate pairs are explicitly excluded from paired means and
retained in all-forecast totals. The sample is too small to establish improvement.
Across all tracked sets, which differ between methods, new ADE/FDE is
1.29/2.64, 2.55/5.13 and 4.06/8.07 m, with only **11.46% coverage**. Trajectron
has **zero scored samples** because recorded sensor classification coverage was
absent. No missing-hazard or false-stop improvement has been established, so
learned control cannot pass its admission criteria.

The optional supervised selector/correction head and TRAIN/VALIDATION fitter
are implemented. Collection yielded only 12 moving TRAIN and 5 moving VALIDATION
examples; the fitter refused a stationary-dominated fit. **No new training ran**,
no checkpoint was replaced, and TEST was not used for fitting or parameter choice.

The frozen SAC interface was reviewed as a braking-only comparison: 47 sensor
features and gate/extra-brake/steering-delta actions. Its feasibility layer cannot
certify side/rear steering or acceleration. Historical stored trained results
record `policy_active=false`, so their eight collisions cannot establish active
SAC performance. No new SAC comparison or RL training was run, and it was not
repurposed for overtaking. The BC and Trajectron checkpoints remain distinct.

## Performance and budget

The original matched stopped baseline was 13.83 native Hz / 13.78 image Hz.
The final capped-display run measured **12.40 / 12.51 Hz**, a **10.36% / 9.17%**
decrease. The native rate narrowly fails the 10% threshold. Earlier full-display
checks fell 11–20%; they remain in the evidence. General driving performance
acceptance is also incomplete. The five-second smoke warm-up overlapped browser
work and is not used as a matched performance pass. No performance gate is set true.

The independent ledger is `output/motion-reliability/budget.sqlite`: validation
is capped at 1800 seconds and supervised fitting at 600 seconds. Crashed
reservations stay charged. Final use is **1735.55 seconds / 28.93 minutes** of
validation and **zero training seconds**. Exact usage is in `budget.json`; no further
experiments are started by the report script. Development, builds and small
unit/browser tests do not use the experimental allowance. The historical
predictive-v2 ledger's SHA-256 still matches the pre-evaluation digest.

A final performance probe was mistakenly started while a reload was restoring
the route. The probe failed before measurement and interrupted the reload's
last acknowledgement. Its error is retained; the running host was checked,
the missing-route guard repaired, and the probe rerun sequentially. It is not
included as a successful performance sample.

## Verification and restored state

- Python: **316 discovered, 315 passed, one skipped**.
- JavaScript: **70 passed**, dashboard build successful.
- Browser fixtures: guided sequence, ownership, partial-spawn hold, old Advanced
  mode, numeric zeros, quality/coverage, rejection reasons, unknown gaze, stale
  data and mobile overflow passed. Fixture commands never reached native control.
- Native user Chrome was refreshed and inspected using Computer use. Side-by-side
  camera/model views and the numeric strip are present.
- Own ego pose, destination 466, Chase view, 800×450 display, weather and original
  40-car/30-pedestrian seed-2589 chaos-50 settings were restored. The approved
  default journey speed is 30 km/h. Final state is **PAUSED, zero speed**.

[Evidence and checksums](evidence/motion_reliability_20261013/manifest.json),
[native scenarios](evidence/motion_reliability_20261013/native-scenarios.json),
[tracker retest](evidence/motion_reliability_20261013/native-scenarios-tracker-fix.json),
[frozen comparison](evidence/motion_reliability_20261013/frozen-evaluation-tracker-fix.json),
[successful ordinary journey](evidence/motion_reliability_20261013/rule-final-smoke.json),
[final restored state](evidence/motion_reliability_20261013/delivery-state.json).

Repeat only with a fresh authorized experiment allowance. Reproduction commands
are `python -m scripts.native.motion_scenarios`,
`python -m scripts.native.validate_motion_reliability --journeys`,
`python -m scripts.evaluate_motion_reliability` and
`python -m scripts.train_motion_selector`. None resets the old ledger.
`python -m scripts.report_motion_reliability` packages existing evidence only.
