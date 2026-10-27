# Egypt completion gates - 27 October 2026

**The task is incomplete at Gate B. Egypt remains restricted.**
Software verification, replay, a diagnostic prefix, and a saved worker report
are not native acceptance. The reserved holdout is still one attempt, not a
source of tuning data.

Two protected-seed diagnostics failed the unchanged sensor deadline. Neither
Normal diagnostic, either full matrix, nor the native browser check was run.
The [retained evidence index](evidence/egypt-urban-chaos-v1/completion-gates-20261027.json)
records both source versions, original report hashes, remaining balances and
independent cleanup/video results.

This follows the [retained native failures](EGYPT_NATIVE_FOLLOWUP_20261024.md)
and [scenario contract](EGYPT_URBAN_CHAOS_V1.md). Work remains on `main` in the
primary checkout; raw recordings and source archives stay local.

## Authorization and ordered execution

The original allowance and every previous reservation remain unchanged.
`EGYPT_DEVELOPMENT_20261027` is a separate, immutable, uniquely keyed
**7200-second development extension**. Applying it again is a no-op; unknown
extensions and changes to existing extension records are rejected.

The effective development cap is 14400 seconds and the acceptance cap remains
7200 seconds. Diagnosis must leave **7200 seconds for the full development
matrix and 480 seconds for the final browser check**. Acceptance reserves
exactly 7200 seconds once. Server processes inheriting a live ticket also
inherit its remaining deadline, including after startup/stop helper handoffs.

The runner requires:

1. Current-source complete offline test/build and retained-replay evidence.
2. Protected seed 2707: at least 50 m and 30 simulation seconds; then Normal
   1703 and 3709 beyond the retained stopping distances or a real terminal
   outcome. All require verified cleanup, video playback and measured timing.
3. One full current-source development matrix: three seeds, both orders.
   Diagnostic fragments are never merged into it.
4. One reserved acceptance matrix on 961103, 961109 and 961121, both orders.
5. The separately charged browser check; its short trip is not acceptance.

Every diagnostic records its source, reservation and concrete change
hypothesis. Its target is claimed before the worker starts, so interruption
cannot erase an attempt. Repeating the same source/target is refused.
Incomplete prerequisites, insufficient storage or protected time, source
changes, crashes, and timeouts retain the failure rather than promoting Egypt.

## Timing and control

Sensor receipt, encoding, synchronized delivery, scene construction, prediction,
maneuver selection, safety check, application check and CARLA call timestamps
share the host monotonic clock. Simulation timestamps remain original and
separate. The [shared timing instrumentation](BEHAVIOR_PROPOSALS_20261027.md)
also distinguishes submission from an observed next-frame vehicle control
state; it does not invent an exact physical application timestamp.

The enforced sensor wall lease remains **250 ms**. The measured engineering
gates are **p95 <= 200 ms and p99 <= 225 ms**, from first required receipt to
the application check. Missing, unaligned or deadline-exceeding samples cannot
be discarded to pass. CARLA call time is recorded separately.

The initial-condition audit, persistence and traffic release run while the ego
is held, outside the control decision. Release requires a subsequent complete,
fresh frame before automatic control begins. Physical scenario events start at
release. Reporting and comparison sampling run after command submission.
Native evidence uses a bounded writer; overflow is an explicit failure with a
durable incomplete prefix. RGB encoding is off the callback path; ordinary
recording uses a bounded, lossless queue rather than silently replacing images.

The maneuver owner and independent shield reuse immutable same-frame forecast
geometry without reusing a previous frame's authorization. All physical modes,
full maneuver/stopping-tail checks and independent vetoes remain.

The second repair stages the new native frame's route-controller proposal and
map geometry during GPU sensor collection. It does not apply that proposal
early: the subsequent current sensor scene, behavior owner, independent shield
and final application check remain mandatory. Immutable urban map rows avoid
repeated deep copies; legacy mutable map callers retain their old contract.

## Retained Normal coverage analysis

The retained runs are:

- `run_f49cc7dbdb2e4071bf434a5eca4b93a2`, near 156.351 m.
- `run_cc6bc8106a144d2ab16d01d7768d26ba`, near 110.246 m.

At frames 3973 and 3683, the measured continuous corridor was **3.0 m**, which
produced a **0 m/s coverage speed cap**. It was not a measured zero-distance
empty road. Front depth measured foreground gaps of approximately 4.379 m and
4.401 m; the original camera frames show a leading vehicle.

Sensor mount positions agree with native transforms to within 0.03 m (the
actual errors are much smaller). Independently expanding processing scope from
6 m to about 13.34 m did not increase coverage. The first unverified body
footprint is at 3.5 m. These observations do not justify declaring its unknown
cells free or driving through the leading vehicle. A sensor-byte regression
checks reactive braking and release after fresh observations clear an obstacle.
This is software verification, not proof that Normal completes either native
route.

The reproducible audit is [audit_egypt_coverage.py](../scripts/audit_egypt_coverage.py).
Raw inputs, original hashes and the full local audit remain under the project.

