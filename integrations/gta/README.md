# GTA migration compatibility gate

This component owns only the initial dependency/compatibility investigation for
the user-requested GTA Enhanced migration. It is not a production provider,
sensor qualification, training result or authorization to remove CARLA.

The repository-root Prove It task belongs to another session. This component's
proof project is isolated here in the existing main checkout; it never activates,
blocks, resumes or overwrites the root task. Later provider, scenario, training,
evaluation and cleanup work depends on genuine native capability evidence.

The approved limits are 100,000,000 downloaded payload bytes and 10,800 aggregate
GTA/training runtime seconds, with no game/update/large-weight download. Existing
CARLA budgets are separate. CARLA and its raw data must remain until the native
GTA capability gate passes. Retain code, weights, numeric results, reports and
videos during any subsequently admitted cleanup.

## Current result: BLOCKED_UNVERIFIED

The real local executable reports `1.0.1013.20`. Original-host requests for the
matching `ScriptHookV_3725.0_1013.20.zip` returned HTTP 406 from both tested
original distribution hosts. The browser fallback redirected the matching URL
to the developer's home page without a download. The published current download
also did not yield a completed file in the browser, including a retry after
dismissing its advertising overlay. This is an access/candidate-availability
blocker, **not proof that GTA or every newer Script Hook V build is incompatible**.

No provider/native bridge has been implemented or installed. No game, native
simulation, training or deletion was started. Eight local negative-control tests
pass; those fixtures do not establish native compatibility, sensor correctness,
driving behavior, performance or training quality. The full evidence gate must
remain failed while the official dependency check fails.

Run from this directory with the existing project interpreter:

```powershell
..\..\.venv-carla\Scripts\python.exe -B -m unittest test_preflight -v
# Real network access; this only reads the game and retrieves a candidate:
..\..\.venv-carla\Scripts\python.exe -B preflight.py --output downloads\inspection-unique-name
```

Use a fresh output directory for each attempt. The persistent
`downloads/payload-ledger.json` accounts for all attempts, including conservative
reservations where a browser attempt's payload could not be measured. Never
reset its charges or remove an interrupted owner's lock automatically. Archives
are inspected in memory and never extracted, installed or executed by this CLI.
Even a successful dependency result leaves `native_capability_accepted=false`.

The local proof contract and receipts live in
`.runtime-proof/gta-compatibility-20261030`. The complete migration's pending
dependency graph remains in the repository's ignored
`.runtime-proof/gta-migration-20261030/PARENT_PLAN.md`. See the committed
[checkpoint report](../../docs/GTA_MIGRATION_PREFLIGHT_20261030.md) for the parent
scope, blockers and resumption requirements. Do not use this component's isolated
proof scope to certify changes to the root application.
