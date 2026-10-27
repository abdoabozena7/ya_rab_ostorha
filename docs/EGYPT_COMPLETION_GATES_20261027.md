# Egypt completion gates - 27 October 2026

**The task is incomplete at Gate B. Egypt remains restricted.**
Software verification, replay, a diagnostic prefix, and a saved worker report
are not native acceptance. The reserved holdout is still one attempt, not a
source of tuning data.

Nineteen protected-seed diagnostics are retained. The latest reached 63.95 m
over 30 simulation seconds, exited cleanly and passed post-exit video checks,
but still failed the unchanged latency gate. Neither Normal diagnostic, either
full matrix in this ordered execution, nor the final native browser check ran.
The [initial checkpoint index](evidence/egypt-urban-chaos-v1/completion-gates-20261027.json)
remains historical and unchanged. The
[continuation index](evidence/egypt-urban-chaos-v1/continuation-20261027.json)
records all source versions, original report hashes, current balances and
independent cleanup/video results. No diagnostic is a completed matrix trip.
The [CPU/deadline follow-up](evidence/egypt-urban-chaos-v1/cpu-deadline-followup-20261027.json)
extends that historical index through attempt 19 without overwriting it.

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

## Initial checkpoint verification (historical)

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

## First continuation checkpoint (through attempt 17)

The first checkpoint above was committed as `4ed8e48`. Subsequent work did not
reset its expenditure or rewrite any failed attempt.

- Measured occupancy and ray marking now use strict compiled kernels, warmed
  before driving. Original sample fractions, rounding, body exclusion,
  first-return deduplication and free/occupied/unknown states are preserved.
  The original NumPy observation path remains the test oracle at 6/35/75 m.
- Body-core depth measurement is compiled without fast math. Full measured
  person histories are immutable and shared; all history rows and physical
  alternatives remain. Spatial-support matching uses the same nine-neighbor
  tolerance without repeatedly expanding it for every track.
- Native BLAS work is bounded to one thread. The dependency manifest pins
  `threadpoolctl`, `numba` and `llvmlite` and is included in source fingerprints.
  There are no new model weights, sensor reductions or lower traffic counts.
- Frame recording is bounded and deferred until after command submission.
  Strict forecast JSON is encoded once rather than twice; immutable queued
  inputs retain conservative byte charges. Cyclic collection is kept outside
  sensor-to-control windows and its prior enabled/disabled state is restored.
- Optional *new* lane changes/returns wait for sufficient lease headroom.
  FOLLOW, committed maneuvers, all stopping checks and the independent veto
  remain active. This can defer overtaking; it does not waive the three measured
  completed-overtake requirement.
- Concurrent measured-space preparation is available for bounded experiments,
  but is disabled in the live service after its measured contention. Frame
  arrival uses an event rather than coarse polling. Native navigation/map
  prefetch still cannot authorize a command without its current sensor frame.
- D3D11 aborted during initial native stepping in attempt 15. D3D12 is restored.
  Attempt 16's render-thread queue experiment had no convincing improvement
  and no applied-console proof; both the code and its local INI override were
  removed. These settings are not claimed as validated optimizations.
- The auxiliary native evidence recorder now closes with the trip recorders,
  before export completion, actor destruction and world restoration. Retiring
  SDK workers keep their single-thread numeric limit until process exit;
  reusable services restore the previous limit. Ordinary and repeated close,
  writer failure and ordering have regression coverage.

### Retained native sequence

All rows are protected seed 2707, never holdout. Times are sensor receipt to
application check, not CARLA RPC duration. Exit 0 means the bounded diagnostic
goal/cleanup completed; it does **not** override the failed latency assessment.

