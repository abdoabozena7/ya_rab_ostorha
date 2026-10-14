# Normal sensor navigation and rear-approach response

Historical report: the forward sensor gate described below was removed from
NORMAL on 2026-10-14. Current behavior and validation are documented in
[BRAKING_DECISION_REPAIR_20261014.md](BRAKING_DECISION_REPAIR_20261014.md).

The user's CARLA screenshots showed a stopped protected drive with a measured
forward gap of 0.8 m and a vehicle approaching from behind. The rear approach
and front gap are separate observations. A rear-only approach must not request
forward braking, but it also cannot justify accelerating into a measured front
obstacle. The current `path_conflicts` policy already excludes rear-only motion
from its forward cut-in trigger.

## Control change

- NORMAL remains autonomous: the native route follower steers along the chosen
  CARLA route and obeys traffic signals and stop signs. It no longer queries the
  privileged CARLA vehicle list to decide forward vehicle clearance.
- The ordinary forward gate uses the existing synchronized radar, LiDAR and
  depth assessment. It requires an observation no older than 0.15 simulation
  seconds and applies a simple `2.5 + 0.55v + v²/7` metre stopping distance
  (v in m/s). Unknown or short forward coverage holds the car.
- A LiDAR surface track labelled `REAR_APPROACH` for at least five frames with
  time to conflict at most two seconds may raise route throttle to 0.55, capped
  at 0.75. This only happens with verified forward clearance, no base route
  brake, steering demand at most 0.2, no experimental maneuver planner and
  speed at least 1 m/s below the
  selected target. The existing RULE layer remains the braking authority in
  ROBOSPHERE mode. A newly detected hazard still overrides throttle.
- The live Driving strip shows current native collision episodes. Its rear
  status explains whether the car can proceed or must hold for a close front
  obstacle. Complete collision and near-miss measurements remain in Results.

## Verification and remaining limit

The full local suites pass: 351 Python tests (one skip), 91 JavaScript tests,
and 119 isolated browser checks across eight viewport sizes. The browser
fixture intercepted every simulation command and used a saved CARLA image.
The pure controller tests cover rear closing, front-first braking, red lights,
stale observations and the one-frame observation-to-control handoff.

An offline read of a previously recorded NORMAL trace found 3,422 measured
frames: 3,173 clear, 173 unknown and 76 forward-risk frames. Applying the new
gate to that fixed trace would add braking on 258 frames, with the longest
continuous interval about three seconds. This is a diagnostic replay, not a
closed-loop outcome; the vehicle and other actors would move differently under
the new commands.

With the operator's approval, the old CARLA and backend processes were stopped
through the dashboard's native shutdown path and restarted on 2026-10-13. A
40-second live NORMAL smoke drive on Town10HD_Opt used a 20 km/h target and the
existing 40-vehicle/30-pedestrian, 85%-chaos population. The route follower
reduced remaining distance from 94.46 m to 20.09 m; top sampled speed was
22.18 km/h. All 188 snapshots reported `SENSOR_BASELINE`, the sensor registry
was fresh, the collision sensor reported zero callbacks, and the backend
reported no sensor errors. A red traffic light caused 85 braking samples. The
car was stopped after the check, and the native session remains connected and
paused. The raw measurements are in `output/normal-navigation/native-smoke.json`,
with a compact checked-in summary in
`docs/evidence/normal_navigation_20261013/live-native-smoke-summary.json`;
the repeatable short probe is `scripts/native/smoke_normal_navigation.py`.

No confirmed rear approach triggered the bounded assist in this drive, so that
branch has focused controller tests but no native rear-approach observation yet.
One collision-free interval cannot establish a reduced collision rate. A
matched multi-seed native comparison would be needed for that claim.
