# Brake decisions and Normal control — 14 October 2026

The protected RULE driver no longer starts a full brake because an empty
measured corridor misses the two-metre release margin. NORMAL no longer applies
sensor obstacle gating to either manual pedals or autonomous route commands.

## Protected driving

The start envelope remains `d + tau*v + v²/(2*a)`, using the existing teacher
clearance, reaction time and assumed deceleration. The release margin is separate;
measured obstacle/TTC hysteresis, minimum hazard hold and gradual release remain.
Missing targets never certify unobserved space.

Measured road range `L` sets a speed bound:

`v_limit = sqrt((a*tau)² + 2*a*max(0, L-d)) - a*tau`

The controller limits acceleration toward that bound and scales coverage braking
with overspeed. A useful but short horizon does not automatically request full
braking. No usable stopping space holds the car; a measured obstacle inside the
existing envelope or confirmed physical path conflict retains protective braking.
Steering, gear and the sensor feasibility/admission checks remain in force.

## Normal driving

Manual NORMAL commands reach the arbiter without sensor pedal rewrites. Autonomous
NORMAL retains the native route, target-speed controller, traffic lights and stop
signs; it ignores native vehicle queries and bypasses maneuver, rear acceleration
and recovery overlays. The independent observer still evaluates and records risk.
An observer processing/freshness error is logged and does not stop NORMAL.

Ordinary operator stops, the emergency latch, invalid/stale commands, connection
loss and navigation heartbeat expiry still apply in both modes. A worker/runtime
failure still stops the vehicle. Emergency acknowledgement leaves it held and
requires an explicit driving start.

The primary buttons are labelled **إيقاف العربية**, **إيقاف طوارئ**, and
**فك إيقاف الطوارئ**. Emergency release is in the main header. The applied brake
percentage now has its source and reason beside it. Free GPU retains its simulator
shutdown action.

## Recording

Safety failures retain their original exception type, traceback, pipeline stage,
sensor frame, driver command and actual applied command. Worker exceptions retain
the same original error details through cleanup. Terminal failures are saved as
ERROR attempts. Automatic recordings close after the terminal command is applied,
audited and its next available native frame recorded. A stop detected after a tick
waits for the subsequent command application before sealing the recording.

The comparison result saves terminal diagnostics, so a later focus-lost stop cannot
replace the cause of the previous attempt. New metadata and decision rows include
onboard vehicle geometry for reproducible sensor projection. This does not recover
an exception that was omitted from an old recording.

## Verification

- 415 Python tests passed; one existing test skipped. The full suite covers empty
  straight roads, curves and a parallel surface outside the route in both modes,
  real measured hazards, fresh/stale observer failures, progressive coverage
  braking, operator stops, emergency acknowledgement and communication expiry.
- 104 JavaScript tests passed; dashboard JavaScript and CSS bundles rebuilt.
- 34 isolated browser checks passed across eight widths (320–1720 px), including
  visible release controls, brake attribution, no horizontal overflow and no
  implicit restart after acknowledgement. API commands and WebSocket state were
  intercepted; screenshots use a saved CARLA image.
- Recorded native sensor frame **681587** from `run_88bdd7307a72435b864077e71a31a07b`
  reproduced the archived **4.986027 m** road coverage and no measured target.
  With the same steering and a 75% throttle request, the corrected protected and
  Normal commands both preserve **75% throttle / 0% brake**, compared with the
  archived **0% throttle / 100% brake**. The speed bound is **3.037773 m/s**
  (10.936 km/h); the current stopping envelope is **3.000076 m**.

The old recording did not include geometry. This sensor replay uses read-only
onboard specifications of the currently connected matching Lincoln blueprint,
and reproduces the archived coverage exactly. The report states that provenance.
This is a fixed sensor-frame reevaluation, not a new closed-loop CARLA journey or
evidence of a reduced collision rate. This initial verification was limited to
sensor replay; the subsequent native checks are documented below.

Evidence: [saved frame](evidence/braking_repair_20261014/saved-frame.json),
[browser checks](evidence/braking_repair_20261014/browser-checks.json),
[Python suite](evidence/braking_repair_20261014/python-tests.txt).

The stopped native backend was reloaded with the correction, preserving the
operator's pose, destination and preferences. A read-only check confirmed a new
connected session, PAUSED, zero speed, RULE enabled and no sensor errors. The
new diagnostic fields and onboard geometry are present in the live snapshot.
See [runtime check](evidence/braking_repair_20261014/runtime-after-reload.json).

