# Behavior proposal first package - 27 October 2026

## Scope and non-claims

This package freezes a reproducible driver baseline, completes software timing
instrumentation, and introduces a **shadow-only semantic proposal boundary**.
It does not load a VLM, start a model worker, enable learned driving, launch
CARLA, allocate native time, or reuse an acceptance seed.

There is **no measured native timing improvement or VLM benefit** in this
package. The proposed p95 target below is not a real-time result. Egypt's
existing native admission gates, failure evidence, and reserved acceptance
window are unchanged.

The implementation follows the [A/B/C/D protocol](../config/behavior-proposals-v1.json):

| Arm | Definition | Status in this package |
| --- | --- | --- |
| A | Fingerprinted effective current driver | Source archive and development sensor replay |
| B | A with timing-only, decision-equivalent improvements | Instrumentation; native improvement not established |
| C | B plus simple queue/parked-blocker rules | Not implemented or evaluated |
| D | B plus VLM proposals with the same permitted information as C | Data boundary only; no model or actuation authority |

The first six development cases are clear road, moving queue, parked blocker,
forbidden passing, unsafe gap, and ambiguous waiting. Fault and software
fixtures are development data, not independent test episodes.

## Source and replay provenance

The checkout already contained another session's Egypt repairs. They were
neither reverted nor silently presented as changes from this package. The
initial effective source was frozen before changing the shared control path:

| Initial capture | Value |
| --- | --- |
| Git HEAD | `32175a58d4b0f4d62915fe5ce5f08142e4417af8` |
| Effective driver source SHA-256 | `f62df374747e5c7945eaaa6ec99336d0bb28e52403f522b509f07c60f082c00d` |
| Verified local source ZIP SHA-256 | `001d87d5dde90afe022316750ce5fc82ba36ad8e504ef2a2957e561cb39a0bae` |
| Sensor frames | 34, frames 299-332; all selected assets checked |
| Recorded urban decisions | Four, frames 328-331 |
| Recording partition | DEVELOPMENT, seed 2707 |

The [initial capture](evidence/behavior-proposals-v1/baseline-a.json) is retained
as an immutable historical record. Its source archive is under ignored
`output/behavior-proposals-v1/baseline-a-source.zip`. A hash of HEAD alone would
not reproduce this source state: the effective source manifest includes the
pre-existing dirty backend/configuration and storage helpers.

The version-2 capture tool additionally binds the complete logical
`comparison-controls.jsonl` stream, including recorded base commands and road
contexts, and records Python/platform/dependency versions. This closes a
provenance gap in the initial capture, whose input digest covered sensors but
not that sidecar. The initial capture is not silently rewritten or treated as a
complete version-2 input manifest.

The [fully pinned historical A](evidence/behavior-proposals-v1/historical-baseline-a-v2.json)
closes that gap without changing the original source identity. The original ZIP
was verified, temporarily expanded as a non-Git source snapshot, and executed
with the original backend and profiler. Its source hash, all 34 RULE outputs,
all four urban outputs, and original sensor input identity matched exactly.
That execution also verified the logical control-sidecar hash used by the
version-2 input manifest. The temporary source snapshot was removed.
**This is historical A, not a new current-source/native authorization.**

[The offline harness](../scripts/behavior_experiment.py) builds on the existing
[control profiler](../scripts/profile_control_pipeline.py), recorded sensor
reader, measured scene builder, urban driver, and independent execution shield.
It:

- Requires an explicit DEVELOPMENT recording, finalized recording status, and
  complete selected sensor frames. Retired recordings, missing assets, checksum
  failures, empty prefixes, duplicate decisions, and mismatched frame/session
  references fail explicitly.
- Supports the existing lossless compressed storage through logical asset
  reads. Source ZIP contents and exact file sets are checked against their
  manifest; an existing capture is never overwritten.
- Separates measured host computation time from a fixed replay decision clock.
  The urban decision lease is 50 ms and its independent shield check is 60 ms
  after the synthetic receipt. These are declared replay inputs, not historical
  native sensor ages.
- Reports a recorded speed cap where available. Older recordings use an
  explicitly labelled 60 km/h replay cap; the tool does not pretend the original
  unrecorded cap was measured.
- Compares serialized commands, final shield-filtered commands, behavior/path
  selection, rejected candidates, completed maneuvers, measured tracks, physical
  forecasts, and independent shield outcomes. It also compares the original
  RULE profiler's output digest.
- Rejects protocol/source/input drift during verification. Failure reports retain
  `passed: false`; failed runs are not omitted from an apparent success.

This short failed-trip prefix can establish software equivalence only. It does
not reconstruct the original native scheduler, reproduce actual actuation, or
demonstrate arrival, completed passing, queue recognition, safety, or efficiency.

