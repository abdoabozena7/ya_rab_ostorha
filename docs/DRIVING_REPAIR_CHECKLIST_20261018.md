# Iterative driving repair — 18 October 2026

## Result and scope

The original failing seed **2086914493** now reaches its destination in the
ordinary six-channel RULE configuration: **267.34 m, zero ego contacts and zero
processing-deadline brake commands**. All **2,639 applied decisions** pass their
original freshness checks. This scoped native regression result is **not full
smooth-driving, detector, bypass or hybrid acceptance**.

The conservative recording audit still fails strict quality acceptance:
comfort, independent verification of every stop, verified 50 km/h cruise and
actual browser performance remain open. Failed iterations are retained.

Compact tracked evidence: [verification.json](evidence/driving-repair-20261018/verification.json).
Raw reports, source archives and HTTP samples remain locally under ignored
`output/driving-repair-20261018/`; recordings remain under ignored `runs/normal_city/`.

## Checklist

- [x] Inspect camera boxes, map identities, braking decisions and original failures.
- [x] End an active journey on observation loss, preserve its original cause and require explicit restart; enforce this without dashboard polling.
- [x] Continue fixture cleanup after an actor disappears; reject changed comparison fixtures rather than silently matching them.
- [x] Reduce control-stage work without extending the 250 ms wall / 100 ms simulation freshness limits.
- [x] Handle an unavailable optional detour without crashing the runtime or admitting an invalid route.
- [x] Retry atomic detector publication under Windows reader locks; retain complete previous results under persistent contention.
- [x] Retain uncertain lead-car candidates without calling them supported identities; suppress the investigated weak signal false positive.
- [x] Distinguish unclassified map surfaces and record exact camera/map source identity, including critical-owner deferred views.
- [x] Run focused regressions, saved-sensor replay, dashboard build and full offline suites.
- [x] Complete the authorized native cohort, preserve failures, export recording/video evidence and release CARLA/GPU resources inside the cap.
- [x] Prepare reviewed source, generated assets, documentation and compact evidence for delivery on main.
- [ ] Pass strict comfort and complete independent stop audits; zero contacts alone is insufficient.
- [ ] Establish general detector/map accuracy and actual browser rendering/playback acceptance.
- [ ] Revalidate gated surround/bypass driving: its retained native iteration still has deadline failures; the final detour repair has offline regression coverage only.

## Original failure chain

Presentation `dd41fef68b434d98a4581627c8ef42d1`, recording
`run_0a3914216ed84085b0db1902a3098bc2`, travels only **9.78 m**. There are **33
full-brake processing-deadline commands**, despite all required sensor channels
being present. An observation timeout disconnects the arbiter while the journey
remains RUNNING; recovered telemetry stays PAUSED until presentation timeout.
Cleanup then throws on stale pedestrian actor 206.

The timeout now ends the journey as ERROR with `observation_receipt_timeout`,
preserving the fault. Fresh observations restore telemetry, not driving authority.
Cleanup handles disappeared native proxies per actor and continues holding or
releasing survivors. A changed fixture cannot start Normal.

The preceding recording `run_6b1c11911158434a9c890785bcc573ca` also contains timing
holds and a missed low-confidence lead car. Its signal stop is legitimate;
a camera inference miss does not prove depth/LiDAR saw no obstruction.
Historical map snapshots were not retained, so their exact old markers cannot
be reconstructed or declared correct.

## Software iterations

- Actor metadata refreshes when snapshot membership changes; poses still come
  from every current snapshot. Repeated actor-catalog RPCs and repeated native
  bounding-box conversions are removed.
- Sensor receipt, scene publication and command admission share a precise QPC
  elapsed clock aligned to the legacy epoch. Windows Python's legacy monotonic
  clock measured 15.625 ms resolution. Safety limits are unchanged.
- Ground fitting batches the same seeded RANSAC candidates. Replay of 20 saved
  frames, repeated five times, yields identical planes and support counts.
  Offline p50/p95 changes from 3.42/4.95 ms to 1.16/1.66 ms; this is not native
  throughput acceptance.
- Numeric forecast freezing preserves finite, immutable, shared values; saved
  forecast p50 changes from 10.08 to 6.69 ms. Calibrated depth is decoded once per
  scene and reused read-only. Optional display work defers under control load.
- The missed lead at frame 1084 is retained at its actual **27.5%**, explicitly
  uncertain. The banner falsely labeled a traffic light at frame 4200 no longer
  passes the signal threshold. Frame 7508 retains its 70.4% car candidate.
  Three examples do not establish calibrated or general detector accuracy.
- A supported display label is a confidence category, not ground truth. Unknown
  surfaces remain hollow gray, not recognized cars. RGB inference gains no RULE
  command authority; existing semantic admission and measured geometry remain.
- New `CAMERA_DETECTIONS` traces retain source image hashes/frames.
  `DISPLAY_PREDICTION` traces retain exact session/frame/time with bounded
  prediction-asset compression. Identity matches establish provenance, not
  physical accuracy or complete coverage of every display frame.
