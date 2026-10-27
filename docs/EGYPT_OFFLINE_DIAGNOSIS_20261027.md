# Egypt: bounded offline driving diagnosis, 27 October 2026

**Gate B remains failed. No runtime change was justified or made.** This is
saved DEVELOPMENT evidence analysis, two bounded sensor replays and four focused
regressions, not a software certificate or native acceptance. No simulator,
holdout, reservation, budget reset, branch, commit or push was used.

## Source and measurement scope

HEAD was `cebed2c32541978f18ee89352c0a8e1a737f39e8`. The actual driving
fingerprint, computed with `backend.core.egypt_urban.source_fingerprint()`, was
`c2ec0594d7a0a80141820d0e2ffc0a448887e0f7f85a35da5a75e40a5fb90137`.
The original goal and attempt 19 agree with this full value.

[Machine-readable evidence](evidence/egypt-urban-chaos-v1/offline-diagnosis-20261027.json)
identifies inputs, original/current comparisons and local artifact hashes.
Historical attempt 18 has its own different source identity; it is a comparator,
not current-source proof.

All 601 recorded `HYBRID_DECISION` frames in each protected diagnostic were
joined to their timing traces by frame identity, including late/stale frames.
There are also 32 submitted non-decision traces in each recording, principally
the held preparation prefix; these are **not erased**. Attempt 19's all-submission
633-frame application-check p95/p99/max are 215.785/242.103/667.504 ms;
attempt 18's are 199.185/228.814/598.559 ms. These are separately reported rather
than silently counted as the published driving distribution. They cannot be
used to claim complete compliant timing. Percentiles use NumPy's linear
interpolation. Individual stage percentiles are not additive.

## Measured host-monotonic stages

Times are milliseconds, p95 / p99. Application check is first required receipt
to the final application check, **not** RPC or exact physical actuation.

| Stage | Attempt 19, current source | Attempt 18, historical |
| --- | ---: | ---: |
| First to last required sensor receipt | 106.684 / 117.468 | 103.869 / 118.897 |
| Encoding tail after last receipt | 1.689 / 2.457 | 1.547 / 2.335 |
| Synchronization after encoding | 0.598 / 0.814 | 0.604 / 0.727 |
| Complete frame to scene start | 2.631 / 2.917 | 2.540 / 2.969 |
| Scene geometry, before prediction | 22.079 / 24.530 | 20.937 / 24.704 |
| Prediction, including semantics/freezing | 49.106 / 57.664 | 45.819 / 51.038 |
| Full scene, inclusive of preceding two rows | 68.830 / 78.990 | 64.323 / 73.959 |
| Published scene to control start | 8.341 / 10.900 | 8.233 / 10.185 |
| Maneuver selection | 46.937 / 54.906 | 43.285 / 48.947 |
| Independent shield | 9.181 / 12.022 | 8.127 / 11.744 |
| Safety inclusive of shield/preparation | 9.598 / 12.488 | 8.463 / 12.146 |
| Safety completion to application check | 0.270 / 0.346 | 0.241 / 0.312 |
| **Application check, all 601 driving frames** | **215.750 / 234.514** | **199.005 / 224.172** |
| CARLA control RPC, separately | 0.105 / 0.167 | 0.101 / 0.119 |

Shield timing is present on all 601 attempt-19 driving frames. Attempt 18
has 600 measured shield intervals: its expired frame 763 never enters that
substage. The missing interval is explicit, not treated as a zero-cost check.
Navigation/map prefetch overlaps collection; its attempt-19 p95/p99 is
24.243/34.635 ms and must not be added as another serial stage.

The worker's separate sample stream contains 600, not 601, driving samples.
Its scene decomposition puts tracking/engine forecasts at 23.565/28.079 ms
p95/p99, semantics/person processing/final freezing at 26.509/33.624 ms,
depth fusion at 21.838/24.238 ms and LiDAR decode at 0.355/0.527 ms.
Thus neither raw LiDAR decoding nor RPC explains the timing failure.
`tracking_and_forecasts` is the implementation's substage label: final
kinematic modes are included in the later semantics/freezing interval.
The sensor-to-application distribution above is from all 601 timing traces,
not the smaller sample stream.