## Lossless storage and replay

[compress_recordings.py](../scripts/compress_recordings.py) operates only on
explicit closed recordings with CARLA stopped and no foreign native owner.
Depth, LiDAR and telemetry are compressed without rewriting their logical
references, timestamps or original checksums. Existing JPEGs and videos are
unchanged.

Each file is decompressed and its original length and SHA-256 verified before
the proof is flushed to the manifest and the uncompressed copy is removed.
At most four files are processed concurrently; manifest commits are serialized.
An interrupted operation retains its verified prefix and remaining originals.
Replay, safety-window tools and video exports support both original and gzip
storage. Retired, deleted sensor recordings are never relabelled as lossless.

Matrix preflight estimates the peak of two raw trips, previously closed
compressed trips, retained exports and temporary annotation images. Rates and
durations come from development recordings, never holdout tuning. The required
free space adds **50% margin and a 4 GiB reserve**. Each finished matrix pair is
compressed only after engine exit, and that work remains inside its reservation.

## Shutdown and saved results

Shutdown is serialized and repeatable: stop control, stop sensor admission,
drain callbacks/final events, finalize recording and exports, then destroy
actors and restore the world. A failed sensor stop still attempts actor cleanup
once callbacks have drained; its error remains a failure. Shutdown errors are
returned explicitly, not hidden behind a written report.

The parent retains the last cleanup stage, fault-handler log, child exit code,
independent world cleanup probe, actual engine exit, and post-exit video
checks. A worker that writes its report and crashes is rejected.

Only `ARRIVED` and `COLLISION` count as completed trips; accepted comparisons
are counted separately out of six. The primary button shows short server-driven
validation/preparation/sensor/shutdown states. Technical gate details are
expandable. GPU name, used/free VRAM, load and sample age remain advisory.

On full acceptance, the six verified comparison records are published to the
existing saved-comparison directory without replacing the user's latest
comparison. Their three videos remain available independently of CARLA.

## Verification record

Local software, compression, handoff and replay records are retained under
`output/egypt-validation/software-20261027`. The initial external paused-engine
handoff was a maintenance shutdown, not a diagnostic trip; it charged 5.313
development seconds and left the acceptance window untouched.

The final offline source passed **1019 Python tests (four optional skips)**,
**209 JavaScript tests**, dashboard generation and bundle syntax checking.
The complete suite passed with unchanged source. Earlier failed checks and
their logs remain local: three shutdown/boundary regressions were repaired, an
asynchronous presentation fixture failed under heavy compression but passed
with quiescent storage, and the worker-argument test was isolated from unrelated
background subprocess calls.

Lossless compression freed **7,088,187,123 bytes (6.601 GiB)**. The first
interrupted compression prefix was preserved and resumed with bounded workers;
the post-compression replay audits match their originals exactly. All four
initial recorded urban decisions, and all 49 decisions from native diagnostic
01, retain equal proposal/forecast/shield hashes on replay. These are software
checks, not native acceptance.

| Protected 2707 diagnostic | 01 | 02 |
| --- | ---: | ---: |
| Distance | 0.000409 m | 0.000409 m |
| Simulation duration | 2.40 s | 2.85 s |
| Application-check p95 | 291.024 ms | 271.507 ms |
| Application-check p99 | 293.878 ms | 296.838 ms |
| Samples exceeding 250 ms | 16 / 48 | 16 / 57 |
| Native worker return code | 1 | 1 |
| Serial cleanup / independent world probe / engine exit | confirmed | confirmed |
| Saved trip video hash and first/last-frame decode after exit | passed | passed |

Return code 1 denotes the failed diagnostic, not a successful drive. Neither
worker suffered the previously observed native stack-overflow exit. These two
closures do not satisfy the required three successful diagnostic trials.
Diagnostic 01's original stricter exit-code gate is retained unchanged; the
independent cleanup evidence must not be conflated with its failed drive.

The repeated deadline vetoes reset the launch throttle before meaningful
movement. Staging map/navigation work removed its repeated critical-path cost,
but scene construction, sensor collection and measured-space planning still
exceed the required envelope. Larger ray batches were tested offline, preserved
all grid states, and were rejected because they were slower.

| Separate allowance at this checkpoint | Seconds |
| --- | ---: |
| Development charged, including historical work and shutdown | 2868.470 |
| Development remaining | 11531.530 |
| Diagnostic spendable after preserving matrix/browser windows | 3851.530 |
| Protected development matrix / browser | 7200 / 480 |
| Acceptance remaining / spent | 7200 / 0 |

There is no unfinished reservation, retained simulator owner or running CARLA
engine. The historical research ledger hash is unchanged. Read-only preflight
refuses development because Gate B did not pass, and refuses acceptance because
the full current-source development matrix did not pass.

**Next required step:** identify and repair the remaining measured latency
cost, verify the resulting source offline, and run an evidenced new-source
protected 2707 diagnostic. Only after that passes may Normal 1703/3709 and the
later gates proceed. This checkpoint must not be described as completed Egypt
acceptance or an unlocked driving option.