| Attempt | Distance (m) | Simulation (s) | p95 / p99 (ms) | Over 250 ms / samples | Worker exit |
| --- | ---: | ---: | ---: | ---: | ---: |
| 03 | 0.585 | 5.80 | 269.547 / 328.299 | 15 / 116 | 1 |
| 04 | 0.676 | 6.20 | 272.795 / 310.214 | 27 / 124 | 1 |
| 05 | 6.451 | 11.40 | 259.960 / 275.151 | 32 / 228 | 1 |
| 06 | 5.616 | 10.30 | 260.382 / 272.140 | 33 / 206 | 3221225725 |
| 07 | 8.321 | 15.35 | 260.405 / 324.216 | 42 / 307 | 1 |
| 08 | 29.676 | 12.85 | 259.108 / 271.993 | 30 / 257 | 1 |
| 09 | 23.739 | 22.65 | 259.418 / 269.095 | 65 / 453 | 3221225725 |
| 10 | 41.685 | 38.45 | 258.837 / 271.118 | 99 / 769 | 1 |
| 11 | 38.600 | 19.25 | 259.539 / 272.108 | 49 / 385 | 1 |
| 12 | 64.477 | 30.00 | 244.701 / 259.654 | 23 / 601 | 0 |
| 13 | 64.561 | 30.00 | 236.028 / 252.400 | 12 / 601 | 0 |
| 14 | 63.038 | 30.00 | 234.506 / 254.884 | 13 / 601 | 0 |
| 15 | no trip | no trip | unmeasured | unmeasured | 3 |
| 16 | 63.333 | 30.00 | 235.900 / 258.825 | 13 / 601 | 3221225725 |
| 17 | 63.932 | 30.00 | 228.343 / 248.143 | 6 / 601 | 0 |

Attempts 06/09/16 suffered Windows stack overflow (`0xC00000FD`) after native
cleanup while the auxiliary evidence writer was closing. The retained Windows
error identifies `ntdll.dll`, not a proven defective CARLA function. Saved
measurements, a restored world and a playable video did not turn those crashes
into clean exits. Their fault traces and last-stage markers remain local.

Attempt 17 confirms the new shutdown order in one actual run: worker exit 0,
complete exports, independent asynchronous-world/zero-owned-actor probe, engine
exit and saved-video hash/first-last-frame decoding all passed. This one closure
does not prove the intermittent failure is eradicated or substitute for the
three required same-source successful diagnostics.

Its only failed diagnostic gate is sensor latency. The maximum was 263.003 ms;
six unaligned/deadline-exceeding frames remain in all 601 samples. CARLA RPC
p95/p99 was 0.096/0.634 ms. No failing samples were dropped and the lease remains
250 ms.

### Current software verification and remaining gates

On source
`44eb8fb1316d3bc906a7fd1d8bd10734ca4fbc40ed5c7cacf33a75b20e66a088`:

- Full Python suite: **1033 tests, 1029 passed and 4 optional skips**.
- Full JavaScript suite: **209 passed**; dashboard JavaScript/CSS regenerated.
- Exact compiled occupancy/certificate and body-core regressions pass.
- All 21 retained late-frame person/forecast hashes match before/after the
  relevant geometry optimizations. The final shutdown-only change also keeps
  all 21 full recorded-semantic replay forecast hashes equal.
- Full semantic profiling is distinct from the earlier geometry-only replay.
  It replays history from the recording start and selects the latest recorded
  detection by evaluation frame. It does not reconstruct exact asynchronous
  native detector arrival or predict a live latency percentile.

The final profiler and original inputs remain in the local evidence directory.
Its profiled scene/maneuver/shield costs still leave substantial CPU work;
passing an offline replay is not a reason to waive the native timing gate.

| Separate allowance after diagnostic 17 | Seconds |
| --- | ---: |
| Development charged, including historical work and shutdown | 5625.034 |
| Development remaining | 8774.966 |
| Diagnostic spendable after protecting matrix/browser | 1094.966 |
| Protected development matrix / browser | 7200 / 480 |
| Acceptance remaining / spent | 7200 / 0 |

The 32 closed development recordings are retained, including failed prefixes.
Stopped-engine compression completed for all 32, recovered **8.848 GiB
additional original-file bytes** and left the native budget unchanged. Every
removed original was verified by decompressed SHA-256. The latest saved video
still passes hash/first-last-frame decoding, and all 21 selected full semantic
replay hashes remain equal when read from compressed storage.

Storage is also still blocked: the snapshot had **92.587 GiB free**, below the
**130.431 GiB** empirical requirement including 50% margin and 4 GiB reserve.
The prior requirement was 197.403 GiB before the remaining recordings were
compressed. These are point-in-time free-space measurements, not a claim that
this shared machine's other disk use stayed constant. Compression reports and
both estimates are in the continuation index. Historical-prefix sizing is provisional:
the acceptance preflight must use the successful current-source development
matrix, then add the required 50% margin and 4 GiB reserve.

There is no permission to proceed to Normal or either matrix while Gate B
fails. Further native diagnosis requires a specific measured change, enough
remaining diagnostic time, and another current-source software gate; there is
no unchanged-source retry. The task, automatic Egypt admission and final native
browser acceptance remain **incomplete**.

