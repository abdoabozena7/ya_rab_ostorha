# Egypt V1 delivery - 27 October 2026

## A. Overall status

**PARTIALLY COMPLETED / BLOCKED / NOT ACCEPTED.**

Offline investigation, lifecycle-status clarification and the demonstration/
defense package are delivered. The required native acceptance is not achieved.
No new CARLA execution, diagnostic retry, holdout use, storage relocation,
evidence deletion or budget extension occurred.

Driving-source fingerprint:
`c2ec0594d7a0a80141820d0e2ffc0a448887e0f7f85a35da5a75e40a5fb90137`.
Driving/configuration source is unchanged from the reviewed commit
`cebed2c32541978f18ee89352c0a8e1a737f39e8`. The existing fingerprint excludes
frontend/documentation; fresh frontend hashes and current software results are
therefore recorded separately in
[delivery verification](evidence/egypt-urban-chaos-v1/delivery-verification-20261027.json).
Historical native results remain historical, not new final-interface acceptance.
The final console delivery records the actual published commit identity.

## B. Implementation checklist

- [ ] Resource plan valid for all required execution.
- [ ] Storage requirements satisfied.
- [x] Tail-latency costs identified from retained complete driving traces.
- [ ] Timing optimization implemented and verified.
- [ ] Normal route-stopping causes resolved.
- [ ] Protected full route and measured overtaking verified.
- [x] JavaScript suite: 210 passed.
- [x] Python suite: 1040 discovered, 1036 passed, 4 optional skips.
- [x] Dashboard build and bundle syntax passed.
- [ ] Full required replay assurance closed; bounded comparisons passed only.
- [ ] Protected diagnostic passed.
- [ ] Normal diagnostic 1703 passed.
- [ ] Normal diagnostic 3709 passed.
- [ ] DEVELOPMENT matrix passed.
- [ ] ACCEPTANCE matrix passed.
- [ ] Native browser verification passed.
- [ ] Final native cleanup and video-readability gate passed.
- [x] README current entry guide updated.
- [x] Architecture, comparison results and evidence index documented.
- [x] Reproducible demonstration guide and academic defense Q&A completed.

Git publication is checked separately after creating the delivery commit; it is
not an experimental acceptance gate. The fresh saved-media check below covers
one historical diagnostic video, not final matrix cleanup or browser operation.

## C. Validation results

All rows below use the driving fingerprint above unless explicitly historical.
Execution identifiers are local paths relative to the primary checkout.

| Gate | Status | Execution / measurements | Evidence / failure |
| --- | --- | --- | --- |
| JavaScript | PASSED, fresh offline | `delivery-20261027`: 210 passed, zero failed | `output\egypt-validation\delivery-20261027\javascript-tests.log`; hash in delivery verification |
| Python | PASSED, fresh offline | Same delivery: 1040 tests, 4 skips, 33.350 s | `output\egypt-validation\delivery-20261027\python-tests.log`; hash in delivery verification |
| Dashboard | PASSED, fresh offline | JavaScript/CSS generated; bundle syntax exit 0 | `output\egypt-validation\delivery-20261027\dashboard-build.log`; generated file hashes in delivery verification |
| Retained replay | BOUNDED CHECKS PASSED; full native deadline assurance OPEN | 21/21 compared track/mode hashes and recorded fields match; nine-frame latest replay has different native deadline behavior | [Offline diagnosis](EGYPT_OFFLINE_DIAGNOSIS_20261027.md); no unqualified equivalence or new admission certificate |
| Resources | FAILED provisional storage; final capacity BLOCKED | D free 100,071,837,696 bytes; provisional required 140,049,743,825 bytes | [Preflight](EGYPT_RESOURCE_PREFLIGHT_20261027.md), snapshot 18:45:40 UTC; deficit 39,977,906,129 bytes |
| Protected 2707 | FAILED retained diagnostic; NOT RERUN | Attempt 19: 63.946 m, 30 simulation s, zero contacts/overtakes; p95 215.750 / p99 234.514 ms, 2 late frames | `output\egypt-validation\native-20261027\diagnostic-2707-protected-19.json`; unchanged-source retry prohibited |
| Normal 1703 | NOT EXECUTED in required current sequence | Diagnostic target about 157.351 m; retained older stall about 156.351 m is not success | [Offline diagnosis](EGYPT_OFFLINE_DIAGNOSIS_20261027.md); protected prerequisite failed |
| Normal 3709 | NOT EXECUTED in required current sequence | Diagnostic target about 111.246 m; retained older stall about 110.246 m is not success | Same; protected prerequisite failed |
| DEVELOPMENT | BLOCKED, no passing final matrix | Required 6 comparisons / 12 runs; no diagnostic splicing | `output\egypt-validation\delivery-20261027\development-preflight.json`: all three diagnostics required |
| ACCEPTANCE | NOT EXECUTED, protected allowance unused | Required one-shot 6 comparisons / 12 runs | `output\egypt-validation\delivery-20261027\acceptance-preflight.json`: complete current-source DEVELOPMENT required |
| Native browser | NOT EXECUTED | Protected 480 s untouched | No final native-browser execution ID; software fixtures are not a substitute |
| Final cleanup / playback | NOT EXECUTED for final matrix | Existing attempt-19 annotated video freshly hash-checked and first/last-frame decoded with no current CARLA process/ownership | `output\egypt-validation\delivery-20261027\saved-media-check.json`; historical video only |

