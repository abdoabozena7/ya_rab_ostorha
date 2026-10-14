# Driving studio redesign

## Repository audit and implementation plan

The served application is `index.html` plus the esbuild-generated
`frontend/dashboard.bundle.js`. `dashboard.js` installs the existing presentation,
traffic preparation, city setup, perception, prediction, research and driving
studio modules. This work extends those modules; it does not replace the native
simulation, control arbiter, RULE policy, recording or experiment budgets.

Visual thesis: a quiet ice-coloured workspace, black navigation rail and one
large, dark simulator surface. Content hierarchy: guided preparation, road and
map, supporting cameras/telemetry, then recorded comparison. Interaction thesis:
progressive step disclosure, an explicit two-mode reveal, and in-place map and
simulator expansion, with reduced-motion support.

Implementation sequence:

1. Consolidate the two-page shell and contextual tools while retaining handlers.
2. Repair guided preparation, readiness and missing-mode recovery transitions.
3. Consolidate the map around native world coordinates and fresh predictions.
4. Present paired recordings, unavailable measurements and setup provenance.
5. Rebuild, exercise isolated backend fixtures, inspect responsive layouts, and
   run the existing JavaScript/Python regressions.

## Audited backend contracts

| Purpose | Contract | Authority |
| --- | --- | --- |
| Engine launch | `POST /api/simulation/start` | Starts CARLA held; does not start driving |
| Readiness | `/api/simulation/status`, WebSocket snapshots | Session, connection, ownership, mode and fresh aligned telemetry |
| Ownership | `take_control` | Existing exclusive owner and held-vehicle semantics |
| Destinations | `/api/simulation/catalog`, `destination` | Native roads, searchable/favourite places, route planner |
| Road preparation | `crowd_route` | Route-specific admission receipt, seed, requested/actual population |
| Journey start | `start_journey` with `driving_mode` | Native runtime validates stopped state, route, recording and readiness |
| Paired setup | `prepare_journey_mode` with `pair_id`, `mode` | Restores manifest while held; explicit start still required |
| Prediction | `/api/simulation/prediction` | Timestamped tracks, trajectories, reference pose, source and conflicts |
| Results | snapshot `journeyComparison` | Persistent run IDs, manifests, recordings, events and measurements |
| Stop / emergency | `stop_driving` / `emergency_stop` | Distinct ordinary stop and immediate latched emergency |
| Reset / engine stop | `reset`, `world_reset` / `stop_simulator` | Existing distinct operations and GPU shutdown |

Ya Rab Ostorha (`ROBOSPHERE`) uses the project's route agent and established RULE
protection. Normal (`NORMAL`) uses the native route and signal follower, with
forward vehicle clearance gated by synchronized radar, LiDAR and depth instead
of CARLA's actor-list obstacle query. RULE proposals remain observed for common
measurement but are not applied in Normal. Neither choice launches experimental
MODEL research. A confirmed rear approach can raise a low route throttle only
when measured forward space is clear, the route is not braking and the car is
below its selected speed. It never overrides a front obstacle or red light.

The existing ordinary-journey recorder already saves both arms independently in
`output/journey-comparisons`, retaining previous attempts and recording paths.
`conditions_match` verifies origin, destination, town, vehicle, requested speed,
weather and population. Matching starting settings do not imply identical live
actor trajectories or a causal count of avoided collisions.

## Implemented experience

Driving and Comparison Results are the only primary workspaces. The black rail
provides navigation and opens destination selection, research, diagnostics and
settings in contextual panels. The native emergency stop remains in the header
and expanded simulator; on narrow screens CARLA shutdown remains in Settings.
The two primary workspaces fit the browser viewport without page scrolling.
Driving preparation opens as a compact sheet on narrow screens. Result tabs
switch journey and safety measurements in place, and the narrow layout switches
between the two recorded arms. Provenance, recordings and archived research are
available through a details dialog. That dialog and advanced configuration may
scroll internally to preserve the complete technical data.
The live measurements now include native collision episodes, while Diagnostics
retains sensor health. A rear approach status explains when front clearance
prevents acceleration.

The stepper separates destination, traffic configuration, native road
preparation, and driving. Traffic selection alone sends no native command; the
operator applies traffic explicitly and waits for the matching native receipt.
Start Driving reveals exactly the ROBOSPHERE and NORMAL backend modes. Ownership,
freshness, stopped speed, environment, recording and emergency state gate each
start. A missing comparison arm returns to Driving with its mode selected and
asks the backend to restore the saved setup; rejected restoration has explicit
retry and current-setup paths. Neither recovery path starts the vehicle.

The unified map uses CARLA's catalog road segments, active native route,
measured vehicle pose and fresh prediction tracks. A shallow perspective is
applied to all of these coordinates together, preserving their alignment while
making bends in the native route easier to see. Tapered road surfaces and their
shadows add depth; measured forecast paths have visible endpoints. It draws the
car heading arrow, destination marker and remaining distance. The map ground
and road palette use the warm cockpit palette immediately. There are no
invented street tiles, roads, terrain elevations or actor paths. The map distinguishes measured
prediction source, age, fallback, stale data and unavailable data. Expansion
widens its canvas without remounting the camera. Camera view controls below the
simulator retain the confirmed selection during a pending backend change and
report both applied and rejected changes.

