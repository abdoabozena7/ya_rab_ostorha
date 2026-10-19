# Fair sensor comparison and recorded forecasts — 19 October 2026

Autonomous **Normal now brakes using sensors**. Both guided arms use the same
Mercedes coupe, physical geometry and sensor rig. Robosphere adds the current
predictive RULE behavior. Reinforcement learning is not enabled or claimed in
this delivery. Historical recordings keep their actual protection settings.
Each guided arm recreates the same Mercedes with the same paint, resetting the
native engine/transmission state even when the blueprint already matches.

## Controller contract

The native route follower continues to own route steering and traffic-signal
commands. Its privileged vehicle-list detector is bypassed in both ordinary
sensor drivers. Normal's obstacle protection is supplied by calibrated radar,
LiDAR and depth measurements through the existing safety admission and command
arbiter, rather than by disabling protection or reading target actor poses.

The two drivers share forward measurement fusion, physical stopping envelopes,
measured closing-speed/TTC checks, coverage speed limits, braking hysteresis and
freshness limits. Normal does not call the path-conflict motion tracker or
possible-start pedestrian forecast. Robosphere retains those predictive checks
and its existing available maneuver behavior. A basic stopping envelope and TTC
are reactive safety calculations; this comparison does not claim that all
production vehicles lack motion prediction.

Normal's safety step runs before command application. Missing or invalid safety
measurements hold/stop automatic driving using the same existing limits.
Changing between drivers resets anticipation state and cached proposals. Manual
Normal still preserves the driver's pedals and steering; the separate
BehaviorAgent/hybrid research protocol retains its own identity.
Manual recordings cannot inherit a previous autonomous driver profile, and
recorded autonomous capabilities cannot be changed mid-drive. Version 6 risk
and coverage metrics use the same reactive forward assessment in both arms;
historical research metrics retain their original path-conflict interpretation.

New results use `SENSOR_REACTIVE_PREDICTIVE_V1`, comparison version 6 and a recorded
`driver_profile`: actual controller, sensor braking, motion prediction and
explicit false values for learned control and reinforcement learning. Setup
comparison additionally binds vehicle geometry, physical configuration and
sensor configuration. Verified initial-condition audits remain necessary before
the UI reports matching starts. Future traffic reactions may diverge.

## Video and interface

Protected forecasts appear inside the camera view without opening Details.
Normal's driving camera hides project forecasts, including when Details is open.
The guide, driver choices, live braking source, requested/measured speed and
recorded outcomes explain the actual distinction. Known historical protection-off
protocols keep that label; missing legacy capability records stay unknown.

The introductory illustration now stops **both** drivers before the person and
lets both resume after the same crossing clears. The predictive illustration
slows earlier. No collision or winning outcome is scripted into Normal.

New camera index rows preserve the actual camera world transform. The recorder
saves bounded `VIDEO_PREDICTION` views from the measured control scene independently
of browser display requests. Export uses only forecasts from the recording's
session with source frame/time no later than the image, crops elapsed path time
and suppresses forecasts older than 0.75 simulation seconds. This display limit
does not relax control freshness. A missing forecast is labelled unavailable,
without drawing an invented trajectory.

Original camera bytes and `driving.mp4` remain intact. The derived
`driving-annotated.mp4` contains controller labels and, for Robosphere only,
measured predicted paths: coral for classified people and cyan for other tracks.
`video-status.json` preserves the raw checksum and adds independent variant
checksums, annotation status, actual forecast coverage and the preferred asset.
Playback and downloads select the annotated asset for new comparisons. Both
variants use the production bounded byte-range handler. Raw-history retention
waits for required annotations and verifies their checksum before retiring raw
sensor assets; old recordings retain their original export contract.

The [native annotated pedestrian frame](evidence/sensor-comparison-20261019/native-pedestrian-forecast.png)
is decoded at 5.1 seconds from a retained MP4; its video, image and source-archive
checksums are in [the frame provenance](evidence/sensor-comparison-20261019/native-frame.json).
The coral possible-crossing path is inside the actual recorded camera image.
[Native video playback](evidence/sensor-comparison-20261019/native-video-ui.png)
uses actual camera exports with explicitly isolated dashboard state.
[Driver choices](evidence/sensor-comparison-20261019/fixture-choices.png) and
[mobile framing](evidence/sensor-comparison-20261019/fixture-mobile-forecast.png)
are labelled UI fixtures, not another native drive.

