# Native journey repair — 11 October 2026

The corrected **RULE comparison journey reached its destination and stopped in
two native CARLA runs** of the persisted seed 2811 recipe. Both had zero collision
episodes and zero collision callbacks. This verifies the repaired journey for
this regression case. It does not establish MODEL acceptance or general safety
across unseen traffic.

## Measured results

| Native recording | Original failed run | Corrected run 1 | Corrected repeat |
|---|---:|---:|---:|
| Destination arrival, with complete stop | No — timeout | Yes | Yes |
| Collision episodes / callbacks | 0 / 0 | 0 / 0 | 0 / 0 |
| Recorded simulation duration (s) | 180.05 | 133.15 | 133.10 |
| Time below 0.2 m/s (s) | 116.90 | 51.85 | 55.55 |
| Longest continuous stop (s) | 65.90 | 5.55 | 21.00 |
| Useful route progress (m) | 112.74 | 184.33 | 184.28 |
| Route completion fraction | 0.6081 | 0.9942 | 0.9940 |
| Final distance from destination (m) | 60.80 | 1.18 | 1.23 |
| Final native speed (m/s) | ~0 | 0.00343 | 0.00342 |
| Safety intervention transitions | 158 | 219 | 184 |
| Safety intervention duration (s) | 118.30 | 61.45 | 53.85 |
| Emergency intervention duration (s) | 0.40 | 0 | 0 |
| Geometry P95 (ms) | 11.62 | 7.71 | 8.00 |
| Whole controller P95 (ms) | 17.49 | 13.56 | 13.51 |

Duration includes approximately 0.1 s of recording priming/finalization. Stopped
time includes navigation holds, safety braking, and the final stop; it is **not
an estimate of unnecessary waiting**. Intervention counts include throttle
reductions and small longitudinal adjustments, and the original trip ended
before completing the route. Raw counts therefore do not establish smoother
driving. Useful progress is projected along the route, not odometer distance.
Arrival retains the existing actual-position radius of 5 m and speed below
0.15 m/s; neither threshold changed.

The repeat's 21 s stop was a shared navigation hold: navigation requested full
braking for 20.65 s within that interval, with zero seconds of safety-only full
braking. The exact signal state was not independently logged. It would be wrong
to label that entire hold an unnecessary safety intervention. Its midpoint camera
image and command audit are preserved in the evidence directory.

## Actual failure causes and repairs

1. **Scripted actors parked in the route.** The original cut-in plan ended at
   approximately 130 m and `UrbanPhysics.follow` applied permanent braking at its
   final waypoint. The original recording shows the ego stopped behind that Audi
   for the last 65.9 s. New v2 recipes preserve the hazard approach and add a
   physical exit route through and 40 m beyond the ego destination. The lead car
   and returning SUV also continue past the destination. Historical recipes and
   recordings are preserved; the test helper creates a distinct corrected pair.
2. **Braking was the wrong response to some rear conflicts.** Seed 2005 recorded
   a 91.35 s stop for an already overlapping padded rear box. A first repair
   retest of seed 2811 then ended in a rear-end collision while nearly stationary
   on a measured clear forward corridor. All predicted rear conflicts remain
   logged. A rear overlap no longer requests braking when forward motion
   monotonically separates it, or when the existing trajectory comparisons show
   that braking has a strict superset of overlap samples and forward motion
   clears it while the object remains behind. Every other object is checked
   independently, so front conflicts and measured emergency hazards still stop
   the vehicle. Regression tests retain closing rear hazards that cannot clear
   within the horizon and verify that a simultaneous front hazard overrides
   forward release.
3. **The final navigation brake was rejected.** An intermediate retest reached
   0.34 m from the destination without collision, then failed at 3.73 m/s.
   Navigation's full-brake command uses `gear=None` to retain the current gear.
   The predictive supervisor incorrectly treated that as non-forward driving.
   It now resolves the retained gear before validating the command. Full braking
   reaches the pedals, and arrival is confirmed only after the actual stop.
   RULE and MODEL contract tests cover this command and retain sensor freshness
   and neutral/reverse rejection.