The repeatable command/recording regressions are in
`tests/test_braking_decisions.py`, `tests/test_active_safety.py` and
`tests/test_normal_navigation.py`. The isolated browser check is
`scripts/verify_braking_repair_ui.js` (serve this repository on port 8012, then
run it through playwright-cli).

## Follow-up: repeated live stop and curved-road range

The user's next live drive reached approximately 30 km/h, then ended after
2.85 simulation seconds. The recorded error was `Safety processing exceeded
sensor wall freshness limit`: frame 46066 was 281 ms old after processing,
exceeding the existing 250 ms limit. A later attempt also supplied a complete
synchronized frame 343 ms old before evaluation. Subsequent focus-lost events
had obscured both original terminal causes in the current dashboard.

Primitive JSON validation now avoids expensive mapping checks on every numeric
trajectory sample. Continuous occupancy coverage checks all original body poses
in one array operation instead of repeated small calls. Unused legacy forecast
copies are deferred until an admitted maneuver/recovery consumes them. Occupancy,
unknown gaps, sensor age limits and geometric feasibility remain enforced.

Expired proposals never authorize motion. A transient processing overrun, or a
late complete synchronized frame in an active autonomous journey, admits only
full braking while waiting for the next fresh frame. A fresh successor can release
that hold gradually within the same driving intent. Delays persisting for one
second are terminal. Missing, invalid or simulation-stale input, manual input
expiry, browser heartbeat expiry and explicit stops remain terminal. Recovery
cannot restart a user-stopped journey.

The loaded-dashboard live check then exposed another geometric fault: the circular
steering corridor measured foreground with `x - front` rather than ordered arc
length. A return roughly 17 m to the side on the far part of the circle looked like
a target only 0.8 m ahead. The range now follows the turn arc. Three recorded native
frames changed from 1.89/0.80/0.86 m to 16.24/20.24/21.45 m; their commands changed
from full brake to the requested 75% throttle and zero brake. Tests preserve full
braking for a real close obstacle on either turn direction. A distant surface
cannot override the speed bound from shorter contiguous observed road coverage.

The dashboard preserves the original stop reason, displays an explicit
**استئناف القيادة** action for interrupted journeys, and distinguishes arrival,
red-signal waiting and temporary sensor holds. The brake card now reserves space
for its reason instead of clipping it. Resume retains the selected driving mode;
it cannot bypass a traffic signal or restart an arrived route. Final navigation
braking is audited as the current base route command rather than a past request.

### Follow-up verification

- The full suite passes 424 Python tests (one existing skip) and 107 JavaScript
  tests. Dedicated regressions cover transient/persistent delays, late complete
  frames, missing/stale input, operator cancellation during recovery, curved
  range, genuine close obstacles and exact terminal command attribution.
- 53 isolated browser checks passed, including original error retention, explicit
  resume, visible brake reasons on narrow layouts, red-signal waiting and arrival.
- The initial protected 40-second live check moved 59.6 m at up to 30.7 km/h.
  The first short Normal check moved 2.9 m before a legitimate red signal and
  remained RUNNING; its minimum-distance check did not pass. A following Normal
  drive moved 45.0 m, reached its destination and stopped. Driver pedals and
  steering were preserved throughout Normal samples, including signal stops.
- The initial loaded-dashboard check failed progress and exposed the arc bug.
  After correction, the same route/start moved **64.4 m during 45 wall seconds**,
  at up to **30.8 km/h**, with the real RGB/forecast dashboard loading alongside
  the production command client. One sampled sensor-delay hold recovered;
  the journey remained RUNNING until the verifier's explicit stop. No native
  collisions were recorded in these checks.

These are bounded native intervals with evolving traffic, not matched causal
experiments or general collision-rate validation. The verifier leaves the live
vehicle connected, stopped, and recording finalized. The final read-only snapshot
confirmed zero speed, no sensor errors and the preserved route.

Evidence: [native attempts and summaries](evidence/braking_repair_20261014/live-followup.json),
[turn-frame replay](evidence/braking_repair_20261014/followup-curve-replay.json),
[browser checks](evidence/braking_repair_20261014/followup-browser-checks.json),
[Python checks](evidence/braking_repair_20261014/followup-python-tests.txt),
[JavaScript checks](evidence/braking_repair_20261014/followup-js-tests.txt),
[final runtime state](evidence/braking_repair_20261014/runtime-after-followup.json).
The repeatable bounded native command check is
`scripts/native/verify_processing_recovery.py`; the isolated browser check is
`scripts/verify_processing_recovery_ui.js`.
