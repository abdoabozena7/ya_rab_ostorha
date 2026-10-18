# Forecasts, pedestrian tracking, passing and storage — 19 October 2026

The guided protected camera now draws measured forecast paths without opening
Details. Old raw sensor recordings were retired with results, videos and lossless
telemetry retained. The final scoped native pedestrian drive anticipates a waiting
person, stops before crossing and arrives with zero contacts. General driving
quality remains unaccepted; a successful UI test is not driving acceptance.

## Latest reported incident

The latest retained protected city recording had **zero registered ego contacts**,
but approached a pedestrian center to **2.12 m at 19.62 km/h**, with no brake applied
at that particular frame. Center distance is not body clearance. The attached
screenshots alone cannot establish their exact recording frame. The paired Normal
run had one contact after 42.32 m. Both complete raw recordings were preserved.

See [incident review](evidence/forecast-passing-storage-20261018/incident-review.json)
and [actual recorded camera](evidence/forecast-passing-storage-20261018/incident-native-camera.jpg).

## Sensor and display changes

- Guided protected operation maintains synchronized measured motion tracks; the
  previous geometry-only path did not provide the existing possible-start person
  hypotheses to ordinary RULE braking.
- A confirmed, recently camera-classified person can request additional RULE
  braking for a possible crossing. This is a hypothesis, not knowledge of intent.
  Rear objects, stale or foreign labels, broad merged bodies and unsupported
  semantics cannot assert a person crossing.
- Native probes exposed a label association error: a distant surface projected
  into the same RGB box could take the person label. The real RGB worker now checks
  same-frame axial depth from the existing, identically calibrated front depth
  sensor. A mismatched depth layer cannot take that label.
- Native replay exposed a second problem: geometric surface clusters joined the
  person to the curb. `DepthPeople` follows the classified body's core in **current
  calibrated depth**, separately from those surfaces. Each emitted measurement
  needs this frame's depth, with bounded layer continuity, fresh RGB evidence,
  odometry compensation, repeated measurements and bounded motion. It omits
  occluded/missing measurements instead of publishing extrapolated detections.
- Uncertain detections may maintain measured geometric identity, but cannot
  publish a person classification or request anticipation. A class still requires
  confidence at least 0.65 and at most 0.75 simulation seconds of age. Current depth
  retains identity/history across short classification gaps. Once an observed
  crossing has cleared the opposite road edge, its stationary start hypothesis is
  not repeatedly replayed. Actual motion back toward the route still brakes.
- Passing cannot arm around a crossing person or a short classification gap, and
  cannot engage without a measured stationary forward target anchor. The shield
  remains the final veto during a permitted maneuver. An applied hold brake no
  longer latches the legacy comfort integrator after native navigation requests
  motion again; actual signal/hazard stops retain precedence.
- The RGB worker targets five updates per wall second during autonomous driving
  and defers OCR then. The supplementary Trajectron process starts only when its
  optional diagnostic view actually needs it; ordinary guided forecasts use the
  existing measured control scene.
- Foreground forecasts are bounded and copied from the control scene for display;
  this avoids running a second expensive forecast graph beside control. Recent
  paths are reprojected from their measured pose into the actual camera pose and
  elapsed trajectory time is removed. Display age is at most 0.75 simulation
  seconds; unchanged control freshness limits remain separately enforced.
- Person hypotheses use coral; other measured paths use cyan. The label says
  **Predicted paths · may change**. Normal and idle main screens hide the overlay.

The observed tracking region extends with the stopping distance to at most 90 m;
it uses existing sensor returns and does not certify unseen space as clear.
The original RULE validator, final execution shield and emergency controls remain.
No experimental learned driving policy was enabled.

## Native checks and retained failures

The original separate expiring tickets were retained. After the second 20-minute
window, the user explicitly instructed continuation until finished without further
time-allowance questions, superseding that limit. Further work uses separately
recorded internal bounded reservations under that authorization; old tickets and
the research ledger were not reset. The native worker is the sole tick owner,
then restores the ordinary host.
The probes use native physics and record contacts even when impulse is zero.

- Clear left bypass: arrived after **47.89 m**, moved into the left lane, passed,
  returned right, and resumed ordinary cruising; zero contacts. This is limited
  low-speed maneuver evidence, with comfort/deadline failures still recorded.
- Right bypass: stopped after **9.89 m**; the adjacent route was repeatedly
  reported occupied. Zero contacts, but **clear-right acceptance failed**.
- Occupied lane: stopped before the blocker after **11.90 m**, maximum lateral
  displacement 0.031 m, and held for over 24 simulation seconds; zero contacts.
- Red signal: traveled **75.59 m**, then held at red through the end, with 822
  stopped red-signal samples, no passing actions and zero contacts.
- First real-camera pedestrian probe: zero contacts, but did not establish early
  anticipation; the crossing occurred while ego was still starting.
