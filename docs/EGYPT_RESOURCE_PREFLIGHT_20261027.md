# Egypt resource preflight — 27 October 2026

**Read-only investigation complete; native prerequisites remain blocked.**
[Verified measurements and artifact fingerprints](evidence/egypt-urban-chaos-v1/resource-preflight-20261027.json)
were collected with CARLA stopped. This is not native acceptance or a software
certificate. No engine lifecycle, storage maintenance, dependency installation,
budget reservation/extension/reset or storage-path change was performed.

## Storage: provisional requirement still fails

At **18:45:40 UTC**, D had **100,071,837,696 free bytes (93.199 GiB)**;
C had **72,010,211,328 free bytes (67.065 GiB)**. Free space changed during
collection: these are snapshots, not reserved capacity. C is **not** pooled
with D.

The existing `recording_size_estimate(closed_egypt_recordings())` recomputation
used 34 closed, non-retired DEVELOPMENT recordings, with a longest measured
duration of **183.450002733 simulation seconds**:

| Component | Bytes |
| --- | ---: |
| Two simultaneous raw trips | 21,677,515,477 |
| Ten retained closed recordings | 60,447,740,346 |
| Twelve trips' generated videos | 5,155,483,073 |
| Temporary export/annotation | 3,222,445,455 |
| Estimator total before margin/reserve | 90,503,184,353 |
| Required free space, 50% margin + 4 GiB reserve | **140,049,743,825** |

Component truncation follows the existing estimator. At this snapshot the exact
deficit is **39,977,906,129 usable bytes (37.232 GiB)** on D. An independently
configured and verified destination would instead need at least
**140,049,743,825 usable free bytes (130.431 GiB; round up to 131 GiB)**,
excluding evidence-copy costs. Neither solution was implemented.

This estimate assumes verified compression between pairs; this preflight did
not compress anything. **No complete successful DEVELOPMENT matrix exists, so
acceptance capacity is not finalized.** Full-route durations, finished-matrix
rates, transient overlap and combined DEVELOPMENT/ACCEPTANCE retention could
increase the requirement. Recalculate from the complete successful DEVELOPMENT
matrix before acceptance.

Actual recording, MP4 and temporary export paths are under
`runs\normal_city` on D. Both recent diagnostic recordings are finalized; four
actual MP4 hashes match their saved raw/annotated variant hashes. This verifies
saved bytes, not a fresh playback/acceptance check.

The legacy `%USERPROFILE%\.codex\native-evidence\ya_rab_ostorha` is a verified
junction to **`D:\CodexArchives\native-evidence\ya_rab_ostorha`**.
It is **one archive, not a duplicate: never delete it**.

## Protected budgets and diagnostic feasibility

Actual Egypt ledger, allowance and historical hybrid ledger hashes were
identical before/after inspection; SQLite reads used `mode=ro&immutable=1`.
No unfinished reservation or simulator ownership lock was found.

- Egypt DEVELOPMENT remaining: **8,325.013 s**.
- Protected matrix/browser: **7,200 s + 480 s**.
- Spendable diagnostics: **645.013 s**.
- Unused protected ACCEPTANCE: **7,200 s**.
- Historical hybrid remaining: **138.161293 s**, unavailable to Egypt.

The runner requires at least **180 s + 300 s cleanup = 480 s per diagnostic
target**. One minimum reservation fits the budget alone; the default
**1,200 s** does not (**554.987 s short**). Three fully charged minimum
reservations require **1,440 s**, a conditional no-refund shortfall of
**794.987 s**. This is arithmetic, **not an authorization request or extension**.

Unused headroom returns only on verified finalization. With 480-second
reservations, the first two targets' combined actual charges must be at most
**165.013 s** to admit the third without protected-time borrowing; that outcome
is unmeasured and cannot be guaranteed. Preparation, driving, export,
compression if performed and cleanup consume wall time, not simulation time.

Independently, snapshot source `c2ec0594…0137` already failed
`2707/ROBOSPHERE`. More resources do not permit retrying that source:
a meaningful evidenced driving fix and a fresh source-bound software/replay
gate must precede any new authorized native attempt.

## Environment and remaining uncertainty

No CARLA/Unreal or ffmpeg process, native worker, or port 2000/2001 listener was
observed. Existing backend ownership of ports 8000/8001 was preserved.
The inventory verified Python/dependency versions across seven existing
environments, CARLA 0.9.16 install-marker/launcher bytes, ffmpeg 7.1 and
18 model/config fingerprints, including Trajectron lock matches.
These are installed-artifact checks, not new inference, engine boot or
dependency compatibility results.

Observed hardware: Ryzen 7 6800H (8 cores/16 threads), 16,371,494,912 bytes RAM,
RTX 3060 Laptop GPU with 6,144 MiB VRAM. RAM/VRAM availability is advisory;
no defensible minimum hardware upgrade or full-route wall-time requirement
can yet be specified. Gate B and the native DEVELOPMENT/ACCEPTANCE/browser
gates remain unpassed.
