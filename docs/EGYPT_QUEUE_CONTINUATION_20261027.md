# Egypt Normal queue checkpoint - 27 October 2026

See the later [resource-accounting correction](EGYPT_RESOURCE_ACCOUNTING_20261027.md):
the requested 795 seconds is conservative headroom, not an unavoidable deficit.
Unused reservation headroom can return through actual elapsed charging;
storage remains independently failed. Measurements below retain their scope.

## Status and success condition

**PARTIALLY COMPLETED / BLOCKED / NOT ACCEPTED.** The overall objective remains
open. Success still requires valid resources, ordered current-source native
diagnostics, complete DEVELOPMENT, frozen one-shot ACCEPTANCE and final native
browser/export/cleanup checks. This checkpoint does not replace any of them.

Driving fingerprint is unchanged:
`4486828db532a310fccffa90ec9d480246425c40fa4460a630c696abd8a5eea3`.
Base commit: `fbf0d13b774285e64cc682b08d23fe816c2540b2`.
No runtime driving, scenario, threshold, budget, ownership or storage changes.
No native launch or holdout use occurred.

## What this closes, and what it does not

The earlier single-frame audit established a real foreground vehicle and unknown
body corridor, but could not distinguish a still-active scripted hold from a
later physical traffic queue. The new read-only audit joins retained native
scenario samples, initial role bindings and original actor observations over
the final 30 simulation seconds of each historical Normal recording.

It verifies original report/metadata/recorded-stream hashes, increasing frame
and timestamp order, DEVELOPMENT provenance and exact final native-sample/frame
alignment. A missing actor breaks continuous stationary evidence; missing event
completion transitions are not inferred. Native truth is **scoring-only** and
never enters the ego policy.

Validation loop: reproduce the complete input-bound queue audit, run focused
false-attribution/alignment regressions and full Python discovery, verify source
and ledger hashes, then run read-only matrix preflights. A behavior change would
require an established cause and appropriate independent replay/native checks;
these observations do not justify one.

## Measured outcomes

Both historical reports bind driving source
`095f1480862a7ac7eb1d49fcc6c0b61e935efdc6e566b0f8e94b597bd25a85ca`,
not the current fingerprint. These are retained failed DEVELOPMENT prefixes.
The [tracked evidence](evidence/egypt-urban-chaos-v1/queue-continuation-20261027.json)
contains exact per-run identities, original hashes, event transitions, final
queues and the full stop-reason sample counts.

| Final 30-second window | Seed 1703 | Seed 3709 |
| --- | ---: | ---: |
| Original recording | `run_f49cc7dbdb2e4071bf434a5eca4b93a2` | `run_cc6bc8106a144d2ab16d01d7768d26ba` |
| Final frame | 3974 | 3684 |
| Lead observed / nearest-front frames | 600 / 600 | 600 / 600 |
| Missing lead observations | 0 | 0 |
| Ego displacement | 9.888666 m | 4.860734 m |
| Lead maximum displacement from first observation | 9.870822 m | 4.877684 m |
| Lead maximum horizontal speed | 4.144656 m/s | 4.069723 m/s |
| Final joint stationary interval, both <=0.1 m/s | 14.650000 s / 294 frames | 25.200000 s / 505 frames |
| Final lead center distance along ego heading | 9.068065 m | 9.068758 m |
| Final lead initial role | `participant_100` | `queue_lead` |
| Recorded queue-lead event completion time | 17.772161 s | 17.933837 s |
| Recorded first parking-event completion time | 62.122162 s | 56.333838 s |
| Final observed vehicle count / requested | 52 / 60 | 52 / 60 |

Both stop/resume events completed **before** the audited window, including
measured resumption above one meter. They are not still executing their original
hold. Both ego and physical lead moved during the window, then stopped jointly.
Normal did not remain immobile throughout this window or ignore all lead
resumption. Center distances are not bumper clearances or free-space proofs.

This rules out a permanently unreleased original scripted hold as an explanation
for these final observations. It **does not establish the downstream cause**:
actor rows do not contain NPC control commands or current traffic-light phases.
Event completion does not prove subsequent continuous flow. Local absence does
not prove destruction. Density fell below the required 60; neither this audit
nor the historical recordings establish compliant full-route density/motion.

No evidence supports clearing unknown cells, reducing body clearance, forcing
Normal forward, manufacturing a collision or changing event timing to make a
desired outcome. The established foreground queue and required collision
avoidance remain valid constraints.

## Implementation and verification

New `scripts\audit_egypt_queue.py` reads only explicitly supplied DEVELOPMENT
reports and their original recordings. Four regressions in
`tests\test_audit_egypt_queue.py` cover unrelated actor/event attribution,
missing observations/transitions, absent corridors/invalid windows and rejected
frame/time mismatches.

Full Python discovery: **1049 tests, 1045 passed, 4 optional skips**, 37.298 s.
Audit execution and all original-stream hashes passed. Driving source and the
Egypt/historical research ledgers remain byte-identical.
Prior **210 JavaScript tests, dashboard build and 30/30 complete-payload
controlled-age replay** remain bound to the same unchanged driving source in
the [freezing checkpoint](EGYPT_FREEZE_CONTINUATION_20261027.md); they were not
rerun or relabeled as fresh here. No new native/software certificate was needed
for this offline-only script/test addition.

```powershell
.\.venv-carla\Scripts\python.exe -m scripts.audit_egypt_queue output\egypt-urban-pairs\b3a5746a2ccf4ac08de730d58e764795\report.json output\egypt-urban-pairs\f98d0a90e6f44a63b37f1646984fe1c3\report.json --report output\egypt-validation\queue-continuation-20261027\normal-queues.json
.\.venv-carla\Scripts\python.exe -m unittest tests.test_audit_egypt_queue
.\.venv-carla\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
```

Raw reports and recordings stay local and ignored; an ordinary clone cannot
reproduce native observations without them. Use a fresh output name for future
audit trials to preserve this checkpoint.

## Remaining blockers and next admissible action

The latest evidence snapshot has D free **100371247104 bytes**, versus the
unchanged provisional **140049743825-byte** requirement: **39678496721 bytes
short**. Provision usable storage without deleting evidence or implement and
verify an explicitly scoped storage integration; C is not automatically D.
Full successful-route and combined matrix/export peaks still need measurement.

Diagnostic allowance is unchanged at **645.013 seconds**. The conservative
three-target minimum-reservation plan requires 1440 seconds; the request for
**795 additional diagnostic-only seconds remains unapproved**. The original
explicit prohibition on budget increases cannot be replaced by an assumption
of consent. Protected DEVELOPMENT 7200 s, browser 480 s and ACCEPTANCE 7200 s
remain untouched. This request is minimum planning arithmetic, not a guarantee
that execution will fit or succeed.

Read-only DEVELOPMENT and ACCEPTANCE preflights still refuse execution:
respectively, all current-source diagnostics and full current-source DEVELOPMENT
are missing. Protected2707, Normal1703/3709, both complete matrices and native
browser/final cleanup remain **NOT EXECUTED** on current source. No source-policy
repair is claimed by this audit.

The checkpoint commit and ordinary push remain on the sole `main` checkout.
Publication identity and clean-tree/tip equality are recorded after committing.
**The goal is not complete, and Egypt Urban Chaos V1 is NOT ACCEPTED.**
