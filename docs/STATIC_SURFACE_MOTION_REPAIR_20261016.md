# Roadside surfaces and false crossing predictions — 16 October 2026

The RULE crossing tracker confused changes in visible LiDAR returns with object
movement. This repair verifies physical displacement before requesting a crossing
brake. It does not require a camera class label to protect against a moving
pedestrian, bicycle, motorcycle or vehicle.

## Evidence and cause

The retained Robosphere recording `run_77a89ec21556425a963dfac77200c1f2`
contains crossing brake decisions at frames 2465 and 2466. Its front image shows
the road and roadside fixtures; the tracked patch is about 6.9 m forward and
5.8 m to the right. The old estimate reported 1.55 m/s inward movement, although
successive scans changed which parts of the surface were visible. Accumulated
one-way registration and a shifting box edge agreed on a false inward trend.
This is evidence for this recorded failure, not an identification of every
unrecorded stop the operator saw.

There was also a calibration mismatch: the crossing tracker filtered height in
the raw ego frame while measured road occupancy used a fitted ground plane.
Suspension tilt or sloped road could consequently enter the object clusters.

The first new native check reached its destination with zero contacts, but
exposed another false stop in the forward radar adapter. A retained radar return
was present while the usable fused foreground target was absent. The legacy
teacher's independent nearest-32 filter then returned "no valid foreground";
the adapter incorrectly treated that missing-target fallback as collision
evidence and held a full stop. The measured stopping corridor was sufficient.

## Change

- RULE now reuses the ground plane already measured for forward space. Its
  independent tracker/replay entry point fits the same ground model when needed.
- Registration compares prior-motion and measured-center initializations with
  bidirectional error including the surface edges. Interior nearest-neighbor
  medians alone can match dense pedestrian/bike samples in the wrong direction.
- A candidate crossing needs a separate 0.25–0.5 s baseline of original returns,
  compensated with ego speed and IMU rotation. Its translated fit must explain
  both scans better than stationary geometry. Sparse/changing faces remain
  `UNRESOLVED`; they are not called moving actors or certified free space.
- Crossing forecasts use the displacement that passed that test, rather than
  the accumulated estimate being tested. Trace rows retain fit errors, support,
  baseline, displacement, velocity and the rejection state.
- The UI distinguishes an unclassified moving object approaching the route from
  a measured obstacle already on the path. Geometry alone never supplies a
  pedestrian label. The camera detector remains supplementary display evidence.
- The legacy radar teacher contributes a hazard only with usable measured
  foreground evidence. Its missing-target fallback cannot override the fused
  coverage controller. Unknown coverage still produces its existing speed limit
  or hold, and current near radar/LiDAR/depth obstacles still brake.

Policy identity is `FORWARD_PHYSICAL_INGRESS_V4`. Forward obstacle braking,
coverage speed limits, traffic signals, sensor freshness, Stop and Emergency stop
retain their existing thresholds and authority. Static occupancy is still
checked, including when the ego path turns toward an object.

## Verification

Offline replay of **4,168 recorded native sensor frames**, with original LiDAR
checksums verified, found:

| Recording | Frames | Old crossing requests | Repaired crossing requests |
| --- | ---: | ---: | ---: |
| `run_77a89ec21556425a963dfac77200c1f2` | 2,334 | 2 | 0 |
| `run_383536ff237e455d96230b92ac87406f` | 1,834 | 0 | 0 |

This is a replay of the crossing tracker over recorded measurements and ego
commands; it does not establish counterfactual vehicle motion or general native
acceptance. [Replay measurements](evidence/surface-motion-20261016/replay.json)
include tracker timing and its scope. Run it again with:

```powershell
.\.venv-carla\Scripts\python.exe -m scripts.replay_surface_motion runs/normal_city/run_77a89ec21556425a963dfac77200c1f2 runs/normal_city/run_383536ff237e455d96230b92ac87406f
```

A separate [36-frame forward-supervisor replay](evidence/surface-motion-20261016/radar-replay.json)
of the first new native run changes **10 missing-target hazard decisions to
zero**. It processes every recorded frame, including a frame skipped by live
freshness handling; its counts are not claimed as identical to live actuation.
The legacy research teacher itself is unchanged. Regression tests also check an
out-of-range return and disagreement between the fused and nearest-32 filters.

Regression tests retain an attributed XY subset of the native scans, and cover
sloped ground, static roadside surfaces while ego turns, adjacent/rear traffic,
stationary sampling changes, slow merges and approaching moving bodies with
pedestrian, bike and vehicle dimensions. The dimensions are synthetic test
fixtures, not semantic recognition or native actor acceptance. Real forward
obstacles still request full braking.

Software verification: dashboard bundles rebuilt; **119 JavaScript tests pass**;
Python discovers **516 tests, 515 pass and one existing optional test skips**.
No experimental hybrid or maneuver gate is promoted by this repair.

## Native loading and bounded drive

The operator's in-progress 30 km/h journey was allowed to arrive and finalize
before the backend reload. No active recording was interrupted to apply code.
The native runtime then loaded V4 and completed two bounded ordinary drives:

| Scope | Result | Distance | Simulated time | Contacts | Crossing requests | Missing-target hazards |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| V4 motion test, before radar validity repair | Arrived | 142.09 m | 51.45 s | 0 | 0 | 10 |
| Final code, including radar validity repair | Arrived | 141.49 m | 29.70 s | 0 | 0 | 0 |

These are separate smoke checks, not matched performance comparisons; traffic
signal timing can differ. The final run requested 30 km/h, peaked at 30.65 km/h
and automatically resumed after its red signal. It still recorded **one sensor
delay hold frame and three harsh-braking events**. It does not establish smooth
driving everywhere, the 99% freshness gate, native pedestrian/bike avoidance or
the separate 50 km/h hybrid acceptance.

[Verification evidence](evidence/surface-motion-20261016/verification.json)
retains each run's source hashes, outcomes, full decision counts, raw recording
references and the earlier radar failure. One initial observer rehearsal read
`READY` before its queued start completed; its previous-run metrics are explicitly
excluded. The verifier now waits for a new `RUNNING` comparison identity.

The real browser connected to the reloaded native runtime, displayed the native
camera, contained English interface text and had no horizontal overflow or
console errors. [The live screenshot](evidence/surface-motion-20261016/live-drive.png)
shows the first V4 drive waiting at a red light, not a fabricated crossing.
The application is left connected, held at zero speed, with recording finalized
and V4 active. No experimental acceptance flags or research budgets were reset.