The result panels read persisted ordinary-journey manifests. They show missing
values as unavailable, retain real zeros, show paired differences only when
both journeys arrived with verified matching setup, and keep experiment setup,
recording paths, risk timelines and observed events available. Additional
measurements are taken from the native run: destination arrival, harsh braking
episodes, RULE intervention duration and measurement sample counts. A missing
collision sensor is reported as unavailable. Harsh braking uses measured
longitudinal deceleration at or below -3.5 m/s² above 1 m/s with brake above
0.2 and a one-second release interval. This reporting does not change driving
or safety control.

## Validation and limits

Run `npm run build:dashboard`, `npm test`, and
`.\.venv-carla\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'`.
Final checks passed: dashboard bundle built, 91 JavaScript tests passed, and
355 Python tests ran successfully with one existing skip. The isolated browser
rehearsal passed all assertions across eight viewport sizes with zero browser
errors and zero native mutations. `git diff --check` found no whitespace errors.
The isolated browser rehearsal is `scripts/verify_redesign_ui.js`, executed
with Playwright CLI against the served frontend. It intercepts every simulation
API request and WebSocket in the browser, labels every screenshot as a fixture,
and uses a previously saved CARLA RGB frame. It exercises the guided flow,
both actual command names, failed and retried preparation, map prediction
states, camera confirmation, emergency stop, manual-control modal, saved
results, the responsive widths 1440, 1366, 1024, 768, 390 and 320 pixels
(including short 600 and 667 pixel viewports),
dark mode and no primary-page scroll. This isolated UI rehearsal made no native
mutations. With the operator's later approval, CARLA and the backend were
restarted and the revised NORMAL controller completed a separate short live
smoke check: 74.37 m of route progress, zero collision callbacks and no sensor
errors over 40 seconds. It ended connected and paused. See
`docs/NORMAL_SENSOR_NAVIGATION_20261013.md` and
`output/normal-navigation/native-smoke.json` for scope and measurements; this
single run does not establish a general collision reduction.

## 14 October cockpit and controls update

The dashboard now uses a warm black frame with mint, blush, lavender and pale
yellow gradients inspired by the supplied reference. Blue UI accents were
replaced. The map is a small round inset at the top of the camera image; it
shows CARLA's actual road geometry, route and car heading. Opening it reveals
route details, measured forecasts, actor filters, front gap and observed road
range. It remains inside the full-screen simulation. The camera image is the
main visual anchor, and setup and results still fit the tested viewports
without primary-page scrolling.

Keyboard control is entered explicitly with **Take manual control**. The
operator may choose Protected or Normal before a destination; taking over an
autonomous run inherits its active protection mode. Driving keys do not silently
take over an autonomous journey. Normal manual driving retains the measured
radar/LiDAR/depth forward gate, while Protected manual driving retains RULE.
Camera depth now samples every four vertical and two horizontal pixels so narrow measured road strips at
junctions are less likely to be missed. Unknown forward space is still a stop,
not an inferred clear road.

The manual 80 km/h ceiling is conditional on measured clear road. Native radar
and LiDAR range increased to 100 m, and the forward-space validation horizon
to 90 m, because a 45 m sensor cap could not establish stopping room at
80 km/h. The governor and safety brake still limit or stop the vehicle when
traffic, signal state or measured clearance demands it.

| Shortcut | Action |
| --- | --- |
| W / A / S / D | Drive forward / steer left / brake then reverse / steer right, during manual control |
| Shift + W | Raise the manual forward speed ceiling from 30 to 80 km/h |
| Space | Parking brake |
| C | Cycle camera view, including during an autonomous recording |
| M | Open or close the round route map |
| F | Expand or restore the simulation |
| P | Open phone tools |
| H | Show the in-app shortcut guide |
| Escape | Close the open overlay or full-screen simulation |

The live CARLA validation after restart reached the destination in both modes
on the same ~94.5 m route: NORMAL finished with 0 collision callbacks and 0.87 m
remaining, while Protected finished with 0 collision callbacks and 0.34 m
remaining. Both reported no sensor errors. A separate live camera switch to
Hood was applied while the NORMAL journey stayed RUNNING and moved at 3.5 km/h;
the manual NORMAL start reported SENSOR_BASELINE before any throttle. These are
single-run functional checks, not broad collision-rate evidence. Results are in
`output/normal-navigation/native-smoke-final-20261013.json` and
`output/normal-navigation/native-smoke-protected-20261013.json`.

After extending the sensing range, additional 40-second live drives in both
modes advanced roughly 74 m on that route and stopped for its red light. Each
reported zero collision callbacks and zero sensor errors. Median native tick
rates were 16.1 Hz (NORMAL) and 16.7 Hz (Protected) with 40 vehicles and 30
pedestrians configured. These runs did not reach 80 km/h, so 80 km/h behavior
is covered by the control and stopping-horizon tests rather than a live
high-speed claim. The CARLA session is left connected and paused. Evidence:
`output/normal-navigation/native-smoke-long-range-20261014.json` and
`output/normal-navigation/native-smoke-protected-long-range-20261014.json`.

Fixture screenshots and the exact rehearsal scope are in
`docs/evidence/ui_redesign_20261013/README.md`.
