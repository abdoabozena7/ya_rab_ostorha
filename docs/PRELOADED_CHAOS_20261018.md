# Prepared city and distinct native vehicles — 18 October 2026

Opening the guided dashboard now starts CARLA automatically, then prepares one
Dense Chaos world before a drive is chosen. The selected Normal/protected mode
consumes that prepared world; it does not choose a different traffic scenario.
No alternate-scene selector remains in the guided journey.

## State and ownership contract

`PRELOAD` is idempotent while a presentation is active. It prepares the route,
seeded population and native motion audit, captures reconstructable participant
roles, then freezes the world in `CHOOSING`. No journey or recording starts in
that state. The seed and prepared-condition identity are chosen before the first
driver. The UI permits selection during preparation but only offers the Start
action when the held world is ready.

`START_GUIDED` supplies `prepared_id` and the selected `first_mode`. The server
rejects stale identities or a choice made before `CHOOSING`. `SELECTING` queues
vehicle installation on the sole simulation worker. Fresh sensor frames and the
existing starting-condition audit are required before recording/control release.
Legacy direct guided and automatic presentation operations remain supported.

Free GPU cancels preparation/selection and pending transitions. It still closes
the native process and returns to the stopped opening. That page does not
immediately auto-launch again; its Start action remains available. A newly opened
page automatically loads the simulator. A frozen `CHOOSING` world survives
dashboard ownership release and page reload without sending `stop_driving`;
active preparation/driving still has the existing
connection watchdog and stop behavior.

## One dense default

The guided preset requests **60 vehicles and 100 pedestrians**, compared with the
former 40/50 stress preset. Counts are verified from native snapshots and exposed
as actual counts; failed spawns are not counted as successful actors. The native
population limit now accepts up to 100 pedestrians (vehicles remain capped at
75). Developer settings retain their explicit configuration tools.

The preset uses seeded UNREGULATED profiles, maximum configured chaos, 20% light
compliance, 60% crossing eligibility and 20% fast walkers. Plans include up to
four sudden-braking roles, five cut-in requests and three opposing-lane entries
where native lane topology allows them, alongside Traffic Manager traffic.
Requests are distinct from observed maneuvers. Traffic keeps physical motion;
no actor is moved into a live camera to manufacture an outcome, and no ego
protection policy, learned driver or freshness threshold was changed.

The pre-start audit still requires nearby/front-cone population and actual
displacement; the per-drive audit retains density and motion failures over time.
Matching beginnings do not promise identical reactive traffic futures.

## Distinct native cars and honest comparisons

Normal uses `vehicle.lincoln.mkz_2020`. The protected mode uses a dark
`vehicle.mercedes.coupe_2020`, available in the installed CARLA distribution.
These are actual native vehicles, visible in the native chase-camera captures.
No external model downloads or weights are included.

Switching vehicles retires the old ego and its sensors, installs the new model
at the saved start, measures its onboard geometry and reattaches the existing
sensor configuration. Stable world roles, route, signals, weather and seed are
restored before the other drive. Rebuilt participants are first admitted in a
staging volume and moved to their saved poses with physics disabled before the
next native tick; the main camera remains hidden until verification. This fixes
CARLA spawn rejection when dense saved pedestrian capsules touch another actor.
Reconstructed role names keep the project prefix for orphan cleanup.

Guided vehicle-variant comparisons use version 5. Older formats remain readable.
`world_start_match` reports verified matching world starts. `conditions_match`
retains the strict whole-setup meaning and is false when the vehicle blueprints
differ. Both models, their geometry and the comparison scope are recorded.
Different vehicle dimensions/physics are an experimental variable: the UI does
not describe the results as a brake-only causal comparison.

## Verification and limitations

The frontend was rebuilt. **157 JavaScript tests** passed. Python discovery ran
**627 tests: 625 passed, two optional-dependency skips**. Focused regressions
cover preload identity/idempotence, held choice waiting, cancellation, dense
reconstruction, increased population bounds and separate world/vehicle matching.
The isolated browser checks verify automatic startup, one preloading request,
no alternate scene, unavailable Start during preparation, prepared identity on
selection, mobile layout and no automatic relaunch after Free GPU.

Native runs verified both orders. The protected-first repeat admitted 60 vehicles
and 100 pedestrians; its setup measured 44 nearby vehicles, 49 nearby pedestrians,
six vehicles and 37 pedestrians in the front viewing cone. All six front vehicles
and 37 front pedestrians had measured displacement at setup. Both vehicle audits
passed against the same condition identity; world match was true and full vehicle
conditions match was false. These were deliberately shortened lifecycle probes,
not completed-route acceptance.

The recorded stress plan contained 48 ordinary Traffic Manager roles, five
cut-ins, four braking roles and three opposing-lane roles. In the short native
probe, only a cut-in request was recorded as an observed request. Each arm's
rolling audit retained one motion failure among four measured motion windows.
The successful point-in-time density/motion sample does not erase that failure.
The final longer observation ran the protected arm for 60 wall seconds
(17.55 simulated seconds), then the Normal arm until a contact at 12.65 simulated
seconds. Both started from the same verified held condition on delivery code.
The protected car moved only 0.42 m, recorded zero contacts and was shortened;
Normal travelled 71.72 m and recorded one contact. A stationary protected attempt
does not establish useful navigation or predictive-driving quality.

That longer observation recorded five cut-in requests, four braking roles
released back to traffic, and three moving opposing-entry roles per arm. Native
lane measurements confirmed opposing-lane presence for two protected-arm roles
and one Normal-arm role. Cut-in requests are not proof of completed lane changes.
The protected audit retained one density and one motion failure; Normal retained
one motion failure. Sustained chaos, signal violations, complete lane-change
execution and general driving quality remain unaccepted. The compact
`native-long-observation.json` preserves these results alongside the earlier probes.

An earlier protected-first probe failed rebuilding `participant_105`; its first
recording was preserved. A subsequent backend reload timed out during disconnect,
then refused an orphan synchronous world. After confirming no backend listener,
the orphan world was restored to asynchronous operation and the normal launcher
recovered. These failures are retained in the compact evidence rather than
removed from the acceptance record.

The native browser also exercised Free GPU: the stopped host reported
`process_exited: true`, and process inventory showed no CARLA processes. Reloading
the page automatically launched CARLA and reached the held 60/100 scene again.
The held-world ownership release was verified natively without changing its
identity. A real browser reload also returned to the same held presentation and
condition identities. Some localhost asset/frame requests in that browser session
reported `ERR_CONNECTION_REFUSED`; a later reload recovered. These transport errors
remain a reliability limitation, separate from successful native scene retention.
Final first-choice retry and page-close cleanup also ran in the longer native
probe; the earlier probes retain their separately recorded source scope.

Evidence: [compact verification records and screenshots](evidence/preloaded-chaos-20261018/).
Raw runs, original full-state snapshots and CLI logs remain in ignored `output/`
and `runs/`. `scripts/verify_preloaded_native.py` is an explicit native smoke that
starts and shortens real drives; `scripts/check_preloaded_ui.js` uses the isolated
fixture installer documented in the guided report.