## Timing: receipt, submission, and observed control are different

[Timing evidence](../backend/core/pipeline_timing.py) uses a separate host-clock
side channel. Policy sensor calibration intentionally strips host receipt and
encoding metadata. Reading these fields from policy calibration therefore
cannot measure frame completion; the previous fallback confused first receipt
with completion. The service now passes the native sensor metadata and the
time it receives a synchronized complete frame separately to the scene builder.

Each submitted control can carry:

1. First and last required sensor callback receipt.
2. Completion of required sensor encoding.
3. Delivery of the synchronized complete frame to the scene publisher.
4. Scene build, prediction, and publication.
5. Maneuver selection.
6. Independent execution-shield check.
7. Final freshness check, CARLA call, and call return.
8. A linked observation of the next actual native vehicle control state.

`CONTROL_PIPELINE_TIMING` and `CONTROL_APPLICATION_OBSERVED` share a
session/frame-specific trace identity. Host monotonic seconds are never
subtracted from simulation timestamps. Simulation age is reported separately.
Unavailable stages are `null` with explicit timing issues, not invented zeros.
Standalone replay scenes identify their clock as uninstrumented/replay rather
than mixing old recording epochs with the current host clock.

A successful RPC or synchronous batch acknowledgement is **not** a measurement
of physical application time. The next-frame check reads the actual vehicle
state, not the service's echoed `SimulationFrame.control`. It reports mismatches,
old frames, actor replacement, and host-clock ordering errors. Matching control
state provides an observational upper bound only; identical repeated commands
do not prove which command instance was applied. Exact physical application time
and command identity therefore remain explicitly unproven.

The timing summary reports submitted, observed, eligible, missing, and invalid
coverage. Missing/mismatched frames or failed freshness checks cannot be
discarded to pass the proposed
strict **p95 < 200 ms** observed-control upper-bound target. That target is
proposed engineering headroom before the existing 250 ms wall-age gate, not
native acceptance. The existing **250 ms wall / 100 ms simulation freshness
limits remain unchanged**. Real-time throughput needs a separate native
wall/simulation measurement.

## Proposal contract and fault behavior

[The proposal boundary](../backend/core/behavior_proposals.py) admits only
`FOLLOW`, `FOLLOW_QUEUE`, `WAIT`, and `PREPARE_TO_PASS`, with enumerated compatible
reason codes, explicit abstention, session/request/source-frame references, and
an expiry. It has no field for steering, throttle, braking, a trajectory, or a
clearance certificate. Unknown fields and duplicate JSON keys are rejected.

Inputs are bounded to 32 confirmed visible measured tracks, eight history
frames, and two frame-bound RGB references, plus selected current road context.
No native actor identities, scenario labels, oracle forecasts, or future ground
truth are copied into the request. Worker-facing data is a copy of immutable
measurements, not a mutable view into the driver.

One nonblocking mailbox holds a request and its response. No inference callback
executes on the control thread. The interface exists for a future separately
measured worker; there is no model selection/download or GPU worker here.
Within the live service, shadow inspection runs **after command submission** and
its wall cost is reported separately. It can still consume resources and delay
the next tick, so offline tests do not establish native timing neutrality.

Proposal validity is at most one second in both wall and simulation time and
never extends physical sensor freshness. Validation rejects:

- Unavailable/failed/timed-out models and malformed or conflicting responses.
- Unknown request, session/frame/time mismatch, clock rollback, or expired data.
- Missing, replaced, occluded, displaced, reclassified, or materially
  velocity-changed blockers.
- Changed road geometry/permissions, junctions, traffic stops, and unsupported
  passing proposals.

The initial geometry comparison is intentionally conservative: any difference
in the complete road-context fingerprint invalidates a captured suggestion.
A blocker displacement over 1.5 m or velocity change over 0.5 m/s also invalidates
it. A stationary-blockage proposal cannot be used for a currently moving
blocker. These checks do not certify a maneuver or an available gap.

Every outcome explicitly retains `UNCHANGED_BASE_DRIVER` and
`control_authority: false`. Valid semantic proposals are not labelled physically
admissible. Even a future admitted proposal must generate a new maneuver using
current measurements and pass the existing independent shield; there is no
old-path replay or execution switch in this package.

## Independent evaluation and native ownership

The protocol declares fresh development and test seed numbers, separate from
the existing Egypt seed sets. **Native locations remain unassigned**. A
location-disjoint manifest, disjoint also from all prior test/holdout road
footprints, is required before this becomes a usable native partition.
Software case labels and new seed numbers alone cannot establish location
disjointness.