The compact tracked verification embeds preflight results and hashes local
logs. An ordinary clone does not include raw recordings, local reports, models
or videos. Use the [evidence index](evidence/egypt-urban-chaos-v1/delivery-index-20261027.json)
for historical sources, failed attempts, videos and retained replay artifacts.

## D. Changes made

`frontend\mission-state.js` and `frontend\sequential-drive.js` expose **Ready,
Preparing, Running, Saving, Verification Required** beside the existing session
context. Finish remains Saving while awaiting server confirmation; saving,
sensor/operation faults and validation blocks do not look like drive readiness.
These are interaction states, not certificates. Commands, driver selection,
scenario admission and design are preserved.

`tests\mission-state.test.js` adds focused lifecycle/fault/Finish transition
coverage. `frontend\dashboard.bundle.js` is regenerated; the CSS build was run
and its unchanged bytes retained.

README now separates current operating instructions from expandable dated
delivery notes. The new resource report, offline diagnosis and
[demonstration/defense guide](EGYPT_DEMONSTRATION_DEFENSE_20261027.md) supply
architecture, measured comparisons, exact environment/model fingerprints,
startup/replay commands, workflow instructions and evidence-based answers.

No runtime driving fix or performance optimization is claimed: the bounded
investigation did not establish a defensible small behavior-equivalent repair.
No timing/safety threshold, coverage, physical alternative, scenario density,
route, Normal behavior or acceptance requirement changed.

## E. Measured outcomes

Attempt 19's 601 driving-frame p95/p99 costs were sensor collection
106.684/117.468 ms, scene geometry 22.079/24.530 ms, inclusive prediction
49.106/57.664 ms, maneuver selection 46.937/54.906 ms and independent shield
9.181/12.022 ms. RPC was only 0.105/0.167 ms. Stage percentiles are not additive.
The measured driving RTF was 0.216708, not real-time execution.

All 633 submitted timing traces, including 32 held-prefix submissions, remain
accounted for separately: application-check p95/p99/max
215.785/242.103/667.504 ms. No late sample was removed to obtain a pass.
Recording/detector-worker interference is not causally separable from the
saved streams. Final zero backlog does not prove zero I/O interference.

Normal's audited stop frames retain a 3.0 m verified corridor and zero coverage
speed cap, with foreground depth around 4.379/4.401 m and unknown body cells
at 3.5 m. They do not prove an empty road or justify overriding observations.
No complete route, three measured passes/returns or final driver advantage is
established by these data.

## F. Remaining blockers and authorization

| Blocker | Evidence / known cause | Unknowns | Required action / authorization | Scope / status |
| --- | --- | --- | --- | --- |
| Insufficient D storage | Verified provisional deficit 39,977,906,129 bytes (37.232 GiB) | Full successful-route rates and combined matrix retention | Add at least that usable D capacity, or deliberately configure/verify another recording/export volume with at least 140,049,743,825 usable free bytes (round up to 131 GiB), plus any copy costs. Preserve the archive. Recompute from complete successful DEVELOPMENT before ACCEPTANCE. No relocation/deletion performed. | Native resource prerequisite FAILED; final capacity BLOCKED |
| Diagnostic-time feasibility | 645.013 s spendable; matrix 7200 s and browser 480 s protected; acceptance 7200 s unused | Actual time to complete corrected Normal targets | For a conservative three-target minimum-reservation plan, request **795 additional diagnostic-only seconds**: three allocations of 480 s each (180 execution + 300 cleanup), using existing 645.013 s plus 795 s. This only closes the 794.987 s reservation gap; it does not guarantee route success. No increase applied or protected time borrowed. Re-estimate if measured work exceeds these caps. | Ordered diagnostics BLOCKED; matrices/browser cannot follow failed prerequisites |
| Timing failure and retry restriction | Attempt 19 fails 200/225/250 ms requirements; same source already attempted | Precise worker/I/O attribution and defensible optimization | Establish a meaningful measured, behavior-preserving repair, then fresh complete source-bound software/replay evidence. More storage/time alone does not permit retrying unchanged source. | Gate B FAILED |
| Normal progress and protected route/overtakes | Saved vehicle/unknown-corridor evidence; no full route or three passes | Queue/event release cause and complete native performance | Diagnose physical queue/event/sensor cause without hidden inputs or forced failure; validate in the required ordered DEVELOPMENT sequence after earlier gates. | UNRESOLVED / NOT EXECUTED |
| Full native matrices/browser/cleanup | Read-only runner refuses both matrices | Final holdout outcomes, final workflow/exports/cleanup | Complete preceding gates on stable source, update storage from successful DEVELOPMENT, freeze, run ACCEPTANCE once, then reserved browser verification. Do not tune on holdout. | BLOCKED / NOT EXECUTED |

Budget, allowance and historical research-ledger hashes remained unchanged.
The archive is one D directory reached through the old C junction, not a
duplicate to delete. Installed environments/models remain outside Git.

## G. Git delivery

Work remains on `main` in the only primary checkout. The final console report
records the commit, ordinary push result, remote comparison and working-tree
status after publication. No force-push or history rewrite is authorized.

## H. Final conclusion

**Egypt Urban Chaos V1 is NOT ACCEPTED.** The delivery improves reproducibility
and defensibility but does not close the execution/acceptance gates. Passing
software checks and a readable historical video do not replace them.