No weights were retrained or changed. Sensor freshness, clearance, emergency
stopping, minimum hold, three-clear-reading release, braking release rate,
traffic-light compliance and speed caps retain their values. The longitudinal
action selection changed where braking was provably worse for the rear conflict.
The emergency protection remains active. No new application UI or feature was
added for this repair.

The experiment admission now reserves the smaller of 600 seconds and the
remaining existing budget. Its termination deadline uses that reservation.
This permits a bounded final run without exceeding the same 5,400-second cap.

## Reproducibility and evidence

Both completed runs used seed **2811**, the original start, destination, weather,
40 vehicles, 30 pedestrians and hazard schedule. All admitted actor positions,
velocities and orientations matched the original approved initial states with
zero recorded error. The shared signal state/timing audit also passed on the
repeat. Reactive traffic after the start can diverge; subsequent trajectories
are not claimed to be identical. Hazard schedules are not proof that every
hazard was encountered by the ego at the same point in its trip.

The seed was inspected during repair, so these are regression runs, not untouched
holdout TEST evidence. The three independent full RULE/MODEL acceptance pairs
remain unproven after the changes. The new implementation remains experimental
and the existing startup RULE policy remains the default. The learned MODEL's
parked-object predictions and stop behavior remain unproven; no MODEL improvement
is attributed to these shared fixes. Short conservative stop/start cycles still
occur in the corrected RULE runs.

Evidence: [journey_repair_20261011](evidence/journey_repair_20261011/).
It contains both compact completed results, the original and corrected manifests,
the baseline, intermediate failures, the navigation-hold audit, checksums, and
the persistent experiment-budget snapshot. Native recordings remain at:

- Original: `runs/normal_city/run_33ffaf36df074ee1bcd55f8f70f53894`
- Completed run 1: `runs/normal_city/run_365ac6a864c840e695a7cc4e1f99709d`
- Completed repeat: `runs/normal_city/run_eaf8370a031c49159633dfeccb265d19`

Each completed result includes the source manifest hash, frozen runtime source
hashes, weight checksum, actual position/speed verification, and sampled progress.
The predictor receives sensor observations only; native poses are used by the
separate evaluator for arrival, progress, collision and initial-condition audits.

The observer never ticks CARLA. To reproduce from the project root, stop the
identified backend first, prepare the corrected recipe, start the existing native
owner, then observe its run:

```powershell
.venv-carla/Scripts/python -c "from scripts.final_runtime import disconnect_backend; disconnect_backend()"
.venv-carla/Scripts/python -m scripts.native.retest_journey --prepare --source docs/evidence/journey_repair_20261011/baseline-manifest.json --output output/journey-reproduction
.venv-carla/Scripts/python -m scripts.final_runtime
.venv-carla/Scripts/python -m scripts.native.retest_journey --source docs/evidence/journey_repair_20261011/baseline-manifest.json --output output/journey-reproduction
```

These commands consume the persistent experiment allowance. This task finished
at **5,359.297 charged seconds (89.32 minutes)**, including a fully charged crashed
600-second setup reservation. Only 40.703 seconds remain, so a further complete
native retest requires a separately authorized experiment budget. Do not delete
or edit the ledger to bypass the cap. Existing recordings can be audited offline.

One CARLA reset crashed before driving with a native null-pointer access
violation; its root cause is unresolved and is documented separately. The
observer also encountered the normal temporary `vehicle=None` reset state; it
now tolerates that state and preserves incomplete results on errors. The two
final journeys and their recording writers completed successfully.

Validation: **260 Python tests, one skipped; all remaining tests passed.** The
new regression cases cover rear-action selection, front-hazard override,
continued scripted exits, final-brake command compatibility, and hard-cap
admission. No frontend code changed in this repair.
