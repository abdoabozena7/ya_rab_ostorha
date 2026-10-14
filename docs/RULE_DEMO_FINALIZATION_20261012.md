# RULE dashboard finalization — 12 October 2026

**Subsequent native verification:** see [the freshness repair and native rehearsal](RULE_FRESHNESS_REPAIR_20261012.md).
The updated dashboard/backend completed the saved RULE journey with independent
native arrival, zero recorded collisions or sensor faults, and finalized results.
The report below preserves the earlier offline verification state.

The existing dashboard, launcher, driving controls and recorded journey results
are integrated and verified offline. **RULE remains the startup default and the
primary journey action. MODEL is explicitly experimental.** A fresh live demo
rehearsal of this integration remains blocked; this report does not certify the
demo ready for an unattended presentation.

## Existing native evidence

The two completed seed 2811 RULE recordings are retained without alteration:

| Recording | Recorded duration | Final native distance / speed | Collision episodes |
|---|---:|---:|---:|
| `run_365ac6a864c840e695a7cc4e1f99709d` | 133.15 s | 1.179 m / 0.00343 m/s | 0 |
| `run_eaf8370a031c49159633dfeccb265d19` | 133.10 s | 1.226 m / 0.00342 m/s | 0 |

Both passed the existing actual-position and complete-stop arrival checks.
The route, start, weather, 40 vehicles, 30 pedestrians and initial-condition audit
are preserved in the active saved pair `90ab411017f54272b96493fd1cfea0de`.
These are regression observations of an inspected seed, not unseen TEST pairs.
Short stop/start cycles and close approaches remain. The repeat's measured
minimum planar clearance was 0.112 m; zero recorded collisions do not establish
a safe clearance margin. Full details and earlier failed runs are in
[the native journey repair report](NATIVE_JOURNEY_REPAIR_20261011.md).

## Integrated behavior

- **Launch:** verifies both dashboard assets and native telemetry. A fresh launch
  must report PAUSED with RULE enabled. An existing backend with the older
  journey interface is reported explicitly and requires `-Reload`.
  `Start-YA-RAB-OSTORHA.ps1 -Check` is read only and opens no browser.
- **Driving:** RULE receives primary emphasis. MODEL is labelled experimental.
  Requests remain behind the native ownership, freshness and control pipeline.
  Pending starts disable duplicate/overlapping actions. Coalesced WebSocket
  acknowledgements retire all preceding pending requests, preventing a stuck
  Starting state after a quick Start/Stop.
- **Stop:** cancels queued or preparing v2 runs as well as active journeys.
  Native cleanup and recording finalization stay on the simulation worker.
  The internal scenario-setup brake hold preserves its admitted run. Operator
  and emergency stops cancel it; emergency acknowledgement stays explicit.
- **Reset:** the backend stops the journey, finalizes an active v2 recording,
  restores the original safety supervisor, then resets the native vehicle.
  Historical comparison reset semantics remain intact. Reset never starts a
  replacement drive automatically.
- **Results:** the Results workspace shows saved destination-journey measurements
  separately from historical WITHOUT/WITH comparisons. Latest interrupted
  attempts remain distinct from previous terminal arrivals, including after a
  backend restart. Missing values say Not measured. The waiting estimate says
  Waiting proxy. Disconnect retains received saved results with an explicit
  connection-unavailable label, while removing live control authority.
- **Budget:** the UI reads the persistent experiment allowance and blocks new
  comparison journeys below the normal 600-second reservation. The backend's
  existing bounded research-run admission and 90-minute hard cap remain.
  No training runs from any launch or driving action.

The prediction policy, sensor freshness limits, braking/release thresholds,
three-clear-reading requirement, emergency protection, traffic-light behavior,
speed caps and learned weights were not changed. Lifecycle and presentation
code changed, so the previous recordings alone cannot validate those changes
on native hardware.

## Verification performed

- Python: **270 tests run, one skipped, all others passed**.
- JavaScript: **64 tests passed**; production dashboard bundle rebuilt.
- Browser integration rehearsal: RULE/MODEL protocol, queued Stop, manual
  start/stop, reset cancellation/confirmation, emergency latch and acknowledgement,
  five camera-selection controls, saved native results, interrupted retry,
  budget blocking and disconnected result retention passed. Five viewport sizes
  (1920, 1366, 900, 430 and 320 px) had no horizontal overflow or browser errors.
- Historical workspace rehearsal: keyboard tabs, continued autonomous inspection,
  intervention causes/timeline, modal emergency access, explicit reset, distinct
  archived results and six responsive viewports passed.
- Read-only launch check: the existing native host reports **connected, PAUSED,
  RULE enabled**. Dashboard assets are served successfully. Its
  `journey_interface_current` is **false** because it was started before these
  backend changes.

Browser rehearsals used real application assets and existing saved measurements
with an isolated WebSocket fixture. **No browser command was sent to CARLA.**
They verify UI wiring and rendering, not native camera alignment or driving
outcomes. The offline lifecycle tests verify cancellation, finalization-before-
reset ordering, emergency preservation, rejected-start ownership and launch
contracts with mocked native boundaries.

Machine-readable evidence is in
[the evidence directory](evidence/demo_finalization_20261011/):
`browser-report.json`, `workspace-report.json`, `launch-check.json`,
`rule-result.json`, `budget.json`, `verification.json` and `checksums.json`.
Browser screenshots remain in `output/playwright/demo-*.png`.

## Remaining blockers

1. **Updated backend is not loaded.** The current stopped native host still runs
   the previous Python code. Use the existing launcher with `-Reload` to load
   the integration. Cold startup, native Stop during setup and native Reset
   with these changes have not been re-rehearsed; the earlier CARLA setup access
   violation remains unexplained.
2. **Insufficient remaining experiment allowance.** The ledger is unchanged at
   **5,359.297 / 5,400 seconds (89.32 / 90 minutes)**, leaving **40.703 seconds**.
   The verified repeat alone took about 241 wall seconds. No new live journey,
   model experiment or training was started. A full fresh live rehearsal cannot
   fit within the remaining allowance. The ledger has not been reset or enlarged.
3. **MODEL/full v2 acceptance remains unproven.** No superiority claim or default
   enablement was introduced. The three independent final RULE/MODEL TEST pairs,
   measured risk calibration and generalization requirements remain outstanding.

The saved RULE journey is verified regression evidence; the updated integration
is offline-verified with the above live-verification blockers.
