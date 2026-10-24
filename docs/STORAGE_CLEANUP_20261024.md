# Project storage recovery — 24 October 2026

The user authorized removing unused data inside this project and continuing the
current native validation. The simulator was stopped and its ownership lease was
released before maintenance. No external drive, recovery archive, current model
runtime or active recording was removed.

## Measured storage recovery

| Measurement | Before | After cleanup |
| --- | ---: | ---: |
| Project logical size, after Git duplicate pruning | 220.86 GiB | 63.41 GiB |
| Files | 725,743 | 246,130 |
| D: free space, including Git duplicate recovery | 11.46 GiB | 125.63 GiB |

Logical file size and free disk space are different measurements: older sensor
files had NTFS compression. The net disk-space increase was **114.17 GiB** at the
cleanup snapshot. Subsequent validation recordings consume some of that space.
Exact bytes, manifest hashes and the preserved recording list are in the
[compact evidence](evidence/storage-cleanup-20261024/summary.json). Full local
inventories and per-recording manifests remain under
`output/maintenance/cleanup-20261024/`.

The existing retention implementation retired raw RGB, depth and LiDAR from
**228 closed recordings**, totaling **147.03 GiB of logical raw sensor assets**.
It kept their videos, metadata, results and reports. It compressed 1,187 telemetry
files only after verifying the decompressed SHA-256. Archived recordings have a
`storage-retention.json` marker: **their original raw sensor replay is no longer
available**. Historical raw-asset hashes describe those former assets, not files
still available locally.

All **18 explicitly preserved recordings** retained the same byte and file
counts, including every current Egypt recording and the named historical
incident records. All thirteen preceding native report hashes remained equal to
the committed evidence index. A sampled archived telemetry stream matched its
historical decompressed hash. There were no retirement errors.

Two unused Qwen GGUF weights and their unused llama download archive were
removed, recovering 4,363,834,140 logical bytes. No current source/configuration
references or matching running processes were found. Current perception,
Trajectron, OCR and detector dependencies remain, including `.venv-learned` and
`.venv-rl`, which the active environment still references. The historical
consolidation recovery bundle remains outside this project.

`git prune-packed` removed 4,860 redundant loose objects already present in the
packfiles. Loose objects fell from 5,156 to 296. Branches, refs, reflogs, commits
and packed history were not rewritten.

Automatic approval review rejected deleting the remaining unused
`.runtime/llama` folder with **`blocked by policy`**, without a more specific
reason. That folder was retained; the blocked operation was not retried.

## Preventing another full disk

New recordings require **4 GiB free** before any run folder is created. The
buffered writer checks the same reserve every sixteen frames. If storage falls
below it, recording stops with an explicit error and retains the written prefix;
it does not silently discard current sensor evidence. This reserve is a minimum
guard, not a guarantee that a long validation corpus will fit.

`scripts/prune_recordings.py` now accepts a JSON `--preserve-file` and a
workspace-contained `--report`. It refuses an existing report path, checks for a
native engine and retained Egypt ownership, and continues to reject paths
outside the project or through junctions. Example, after stopping CARLA:

```powershell
.\.venv-carla\Scripts\python.exe -m scripts.prune_recordings `
  --preserve-file output/maintenance/cleanup-20261024/preserved-recordings.json `
  --report output/maintenance/next-cleanup-dry-run.json
```

The default remains a dry run. Applying retirement requires `--apply` and a new
report filename. Review the preserve list before future maintenance: newly
created recordings are not automatically added to an old list.

Native validation resumed after cleanup. Its failures and remaining gates are
documented separately in the [native follow-up](EGYPT_NATIVE_FOLLOWUP_20261024.md).
Storage recovery and offline checks do not constitute driving acceptance.