## CPU and deadline follow-up (attempts 18-19)

Further work stayed within the existing allowance:

- Bounded surface registration is compiled without fast math. The original
  batched NumPy implementation and scalar tests remain independent oracles;
  ragged clouds, ties, missing inliers and both seed policies are covered.
- History conversion retains five-field records, exact sampled values and
  explicit rejection of ragged rows. Equal immutable uncertainty bounds are
  shared; mutable legacy results retain independent containers.
- Forecast and road numeric rows are cached only for validated immutable
  same-frame inputs. Cached arrays are backed by immutable bytes; mutable
  callers are converted afresh. All physical hypotheses and time grids remain.
- The compiled map can now overlap measured tracking using one bounded worker
  and an exactly frame-matched prefetched road. Errors propagate rather than
  yielding empty/free geometry. Recorded forecast hashes remain identical.
- A late maneuver start reserves 50 ms for the independent braking-path check
  and submission inside the original 250 ms lease. It brakes without erasing
  an active maneuver, and an expired proof cannot commit a new maneuver.
  This is an explicit emergency hold, not permission to omit safety checks.

| Protected 2707 diagnostic | 18 | 19 |
| --- | ---: | ---: |
| Distance / simulation time | 64.567 m / 30.00 s | 63.946 m / 30.00 s |
| Application-check p95 | 199.005 ms | 215.750 ms |
| Application-check p99 | 224.172 ms | 234.514 ms |
| Maximum | 255.327 ms | 259.957 ms |
| Frames over 250 ms / samples | 1 / 601 | 2 / 601 |
| Worker exit / independent cleanup / post-exit video | 0 / passed / passed | 0 / passed / passed |
| Complete diagnostic gate | failed | failed |

Attempt 18 met the percentile targets but was **not promoted**: frame 763
started maneuver selection at 207.717 ms and finished it at 254.981 ms.
Its independent execution check could no longer run on a fresh scene.
Replaying that measured entry age with the headroom guard produced full braking,
preserved maneuver state and passed the independent complete stopping-tail
check at 247.641 ms under profiling. This is offline case verification only:
attempt 19 still had two late frames and worse percentiles. It does not establish
stable native latency or close Gate B.

The current source is
`c2ec0594d7a0a80141820d0e2ffc0a448887e0f7f85a35da5a75e40a5fb90137`.
Its full Python suite ran **1040 tests: 1036 passed, 4 optional skips**.
All **209 JavaScript tests** passed again and dashboard assets were regenerated.
No new model weights or weaker acceptance criteria were introduced.

Additional read-only Normal analysis found a stationary Nissan Patrol roughly
9.068 m ahead of the ego in both retained stops, consistent with the measured
foreground gap. Other traffic still moved; these were not empty roads.
The old runs also lost their sustained 60-vehicle density, and a merge event
expired in seed 3709. The precise cause of the persistent traffic queue is not
proved by these snapshots. No forced movement, invented clearance, fabricated
collision or successful Normal outcome was substituted.

Alternative lossless XZ/delta/bitshuffle and reversible depth-difference codecs
were benchmarked on original bytes. They were not adopted: the probes did not
establish a sufficient end-to-end storage solution, and no recording was
rewritten into an experimental format. Other closed recordings under `runs`
held less than 4 GiB of additional uncompressed candidate data, insufficient
to close the observed capacity gap. No files outside the project were removed.

| Allowance after attempt 19 | Seconds |
| --- | ---: |
| Development charged / remaining | 6074.987 / 8325.013 |
| Diagnostic spendable | 645.013 |
| Protected full development / browser | 7200 / 480 |
| Acceptance remaining / attempted | 7200 / no |

The two new recordings, their final lossless compression reports and refreshed
storage estimate are preserved in the latest evidence index. Their verified
compression recovered another **1.496 GiB** without consuming native budget;
both compressed replays and post-compression video checks pass. The refreshed
capacity snapshot is **91.764 GiB free versus 130.431 GiB required**.
No unchanged-source
retry or borrowing from protected windows is allowed. Further native work needs
a justified change and enough diagnostic reservation; any additional allowance
requires explicit authorization. Storage capacity must also pass before a
matrix. Egypt, both ordered Normal diagnostics, the matrices and final browser
acceptance remain **incomplete**.