### Concrete late frames, not a speculative aggregate explanation

- **700:** application check 259.957 ms. Sensor spread 101.420 ms; scene
  92.832 ms, including 73.959 ms prediction; published-to-control 11.183 ms.
  The late reserve already selects HOLD in only 0.228 ms. Safety still takes
  50.902 ms, including 32.716 ms independent shield; the remainder is outside
  the shield timestamps and is not proven to be a particular function.
  Final brake is 1.0, freshness fails. Reserving 50 ms does not prove a
  50 ms worst-case bound; increasing it without evidence changes behavior.
- **708:** application check 250.556 ms. Sensor spread 87.161 ms; scene
  88.768 ms, including 64.684 ms prediction; maneuver 55.022 ms; safety
  8.106 ms. The combined serial work, not a slow RPC (0.993 ms), misses
  the unchanged lease. Final brake is 1.0, freshness fails.
- Historical **763, attempt 18:** application check 255.327 ms, prediction
  57.422 ms and maneuver 47.268 ms after a 114.927 ms receipt spread.
  The repair-19 reserve moved the expensive decision toward braking checks;
  it did not establish that the overall envelope was bounded.

### Sensor, recording and external-worker attribution

Across all 601 saved attempt-19 driving frames, **rearRightDepth is last to
arrive every time**; its receipt p95/p99 offset equals 106.684/117.468 ms.
Its own decode p95/p99 is only 1.686/2.453 ms, with queue wait
0.0040/0.0056 ms. Front RGB decode is 21.474/25.043 ms; its queue wait is
0.481/4.068 ms. These per-channel numbers use all saved sensor channels;
the actual gate above uses the recorded required-sensor timestamps.
This identifies arrival/processing ordering as a concrete collection cost,
not proof that the rear sensor or GPU itself is defective. Receipt spread
includes callback scheduling and any preceding processing; dropping a camera,
changing its resolution or moving the first-receipt clock is not justified.

Final recorder status is complete with zero dropped frames/events/trace rows,
zero pending items and zero queued bytes. That proves no reported overflow,
**not absence of writer contention during driving**. The saved streams have
no per-frame writer CPU/I/O timeline, process run-queue trace or detector-worker
occupancy attribution. Scene/behavior thread CPU samples are quantized in
15.625 ms steps, so subtracting them from wall time is not a defensible precise
interference estimate. Post-submission recording/export work can still delay a
future frame. The saved worker log places FINALIZING after DRIVING, so final
export is not shown as this frame's serial control work. No recording/export
or foreign worker cause can be isolated from these data alone.

## Sensor replay and original comparison

The existing local `profile_frozen_road_control.py` replays from recording start,
uses original saved camera semantics by latest evaluation frame, immutable road
rows and same-frame measured-space preparation. This is **not exact native
asynchronous detector delivery**, and the helper enables preparation rather
than proving the native scheduling boundary.

- Original retained recording `run_6328c6a903aa4881b8f12a1018a66698`,
  frames 900--920: **21/21** full track/mode hashes, action/reason, shield
  acceptance/reason and track/mode counts match
  `current-source-frozen-replay18.json`. The original evidence is source
  `a4bdcef3...`, not today's source. Current replay p95/p99 scene
  53.835/53.958 ms, maneuver 18.604/18.742 ms, shield 4.904/4.936 ms,
  total 75.672/76.754 ms. Original total was 75.091/83.158 ms.
  These small, profiled samples are not a measured optimization.
- Latest attempt-19 recording, frames 700--708, replayed with full earlier
  sensor/semantic history: nine complete decisions; p95/p99 scene
  54.983/55.287 ms, maneuver 39.305/39.381 ms, shield 8.019/8.233 ms,
  total 101.807/102.268 ms. Its frame 700 is FOLLOW, not native HOLD:
  replay supplies a fresh synthetic wall clock and omits the original
  101 ms receipt delay. This is an explicit **non-equivalence to native
  deadline behavior**, not a silently passing recreation of the late frame.

