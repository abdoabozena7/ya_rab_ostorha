# Egypt storage continuation — 27 October 2026

The later [verified relocation](EGYPT_RECORDING_RELOCATION_20261027.md) implements
an explicit location/trust contract and resolves provisional capacity while
preserving original paths. The unsupported-junction findings and snapshots
below remain historical; they were not overwritten or treated as a solution.

**Read-only investigation complete; multi-volume retention is NOT implemented
or verified. Native storage remains blocked.** No recording, archive, junction,
configuration, budget or engine was changed. This report and its
[JSON evidence](evidence/egypt-urban-chaos-v1/storage-continuation-20261027.json)
are the only task outputs. No native window was consumed.

## Exact capacity snapshot

At **19:07:06 UTC**, D had **100,070,772,736 free bytes** and C had
**72,559,644,672 free bytes**. They are distinct NTFS volumes, not a pooled disk.
The [earlier preflight](EGYPT_RESOURCE_PREFLIGHT_20261027.md) estimator requires
**140,049,743,825 free bytes (130.431 GiB)** on the current D recording volume.
The updated D deficit is **39,978,971,089 usable bytes**. These measurements
are snapshots, not reservations. C alone is also **67,490,099,153 bytes short**
of hosting that entire provisional workload.

This reuses the saved 34-recording estimate, not a fresh successful-matrix
measurement. Full-route duration, combined DEVELOPMENT/ACCEPTANCE retention
and transient costs remain unresolved. It is not final acceptance capacity.

## Why a closed-run junction is not an existing supported solution

The actual contract is narrower than Windows filesystem readability:

| Consumer | Existing contract and consequence |
| --- | --- |
| `storage_retention.contained` | Resolves a target inside the project, excludes the workspace root itself, and rejects links/junctions along its supplied path. A C target outside the workspace fails containment. |
| `recording_roots` / `closed_egypt_recordings` | Discovery under `runs\normal_city` explicitly skips link/junction children. Moved historical samples would disappear from DEVELOPMENT discovery. |
| `compress_pair_recordings` / `compress_recording` | Uses the project workspace as the allowed root. External or junction-backed runs are not an allowed lossless-compression target. |
| `storage_preflight` | Compares the **entire** estimate with `shutil.disk_usage(ROOT).free`, i.e. D. There is no per-volume allocation, margin or reserve accounting. Moving closed runs cannot make C count as D. |
| `video_http.serve_video` | Resolves each run and requires its parent to equal the resolved recording root. An individual D run junction targeting C fails browser video/status containment. |
| `validate_crossing_pair.verify_videos` | Requires each resolved run to be inside resolved `ROOT\runs\normal_city`; a per-run external junction fails final saved-video verification. |

`ReplayReader` resolves its explicit run root; `read_asset` checks run-local
containment and original length/hash. Thus a whole copied run could plausibly
remain directly replay-readable, but that is **not** an end-to-end retention
contract or a verified migration. Sensor references and lossless manifests are
run-relative; comparison records retain a `recording` path. Compression's
`lossless-compression.json` also records the root string. No relocation manifest,
lookup or automatic path rewrite exists. Do not edit historical reports to
silently point elsewhere: matrix records bind report bytes with SHA-256.

Replacing the entire recording parent with a junction does not solve this:
storage discovery/compression reject it and preflight still measures D.
Moving assets individually also violates run-local containment. Do not weaken
these checks just to admit a different disk.

## Arithmetic feasibility is not implementation feasibility

A hypothetical allocation of **six of ten retained closed runs on C**, keeping
the other four plus two raw trips, all videos and temporary annotation on D,
fits the saved aggregate estimate with a separate 50% margin and 4 GiB reserve
on **each** volume:

| Volume | Planned component bytes | Required bytes including margin/reserve | Snapshot headroom |
| --- | ---: | ---: | ---: |
| C | 36,268,644,208 | 58,697,933,608 | 13,861,711,064 |
| D | 54,234,540,145 | 85,646,777,514 | 14,423,995,222 |

Rounded conservatively from aggregate saved components; not six measured
individual run sizes. This **illustrates capacity only**, not an executable
plan. The current gate would still demand 140,049,743,825 bytes on D and fail.
No allocator, admission change or relocation facility was added.

## Peak lifecycle and preservation requirements

Current matrices finish/export/stop a pair, save its report, then compress
closed recordings before the next pair. Raw/annotated/shared videos and
`.encoding.mp4`, concat and annotation intermediates live in the run tree.
Compression retains each original until a decoded checksum proof is flushed
and fsynced; up to four gzip candidates coexist with originals. Its manifest
proves compression equality, **not cross-volume relocation**. The estimator
does not separately itemize compression-candidate overhead or migration copies.

Any future deliberate split must budget both source and destination bytes
during verified copying, reserve at least 4 GiB separately on each physical
volume, account for existing/failed attempts and retained DEVELOPMENT while
ACCEPTANCE runs, and verify export/compression/copy peaks before admitting work.
It must preserve original paths through a supported lookup or explicitly
validated path contract, not assume a junction satisfies all consumers.
Closure, drained exports, stopped CARLA/compatible reservation ownership,
complete file manifests, source/destination hashes, replay, browser video and
rollback must be verified before an authorized source removal. None was done.

The old C junction still resolves to
`D:\CodexArchives\native-evidence\ya_rab_ostorha`. **It is one protected D
archive, not duplicate capacity: never delete the archive or its old C link.**
The recovery archive described in the consolidated delivery guide is likewise
not authorized scratch space.

## Simplest safe next action

**Keep current recording paths and provision at least 39,978,971,089 additional
usable free bytes on D**, preserving all existing evidence. This avoids a new
abstraction or backend/path change. Obtain explicit storage-maintenance
authorization and any required disk/volume-administration permission first;
no such permission or capacity was exercised here. Remeasure and rerun the
unchanged read-only storage gate immediately before any separately authorized
execution; recalculate from the complete successful DEVELOPMENT matrix before
ACCEPTANCE. This storage action grants no budget extension or native retry.

A split remains a possible **future engineering task**, requiring separately
authorized backend/gate/consumer changes and offline verification, not just
filesystem write/junction privileges. A different single destination needs at
least the full provisional 140,049,743,825 free bytes plus copy/retention costs
and a verified path/gate integration; current C is not that destination.