- Optional detour initialization now treats graph/route validation failure as
  no detour and restores planner turn state. Explicit route validation is not
  weakened. This follows iteration 4's retained native failure.

## Native iteration log

All attempts use seed 2086914493. Iterations 1–4 use the repair ticket's gated
surround/bypass setup, not the ordinary rig. Results are not interchangeable.

| Iteration | Pair ID | Protected result | Retained limitation/failure |
| --- | --- | --- | --- |
| 1 | `0dec814691c64aaea8e29a208088b5ac` | Setup ERROR | Missing `apply_driver` import introduced in release refactor; fixed and regression-tested. Failed teardown required native restart inside the same window. |
| 2 | `f7f9e91d00ff480b918638bfc4f21292` | ARRIVED, 268.86 m, 0 contacts | 3 deadline brake frames. Normal collides after 71.86 m. Backend reaches PLAYBACK; browser playback not acknowledged. |
| 3 | `0d91baf0689e4f238adc23f690749fbc` | ARRIVED, 268.94 m, 0 contacts | 1 deadline brake frame. Pedestrian 423 disappears during fixture hold; backend catches it, stays connected and refuses Normal from changed conditions. Presentation ERROR retained. |
| 4 | `d398c18dd6864a698a99d9fe0a20164d` | ERROR, 186.57 m, 0 contacts | 15 deadline brake frames; optional detour throws route validation error. Subsequent fix covered offline, not by new native bypass acceptance. |
| 5 — ordinary rig | `40d8c77a3f3a4c5a9883e44144a83b5c` | ARRIVED, 267.34 m, 131.80 simulation seconds, 0 contacts | 0 deadline brakes; all 2,639 applied decisions fresh. Peak 38.61 km/h; 4 harsh-braking events. Normal collides after 74.93 m. Strict quality still fails. |

Final protected recording: `run_b1f433a306ba4b10b47e523763594023`.
Normal recording: `run_1bb3deafd86b4edd935b1969fc314b8c`.
Both finalize without dropped frames/events/traces; both MP4 checksums match.
The observer reaches backend PLAYBACK, not verified browser playback completion.

The final recording contains 172 detection traces and 105 map traces. Camera
source hashes match 170 recorded images; two source frames precede the recording
and stay explicitly flagged outside its coverage. No checked visual identity
mismatch is found. The all-recorded-frame audit includes one unpaired terminal
frame (fresh fraction 99.9621%), so `no_control_delays` remains false;
the separate all-applied-decisions result does not override it.

Seven stationary segments of at least 0.5 seconds are listed in the evidence.
Images at frames 33900 and 35000 show a real queued lead car during the two
approximately 26-second holds. Recorded native actor poses also place the Ford
ahead of ego. This verifies those samples only, not every frame or complete
stop/release timing. No logged reason automatically excuses a stop. The audit
retains 464 comfort violations and 1,425 unresolved stop frames; none are
silently waived as emergencies.

HTTP camera/map workload checks have no request errors: 95 distinct camera frames
in 30 seconds in iteration 2, and 65 in 20 seconds in iteration 5. These are
endpoint workload samples, **not browser FPS or display acceptance**.

## Verification and budget

- Dashboard JavaScript/CSS regeneration: passed (`npm run build:dashboard`).
- JavaScript: **135 passed** (`npm test`).
- Control Python: **591 discovered, 589 passed, 2 skipped** (full unittest suite).
- Perception Python: dedicated detector regression **1 passed** in
  `.venv-perception`; skipped where optional OpenCV is absent.
- The audit regression retains unpaired recording frames even when every applied
  command is fresh. Missing evidence never becomes a passing quality gate.

The user authorizes **40 minutes**, ticket
`repair-94867ef65c9844e9baad45d4b516a9fd.json`. The ordinary-rig 592-second ticket is
an explicit **suballocation**, expires before its parent, and adds no time.
CARLA cleanup completes **35.04 minutes** after the parent starts, with no native
processes remaining and a stopped SDK-free dashboard available. These tickets
do not authorize further native testing. Earlier ledgers are unchanged.

Backend source hashes remain unchanged within native iterations 3–5; exact
source archives exist locally for those attempts. Earlier attempts retain hashes
but have no exact-byte archive. The final archive covers the 96 Python files in
`backend/core`, `backend/carla` and `backend/computer_vision`, not the whole repo.
Downloaded weights, virtual environments and raw runs are not delivered in Git.

Repeat the read-only final audit locally:

```powershell
.\.venv-carla\Scripts\python.exe -m scripts.audit_driving_repair output/journey-comparisons/40d8c77a3f3a4c5a9883e44144a83b5c.json --output output/driving-repair-20261018/iteration-5-default/audit.json
```

Next acceptance work: independent frame-by-frame stop/comfort review, detector/map
evaluation across more scenes, browser rendering/playback measurement and a newly
authorized gated surround/bypass cohort. Do not remove protective holds or widen
freshness limits to make an acceptance report pass.