- Delayed crossing probe: arrived with zero contacts, but crossed too late to
  challenge ego. Its single person-labelled intervention was linked to the wrong
  depth layer; it is **not accepted as early pedestrian avoidance**.
- Same-frame-depth probe, crossing at 8 simulation seconds: **failed**, with one
  pedestrian contact at approximately 19 km/h. The controller did not have a
  separate recognized person track before contact. That full recording and its
  actual zero-impulse contact event remain available locally.
- Intermediate body-core revisions stopped without contact but did not finish:
  a passing attempt around the person, duplicate geometric person hypotheses,
  identity loss during uncertain RGB and a latched legacy comfort brake were
  diagnosed and repaired. These intermediate failures remain in the evidence.

On the final repaired source, the real RGB/depth pedestrian drive **arrived after
40.01 m with zero contacts**. The first `PEDESTRIAN_POSSIBLE_START` intervention
occurred at **5.10 simulation seconds / 9.71 km/h**, while independent evaluation
shows the person still stationary on the curb. Ego was stopped at **5.40 s**;
physical crossing began at **8.20 s**. It subsequently resumed and reached the
destination, with a measured maximum of 26.03 km/h. This is one scoped 30 km/h
requested-speed case, not an 80 km/h qualification. Source stayed unchanged,
native actors/sensors were cleaned and the ordinary host resumed ticking.
See [final pedestrian evidence](evidence/forecast-passing-storage-20261018/pedestrian-final.json),
[stopped before crossing](evidence/forecast-passing-storage-20261018/person-wait-native.jpg),
[actual crossing](evidence/forecast-passing-storage-20261018/person-crossing-native.jpg)
and [drive after crossing](evidence/forecast-passing-storage-20261018/person-passed-native.jpg).

A final calibrated repeat with the guided protected car's actual
`vehicle.mercedes.coupe_2020` also **arrived with zero contacts** after 40.04 m.
Its first forecast occurred at 5.05 s / 10.81 km/h, ego was stopped at 5.40 s,
and physical crossing began at 8.20 s. It resumed and reached 27.95 km/h maximum. Both probes
use the actual native model's onboard geometry, real RGB/depth and measured
motion; no fixture actor locations or schedules enter the controller. See
[Mercedes pedestrian repeat](evidence/forecast-passing-storage-20261018/pedestrian-mercedes-final.json).

Earlier Mercedes passing checks exposed an independent rig problem:
CARLA's reported 0.906 m half width excluded its mirrors, whose measured own
LiDAR returns lie at about y = ±0.972 m and z = 1.03–1.10 m. The controller
correctly refused to move into those apparently external objects. Its physical
body envelope is now 1.01 m half width, consistently used for both collision
clearance and self-return masking. This **enlarges** the protected car's footprint;
it does not add a broad blind shell while retaining a narrow collision model.
Other vehicle dimensions are unchanged and native widths are never reduced.
See [onboard mirror audit](evidence/forecast-passing-storage-20261018/mirror-envelope.json).
The earlier geometry-version probes remain retained and cannot alone admit the
final calibration. The final cohort below repeats the checks with the calibrated
Mercedes and satisfies the existing scoped admission gates.

The full driving-quality gate still fails: deadline/comfort, independent stop
classification, cruise-50 and display acceptance are separate from this scoped
successful crossing. The evaluator currently calls a pedestrian wait an
"unexplained stop" unless its own independent stop classification admits it;
the report retains that failure rather than modifying the metric to obtain a pass.

The new body-core tracker was then checked against that failed recording using
the real ONNX detector, delayed RGB results, recorded depth, onboard geometry and
odometry. Ground truth is used only afterwards to compare event timing. See
[reprocessing evidence](evidence/forecast-passing-storage-20261018/person-recorded-reprocessing.json).
This fixes the recorded sensor association; it cannot establish how a new native
ego trajectory changes after braking. Run it without CARLA:

```powershell
.\.venv-perception\Scripts\python.exe -m scripts.audit_recorded_person_forecast <native-report.json> --out <audit.json>
```

Before mirror calibration, the right-pass repeat used legal map fixture variant 1 (spawn 54),
after the original variant 0 (spawn 22) was measured blocked. It arrives after
47.85 m with zero contacts, completes `PASS_RETURN` and resumes ordinary cruising
at 14.30 km/h. A final-source left repeat arrives after 48.01 m, also completes
`PASS_RETURN`, resumes at 14.71 km/h and has zero contacts. A preceding left repeat
arrived but stopped for 22.25 simulation seconds; that comfort/progress failure is
retained alongside the successful repeat. Neither success guarantees that all
roads or repeated runs behave equally well.

