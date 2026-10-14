# Congestion recovery — implementation and native result

14 October 2026. **Native recovery acceptance failed. Reverse, lateral recovery,
traffic-rule exceptions and additional depth cameras remain disabled in ordinary
driving.** This work implements a bounded sensor-based planner; it does not train
or certify a learned driver. Existing dirty repository changes were preserved.

## Behavior implemented

The route controller can request a short reposition after a measured stationary
front obstruction holds the vehicle, or a forward clearance maneuver when a
confirmed rear approach makes holding hazardous. Each candidate requires fresh
onboard motion observations, a clear measured swept footprint, and no predicted
intersection across the tracked hypotheses. Unknown space remains a veto.

The lease is limited to 1 m/s, 2 m travelled and 4 simulation seconds. Actual
braking detects congestion even when the route controller requests throttle.
Reverse gear is selected while stopped and throttle waits for actual gear
confirmation. Missing scenes, overspeed, frame gaps and uncertainty hold the
current gear; stopping precedes returning to forward gear and replanning.

Lateral proposals use permitted adjacent lanes and certify the steering command
that will actually be applied. A traffic-rule exception requires a confirmed
urgent rear conflict, an accepted capability and a clear path outside an
unverified junction. Collision checks and the independent forward safety layer
retain priority. These capabilities have no ordinary-driving acceptance.

Three low-resolution native depth cameras were tested on the rear and sides.
Their exact synchronized frames, axial depth and calibrated mounts supplement
the measured occupancy map. The fixed front depth channel remains the forward
supervisor's source. Own body returns are removed before occupied-cell dilation;
ground measurements cannot erase an occupied cell. Certification includes the
last path sample and the additional stopping tail. Depth projection and ray
processing run outside the command lock; measured control data is published
before display/model scoring. During recovery, display inference is deferred.

The older planner's maneuver cost now includes rear conflicts. Reverse odometry
uses signed travel rather than the speed magnitude.

## Native validation

The user authorized an independent **600-second** allowance. The new SQLite
ledger charged **573.298 seconds (9 min 33.298 s)**, including setup, cleanup,
failed probes and browser retries. Every reservation is finished. The historical
motion ledger remains at validation **1755.565 / 1800 seconds**, training 0 / 600.
It was neither reset nor extended. An expiring test ticket requires an unfinished
reservation in the independent ledger; a ticket file alone cannot enable motion.

Four rounds completed ten native CARLA 0.9.16 fixtures:

| Fixture | Repetitions | Result |
| --- | ---: | --- |
| Front blocked, rear clear | 4 | Clear rear readiness improved to 100%; no reverse execution |
| Front and rear blocked | 3 | No admitted escape; the final attempt paused on a sensor freshness fault |
| Front/rear blocked, adjacent lane available | 3 | No lateral execution; the final attempt paused on a sensor freshness fault |

The third round's clear-rear readiness map verified all **166 / 166 sampled
forecasts**. This metric covers the three-second readiness trajectory; it is not
the final admission certificate with its additional stopping tail, and does not
establish a safe dynamic maneuver. The blocked-rear case never certified that
rear corridor in the same round. See the frame-specific JSON evidence below.

No fixture executed `BACK_UP` or `CLEAR_LEFT/RIGHT`. Recorded motion was only
numerical drift (maximum about 0.0065 km/h). There were zero recorded ego contacts,
which provides **no moving collision-avoidance proof**. Forecasts often exceeded
the unchanged 0.1-second simulation age limit; other frames retained unconfirmed
or occluded tracks. Two final fixtures also exceeded safety observation freshness
and paused. The original 0.25-second wall bound was preserved.

Observer profiling exposed dense occupancy work as a substantial cost. Native
fixture throughput and track continuity did not establish acceptable sustained
recovery operation. The final restored held session measured 15.72 native ticks/s
and 15.75 camera frames/s. This is a cleanup measurement, not a matched performance
acceptance comparison. Live setup snapshots changed between rounds; each round
restored its captured operator setup. Physical traffic actor poses were recreated,
not restored exactly. No journey arrival or complete lane change was demonstrated.

## Fault label and cockpit verification

An old sensor failure previously remained latched after fresh synchronized data
returned while the vehicle was held. The status now clears only after the same
wall/simulation freshness and frame-identity checks used by safety pass. It does
not resume driving, and a model failure stays latched. Ordinary hold commands are
audited as `VEHICLE_HOLD`, distinct from a current emergency or sensor fault.

The cockpit displays protection state without controller/model names and shows
repositioning only from current maneuver telemetry. Native browser verification
passed nine checks: held vehicle, real 100% applied brake, advancing native camera,
fresh `STANDBY`, no experimental depth cameras, no browser runtime errors and no
controller names in the primary status. The final screenshot is
`output/playwright/recovery-native-final.png`. The task-owned browser was closed.

The temporary sensor actors were removed by a verified session restart. The
backend remains connected with the captured destination/population and the
vehicle held. Recovery acceptance flags are all false.

## Evidence and checks

- `output/congestion-recovery/budget.sqlite`, `final-ui.json`: independent ledger and final UI result.
- `output/congestion-recovery/native-readiness.json`: original read-only sparse LiDAR audit.
- `output/congestion-recovery/depth-probe.json`, `depth-probe-2.json`: failed and successful depth probes.
- `output/congestion-recovery/native-fixtures-1.json` through `native-fixtures-4.json`: native commands, sensor diagnostics, forecasts and outcomes.
- `output/congestion-recovery/final-native-session.json`: restored session and historical budget.
- `output/playwright/recovery-native-ui-final.txt`: nine passing native UI checks.
- `output/playwright/recovery-regressions.txt`: Python regression results.
- `output/playwright/recovery-frontend-tests.txt`: 103 passing JavaScript tests.
- `output/playwright/recovery-build.txt`: successful `npm run build:dashboard`.

Unit fixtures cover gear confirmation, cancellation while reversing, frame gaps,
speed/time/distance limits, occupied/unknown space, rear/front/crossing conflicts,
traffic lease expiry, lane permissions, signed odometry, calibrated projection,
own-body filtering, stopping-tail inclusion and ledger authorization. They do
not substitute for native motion acceptance.

Further acceptance requires reducing measured-scene latency and stabilizing
tracking while retaining the freshness veto, then demonstrating real reverse,
settling/replanning and lateral progress across blocked and crossing cases.
Recovery is not ready to enable for ordinary driving.