## Verification and evidence

Focused controller, projection, export, range-serving, storage and historical
compatibility regressions pass. Browser fixtures verify actual canvas pixels,
stale-data removal, responsive framing, capability labels and the absence of a
forced collision. Browser fixtures are software/UI evidence, not native driving.

The native matrix runs the existing production worker in isolated processes,
with Mercedes, real physics/cameras and real RGB classification. It uses three
fixed seeds (1701, 2811, 4137) for empty road, front obstacle, braking lead vehicle
and pedestrian crossing. All source archives, recordings, failed outcomes and
internal bounded reservations remain local under `output/`; research ledgers
are not reset. Results and final verification are indexed in
`docs/evidence/sensor-comparison-20261019/`.

The [completed native matrix](evidence/sensor-comparison-20261019/native-matrix.json)
contains **24 trials, zero registered contacts and 16 arrivals**. All 24 raw and
annotated exports are ready. All 12 independently constructed pairs matched the
diagnostic initial pose/velocity/settings checks and recorded physical/sensor
configurations. These are diagnostic comparisons, not production reconstruction
audits. The
repair-ticket rig had 16 native sensor actors; this does not qualify the ordinary
unticketed rig or the dense 60/100 city at 80 km/h.

| Case, three seeds each | Normal arrivals | Robosphere arrivals | Contacts |
| --- | ---: | ---: | ---: |
| Empty road | 3/3 | 3/3 | 0 |
| Stationary front obstacle | 0/3, stopped before it | 2/3 | 0 |
| Braking lead vehicle | 3/3 | 2/3 | 0 |
| Pedestrian crossing | 3/3, passed before road entry | 0/3 within 25 simulation seconds | 0 |

Normal stopped after **8.45 m in all three front-obstacle trials**. Its common
range-approach controller slowed/braked through NAVIGATION; an additional direct
sensor override was only one low-brake frame. The original matrix gate required
direct override samples above 0.1 and marked these trials failed. That original
gate/outcome remains preserved. The audit separately records the real range
approach, native stopping, motion and absence of contact; it does not force a
worse Normal result or turn the original matrix into a pass.
The runner's final scoring now recognizes applied measured-approach braking
and low-pressure sensor braking, and excludes startup holds. Its focused
regression rejects an ordinary route brake without measured approach evidence.

The first empty-road pair reached its destination: Normal 44.24 m / 31.02 km/h
peak, Robosphere 41.56 m / 29.65 km/h peak, both requesting 30 km/h. Normal's
crossing-exposure count was zero in all three pedestrian cases: it had already
passed when the person entered the lane. Robosphere had 85–86 independently
observed moving-person exposure frames and remained incomplete at the time
limit. These are different actual outcomes, not proof that Normal cannot handle
a crossing or that Robosphere is superior.

**The original matrix and general driving acceptance remain failed/unaccepted.**
Shortened progress, unverified comfort and requested speed are not hidden behind
zero contacts. Native source archives bind each original trial. The final
metadata/research-metric guard and same-model respawn follow-up have final-source
offline verification; the separate [held native reset audit](evidence/sensor-comparison-20261019/same-vehicle-reset.json)
verifies two distinct fresh Mercedes actors, identical paint/physics/sensors,
passing initial-condition audits, cleanup and return to a stopped engine. That
audit uses the ordinary eight-actor sensor rig and is a lifecycle check, not two
additional driving trials.

## Final software checks

- `npm run build:dashboard`: passed; checked-in JavaScript and CSS regenerated.
- `npm test`: all **167 JavaScript tests** passed.
- Python discovery: **680 tests**, **678 passed**, two optional skips.
- **11 browser checks** passed across isolated forecast/capability fixtures and
  actual native MP4 playback/download with production HTTP byte-range requests.
- [Verification index](evidence/sensor-comparison-20261019/verification.json)
  keeps software, UI, video playback and native-driving scopes separate.

Repeat the offline suites from the README. With the ordinary dashboard stopped,
`python -m scripts.native.validate_sensor_comparison` retains a fresh bounded
matrix and source archives. `python -m scripts.summarize_sensor_comparison
<matrix-summary> --output <audit.json>` audits it without rewriting original
outcomes. The held reset probe requires CARLA to be stopped and returns it to
that state. Native runs require the existing local CARLA/model installations;
raw recordings and source archives remain ignored local evidence.
