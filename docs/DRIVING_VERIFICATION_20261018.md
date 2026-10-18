# Driving verification and follow-up repairs — 18 October 2026

This follows [the original repair checklist](DRIVING_REPAIR_CHECKLIST_20261018.md).
The user subsequently authorized native verification and repairs **until task
completion, without an overall time cap**. The previous 40-minute window is not
extended or rewritten. New expiring 1,200-second operational batches retain
per-run freshness, stop, ownership and recording limits. Research ledgers and
hybrid acceptance are unchanged.

## Checklist

- [x] Repeat the dashboard build, JavaScript suite, Python suite and optional detector regression.
- [x] Run real-browser-owned native presentations, not just an HTTP observer.
- [x] Verify actual saved MP4 playback and automatic backend completion in iterations 2b/3; preserve Normal's collision outcomes.
- [x] Record frame-matched native bounds/poses and relevant light state for an independent, read-only stop review.
- [x] Add earlier measured-gap approach slowing before the independent emergency supervisor; never weaken its brake or freshness limits.
- [x] Remove repeated deep copies of population profiles from compact native/dashboard observations.
- [x] Defer optional hypothetical ego-path scoring during ordinary automatic driving, while retaining measured tracks and forecasts.
- [x] Invalidate WebSocket snapshots when the native frame changes and remove a polling bottleneck; ownership and pong checks remain.
- [x] Fix the collapsed camera and clipped circular map at desktop/mobile widths.
- [x] Keep uncertain camera candidates out of supported cockpit counts and label/dash their 2D boxes explicitly.
- [x] Avoid claiming no intersection when diagnostic scoring was deferred.
- [x] Preserve collision wording without incorrectly turning it into a recording failure; explain observation receipt loss explicitly.
- [x] Audit the first Low-profile diagnostic, including its changed-fixture failure.
- [x] Fix Restart reusing a failed presentation's consumed traffic-hold request.
- [x] Complete the final post-repair repeat and artifact audit, retaining its failure.
- [x] Verify native Restart after the failed fixture, emergency stop from motion and explicit release without auto-resuming.
- [x] Release native GPU resources and preserve the user's Epic next-launch preference.
- [ ] Complete a matched presentation on the final backend despite native pedestrian loss; do not suppress fixture faults to pass.
- [ ] Pass strict comfort, every-stop necessity/release timing, 50 km/h cruise and live-rendering acceptance.
- [ ] Validate general semantic accuracy and the gated surround/bypass configuration; this cohort does not admit a new hybrid policy.

## Repairs found during verification

### Stop decisions

The old hard protective brake remains unchanged. The route comfort controller
now uses only a fresh prior-frame measured forward gap and coverage to lower its
approach target. It cannot raise a route target, override a signal/hazard stop,
change steering/gear, or use native actor truth as a driving input. Its effective
target and source frame are recorded. The controller resets between journeys.

This is not a comfort acceptance claim. Native hard-brake and jerk violations
remain; removing protective brakes to improve a score is not an acceptable fix.
Recorded native evidence is an evaluator only, explicitly tagged
`used_for_applied_decision: false` and enabled only in validation sessions.

The independent stop reviewer checks every stationary segment of at least
0.5 seconds. Native object presence or a relevant red light supports a physical
explanation, but does **not** automatically prove the necessity of the entire
stop, the chosen gap, safe release timing, or a turning swept corridor. Unknown
or missing evidence remains unresolved; strict quality gates are not waived.

### Camera and map

The processed perception panel previously distinguished uncertainty, but the
ordinary cockpit still counted uncertain cars/people and drew definite class
labels. It now counts only supported confidence categories, lists uncertainty,
and uses dashed gray `Possible …` boxes with actual confidence. Missing or
invalid confidence is not supported. Supported remains a model-confidence
category, **not ground truth**.

Measured unclassified map surfaces remain distinct from recognized cars. Exact
session/frame/timestamp and source-image hash audits establish provenance, not
general detector or physical forecast accuracy. Deferred diagnostic intersection
scoring now says so rather than displaying a no-intersection claim.

