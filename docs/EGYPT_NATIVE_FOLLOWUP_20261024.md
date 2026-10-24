# Egypt native validation after storage recovery — 24 October 2026

**Native development still fails. Egypt remains validation-only; the historical
crossing scenario remains the default.** No acceptance seed was run, and no
budget was reset, transferred or extended.

The [project cleanup](STORAGE_CLEANUP_20261024.md) removed the storage blocker.
Six additional native development attempts then ran on seed 2707, protected
driver first, using Town10HD_Opt / LOW, the same Mercedes and sensor rig, and
the requested 60 vehicles / 100 pedestrians. Every attempt passed the physical
initial-condition audit and entered `DRIVING`, but the first arm stopped with
`Current synchronized sensor scene unavailable for one second`. None travelled
a meaningful distance: about 0.00026 m, with no arrival or measured overtake.

The [retained evidence index](evidence/egypt-urban-chaos-v1/native-followup-20261024.json)
records each source fingerprint, original report hash, recording, failure,
pipeline timing, process-exit result and budget. The preceding
[thirteen-attempt index](evidence/egypt-urban-chaos-v1/native-execution-20261024.json)
is unchanged, and all thirteen original report hashes still match it. Raw runs
and source archives remain local under ignored `output/` and `runs/`.

## Measured timing and bounded changes

The existing **250 ms sensor wall-age lease remains enforced**. Diagnostics now
separate native navigation, road context and behavior evaluation. In attempt 11,
the first map build consumed 96 ms; a cold behavior evaluation consumed 176 ms.
Later behavior evaluations were about 68–72 ms. The native route controller
itself took only about 2–3 ms.

The implementation now:

- Builds static drivable-map strips during preparation, before driving. Actual
  ego transforms and route/lane permissions are still evaluated each frame.
- Starts the measured-road query at 6 m while held and grows it with current
  reaction/braking distance. Target speed stays capped by actual continuous
  measured coverage. Complete maneuver and independent stopping proofs remain
  mandatory; no unknown cell is declared free.
- Copies finite numeric forecast matrices directly into immutable JSON rows.
  Existing mutable callers retain their default behavior. Numeric payloads,
  mode alternatives, horizons and timestamps are unchanged.
- Uses explicitly incomplete progress checkpoints, retaining full actor starts
  in recording metadata and final reports. The final checkpoint was 28,067
  bytes, compared with the preceding 449,548-byte compact snapshot. A checkpoint
  cannot certify matching initial conditions or native acceptance.

An offline forecast microbenchmark on a retained 42-track / 114-mode frame
measured medians of 13.26 ms before and 7.63 ms with direct numeric freezing,
with equal serialized payloads. This is isolated software timing, not a native
end-to-end speedup. Ray batching/in-place experiments showed little benefit and
were not adopted.

These changes **did not close the freshness gate**. Attempt 12 sensor metadata
shows the last depth callbacks arriving about 80–120 ms after the first radar
callback. Its scene build and behavior proof still exceeded the remaining
lease. In the final attempt, representative scene-to-publication ages were
136.6–146.5 ms, behavior took 73.2–77.6 ms, road context 16.9–24.0 ms, and
additional safety/transport work pushed commands beyond 250 ms. Maximum reported
sensor wall age was 0.6482 s. Neither VRAM usage alone nor a single algorithm
has been established as the sole cause.

## Native shutdown evidence

Attempts 09 and 13 exited with **3221225725 / `0xC00000FD`** after saving their
measurements and before confirming worker cleanup. Their exit codes are
preserved in the original parent console logs. This Windows status indicates a
stack overflow; its exact native call site remains unproven. Worker cleanup and
export closure are therefore **unconfirmed** for those two attempts.

All six parent processes independently verified an asynchronous world with no
remaining project actors and confirmed CARLA process exit. This does not turn
an unconfirmed worker close into a successful recording finalization. The final
attempt completed worker cleanup and exports normally, with validation exit
code 1 because driving failed.

The runner now always retains the child exit code even if `report.json` already
exists, writes the last entered cleanup stage, and enables fault-handler output.
A regression verifies that a worker which saves a report then crashes cannot
be accepted. This improves diagnosis; it does not claim the intermittent native
stack overflow is repaired.

## Remaining authorization and acceptance

| Separate allowance | Seconds |
| --- | ---: |
| Originally authorized | 14,400 |
| Development charged, including cleanup | 2,688.266 |
| Development remaining | 4,511.734 |
| Acceptance remaining / spent | 7,200 / 0 |

There are no unfinished reservations or retained simulator ownership, and no
CARLA engine remains running. The historical research ledger still has SHA-256
`ca6ac6acde5266168ac4af7da8bfd755303cdd9ff147b707050073a4f3bd7c3c`.

Read-only preflight refuses the protected acceptance window because the complete
current-source development matrix has not passed. It also refuses the standard
7,200 s development matrix reservation because it exceeds the remaining
development balance. Remaining development time can fund bounded diagnosis;
the acceptance allocation cannot be spent on development.

The unresolved work is to reduce actual sensor-to-actuator latency, investigate
the intermittent native shutdown overflow and the prior Normal coverage holds,
then complete six current-source development pairs. Only a passing development
matrix permits the reserved one-shot acceptance matrix. No full-route, three
overtake, zero-contact arrival, event-diversity or three-video acceptance claim
is supported by these failed attempts.

## Software verification

`npm test`: **207 passed**. Python discovery: **957 tests, 953 passed and four
optional tests skipped**. Coverage includes the disk reserve and saved prefix,
preserved cleanup roots and immutable manifests, finite immutable forecast
equivalence, map-cache invalidation, stopping-distance query growth, incomplete
checkpoint behavior and a crash after a saved report. No frontend module or
theme changed in this follow-up, so no dashboard regeneration was necessary.
