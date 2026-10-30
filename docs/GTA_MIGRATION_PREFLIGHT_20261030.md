# GTA migration — dependency checkpoint, 30 October 2026

**BLOCKED_UNVERIFIED. The requested migration, training and cleanup are not
complete. CARLA and the old raw data remain intact.**

## Authorized outcome and retained scope

The owner approved replacing the simulator with the existing GTA V Enhanced
installation while retaining the collision-avoidance project and its interface.
The plan includes automated setup, sensor/control qualification, GTA scenarios,
MaskablePPO training/evaluation and subsequent CARLA/raw-data retirement.

Limits are 10,800 aggregate GTA/training runtime seconds and 100,000,000
dependency payload bytes. No game/update/large-weight download is authorized.
Keep code, existing user changes, weights, numeric results, reports, videos and
old budget records. CARLA/raw-data retirement is conditional on a genuine native
GTA capability gate; dependency inspection alone cannot authorize it.

The installed executable at `D:\games\Grand Theft Auto V Enhanced` reports
`1.0.1013.20`. The project remains on `main` in the original checkout.

## Executed boundary

The new [compatibility entry point](../integrations/gta/preflight.py) reads the
real executable version and hashes protected inputs before and after requests.
It restricts candidates and redirects to approved original HTTPS distribution
hosts, persists download reservations before reads, and checks the archive
version declaration, required DLL paths, PE signatures and unsafe entries. It
does not extract or execute downloaded files or start a native process.

The exact candidate `ScriptHookV_3725.0_1013.20.zip` returned HTTP **406** from
`www.dev-c.com` and `www.dev-c.enbdev.com`. Both 226-byte error bodies and their
SHA-256 values were retained. Original HTTP failures are not accepted as ZIPs.
Protected-input comparison passed on the real preflight.

Browser observations were also made against the developer's site. The matching
archive URL redirected to the home page without a completed download. The
current product page advertised `v3889.0 / 1158.13`; its download did not complete,
including a retry after dismissing an advertising overlay. The browser attempts
retain conservative payload reservations, not invented exact byte counts.
Compatibility of the current published build with the installed game remains
**unverified**, not disproven. There is no basis for a universal GTA rejection.

Eight independent fixture controls pass: old-build refusal, changelog-only
version refusal, candidate/native-acceptance separation, error-page refusal,
unsafe ZIP-entry refusal, original-HTTPS restrictions, interruption-safe budget
exhaustion, and rejection of duplicate accounting refunds. The initial failed
ZIP fixture and its subsequent correction are preserved in the receipts. On
Windows, ZIP metadata normalizes backslashes; the corrected fixture serializes
the hostile spelling verbatim, and the validator checks the original entry name.

These controls are **software/fixture evidence**, not simulation or training.
No C++ bridge, ReShade capture, sensor calibration, GTA provider, scenario engine,
optimizer update, fresh checkpoint or cleanup has been produced. GTA/training
runtime consumed by this work is **zero seconds**. No performance, visual-quality,
sensor-fidelity or safety improvement is claimed.

## Proof ownership and pending work

The repository-root collector refused initialization because its previous active
task still belongs to another session and does not currently verify. It was not
blocked, resumed, deactivated or overwritten. This initial component therefore
uses a separate proof project under `integrations/gta`, within the same branch
and checkout. It covers only this component, not the root application.

The existing skill was reused unchanged. The task was sealed before its actual
implementation; raw attempts, source fingerprints and failed gates are retained.
This host is Codex desktop; its actual host session ID was used for local task
metadata. No Copilot SDK session, model observation, callback or desktop Stop
enforcement is claimed, and no other inference client or worker was invoked.

| Stage | Dependency | Required result | Current state |
| --- | --- | --- | --- |
| Official dependency | none | Original candidate available for the installed build | BLOCKED |
| Native qualification | dependency | Actual sensors, control, motion, timing, occlusion and contact negatives | NOT EXECUTED |
| Provider/scenarios | native qualification | Existing UI and SI contracts; one control owner; separate GTA protocol/splits | NOT IMPLEMENTED |
| Training/evaluation | provider/scenarios | Equal-budget warm/scratch pilots, real updates, frozen separate evaluation | NOT EXECUTED |
| CARLA/data retirement | native qualification | Checked allowlist and preserved-file hashes; retain weights/numbers/reports/video | NOT EXECUTED |
| Final integration | all preceding stages | Real product journey, relevant suites/build, inspected media and passing current-source gate | NOT ACCEPTED |

The behavioral goals remain 600–800 m routes, 60 vehicles, 100 pedestrians,
three measured passes/returns and the existing physical/safety/timing criteria.
Old CARLA results do not certify GTA. The 3-hour limit is not a promise that
training or full acceptance can finish. Existing CARLA ledgers are separate.

## Resume condition

Obtain an original, verifiably sourced Script Hook V candidate usable with the
installed build, within the remaining payload allowance. If a newer candidate
is used, document that change of approach and prove actual compatibility; do
not silently change the sealed exact-candidate contract into a passing result.
Then resume the native capability gate before any training or cleanup. Never
update/redownload the game, reset budgets, substitute privileged actor truth for
policy sensors, or treat an archive header as native acceptance to get past this
checkpoint.

Fresh verification is required after any relevant source change. The local
parent plan and proof artifacts are intentionally ignored by Git; this report
preserves the blocker and all outstanding outcomes in the delivery history.