The full-width camera was collapsing to roughly 145 pixels high, clipping the
map and shrinking the actual image. The browser check measures 576 pixels at a
1,280-pixel viewport and at least 250 pixels at a 390-pixel viewport, with the
circle inside its camera and no horizontal overflow. This is layout evidence,
not a camera FPS result.

### Runtime and transport

Profiling identified repeated population-profile deep copies, optional display
work and WebSocket compression/serialization in the shared Python process.
Compact population views omit profiles **before** copying, while rich inspection
retains them. Ordinary optional display work targets 3 Hz; admitted maneuver
control retains its existing cadence and independent limits.

The transport no longer lets its 50 ms cache hide a newly published native frame.
It polls messages more promptly, avoids redundant unchanged payload sends and
keeps local telemetry uncompressed. Tests retain exclusive ownership, control
admission, watchdogs and native pong-based liveness. Neither the 250 ms wall nor
100 ms simulation safety threshold is increased.

### Outcome wording

A saved Normal collision was translated twice. Its already formatted English
sentence contained “recording”, so the generic error formatter incorrectly
displayed “Recording did not finish”. The changed-traffic failure's retained
“recordings” also triggered that broad match. Collision outcomes now get formatted
once; recording faults require an actual failure indicator. Changed traffic has
its own explanation. Recordings and original failed outcomes remain intact.

### Restart after a changed fixture

Iteration 4 correctly refused a matched Normal arm when pedestrian 141 vanished.
An explicit Restart then exposed a separate state bug: `_stop_navigation` queued
another hold of the old traffic merely because the historical journey retained a
presentation ID. That hold failed against the old missing pedestrian and rejected
the new presentation before setup. The failed startup is retained as iteration 5.

Traffic holds now enqueue only when a presentation journey actually transitions
out of STARTING/RUNNING. An error handler or Restart of an already terminal
journey cannot re-arm its consumed request. Regression tests cover both the
failure callback and reaching fresh setup after the failure. Missing traffic is
not silently replaced or admitted as a valid matched fixture.

## Retained native iterations

Seed 2086914493 repeats the investigated route. These are sequential diagnostic
revisions, **not a controlled A/B performance experiment**; reactive traffic and
graphics can differ. Exact backend hashes/archives and original outcomes remain
in ignored `output/driving-verification-20261018/`.
Iteration 1 also overlaps offline tests early in its drive, so its timing is not
an isolated benchmark. Contact counts refer to ego contacts; a vanished pedestrian
does not establish whether another native traffic actor hit it.

| Attempt | Configuration | Protected result | Retained failure or limitation |
| --- | --- | --- | --- |
| 1 | Ordinary rig, Epic, approach revision | ARRIVED, 268.33 m, 179.05 simulation seconds, 0 contacts | 40 deadline brakes, 11 harsh events. Two pedestrians disappeared; changed fixture correctly refused Normal rather than crashing or fabricating a matched run. |
| 2b | Ordinary rig, Epic, display scoring deferred | ARRIVED, 267.57 m, 131.35 simulation seconds, 0 contacts | 10 deadline brakes, 5 harsh events. Normal collided. Both actual videos played to the end; real browser acknowledged COMPLETE. Strict comfort/rendering still failed. |
| 3 | Ordinary rig, Epic, compact population and reduced optional display work | ARRIVED, 268.28 m, 166.30 simulation seconds, 0 contacts | 1 deadline brake, 3 harsh events. Normal collided. Both recordings finalized and actual playback reached COMPLETE. Strict quality remains unaccepted. |
| 4 | Ordinary rig, temporary Low profile and frame-aware transport | ARRIVED, 268.21 m, 127.70 simulation seconds, 0 contacts | 0 deadline brakes, 2 harsh events, 176 comfort violations. One initial held command exceeded freshness. A pedestrian disappeared; Normal was refused. Live camera 11.1–13.7 FPS still fails. |
| 5 | Explicit Restart after iteration 4 | No new driving arm | Old fixture hold re-armed and immediately rejected the new presentation. This is a failed startup, not another successful drive. Fixed as described above. |
| 6 | Ordinary rig, Low, corrected terminal-hold lifecycle | ARRIVED, 268.33 m, 128.40 simulation seconds, 0 contacts | 1 deadline brake, 1 harsh event, 158 comfort violations. Pedestrians 306/312 disappeared; Normal was refused. Camera 11.4–14.0 FPS still fails. |