The original 21-frame replay's largest cumulative costs include tracking
(`prediction.update`, 440 ms over 21 frames) and recursive `freeze_json`
(205 ms); latest-window full maneuver proof is 305 ms over nine frames.
These identify possible future investigation sites, not permission to remove
histories, physical modes, freezing boundaries or stopping/body proofs.

### Historical Normal stalls

Fresh offline audits reproduce frames 3973 and 3683 of
`run_f49cc7dbdb2e4071bf434a5eca4b93a2` and
`run_cc6bc8106a144d2ab16d01d7768d26ba`. Each has a 3.0 m continuous corridor,
0 m/s coverage cap, first unknown body footprint at 3.5 m with five unknown
samples and zero occupied samples at that footprint. Expanding processing
scope from 6 m to 13.339 m does not extend coverage. Front depth foreground
gaps remain 4.3786/4.4012 m. Sensor mount errors remain below 0.03 m.
This is not an observed empty road, and does not justify clearing unknown
cells or weakening Normal's reactive sensors. Full Normal progress remains
unproved; these single-frame geometry audits are not timing distributions.

## Decision, checks and remaining work

No behavior-equivalent optimization with a demonstrated benefit was established
within this bounded investigation. Runtime source is unchanged, so there is no
new implementation whose equivalence can be claimed. The original-window
equality is limited to the recorded semantic fields above, not every command
field or all routes. Existing failures are retained.

Four focused tests passed: late-scene stopping reserve, stale/occluded maneuver
refusal, disconnected-ground unknown coverage, and forward-vs-unknown-reverse
geometry. No full suite, new software certificate or native trial was run.
All physical alternatives, body/stopping checks, unknown-space handling,
100 ms simulation-age limit, 200/225/250 ms timing, density and route remain.

Next work needs an evidenced, semantics-preserving reduction in the measured
collection/prediction/maneuver path, with scheduling/I/O tracing to distinguish
recording and detector-worker interference. That instrumentation should be
evaluated offline first; it is not itself a reason to consume a new diagnostic.
Only after a defensible source repair and parent-owned complete verification
may ordered protected diagnostics be considered. Current Gate B, full Normal
progress, full development matrix and native acceptance remain unresolved.
Storage and protected-time blockers remain independently owned by the parent.

## Reproduce locally, without CARLA

Raw recordings and the original profiling helpers are retained local evidence,
not part of an ordinary clone. Run in the primary checkout:

```powershell
.\.venv-carla\Scripts\python.exe output\egypt-validation\offline-diagnosis-20261027\analyze_traces.py
.\.venv-carla\Scripts\python.exe output\egypt-validation\software-20261027\profile_frozen_road_control.py runs\normal_city\run_6328c6a903aa4881b8f12a1018a66698 output\egypt-validation\offline-diagnosis-20261027\current-original-window.json --first 900 --last 920
.\.venv-carla\Scripts\python.exe output\egypt-validation\software-20261027\profile_frozen_road_control.py runs\normal_city\run_c8d966cf0d16438180d3dd7e9e879bea output\egypt-validation\offline-diagnosis-20261027\attempt19-late-window.json --first 700 --last 708
.\.venv-carla\Scripts\python.exe -m scripts.audit_egypt_coverage runs\normal_city\run_f49cc7dbdb2e4071bf434a5eca4b93a2 runs\normal_city\run_cc6bc8106a144d2ab16d01d7768d26ba --report output\egypt-validation\offline-diagnosis-20261027\normal-coverage.json
.\.venv-carla\Scripts\python.exe -m unittest tests.test_egypt_urban.UrbanDriverTests.test_late_scene_reserves_independent_braking_time_without_erasing_maneuver_state tests.test_egypt_urban.UrbanDriverTests.test_occluded_space_and_stale_or_missing_motion_data_never_admit_a_maneuver tests.test_control_scene.ControlSceneTests.test_disconnected_far_ground_is_not_a_continuous_corridor tests.test_control_scene.ControlSceneTests.test_sensor_geometry_can_admit_forward_and_reject_unobserved_reverse
```
