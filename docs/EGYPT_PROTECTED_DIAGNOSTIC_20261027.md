# Egypt current-source protected diagnostic - 27 October 2026

**Protected seed 2707 / ROBOSPHERE diagnostic PASSED. Egypt V1 remains NOT
ACCEPTED. Normal 1703 is now blocked by insufficient diagnostic funds.**
The [retained checkpoint](evidence/egypt-urban-chaos-v1/protected-diagnostic-20261027.json)
binds local artifacts, timing populations, cleanup, storage and ledger hashes.
This checkpoint follows the [165-recording preservation delivery](EGYPT_RECORDING_RELOCATION_20261027.md)
at commit `03f3695ff5bc520da68e0d6059d5a677a67ae8dc`.

## What actually ran

The first ordered current-source native diagnostic ran once on fingerprint
`a7ece445d9eab71d4328f08bb1b25e245499eb39539461b573646271b3777933`.
The source was unchanged through execution. All ten diagnostic gates passed,
including independent cleanup, engine exit, closed exports and saved-video hash
verification plus first/last-frame decode after engine exit.

| Measurement | Result |
| --- | --- |
| Simulation duration / distance | 30.000 s / 64.756 m |
| Route completion / completed overtakes | 8.844% / 0 |
| Contacts / control timeout | 0 / none |
| Driving receipt-to-application-check samples | 601, frames 179-779 |
| Driving p95 / p99 / maximum | 184.525 / 212.411 / 229.657 ms |
| Driving frames over 250 ms / unmeasured / unaligned | 0 / 0 / 0 |
| Actual population | 60 vehicles / 100 pedestrians |
| Sustained density / motion audit | 31 density samples / 30 motion samples, no failures |
| Recorded simulation/wall ratio | 0.245018 |
| Final status | INTERRUPTED, diagnostic_goal_reached |

This is the prescribed protected prefix, **not a completed route, overtake,
Normal result, complete DEVELOPMENT matrix or ACCEPTANCE result**. One result
does not prove repeatability or establish that the isolated freezing optimization
caused a native improvement; host scheduling, load and storage also changed.
No safety threshold, timing threshold or holdout policy was relaxed.

### Complete timing population, including non-driving submissions

The native gate's 601 driving records were independently reproduced exactly
from compressed `telemetry\comparison-controls.jsonl` using host-monotonic
`application_checked - first_required_sensor_received`. The command's recorded
simulation timestamp lies within the run's first/last driving timestamps.
This is not the earlier `sensor_to_submit_ms` endpoint or the scenario-hook
sample population.

All **633** submitted pipeline records remain accounted for: 31 held-prefix
frames 148-178, 601 driving frames 179-779, and one post-stop frame 780.
The all-submission p95/p99/maximum are **185.095 / 217.335 / 567.409 ms**.
Held-prefix frames **148 and 178 exceed 250 ms**; neither is hidden or counted
as a driving pass. Sensor-age telemetry separately reports 632 samples,
99.501% coverage and maximum wall age 0.567691 s; it is not the 601-record
driving application-check distribution.

## Preservation and current resources

The native reservation was 600 s (300 execution plus 300 cleanup); its actual
final charge was **218.078 s**. A separate 240 s maintenance reservation charged
**83.938 s** for lossless compression and consumer checks. Compression saved
795,852,928 logical bytes. These are finalized charges, not the reservations'
maximum possible cost.

The closed diagnostic was then preserved on C using the existing verified
relocation tool: **1,101,533,553 bytes / 5,324 files**, with the original D path
retained and replay/media consumers checked before duplicate release. This is
the 166th active preserved recording, separate from the restored pilot.
Offline relocation took **35.797 s**, separately recorded; it started no native
run, used no native reservation and changed no native ledger. Its report binds
the exact manifest and consumer checks. It is not disguised as part of the
charged compression or native time.

Fresh full-plan storage admission passes: **142,193,082,368 bytes free** against
the unchanged **140,049,743,825-byte** provisional requirement. This remains a
snapshot; final sizing must use a complete successful DEVELOPMENT matrix.
The simulator is stopped, ownership is clear and no native process remains.

## Actual remaining blocker

The ledger now has **342.997 s** diagnostic spendable, **7,200 s** protected
DEVELOPMENT matrix, **480 s** protected browser and **7,200 s** unused ACCEPTANCE.
Total DEVELOPMENT remaining is 8,022.997 s. No allowance was reset or increased,
no protected time was borrowed, and no acceptance attempt was made.

Fresh read-only Normal 1703 preflights refuse both candidate reservations
without starting the engine:

| Reservation | Exact additional admission headroom | Whole-second lower bound |
| --- | ---: | ---: |
| Minimum 480 s: 180 execution + 300 cleanup | 137.003 s | 138 s |
| 600 s: 300 execution + 300 cleanup | 257.003 s | 258 s |
| Conservative two remaining 600 s windows | 857.003 s | 858 s |

The first row is a demonstrated next-admission deficit, not sufficient funding
for all remaining gates. The last row only funds two reservations if fully
charged; it is **not a proven minimum total extension or a guarantee of success**.
Actual finalized charges determine subsequent headroom. The original
no-increase restriction remains binding: generic continuation does not authorize
an extension. No extension is applied by this report.

Remaining order: Normal 1703, Normal 3709, complete DEVELOPMENT (three seeds,
both first-driver orders), source/configuration freeze, one-shot ACCEPTANCE
(961103/961109/961121, both orders), then the protected native browser/export/
cleanup gate. Historical Normal stalls remain unresolved. Do not retry the
passed protected target, spend protected windows on diagnostics, or tune on
holdout to work around the funding block.
