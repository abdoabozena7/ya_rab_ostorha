# Egypt diagnostic storage admission - 27 October 2026

**BLOCKED / NOT ACCEPTED. The overall goal remains incomplete.** This checkpoint
closes a resource-admission gap; it does not provision storage, repair driving
or pass a native gate. No native run, budget extension, relocation, compression
or evidence deletion occurred.

## Change

`scripts\native\validate_egypt_urban.py` previously checked measured storage only
for full matrices. A diagnostic could therefore report `can_run=true` when its
software, budget and ordering checks passed despite failing the user's full
resource prerequisite. The earlier [accounting report](EGYPT_RESOURCE_ACCOUNTING_20261027.md)
correctly identified that result as **budget/software-only** readiness.

The same existing storage preflight now applies to diagnostics whenever the
preceding checks permit admission. Its unchanged **12-trip provisional plan,
50% margin and 4 GiB reserve** remain required. No smaller diagnostic-only
estimate, pooled C/D accounting, new allowance or waived gate was introduced.
Insufficient storage or unavailable estimation refuses admission before
`EgyptBudget.experiment`, native handoff and attempt claiming.

The new regression covers insufficient free space, a storage I/O failure and
missing usable DEVELOPMENT samples. Every case verifies no engine start,
budget mutation, ownership, native handoff, pair execution or diagnostic-attempt
record. Existing funded diagnostic and matrix-ordering tests still pass.

## Current-source evidence

The source fingerprint is now
`a0c2eb77002ee711f8ba4aedf13414e244ac52ae52db03337e34969f242a5ed0`.
The only manifest change from `4486828d...` is the native admission script;
no backend driving, sensor, scenario or timing policy changed.
**A gate-only fingerprint change is not an evidenced driving repair and does
not authorize a retry of failed unchanged driving.**

Fresh offline checks: **210 JavaScript passes; 1052 Python tests, 1048 passes
and 4 optional skips; dashboard build and bundle syntax passed**. Both retained
DEVELOPMENT windows again match all **30 complete decision payloads and hashes**
against the original source at identical synthetic 100/150 ms ages, including
preceding input history. This does not reproduce native asynchronous delivery
or prove timing improvement.

A new source-bound **offline software** certificate preserves the previous
certificate locally. Historical evidence files are unchanged.
[Tracked verification](evidence/egypt-urban-chaos-v1/diagnostic-storage-20261027.json)
binds the manifest delta, fresh logs, replay comparisons, certificate and
read-only diagnostic report.

## Real read-only admission result

With the existing Egypt allowance, protected2707/ROBOSPHERE, a 180-second
execution limit and 300-second cleanup reservation:

| Check | Result |
| --- | --- |
| Current-source software | Passed |
| Budget-only 480-second reservation | Fits existing 645.013 diagnostic seconds |
| Measured full-plan storage | Failed: 140049743825 required, 100653821952 free bytes |
| Overall `can_run` | **False: insufficient disk** |
| Engine started / authorization changed | **False / false** |

This recalculates the provisional estimator using the existing closed
DEVELOPMENT samples, not a successful full-route matrix. At collection, D was
**39395921873 usable bytes short**. Free space varies and is not reserved.
All Egypt, allowance and historical hybrid ledger hashes remained unchanged;
no simulator ownership was present.

Reproduce without `--run`:

```powershell
.\.venv-carla\Scripts\python.exe -m scripts.native.validate_egypt_urban --egypt-budget output\egypt-validation --diagnostic --development-seed 2707 --first ROBOSPHERE --seconds-per-pair 180 --hypothesis "Read-only resource admission inspection"
```

The [budget correction](EGYPT_RESOURCE_ACCOUNTING_20261027.md) still applies:
795 additional seconds are conservative headroom, not proven unavoidable.
Third-diagnostic admission depends on actual elapsed charges, not the sum of
three initial reservations. The existing compression upper bound still cannot
close the storage deficit.

**Next admissible native work still requires sufficient verified storage and
the other original prerequisites.** Ordered diagnostics, complete DEVELOPMENT,
one-shot ACCEPTANCE and final native browser/export/cleanup remain unpassed.
Do not treat this admission repair or software certificate as native success.
