# Automatic presentation and journey continuity â€” 15 October 2026

The main dashboard is English and exposes **Restart** for one automatic,
recorded Robosphere â†’ Normal presentation at a requested 50 km/h. No Scenarios
visit, destination choice, traffic configuration or second Start click is
required. **Custom drive** retains destination selection and 20/30 km/h ordinary
RULE journeys. The experimental hybrid and independent BehaviorAgent benchmark
retain their separate admission gates and protocol.

## Confirmed causes of the reported stops

The two latest operator recordings before this change were waiting for a red
signal: 173/206 and 169/215 recorded decisions identified the navigation signal
stop. `run_37bcde7979fc43a9925a551eb7d00965` then ended with `focus_lost`;
`run_3c86841580f040e49970464dbfa706af` ended with `simulator_shutdown`. These
are distinct from an obstacle or a sensor failure. Signal waiting must continue
the existing journey automatically rather than require another Start action.

The first new native presentation also exposed a real processing problem:
full hybrid tracking/forecasts ran in the ordinary RULE control publication
path, and a retained decision had 453 ms sensor-to-scene delay. It ended with
the original `Fresh complete safety observations unavailable` exception. That
failure is retained, not replaced by a later successful attempt.

The repairs are:

- Autonomous journeys use actual ping/pong acknowledgements from the current
  WebSocket owner as an independent one-second connection lease. Hidden-tab
  JavaScript timer throttling and workspace inspection do not cancel the route.
  Manual input still requires focus. Closing the owning page, an expired
  connection, Stop or Emergency stop still holds the vehicle; no automatic
  restart follows those events. The 350 ms actuator lease and existing sensor
  freshness limits are unchanged.
- Ordinary RULE consumes current calibrated depth/LiDAR geometry without
  waiting for unused hybrid forecasts. Full motion tracking remains in the
  display observer. The hybrid and admitted recovery planners still request
  the complete control scene. Missing space remains unknown.
- WebSocket pages share a bounded serialized snapshot cache. The stream omits
  raw canonical sensor payloads, duplicate actor manifests and native registry
  dumps; full HTTP diagnostics and original recording data remain available.
- A rejected late proposal applies a full brake on that tick. It does not
  manufacture an obstacle hysteresis period for subsequent fresh decisions.
  Fresh obstacle measurements still brake, and sustained timing failures still
  terminate. The next valid decision clears the old timing attribution.
- Applied brake reasons, elapsed waiting time and recorded stop/resume events
  remain visible beside the camera. Red signals explicitly promise automatic
  continuation; operator pauses and faults offer an in-place recovery action.

## What Restart does

The native simulation worker owns the presentation lifecycle. It stops/finalizes
the previous journey, chooses one of two Town10HD starts and a native route of
about 260 m, generates a fresh seed and prepares 20 traffic vehicles and 15
pedestrians with the FAST traffic pace and BUSY behavior. The second arm uses
the same seed, route, requested speed and restored initial fixture, including
owned actor poses/profiles, lights, sensors and zero velocities. Each arm's
actual initial-condition audit remains visible in the evidence.

Robosphere uses the existing RULE-protected route follower. Normal retains its
historical route-and-signals behavior with obstacle protection off; it is not
relabeled as CARLA's protected BehaviorAgent baseline. Both use the same map
speed policy and goal approach. A requested 50 km/h is not a guarantee that
either driver reaches or sustains 50 km/h. Existing ordinary Normal journeys
still cap at 30 km/h; the extension is scoped to an identified presentation.

After each run, the worker waits for actual recording finalization before
restoring the next arm. Contacts and supported route failures remain measured
outcomes. Configuration, sensor, export and communication failures stop with
their original cause; the presentation does not silently retry for a favorable
outcome. Runs and failures remain in `output/presentations/` and
`output/journey-comparisons/`; raw camera/sensor data remains ignored in `runs/`.

