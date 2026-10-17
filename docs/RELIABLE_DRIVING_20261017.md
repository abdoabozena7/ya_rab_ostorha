# Reliable driving repair — 17 October 2026

**Delivery status: partial implementation, native driving acceptance FAILED.**
The camera/map and sequential controls are repaired, and the control path now
retains more useful evidence. The requested smooth, uninterrupted dense-city
driving has not been demonstrated. A passing unit suite or successful playback
does not change that result.

## Changes

- Route view draws the route and ego only. Details exposes measured surfaces
  separately from semantically supported people and vehicles. Unknown and
  unconfirmed tracks cannot become vehicle-shaped markers.
- Semantic association is cached and one-to-one, uses historical poses and
  timestamp/session checks, and retains label expiry. Control tracks carry
  measurement frame, support, sensor, semantic and motion evidence.
- A narrow forward-only stationary-rear separation certificate checks the
  original padded bounds throughout the command lease and stopping tail.
  Overlap, lateral/reverse movement, stale evidence, recent motion, occupied or
  unknown corridors still veto movement. Original rejected forecasts are kept.
- Command application records frame/session/decision identity and wall and
  simulation ages immediately before the native RPC. The existing 250 ms wall
  and 100 ms simulation limits remain. Diagnostic trace snapshots move after
  command application and charge the bounded recording queue. Display forecasts
  are demand-driven; route-only display does not request them.
- Longitudinal shaping uses measured response and actual pedals, before the
  final shield. Emergency braking is preserved. **This controller remains
  experimental: native comfort tests failed.**
- One shared UI action selects Restart, Stop, Resume, Play/Pause or emergency
  release. Details contains configuration and camera tools. The English main
  driving screen has three buttons, including Emergency stop. Camera and route
  are the default view.
- Presentation outcomes retain `PENDING`, `BOTH_ARRIVED`, `FAILED_ARMS` and
  `INCOMPLETE`. A recoverable first-arm sensor timeout retains the exception and
  terminal command, finalizes the recording, holds owned traffic, restores the
  fixture, and requires 20 consecutive fresh complete frames within 10 seconds
  plus a matching-condition audit before attempting Normal once.
- Population placement now waits for the teleport's next native frame. An
  independent setup audit rejects fewer than 20 actual vehicles, 30 pedestrians,
  10 vehicles ahead or 15 pedestrians ahead before recording.
- The first injected recovery exposed another real defect: Normal's observer
  work expired a navigation command before application. The watchdog changed
  the arbiter to PAUSED while the journey stayed RUNNING. Observer work now
  follows native application, and an expired command ends the journey with a
  retained `CommandLeaseTimeout`. Watchdog limits are unchanged.

## Evidence and acceptance

Compact evidence is in [the evidence index](evidence/reliable-driving-20261017/verification.json).
Raw sensor recordings, MP4s, source archives and detailed probe samples remain
in ignored `runs/` and `output/`, with identities and checksums retained in the
compact report. An ordinary clone does not include these raw assets.

| Native attempt | Observed result | Acceptance |
| --- | --- | --- |
| Clear road, 20 km/h, probe `6f17b48e88fd45e1b8f2ebb5c3e22c71` | 118.26 m, peak 22.66 km/h, zero contacts; arrival bookkeeping and comfort failed | Failed; earlier revision |
| Bypass profiling, probe `a26286d6b8c247deaebfd717f6ae100b` | Retained cProfile measurements, 100 control ticks | Diagnostic only |
| First clear 50 setup, probe `caf3e859a570426c8eb91dc6a70031d0` | Telemetry unavailable before worker; operator state restored | Failed setup |
| Revised clear 50, probe `2cc897a7b0cb42a696e57461b639bc47` | Arrived, 120.52 m, peak 49.94 km/h, zero contacts; 111 comfort excursions and control-delay failure | Failed; peak speed is not verified stable cruising |
| Dense seed 320418473, presentation `cab445c08fcc471c9f2d7860d09b7a73` | 22 vehicles/30 pedestrians; 6.87 m, peak 4.84 km/h, 90.68% fresh recorded frames; stopped by operator after failure | Failed; Normal not run |
| Dense seed 912833484, presentation `a4997aac37a844e1bc4a9b2dcb8817e3` | 18 vehicles/30 pedestrians; 5.92 m, peak 5.69 km/h | Invalid density and failed driving; Normal not run |
| Dense seed 850261841, presentation `342b80b521674c6788213bd50724c820` | 16 vehicles/30 pedestrians; 7.36 m, peak 5.10 km/h | Invalid density and failed driving; Normal not run |
| First injected recovery, presentation `32a36d89601c4523aabde8bd9edca98c` | Original timeout preserved; 20 fresh frames and fixture audit passed; Normal then hit the command-timeout/state mismatch | Failed workflow; excluded from driving acceptance |
| Second injected recovery, presentation `6088534a90874d86b76673eb3b83ed48` | Recovery passed again; Normal traveled 75.17 m, reached 49.36 km/h, then made contact. Changed traffic actor 1226 caused a hold/cleanup `KeyError` | Failed workflow; both MP4 checksums verified; excluded from driving acceptance |