The complete final-source passing cohort passes its five existing admission gates
and re-admits the limited stationary-obstacle RULE overlay: left pass, right pass,
ordinary resumption, occupied-lane hold and red-signal hold. This admits only legal
same-direction maneuvers targeting at most **2 m/s**. High-speed weaving remains
outside that scope. See [current scoped acceptance](evidence/route-bypass-20261016/acceptance.json)
and the [preserved previous acceptance](evidence/forecast-passing-storage-20261018/previous-passing-acceptance.json).

The pre-calibration occupied-lane repeat also held correctly: 11.90 m traveled,
0.031 m maximum lateral displacement, over 19 simulation seconds held and zero
contacts. No passing action was admitted into the occupied adjacent lane.
The pre-calibration red-signal repeat held at red through its end with 723 stopped samples,
75.59 m traveled, zero contacts and no passing actions.

After the mirror correction the **actual Mercedes** repeats establish the current
admission: left pass/return/arrival 47.93 m (resumed 14.93 km/h, longest stop 1.60 s),
right pass/return/arrival 47.86 m (resumed 14.80 km/h, longest stop 1.60 s), occupied
lane hold at 11.92 m with only 0.032 m lateral displacement, and red-signal hold
through the end with 591 stopped samples. All have zero contacts, unchanged source,
verified native cleanup and restored host ticking. The first calibrated left
attempt arrived but paused for 10.05 s; it remains recorded rather than being
counted as a smooth-pass success. See the full
[30-attempt native evidence](evidence/forecast-passing-storage-20261018/native-attempts.json),
which preserves failures and marks earlier source versions as such.

## Storage retirement

The measured workspace inventory fell from **250.93 GiB / 1,573,655 files** to
**29.52 GiB / 133,727 files**, freeing **221.41 GiB** before additional diagnostic
recordings. Native validation subsequently creates new local evidence, so 29.52
GiB is a dated inventory rather than a permanent disk-size claim.

The maintenance tool retired raw RGB/depth/LiDAR assets from **722 recordings**.
It kept existing MP4s, results, outcomes and metadata, and gzip-compressed telemetry
and events only after verifying their decompressed SHA-256. Raw replay explicitly
explains that these old sensor assets were archived; it does not silently display
an incomplete run. See [inventory and manifest digest](evidence/forecast-passing-storage-20261018/storage.json).

After native verification, another **24 intermediate recordings / 16.34 GiB of
raw sensor assets** were retired under the same lossless-log/video policy. The
final measured workspace is **34.64 GiB / 163,857 files**, including the additional
native evidence: **216.29 GiB net freed** compared with the original inventory.
Eight raw recordings remain: the original paired incident, the retained failed
pedestrian probe, and the five final calibrated Mercedes checks. Their paths and
both maintenance-manifest digests are in the storage evidence above.

The two incident recordings above were excluded. Native environments, active
Trajectron assets, cross-environment runtime dependencies, research records, Git
history and the external consolidation recovery archive were preserved. The
large learned environment is referenced by the current Trajectron runtime and
cannot be treated as an unused cache merely because of its directory name.

New guided recordings carry a keep-two-raw policy. After a successful MP4 export,
older finalized guided recordings can retire their raw assets. Active writers,
the newest two recordings, failed exports and explicit research recordings keep
their raw data. This bounds normal guided history without losing export recovery.
The bulk command defaults to a dry run, refuses a connected native host and
rejects paths outside the workspace or through symlinks/junctions:

```powershell
.\.venv-carla\Scripts\python.exe -m scripts.prune_recordings
# Stop CARLA first; explicitly preserve incident runs when applying bulk cleanup.
```

Automatic approval review rejected direct deletion of the two unused Qwen GGUF
files and the llama download ZIP, even as three exact literal file targets. The
reported reason was only "blocked by policy". Approximately 4.1 GiB remains;
deletion was not retried through another filesystem mechanism.

## Software and visual verification

- JavaScript: **165 passed**; frontend JavaScript/CSS regenerated with
  `npm run build:dashboard`.
- Python: **660 tests, 658 passed, 2 optional skips** on the final source.
- Isolated browser fixture: actual forecast pixels on the main camera, contained
  mobile layout, no page errors, and correct disappearance for missing sources
  and Normal mode. The synthetic forecast fixture is explicitly separate from
  native perception evidence: [desktop](evidence/forecast-passing-storage-20261018/forecast-desktop.png),
  [mobile](evidence/forecast-passing-storage-20261018/forecast-mobile.png).
  [Verification counts, bundle hashes and isolated UI checks](evidence/forecast-passing-storage-20261018/verification.json).

The visual verifier explicitly primes a connected paused fixture before testing
the live camera. Its simulated startup response does not construct a native
engine. Fresh fixtures and the existing transport installer therefore exercise
the intended camera state without issuing native writes or opening another
real simulator session.

Remaining native acceptance and any further repairs must retain the failed
crossing and right-pass cases. No claim is made that the protected system cannot
collide, that it reaches 80 km/h in this cohort, or that these probes establish
dense-city driving quality.