Original driving-camera frames are exported to MP4. New presentation exports
start at the admitted RUNNING event, excluding setup frames. The longer video
leads synchronized playback, so an early-ending arm does not truncate the
other recording. The browser acknowledges the actual longer video's end before
the presentation reaches COMPLETE and scrolls to the measured results.
Muted playback supports browser autoplay; a blocked/error state offers Replay
both. Each column reports contacts, forward near misses, harsh braking,
interventions, time, distance and measured versus requested speed. Interrupted
runs are not presented as successful comparisons or prevented collisions.

## Verification and limits

Native presentation evidence and exact outcomes are indexed in
[the retained summary](evidence/presentation/native.json). Browser evidence,
software counts and source identity are indexed in
[verification](evidence/presentation/verification.json). Screenshots use actual
native MP4s, not generated substitute footage.

Two complete presentations and the intermediate failures are reported
individually. Seeded reactive traffic can diverge after the drivers choose
different actions. A matched initial fixture does not prove identical hidden
drivetrain state or future traffic. A Normal contact and a zero-contact RULE
run are observations from those attempts, not a causal estimate of accidents
prevented. Signal waits, protective interventions and failed acceptance
criteria stay visible.

| Native presentation | Robosphere | Normal | Presentation lifecycle |
| --- | --- | --- | --- |
| `ebce6a36a3384331a97dd86d1581bafa` | Arrived, 262.7 m, no contact; peak 45.6 km/h | Contact after 139.3 m; peak 50.3 km/h | Automatic restoration, export, playback and COMPLETE |
| `1603fc8a4d304c839d93c35f8b39fd1c` | Arrived, 257.3 m, no contact; peak 49.3 km/h | Arrived, 257.0 m, no contact; peak 50.3 km/h | Started from CARLA stopped with one Restart click; both exports anchored to admitted start; COMPLETE |

The latest pair recorded 6/5 harsh-braking episodes and 57/0 protective
intervention episodes for Robosphere/Normal. Robosphere had 25 sensor-delay
hold decisions out of 1,834 retained control decisions. These outcomes remain
visible; arriving does not establish the 99% freshness or general comfort gate.
Both arms waited approximately 57 simulation seconds for traffic lights, which
explains much of their low mean speed (10.0/10.4 km/h). These are separate
revisions/seeds, so their differences are not a controlled before/after result.

The full cold-start browser rehearsal passed 17 real UI/video checks. On the
final cancellation revision, native Stop and Emergency stop were both issued
**during PREPARING**. Both stayed cancelled for at least 15 further native
frames with throttle zero and brake one. Emergency acknowledgement returned to
PAUSED without resuming; the completed comparison remained intact. The first
15-frame check used the existing 0.15 m/s stopped tolerance while the teleported
vehicle settled; the final measured speed was exactly zero.

Final control verification completed on 16 October (Africa/Cairo).

Software verification discovered 510 Python tests: 509 passed and one optional
test was skipped. All 118 JavaScript tests passed and checked-in assets were
rebuilt. The final cancellation/timeout guards and small display wording fixes
followed the complete cold-start rehearsal; their source changes are enumerated
separately in verification, with the final native cancellation checks and
offline suites. The earlier complete recordings retain their own source hashes.

This work verifies the presentation lifecycle and repairs demonstrated sources
of unwanted cancellation and processing delay. It does not establish general
smoothness, all maneuvers, the frozen ten-journey cohort, or hybrid acceptance
up to 50 km/h. Those unfinished gates remain documented in
[the hybrid implementation report](HYBRID_DRIVING_IMPLEMENTATION_20261015.md).

Reproduce software checks with `npm test`, `npm run build:dashboard` and
`.\.venv-carla\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'`.
For an explicitly requested native rehearsal, open the dashboard, press Restart
once and use `python -m scripts.observe_presentation --output <local JSON>` for
a read-only phase/measurement record. `scripts/verify_presentation_results_ui.js`
checks the completed native result in Playwright. Neither verifier drives the
vehicle or invents evidence.