The three dense attempts preceded the final setup and watchdog repairs. They
cannot validate the final revision. Every attempt remains retained.

The changed-fixture correction now freezes remaining owned actors by their
actual type and reports lost/replaced actors explicitly. It stops continuation
and permits cleanup; it cannot admit Normal from changed initial conditions.
Automatic traffic replacement is disabled while the benchmark is locked.
These final corrections, historical failure summaries, and the shared display
semantic association received offline verification only. No additional native
cohort was started after shutdown.

The retained 94927 replay reconstructs 1,145 sensor frames and all 23 final
tracks, including the geometry corresponding to tracks 383 and 393. The rear
corner still fails the new stationary-history condition; the replay does not
justify ignoring it. Replay scene-build p50/p95/p99 were approximately
115.8/174.8/269.7 ms on this host. Those are offline profiling measurements.
An independent complete physical-bounds and every-stop audit remains missing.

Actual browser camera windows measured roughly 3–5 fps in dense runs, with gaps
over 250 ms and simulation/wall ratios around 0.2. **Display performance fails**;
this does not substitute for control-rate measurement. The native graphics,
sensor rig, recording and route traffic were retained.

The final offline audit retains every recorded frame, including startup and
terminal holds and frames without matching decisions. DRIVER and VEHICLE_HOLD
labels do not exempt a stop from independent review. The 90.68% above uses this
conservative denominator; an earlier decision-filtered audit reported 90.92%.
Missing or invalid physical measurements fail an explicit evidence gate.

## Offline software and saved-video verification

- Dashboard assets regenerated; **130 JavaScript tests passed**.
- Python suite: **574 discovered, 573 passed, one optional test skipped**.
- Real Chrome saved-pair playback: **11 checks passed**, including both native
  MP4s ending, synchronized overlapping playback, original timeout/injection
  text, Normal's contact, English text, three main buttons, and desktop/390 px
  layout. [Desktop](evidence/reliable-driving-20261017/reliable-saved-results-1600.png)
  and [mobile](evidence/reliable-driving-20261017/reliable-saved-results-390.png).
- **Six further browser checks passed** for keyboard opening/closing Details
  with focus return, pausing both videos, holding playback position, resuming
  both videos, natural completion, and absence of page errors. These exposed
  and verified corrections to Pause branching and driving shortcuts consuming
  Space while a button had focus.

This was manual replay of the second injected recovery's real saved failures
after CARLA shutdown. It does **not** verify automatic Restart-to-results or
convert either drive to success. Final controller/fixture revisions have no
new native cohort. Compact browser results and their source identities are
retained alongside the failed acceptance report.

## Remaining gates and next engineering work

1. Remove dense control-stage tail latency, then repeat the exact final source
   under recording and display load. At least 99% freshness alone cannot pass
   a drive containing any unjustified delay hold.
2. Complete measured longitudinal/steering calibration and handover validation
   at 20/30/50 km/h. Enforce 2 m/s² acceleration, 3 m/s² deceleration, 2 m/s²
   lateral acceleration and 3 m/s³ jerk over 0.2 seconds outside independently
   established emergencies. Preserve raw excursions, not only averages.
3. Audit rear-corner and adjacent-track geometry against synchronized physical
   reference. Complete causal checks for ground leakage, duplicate surfaces,
   changing visible faces and semantic associations. Display filtering is not
   proof that a measured obstacle is false.
4. Repeat all three dense seeds at valid density on the final control revision,
   plus curves, left/right pass and return, legal alternate street, occupied
   lanes, signal release, crossings and rear traffic. No final-revision passing
   cohort exists. Full hybrid and reverse admission remain separate and closed.
5. Complete the automatic workflow and strict driving-quality acceptance
   separately. Normal preserves historical obstacle-protection-off behavior;
   its collisions cannot be presented as evidence of hybrid superiority.

## Budget and delivery

This work uses the separate 60-minute RULE repair ticket beginning
2026-10-17 17:34:50 UTC with absolute expiry 18:34:50 UTC. Setup, reloads and
diagnostics count against that wall window. The planned phase allocation is
retained; failures and repairs displaced several planned acceptance cases.
No missing gate is waived. The previous four-hour ledger and separate
20-minute ticket are not extended. Source-bound admission is not regenerated
as passing for this failed revision.

Final offline test counts, native cleanup, source hashes and workflow outcome
are recorded in the compact verification report.
The window has expired with zero remaining allowance. CARLA and its native
backend were stopped before expiry; only the SDK-free stopped dashboard remains
available for saved-video review. Further native validation requires a newly
authorized window. The old four-hour ledger still has 138.1613 seconds and was
not used to extend this run.
