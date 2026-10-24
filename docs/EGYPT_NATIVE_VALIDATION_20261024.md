# Egypt native development execution — 24 October 2026

Egypt remains unavailable for ordinary driving because native development
**failed**. No native acceptance artifact was created, no reserved acceptance
seed ran, and the historical crossing remains the default. Available VRAM alone
cannot satisfy this gate.

The user authorized execution after the earlier infrastructure-only delivery.
The normal dashboard handoff saved its current state and used ordinary
recording/SDK/engine shutdown before validation. Work stayed on `main` in the
primary checkout. The [retained execution index](evidence/egypt-urban-chaos-v1/native-execution-20261024.json)
contains thirteen native attempts, including preparation failures, report hashes,
source fingerprints, outcomes, measured distances, stop reasons, cleanup results,
software-check hashes and the final read-only preflights. Thirteen attempts does
not mean thirteen completed trips.

## Repairs and their observed limits

- Missing scripted traffic participants are staged from existing unused native
  vehicles into measured free native lane slots **before** recording. Actor
  counts stay 60 vehicles and 100 pedestrians. Both arms capture the same poses
  and profiles. There is no driving-time teleport or inferred event success.
- Comparison surround mounts use a 0.1 mm construction grid within their 100 mm
  body offset. This removes sub-micrometre native respawn noise while retaining
  exact sensor calibration comparison. Changed calibrations still fail.
- Combined brake/hazard flags are constructed as the native `VehicleLightState`
  enum. The previous integer bitmask caused a real CARLA argument error.
- Failed preparation can be summarized when no manifest exists. Scenario status
  retains recording/cleanup errors, startup failures and the original control
  fault message.
- Map context is reused only within the same frame/session/route, with isolated
  caller copies. Bounded forecasts are shared only for the same immutable
  measurements and horizon. Independent command/path checks and the 250 ms
  freshness limit remain in place. These changes did **not** close native timing.
- A frozen Egypt start preserves its captured route instead of replanning after
  the Mercedes suspension settles. Ordinary resumes still replan. Native route
  validation, captured-route equality and the physical initial-condition audit
  remain mandatory.
- Progress checkpoints use the existing compact snapshot; full actor starts
  remain in recording metadata and final reports. This reduces control-thread
  checkpoint serialization without discarding the underlying evidence.

## Actual native outcomes

All six development seed/order cases ran against frozen source
`095f1480862a7ac7eb1d49fcc6c0b61e935efdc6e566b0f8e94b597bd25a85ca`.
Each pair had an 800 s worker window plus a 300 s cleanup reservation, fitting
the remaining phase allowance. No pair passed. Neither Normal-first case below
completed its second trip. `RUNNING` in its retained report is an incomplete
drive at the bounded worker exit, not an arrival.

| Development case | Observed result |
| --- | --- |
| 1703 / Normal first | 156.351 m; repeatedly held at zero measured forward coverage; incomplete at worker exit; zero contact callbacks |
| 1703 / protected first | Sensor freshness watchdog ended the first trip; no route completion |
| 2707 / either first driver | Replanning the captured route changed connectivity; neither drive started |
| 3709 / Normal first | 110.246 m; repeated coverage holds; incomplete at worker exit |
| 3709 / protected first | Sensor freshness watchdog ended the first trip; no route completion |

The subsequent route/checkpoint repair changed the source fingerprint to
`cb08f0cbef3e88b14fd4ce4de175398ea9f53769bcf5ed197237bafc8cf606a4`.
A focused **2707 / protected-first** native rerun then entered `DRIVING` and
passed the physical initial-condition audit, confirming the route startup
repair. It still ended with `Current synchronized sensor scene unavailable for
one second`. Maximum recorded sensor wall age was **0.5524 s**, beyond the
existing 0.250 s lease. It travelled approximately 0.00026 m, so it proves no
useful progress, overtake or arrival. Background compression was stopped for
this focused check. An earlier focused run also reproduced the timing failure
without background compression.

No complete current-source development matrix passed. Three complete measured
overtakes, all physical hazards/pedestrian behaviors, protected zero-contact
arrival, matched complete driver outcomes and all three post-exit media checks
remain open. Source-specific failures and older attempts are retained, rather
than relabelled as evidence for the repaired source.

## Recording space and cleanup

One earlier drive stopped at 116.856 m with the recording writer's real disk
reserve error. D: had only 96,636,928 bytes free. Its prefix and failure remain
saved. Lossless NTFS LZX compression was applied to older sensor arrays and
telemetry; no raw recording retirement or evidence deletion was performed.
Two sampled before/after SHA-256 checks matched. About 11.46 GiB was free at the
final evidence snapshot. This is not a capacity guarantee for a full retained
development-plus-acceptance corpus.

Some development runs overlapped idle-priority compression of a fixed list of
older, closed recording roots. The active recordings were excluded. Timing
failures were separately reproduced with compression stopped; the observations
do not establish VRAM pressure as their sole cause.

All thirteen attempts verified CARLA process exit and independent cleanup with
no project actors and asynchronous world settings. The disk-failure attempt
retains its worker recording-close error despite the independent cleanup pass;
it is not reported as a clean completed recording. At delivery no CARLA engine
was running, no reservation was unfinished, and simulator ownership was released.

| Separate allowance | Seconds |
| --- | ---: |
| Originally authorized | 14,400 |
| Development charged, including native cleanup | 2,335.283 |
| Development remaining | 4,864.717 |
| Acceptance remaining / spent | 7,200 / 0 |

The historical research ledger remains unchanged at SHA-256
`ca6ac6acde5266168ac4af7da8bfd755303cdd9ff147b707050073a4f3bd7c3c`.
No allowance was reset, extended or transferred. Final read-only preflight
refuses acceptance because current-source development has not passed. The
standard 7,200 s development matrix reservation also exceeds the remaining
development balance. Later work must fit the remaining authorization or obtain
explicit additional authorization; the protected acceptance window is not
development time.

## Software verification and next required work

`npm test`: **207 passed**. The approved Python discovery suite: **950 tests,
946 passed and four skipped**. These are software checks, not native acceptance.
No frontend module or stylesheet changed in this follow-up, so generated
dashboard assets did not require regeneration.

The remaining work is to profile sensor receipt, scene construction and measured
corridor proof until fresh commands repeatedly reach the actuator within the
existing 250 ms lease; inspect the saved Normal coverage holds against actual
calibrated depth/LiDAR and route geometry; then freeze the repaired source and
complete all six development pairs. Only a passing current-source development
matrix can admit the one-shot reserved acceptance matrix. No timestamp
relabeling, invented free space, forced Normal contact or disabled safety gate
can substitute for those measurements.
