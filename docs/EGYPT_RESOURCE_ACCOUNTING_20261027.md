# Egypt resource accounting correction - 27 October 2026

**BLOCKED / NOT ACCEPTED. The overall objective remains open.** No native
execution, real budget modification, evidence deletion or recording compression
occurred. Driving fingerprint remains
`4486828db532a310fccffa90ec9d480246425c40fa4460a630c696abd8a5eea3`.
Base checkpoint is `0fed9410802b230263d8003af938ed8fb9a0af83`.

Success still requires valid resources and all ordered native gates on frozen
source. This checkpoint validates two resource questions before further work:
whether existing compression could close storage, and whether summing all
diagnostic reservations overstates the additional budget necessarily required.

## Corrected budget interpretation

The **795 additional diagnostic-only seconds** previously requested are
**conservative fully charged reservation headroom, not a proven unavoidable
budget deficit**. Statements treating that request as an absolute prerequisite
were too strong. No extension is authorized or applied.

The existing ledger has **645.013 diagnostic seconds** available after
protecting DEVELOPMENT 7200 s and browser 480 s; ACCEPTANCE 7200 s is untouched.
Each diagnostic needs at least a **480-second reservation** (180 execution +
300 cleanup). One such reservation fits now. In a normal context finalization,
`EgyptBudget.experiment` replaces the initial reserved charge with **actual
elapsed wall time**. Interrupted process termination retains its crash charge;
failed cleanup retains exclusive ownership and prevents further native work.
None of these mechanisms is changed.

Three reservations do not necessarily cost 1440 actual seconds. To admit the
third 480-second reservation from today's allowance, the **first two actual
charges combined must not exceed 165.013 seconds**. Whether real preparation,
driving, export and cleanup can satisfy that condition is unmeasured. Historical
RTF and the current small freezing improvement do not establish it.
If actual charges exceed that limit, further work must stop for authorization;
protected windows cannot fund diagnosis.

Two new tests in existing `tests\test_egypt_validation.py` prove the distinction
using **temporary fixture ledgers and synthetic clocks only**:

| Fixture | Result |
| --- | --- |
| Initial diagnostic balance 645.013 s, three 480-second reservations, actual charges 80 + 80 + 200 s | All reservations admitted; only 360 s charged, caps/extensions unchanged, matrix/browser/acceptance protected |
| Same initial balance, first two actual charges 82.507 + 82.507 s | 479.999 s left; third 480-second reservation rejected, no protected borrowing or ledger mutation on refusal |

A fresh **read-only** protected2707/ROBOSPHERE preflight with
`--seconds-per-pair 180` reports `can_run=true`, current-source software passed,
480-second reservation, `engine_started=false`, authorization unchanged.
**This is budget/software-only readiness, not permission to bypass storage.**
The diagnostic runner does not independently evaluate the complete storage plan
in that branch; the user's stronger resource prerequisite remains mandatory.
No `--run` was used.

The former 795-second request remains a possible conservative resource request
if needed, not permission to extend the ledger and not a guarantee of success.

## Compression cannot close storage

Read-only measurement traversed the existing `runs\normal_city` recording
trees: **511 recordings, 509 finalized**. Across finalized trees, all remaining
uncompressed `.npy`, `.bin` and `.jsonl` files total **4074105155 bytes**.

This deliberately **overestimates** supported recoverable capacity: it includes
recursive matches, potentially ineligible/retired files and proof manifests.
The existing compressor operates only on eligible closed run subdirectories,
and every compressed output still consumes bytes. RGB and MP4 are excluded
because they are already compressed media and not supported by this lossless
recording command. No foreign files, archive or environments were considered
disposable; none was changed.

Latest free-space snapshot: D **100370800640 bytes**, against the unchanged
provisional **140049743825-byte** requirement: **39678943185 bytes short**.
Even impossible compression of every candidate to zero bytes would leave
**35604838030 bytes short**. Existing compression therefore cannot solve this
gap. Actual achievable recovery is smaller; no mutation was undertaken for a
plan already proved insufficient.

These are capacity snapshots, not reservations or a fresh successful-route
estimate. Provision additional usable storage while preserving evidence, or
deliberately implement and verify a supported storage integration. C is not D;
the [split-volume investigation](EGYPT_STORAGE_CONTINUATION_20261027.md) still
applies. Full successful DEVELOPMENT must inform final acceptance sizing.

## Validation and evidence

Full Python discovery: **1051 tests, 1047 passed, 4 optional skips**, 35.373 s.
The two new tests exercise funding behavior; no runtime source changed.
Prior JavaScript/build/controlled-age replay remain bound to the same unchanged
driving source, not rerun here. Original budget/allowance/research-ledger hashes
are unchanged. No unfinished reservation or simulator ownership is reported.

[Tracked verification](evidence/egypt-urban-chaos-v1/resource-accounting-20261027.json)
binds current source, exact suite log/test hashes, read-only preflight,
unchanged ledgers, compressed-capacity measurement and its preserved local
511-recording inventory. Heavy inventories remain ignored.

```powershell
.\.venv-carla\Scripts\python.exe -m unittest tests.test_egypt_validation.IsolatedEgyptTests.test_sequential_diagnostics_reuse_unspent_headroom_without_an_extension tests.test_egypt_validation.IsolatedEgyptTests.test_third_diagnostic_cannot_borrow_protected_time_when_actual_charges_exceed_headroom
```

## Remaining gates

Storage still fails. Native timing, Normal downstream queue cause, complete
routes/three measured passes and returns remain unverified. No current-source
native diagnostic, DEVELOPMENT matrix, one-shot ACCEPTANCE, native browser or
final export/cleanup gate has passed. The [queue checkpoint](EGYPT_QUEUE_CONTINUATION_20261027.md)
retains its physical observations without claiming a runtime repair.

Budget feasibility is **conditional**, not automatically exhausted; storage is
the established immediate resource blocker. Do not launch merely because the
budget-only preflight is green, and do not assume further time is authorized.
The overall goal is **not complete**, and **Egypt Urban Chaos V1 is NOT ACCEPTED**.
