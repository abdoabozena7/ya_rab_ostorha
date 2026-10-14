# RULE freshness repair and native verification — 12 October 2026

**The updated backend completed the saved RULE journey through the actual
dashboard and real CARLA.** Independent native position/speed checks, the Results
display and the finalized recording audit passed. No sensor/communication fault,
collision callback or collision episode occurred in this journey. RULE remains
the default; MODEL remains experimental. This is verification of the existing
seed 2811 demo, not general safety certification or full MODEL/v2 acceptance.

## Failure mechanism and integration repair

The previous failed recording, `run_6dcb6e9c4f564b84a40a37bc7713f4c5`, had all six
required sensor measurements aligned with evaluation frame 261309. Their
simulation ages were zero, but their earliest callback receipt was **265 ms** old
against the existing **250 ms** wall freshness limit. The stop was correctly
triggered by wall freshness, rather than by a missing detection or an obstacle.

Inspection found synchronous display work in the sensor/control critical path:

- Every command/heartbeat availability check called the full dashboard snapshot
  while holding the service lock. That rebuilt the canonical dashboard frame and
  collected sensor registry, population and other display data.
- Registry serialization held both the outer control lock and the callback lock,
  allowing display processing to delay sensor admission and control.
- Urban population display sampled ego plus 70 native actor handles on repeated
  reads, including reads under the control lock.

Availability checks now only inspect connection freshness. The dashboard reuses
the view already generated at synchronized publication. Registry serialization
runs outside both locks, using captured envelope references. Urban local counts
come from the existing worker-owned native snapshot. They remain display data;
ground truth is not added to safety inference. Stage timing is now recorded in
the safety sidecar, including control-lock wait, time since publication,
navigation and safety processing.

Threaded regression checks demonstrate that a blocked display conversion cannot
hold either control or sensor-callback admission. A separate regression confirms
that a genuinely stale receipt still forces full braking and PAUSED mode, and
fresh data alone does not resume driving. These confirm the contention defect and
its repair. The old recording lacks stage timings, so the exact contributor to
its final 15 ms overrun cannot be reconstructed; the successful updated rehearsal
is the native verification of the repair.

No safety thresholds, prediction policy, scenario/hazard plans or learned weights
were changed. Minimum hold, release rate, clearance confirmation and explicit
resume after failures remain intact.

## Actual application and native outcome

The launcher reloaded the updated backend against CARLA 0.9.16, Town10HD_Opt.
The application started connected and PAUSED with RULE enabled. The actual
**Rules driving** button started the persisted pair
`90ab411017f54272b96493fd1cfea0de`, seed **2811**, with 40 vehicles and 30 pedestrians
and automatic recording. Initial configuration, traffic lights and approved
native actor poses matched the saved pair. The application sent its normal
heartbeats; no replacement transport, scripted pedal driver or second tick owner
was used. Live camera, prediction/minimap and recording were observed.

The new attempt is `04eae298f38048209d38947fa502d7a1`, recording
`runs/normal_city/run_b308fe67540b4a5d85c0775357ad2078`.

| Measurement | Result |
|---|---:|
| Terminal result | ARRIVED |
| Scenario duration | 145.65 simulation seconds |
| Native independent destination distance | 1.1146 m |
| Native independent speed | 0.00763 m/s |
| Native terminal pedals | Throttle 0; brake 1 |
| Recorded collision callbacks / episodes | 0 / 0 |
| Route progress | 184.39 m |
| Stopped time / longest stop | 57.75 s / 5.55 s |
| Waiting proxy | 10.60 s |
| Harsh braking events | 184 |
| Emergency protection duration | 0.10 s |
| Minimum planar bounding-box clearance | 0.0101 m |
| Geometry / controller pipeline P95 | 7.98 ms / 14.76 ms |
| Maximum evaluated driving-command sensor wall age | 234 ms |
| Maximum control-lock wait / navigation time | 16 ms / 16 ms |

The destination was reached and the vehicle stopped, so this rehearsal had no
permanent stop. Waiting is a proxy, not a labeling of every stop as unnecessary.
Frequent harsh braking and the close measured clearance remain limitations;
zero recorded collisions do not establish an adequate clearance margin. No
MODEL improvement or general superiority claim follows from this result.

The Results page matched this new attempt, recording path, arrival, duration,
progress, waiting proxy and harsh braking measurements. After arrival, actual
dashboard input also reverified manual throttle producing native motion, manual
stop, emergency latching, explicit acknowledgement without automatic resumption,
and reset replacing the native ego while preserving enabled RULE. Earlier native
verification of Stop/Reset during active recordings and active RULE emergency
finalization remains in the linked historical integration report.

Seven camera HTTP 503 responses occurred during scenario setup, and one camera
request reported connection refused about 141 seconds into browser observation.
The image recovered and the journey continued. No JavaScript page exception or
WebSocket application error occurred during the recorded journey. The isolated
camera-request failure's cause is unproven; it remains a display reliability
limitation, distinct from the repaired sensor/control freshness interruption.

## Recording and offline checks

The recording finalized with **2,915 frames**, **2,915 safety sidecar entries**,
**2,913 command trace rows**, one native ego, and zero dropped frames, events or
trace rows. ReplayReader accepted the entire recording. All driving interventions
have causes, and every traced applied command matches its evaluation-frame
diagnostic. Evaluation happens before the next recorded physics frame.

The initial strict audit rejected the terminal arrival hold because it required
a policy proposal even after the policy had entered STANDBY. Its FAIL report is
preserved as `recording-audit-initial-strict.json`. The corrected audit accepts
only the last RULE row with verified ARRIVED status, STANDBY, matching paused
diagnostic and zero throttle/full brake; a fault, MODEL row, missing diagnostic
or missing proposal during driving still fails. No recording was rewritten.
The final audit passes all checks. A 703 ms age during stopped setup is reported
separately; all 2,912 evaluated driving commands were at or below 234 ms.

Python: **278 tests run, 277 passed and one skipped**. JavaScript: **64 passed**.
No frontend change or learned-weight update was needed for this repair.

## Budget and retained state

The latest explicit authorization provided a separate **600-second RULE-only
validation window**. Its ticket is
`validation-d0ae9d41dc7c4c3a95917e9045970fa6.json`. The validation backend was retired
within that window; subsequent work was offline audit or paused/read-only work.
No training or MODEL experiment ran. Checksums confirm the original research
ledger remains **5,359.297 / 5,400 seconds**, with **40.703 seconds** remaining.
Frozen safety configuration, scenario/prediction code and both weights match
their before checksums.

The ordinary updated backend is connected, **PAUSED**, RULE enabled, recording
off, with the new ARRIVED result retained. New comparison journeys still require
their budget allowance; the exhausted research ledger is not bypassed. Future
live rehearsals require another separately authorized validation window.

Evidence: [rule_freshness_repair_20261012](evidence/rule_freshness_repair_20261012/).
Key artifacts are `native-launch.json`, `browser-journey.json`,
`browser-results.json`, `browser-controls.json`, `independent-arrival.json`,
`recording-audit.json`, `preservation.json`, `validation-authorization.json` and
`final-paused-state.json`. Screenshots are in `output/playwright/`.

Prior failures are preserved in
[the earlier native integration report](NATIVE_RULE_INTEGRATION_20261012.md).
