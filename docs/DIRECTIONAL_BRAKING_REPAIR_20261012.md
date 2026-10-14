# Directional side/rear braking repair — 12 October 2026

The ordinary RULE supervisor treated a rear car closing on the ego vehicle as
an instruction to brake. Its side check could also interpret centimetres of
changing LiDAR surface sampling as a cut-in while the padded envelopes already
overlapped. Both failures were reproduced by regression tests before repair.

`LidarPathConflicts` now requires net registered lateral ingress of at least
0.10 m within a bounded 0.5-second window, inward measured velocity, and a
predicted overlap ahead of the ego center. Ego speed and IMU compensation apply
to the accumulated displacements. A rear-only catch-up/merge and a parallel
nearby surface remain observations, without requesting forward braking.
The diagnostic classifications are included in `side_rear_observations`.

The forward radar/LiDAR/depth obstacle supervisor still brakes independently.
The side/rear padding, prediction horizon, frontal braking envelope, TTC,
freshness, hold/release, emergency protection and steering restrictions retain
their prior settings. This does not certify side/rear free space or add actor
ground truth to inference. The runtime identifies this logic as
`FORWARD_LATERAL_INGRESS_V1`.

## Verification

Regression coverage includes closing rear cars, parallel passing cars, adjacent
sampling jitter, a merge behind ego, cut-ins from both sides ahead, a slow
forward merge, runtime command preservation, and a front obstacle with a
simultaneous approaching rear car. The previous rear-braking expectation was
corrected to require a diagnostic observation instead.

The complete Python suite ran 286 tests: 285 passed and one skipped.

The offline audit replayed all 2,915 LiDAR observations from the existing
`run_b308fe67540b4a5d85c0775357ad2078` recording through the old and repaired
tracker. These are tracker decisions on the same recorded trajectory; they are
not counts of new driving interventions or new collision outcomes.

| Tracker measurement | Before | After |
|---|---:|---:|
| Frames with a side/rear conflict request | 599 | 77 |
| Selected conflicts with the measured center behind ego | 475 | 0 |
| Selected conflicts with the measured center ahead | 124 | 77 |
| Tracker processing P95 | 3.58 ms | 3.97 ms |

The remaining forward conflicts are not independently labelled as necessary
or unnecessary. Recorded-data replay cannot establish counterfactual arrival,
clearance or collision outcomes.

Evidence is in `output/path-conflict-repair/before/`,
`output/path-conflict-repair/after/` and `loaded-state.json` in their parent
directory. The audit is reproducible with:

```powershell
.\.venv-carla\Scripts\python.exe -m scripts.native.audit_path_conflicts runs\normal_city\run_b308fe67540b4a5d85c0775357ad2078 --output output\path-conflict-repair\recheck
```

The normal project launcher reloaded the repaired backend. The live API
confirmed connected, PAUSED, zero speed, recording off, RULE enabled and the new
policy marker. The dashboard is on Driving. No new full native journey or MODEL
experiment was run. The research ledger remains at 5,359.297 / 5,400 seconds,
with 40.703 seconds remaining; no validation ticket was created.