An additional observer labeled `iteration-2-default` waited without a browser
Restart and timed out. It contains **no new native driving attempt** and is
retained separately, not counted as a successful drive or silently deleted.

Iteration 3's four stationary segments include startup settling, two queues
with independent native vehicle presence, and a red-signal stop. These explain
the long holds without inventing a pedestrian detection. Some start/release
frames remain unresolved. Its conservative audit retains 220 comfort violations
and a maximum 0.2-second jerk of 123.57 m/s³; these numbers are not hidden by the
three-event harsh-braking summary.

Iteration 4 has startup settling and two queues, lasting 30.90 and 25.15 seconds.
Native bounds support vehicle presence during 579/619 and 491/504 frames of
those queues, respectively. The nearest recorded bumper gaps are approximately
4.73 and 6.26 m. This is not a blanket necessity or release-timing approval.
Its only nonfresh applied row is the initial stationary safety hold, at 322 ms;
it is retained in the strict failed timing gate, not hidden to claim a pass.

The final repeat is **not** a zero-delay or completed-presentation claim. It has
one deadline brake at frame 9384; 2,570 of 2,571 applied rows are fresh. Its maximum
0.2-second jerk is 118.02 m/s³. Its two long queues again have independent native
vehicle presence, but startup/release frames and full necessity remain unresolved.
Both Low presentations refuse Normal after native pedestrian loss. Automatic
full playback is demonstrated on the earlier 2b/3 revisions, **not the final
backend's failed pair**. Repeating without another repair would not establish
that this remaining native fixture failure is fixed.

## Native recovery probe and cleanup

After iteration 6's fixture failure, a real dashboard Restart on the same running
backend reaches DRIVING with a fresh presentation/fixture. This directly verifies
that the old traffic hold no longer rejects fresh setup. The separately identified
probe (`60a263e0d61141f68c0ea15d774f76ae`) is deliberately cancelled with Emergency
stop after a measured 14.54 km/h. Native speed reaches zero in EMERGENCY_STOP.
Explicit release returns PAUSED at zero speed, with no auto-resume observed over
two seconds. This interrupted probe is excluded from route/quality acceptance.

CARLA is then disconnected and stopped: no native processes remain. The SDK-free
dashboard stays available at `http://127.0.0.1:8000/`, disconnected and held.
Saved next-launch quality/resolution are verified restored to Epic/1280×720.

## Verification scope

- Dashboard JavaScript and CSS regenerated.
- JavaScript: **141 passed**.
- Python: **607 discovered, 605 passed, 2 skipped**.
- Optional detector regression: **1 passed**, separately in `.venv-perception`.
- Camera/map identity, recording completeness, video checksums and actual browser
  completion are audited separately from driving quality.
- Neither Epic nor temporary Low meets the strict live-camera rate/realtime gate.
  The Low-profile probe also includes the final transport correction, so it must
  not be used to attribute a performance change solely to graphics quality.

The observer archives/hashes 96 modules in `backend/core`, `backend/carla` and
`backend/computer_vision`; this is not a claim that its archive covers every
runtime asset. Iteration 6 additionally records the WebSocket bridge, dashboard
bundle/styles and browser instrumentation hashes before its drive. Raw audits,
videos and sources remain local; compact evidence is committed separately.

The [compact evidence index](evidence/driving-verification-20261018/verification.json)
retains all driving attempts, the idle observer and failed startup separately,
source/archive hashes, independent stop summaries, browser/recording audits,
offline tests, recovery and cleanup. The original raw evidence stays under
ignored `output/driving-verification-20261018/`, `runs/normal_city/` and
`output/presentations/`; an ordinary Git clone does not include those assets.

No model weights, settings, virtual environments or raw runs are committed.
**Software verification passes; full native acceptance does not.** The open
checklist items are not converted to passes by successful arrival or honest labels.