The proposed benefit target is a 20% relative reduction in unnecessary waiting,
with unnecessary braking events reported separately. Collision, arrival, route
completion, completed pass-and-return, comfort, timing, and worker resource
outcomes must also be retained. Analysis units are matched routes/seeds rather
than correlated frames; paired uncertainty and every failure must be reported.
Relative benefit is undefined when baseline unnecessary waiting is zero.

Numerical noninferiority margins, independent annotation rules, sample size,
new locations, model identity, and native resource limits still require a
pre-run protocol freeze. They are **blocking prerequisites for closed-loop
claims**, not adjustable after seeing D's results. No small collision-free
sample can establish general safety.

The concurrent Egypt completion session owns native reservations and integration
of shared timing files. This package performs no native operations and cannot
borrow from, reset, or reallocate its acceptance window. An externally owned
dashboard is not permission to run an experiment or stop CARLA.

## Offline commands

The package's [recorded replay verification](evidence/behavior-proposals-v1/replay-verification-final.json)
uses the fully pinned historical A:

```powershell
.\.venv-carla\Scripts\python.exe .\scripts\behavior_experiment.py replay `
  --baseline .\docs\evidence\behavior-proposals-v1\historical-baseline-a-v2.json `
  --output .\output\behavior-proposals-v1\replay-new-check.json
```

Only the shared-source owner should capture the next integrated baseline, to
**new**, reviewed output names after source ownership is stable:

```powershell
.\.venv-carla\Scripts\python.exe .\scripts\behavior_experiment.py freeze `
  --recording .\runs\normal_city\run_a0a2db1d096e4b24bc806ebd5594d81a `
  --frames 150 `
  --archive .\output\behavior-proposals-v1\baseline-a-final-source.zip `
  --output .\docs\evidence\behavior-proposals-v1\baseline-a-final.json

.\.venv-carla\Scripts\python.exe .\scripts\behavior_experiment.py replay `
  --baseline .\docs\evidence\behavior-proposals-v1\baseline-a-final.json `
  --output .\docs\evidence\behavior-proposals-v1\replay-verification.json

.\.venv-carla\Scripts\python.exe -m unittest `
  tests.test_behavior_proposals tests.test_pipeline_timing tests.test_behavior_experiment
```

The `timing` subcommand summarizes already-recorded timing rows; it cannot start
the simulator. Existing recordings without the new timing rows cannot pass a
native timing gate. The focused software suite covers six development cases,
malformed/conflicting/failed/late responses, stale measurements and identity
changes, actual-state versus echoed-command observation, strict p95 boundaries,
archive corruption, input/protocol drift, and post-submission shadow isolation.

## Verified software and handoff

[The software evidence](evidence/behavior-proposals-v1/software-verification.json)
records command outcomes, log hashes, package source hashes, and budget-file
checks. Results:

| Check | Result |
| --- | --- |
| First-package focused tests | 27 passed |
| Integrated proposal/timing/scene/lifecycle/braking/urban tests | 117 passed |
| Original RULE replay | 34 frames; identical output digest |
| Urban replay, default and model-unavailable shadow | Four decisions; identical commands, behavior, forecasts and shield outcomes |
| Actual Egypt service with a valid `PREPARE_TO_PASS` response | Same applied command/path/action as disabled default; still `FOLLOW`, no learned authority |
| Egypt budget and allowance file hashes before/after this package | Unchanged |
| Native execution, model loading, commit or push by this package | None |

The urban semantic digest remains
`763e9a5e83e1fe0fc82f97345e766f3d5baff985848f71b4cfd0abd24c8d29d4`;
the RULE digest remains
`e1edf762f13573679f33523dc64aa799b5480d3e34e3dc0d88b9292617f3daea`.

The initial integrated test run encountered the real 4 GiB recording reserve on
C: (3.901 GiB free), not a control failure. Re-running with this test command's
`TEMP`/`TMP` under an isolated ignored D: directory passed; D: had 126.027 GiB
free. The reserve was never lowered or bypassed.

An additional whole-suite diagnostic discovered 1,013 tests: 1,006 passed,
four were skipped, and three failed in the concurrent shared integration.
The findings were forwarded to its owner: sensor destruction after a stop
failure, the surfaced service-close error expectation, and a relative
repository-adapter import that the core SDK-boundary test flags. This diagnostic
is retained as failed evidence, **not a passing final project gate**.

The package's runtime/configuration files are handed off in their tested state.
The Egypt completion session owns subsequent shared cleanup fixes, the final
integrated source freeze, whole-project/native gates, README/evidence-index
links, and Git delivery. It must not use historical A's fingerprint as the
current native source. This package does not require or claim completion of the
remaining native development/acceptance or VLM evaluation stages.
