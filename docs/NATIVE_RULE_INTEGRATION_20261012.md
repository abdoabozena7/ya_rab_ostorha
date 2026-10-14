# Native RULE integration verification — 12 October 2026

**Subsequent verification:** the [freshness repair and native rehearsal](RULE_FRESHNESS_REPAIR_20261012.md)
completed the same saved RULE journey with the updated backend, zero recorded
collisions or sensor faults, independent native arrival and finalized recording.
The report below preserves the earlier failure and its evidence.

**The demo is not ready for an end-to-end presentation.** Launch and the driving
lifecycle passed through the actual dashboard and real CARLA. The complete
updated journey did not arrive: the validated freshness protection stopped it
12.427 m from the destination. Its underlying sensor/publishing delay remains
unresolved. MODEL remains experimental and RULE remains the default.

## Verified in the actual application

The launcher reloaded the updated backend against real CARLA 0.9.16,
Town10HD_Opt, with seven native sensors. Startup checks confirmed connected native
telemetry, dashboard assets, PAUSED mode and enabled RULE safety. Live RGB video
and measured-motion prediction/minimap updates were visible.

Dashboard clicks and WASD input, using an unmodified WebSocket, verified:

- Explicit ownership transfer, manual throttle producing native movement, and
  stopping to below 0.15 m/s.
- RULE start and automatic live recording; Stop finalized an interrupted run.
- Reset during another recording sealed that recording, replaced the native ego,
  restored stopped RULE operation, and recorded `vehicle_reset`.
- Emergency stop during manual and RULE driving. The active RULE run ended with
  `emergency_stop`, recording finalized, the latch blocked starts, and explicit
  acknowledgement left the vehicle PAUSED.
- Results distinguish the latest failed attempt from the earlier saved arrival.
  After the reporting fix and backend reload, the actual Results page displayed
  `Latest attempt · RULE · FAILURE · ya_rab_ostorha_sensor_fault`.

Transient camera HTTP 503 responses occurred while sensors were rebuilt; live RGB
recovered. There were no JavaScript application exceptions or rejected command
messages in the successful lifecycle rehearsal or the repeated full journey.
Queued cancellation remains covered offline; no new native queued-cancellation
claim is made.

## Confirmed integration fixes

1. Reset previously sent Stop followed by Reset. The recording could finish with
   `operator_stop` before the reset request. Reset now disarms local input and
   sends one atomic backend reset; native repetition recorded `vehicle_reset`.
2. Emergency stop had the same preliminary Stop race. It now disarms local input
   and sends the emergency request directly. Native repetition preserved both
   the latch and the `emergency_stop` recording cause.
3. A fault-triggered Stop could preempt comparison completion and classify sensor,
   model or heartbeat failures as INTERRUPTED. New results classify these as
   terminal FAILURE, retain the original cause and diagnostic, and save the
   failure result. Summaries of older v2 fault results also display FAILURE;
   original recording files remain unchanged. Offline coverage and actual
   dashboard display after reload passed. A new driving fault after this
   classification fix has not been rehearsed.
4. Separately authorized RULE validation uses expiring tickets and its own phase
   log. It never writes the research ledger and rejects MODEL runs. An absolute
   deadline watchdog rechecks expiry after a host clock jump; offline coverage
   passed. Normal research admission retains its existing 600-second allowance.
   The dedicated validation UI requires at least 300 seconds for the known
   approximately 241-second journey and bounds execution by the remaining grant.

Prediction/controller policy, scenario recipe, weights, sensor freshness limits,
braking/release thresholds, emergency protection and explicit fault-resume
requirements were preserved. Checksums confirm the three frozen safety/scenario
files, both weight files, and the research SQLite ledger are unchanged.

## Full journey attempts and remaining blocker

Both attempts restored pair `90ab411017f54272b96493fd1cfea0de`, seed 2811,
including the approved start, destination, route, weather, 40 vehicles and 30
pedestrians. Their initial-condition audits passed. Reactive traffic after
startup is not claimed to be identical to earlier recordings.

| Attempt | Outcome | Recorded simulation duration | Collision callbacks / episodes |
|---|---|---:|---:|
| `run_d460ffb9b94b4e8ca3279aa9fda12675` | Interrupted: `controls_released`; observation timeout followed | 26.25 s | 0 / 0 |
| `run_6dcb6e9c4f564b84a40a37bc7713f4c5` | Sensor freshness failure; no arrival | 135.05 s | 0 / 0 |

The first browser/control session disappeared and the host clock advanced past
its authorized window. The exact cause of that interruption is unproven. Its
first SDK observer returned frame zero, so that pose sample is invalid and is
retained as unverified evidence. The observer now waits for a real native tick
without advancing physics itself.

The repeated attempt failed with **Fresh complete safety observations
unavailable**. A separate native SDK observer verified the ego stopped with
throttle 0 and brake 1, **12.4268 m** from the destination, at approximately
**0.000067 m/s**. This is a safe failure response, not successful arrival.
The fault's underlying cause has not been established, and no freshness threshold
was relaxed. Further investigation and a successful complete journey require
another separately authorized native validation window.

The repeat recorded 172.19 m of route progress (92.88%), 168 harsh-braking events,
55.45 s stopped time and 3.10 s measured emergency intervention. Minimum planar
clearance was **0.0101 m**; zero recorded collisions do not establish a safe
clearance margin. Geometric processing P95 was **8.52 ms**, and controller
pipeline P95 was **15.84 ms**.

The four lifecycle/partial recordings and the repeated journey are finalized,
Replay-readable and have zero dropped frames, events or trace rows. The repeat
contains 2,702 native frames, 2,702 safety sidecar frames and 2,700 command trace
rows. The terminal fault row has no computed pre-protection command; its actual
full-brake command and sensor-fault cause are recorded. The strict command
coverage check therefore remains false. No successful new arrival is inferred
from the old saved arrival or the partial recordings.

## Budget, checks and final state

The user separately authorized up to 20 minutes, then up to 10 more minutes
following the interruption. These were RULE integration validation only. No
training or MODEL experiment ran. The original research ledger remains exactly
**5,359.297 / 5,400 seconds**, with **40.703 seconds** remaining and the same file
checksum. The driving experiments ended within their authorized windows. After
the second window, work was limited to offline analysis, paused-state recovery
and read-only result inspection.

An offline regression test briefly wrote a fixture into active-pair storage.
Its isolation was corrected; the saved pair was restored from its existing
pair-specific manifest and verified. Native recordings were untouched. The
fixture artifact was removed. The full corrected suite passed without changing
the restored pair.

- Python: **273 tests run, 272 passed, one skipped**.
- JavaScript: **64 passed**; dashboard bundle rebuilt.
- Native lifecycle browser rehearsal: PASS.
- Active RULE emergency rehearsal: PASS.
- Final failure/results display: PASS.
- Complete updated journey / end-to-end acceptance: **FAIL — sensor freshness**.

The final ordinary backend is connected, **PAUSED with RULE enabled**, recording
off, and the saved seed 2811 pair restored. The read-only launcher check passes.
New recorded comparison journeys remain blocked by the exhausted research
allowance; further live validation requires a separate authorized window.

Evidence is in [native_rule_integration_20261012](evidence/native_rule_integration_20261012/).
Key files are `browser-lifecycle.json`, `active-emergency.json`,
`browser-journey.json`, `browser-results.json`, `recording-audit.json`,
`independent-arrival.json`, `partial-recording-audit.json`, `preservation.json`,
and `validation-authorizations.json`. Earlier interrupted evidence is retained
under `interrupted-journey/`. Actual application screenshots are in
`output/playwright/native-rule-*.png`.
