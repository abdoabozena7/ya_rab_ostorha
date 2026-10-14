# Light driving dashboard — implementation report

14 October 2026. Presentation changes in the existing application; no backend
safety, physics, model, population or control-policy changes were made for this
redesign. The checkout already contained extensive local changes, which were
preserved.

## 1. Implementation summary

Replaced the served dark cockpit with the specified cool pastel design: local
Manrope, the requested CSS color tokens, soft white surfaces, electric blue
navigation, a dominant real camera, one circular map, four essential measurements
and a compact object strip. Scenarios, manual mode selection, destinations,
traffic preparation, research, recording, Results and Diagnostics remain reachable
through the existing handlers and application workspaces.

The header distinguishes CARLA connection, reported safety mode and control
state. Emergency Stop remains separate from ordinary Stop and server shutdown.
There is no native simulation-pause control in this version: ordinary driving
stop retains `stop_driving`, while Pause/Resume remains available for replay.
`Stop CARLA · Free GPU` is under Tools and also in the existing Settings panel.
RULE remains the backend default; MODEL is labeled experimental when selected.

Visual thesis: a quiet, cool, rounded workspace with the real road image as the
dominant surface. Content order: simulation, actual safety intervention, immediate
measurements, then configuration and diagnostics. Interaction thesis: fast drawer
reveals, in-place map expansion and subtle control feedback, with reduced motion
support and no new continuous decorative animation.

## 2. Files changed for this request

| File | Purpose |
| --- | --- |
| `frontend/light-cockpit.css` | Central palette, local Manrope, rounded light shell, desktop and responsive compositions, dialogs, focus and reduced-motion styles. |
| `frontend/light-cockpit.js` | Existing-control composition, Scenarios/Tools/details dialogs, camera dropdown, telemetry rail, safety notice, real 2D overlay and preference settings. |
| `frontend/cockpit-state.js` | Pure presentation checks for freshness, safety state, unavailable values, detection provenance and letterbox coordinates. |
| `frontend/dashboard.js` | Install/update the new UI; clear camera frames more than 0.75 simulation seconds behind current telemetry. Existing frame-ID/header validation remains. |
| `frontend/dashboard-tools.js` | Restore emergency control to the new header, bridge destination selection from Scenarios to the existing map drawer, preserve the icon during expansion. |
| `frontend/driving-studio.js` | Give the new theme ownership of its safety notice and setup visibility; retain journey/results and manual-control implementation. |
| `frontend/perception-view.js` | Retain only the metadata belonging to the successfully displayed analyzed image; clear it on unavailable/disconnected state. |
| `frontend/prediction-view.js` | Presentation-only visibility settings and palette; replace the old guessed conflict cuboid with a marker at the real forecast point. |
| `frontend/unified-map.js` | Cool map palette; remove retained live pose after disconnect rather than presenting a stale map as current. |
| `frontend/appearance.js` | Start in the approved light theme, including when an older dark preference exists. |
| `frontend/dashboard-theme.css` | Compose the existing layout foundations and new theme in their intended cascade order. |
| `scripts/build-dashboard.js`, `package.json` | Use the existing esbuild dependency to emit JS and one CSS bundle, reducing initial stylesheet requests. No dependencies added. |
| `frontend/dashboard.bundle.js`, `frontend/dashboard.styles.css` | Built assets used by the real served entry point. |
| `index.html` | Load the compiled theme, enable the new shell and remove the previous warm/dark theme links. |
| `tests/cockpit-state.test.js` | Eleven meaningful state/provenance/geometry regression tests. |
| `scripts/verify_light_cockpit_ui.js` | Isolated browser rehearsal with explicit synthetic-state labels and a saved real CARLA image. |
| `scripts/verify_light_cockpit_native_ui.js` | Limited real-CARLA feed and camera-setting validation. |
| `README.md`, this report | Current operator entry points and implementation/validation details. |

## 3. UI architecture and progressive disclosure

The original application is plain ES modules composed into a classic esbuild
bundle. `backend.server` serves `index.html`; `dashboard.js` retains the
SimulationClient, DrivingControls, DashboardTools, guided journey, perception,
prediction and Results components. The redesign adds a presentation module
after those modules have installed their DOM and handlers. It does not introduce
a new framework, router or parallel simulation client.

At 1720 × 914, the shell has 18 px outer padding, a 100 px navigation rail, a
100 px header, an approximately 1324 × 626 camera region, a 224 px telemetry
rail and a 116 px summary strip. The map is 160 px in diameter with a 4 px white
border. The camera uses `object-fit: contain` and a dark neutral letterbox.
No video content is cropped or stretched.

Driving and Results retain their original tab behavior. Scenarios is a native
modal side drawer containing the guided destination/traffic/start flow and manual
mode controls. It closes when an accepted start transitions to driving and
returns focus to the camera. Map selection uses the existing map drawer and
returns to Scenarios. Tools exposes Diagnostics, advanced scenario/research
configuration and server lifecycle. View details exposes analysis, scenario
population, other measurements and the full Diagnostics entry point.

Existing modal inspection behavior still stops manual keyboard driving. It does
not silently take over or stop a valid autonomous journey merely to inspect
details. Native dialogs provide focus containment; the existing drawer retains
its focus trap and places Emergency Stop within that scope. Fullscreen includes
normal stop, emergency stop and the actual current safety/control labels.

Desktop layouts fit the initial viewport. Below 1100 px, telemetry moves below
the camera; below 768 px, navigation becomes a bottom rail and the header retains
connection, safety and driver labels. Mobile can scroll naturally through
secondary data. Emergency control remains in the sticky mobile header.

## 4. Data integration

| Display | Actual source / validation |
| --- | --- |
| Connection, ownership, driver state | Existing validated WebSocket snapshots, `SimulationClient.fresh`, `controller`, `controlMode` and replay state. |
| Camera | `displayCamera` or fixed `frontCamera` metadata → `/api/simulation/camera.jpg?frame_id=…`; existing frame/time response-header checks and image decoding before replacement. |
| Speed / applied brake | Current `vehicle.speedKmh` and `vehicle.brake × 100`; recorded actuation is identified as replay. |
| Target speed | Actual `journey.speed_kmh`; manual control is labeled manual rather than inventing an applied target. |
| Front gap / TTC | Timestamp-checked `maneuver.front_gap_m` / `front_ttc_s`, falling back to `safetySystem.measured_range_m` / `ttc_s`. Missing, stale, future or faulty observations display an em dash. |
| Safety notice | Actual emergency mode, safety fault/suspension, active intervention, `teacher_state`, status and supplied reason. No ordinary paused hold is presented as an obstacle intervention. |
| Circular map | Existing catalog road segments, native route, current measured ego pose/heading and fresh measured prediction tracks. No static map tiles or invented actors. |
| Vehicles / pedestrians | Fresh fixed-front-camera inference detections from the existing YOLO worker. Scenario population is shown separately in details. |
| Tracked objects | Confirmed tracks from the existing measured surrounding-sensor prediction, labeled **Surrounding sensors**. These are not relabeled as camera detections. |
| Results / recordings | Existing persisted journey comparison manifests, recording archive and Diagnostics/research modules. |

The added module reuses the existing polling/data flow. It adds no network polling
and changes only visualization preferences in browser-local storage.

### Bounding boxes: completed fallback and missing 3D dependency

The audited perception worker publishes legitimate 2D `xyxy` detections with
session, frame, timestamp and source image dimensions. It does **not** publish
projected object cuboid corners or measured per-object 3D box geometry. The
existing forecast conflict cuboid used a guessed height; it was removed because
a forecast overlap is not a detected object's 3D bounding box.

The new main-camera overlay draws real 2D boxes only when the displayed RGB frame
has the exact inference frame/time/session and the same calibrated front sensor
viewpoint. A different Chase/Hood/Rear/Top mount rejects those coordinates. Canvas
placement accounts for both horizontal and vertical letterboxing and is updated
on resize. Invalid/out-of-frame geometry is rejected or clipped. The overlay
clears when frame alignment or connection is lost. Labels explicitly say **2D**.

Bounding boxes, labels, trajectories and safety highlights have persistent
visualization-only controls. Slower asynchronous inference will often have no
exact match on the newer live image; its actual annotated source frame remains
available through **View analyzed frame**. No stale boxes are moved onto a new
frame, and no ground-truth actor boxes enter the safety decision path.

**Actual 3D object boxes remain unavailable.** Completing that feature requires
a legitimate frame-indexed 3D geometry/projection contract from perception.

## 5. Design fidelity and screenshots

The pasted attachment contained the written brief only; no approved reference
image was present. Pixel-for-pixel image comparison therefore cannot be claimed.
Visual QA compared the screenshots against the brief's exact palette, typography,
desktop dimensions, hierarchy and responsive requirements.

- [Before: previous native dark dashboard](../output/playwright/pastel-before.png)
- [Final: real native dashboard at 1720 × 914](../output/playwright/pastel-desktop-native-final.png)
- [Desktop fixture](../output/playwright/pastel-fixture-desktop.png)
- [Actual safety-state presentation in a labeled fixture](../output/playwright/pastel-fixture-safety.png)
- [1024 px fixture](../output/playwright/pastel-fixture-responsive-1024.png)
- [390 px fixture](../output/playwright/pastel-fixture-responsive-390.png)
- [Disconnected fixture](../output/playwright/pastel-fixture-disconnected.png)

Intentional differences: natural mobile scrolling preserves legible controls;
the minimap sits below the fullscreen control to avoid overlap; contain-fit
letterboxing preserves the entire source frame; unavailable detection values
remain dashes. These are real operational states, not hardcoded visual samples.

## 6. Validation

Commands executed from the repository root (PowerShell):

```powershell
npm run build:dashboard
npm test *> output/playwright/pastel-unit-tests.txt
.\.venv-carla\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py' *> output/playwright/pastel-python-tests.txt
node --check frontend/light-cockpit.js
node --check frontend/cockpit-state.js
node --check scripts/build-dashboard.js
git diff --check -- frontend/dashboard.js frontend/dashboard-tools.js frontend/driving-studio.js frontend/prediction-view.js frontend/perception-view.js frontend/appearance.js frontend/unified-map.js index.html package.json

# Owned static QA server; fixture API/socket traffic is entirely intercepted.
.\.venv-carla\Scripts\python.exe -m http.server 8012 --bind 127.0.0.1
npx --yes --package @playwright/cli playwright-cli -s=pastel-test open about:blank --headed
npx --yes --package @playwright/cli playwright-cli -s=pastel-test run-code --filename scripts/verify_light_cockpit_ui.js *> output/playwright/pastel-browser-tests.txt

# Separate native browser; no mocks and no drive is started.
npx --yes --package @playwright/cli playwright-cli -s=pastel-native open http://127.0.0.1:8000 --headed
npx --yes --package @playwright/cli playwright-cli -s=pastel-native run-code --filename scripts/verify_light_cockpit_native_ui.js *> output/playwright/pastel-native-tests.txt
```

- Build succeeds: existing esbuild emits the classic JS bundle and consolidated
  CSS. No new runtime or package dependency.
- JavaScript: **102 passed, 0 failed** (91 existing + 11 added).
- Python: **355 run, 0 failures, 1 existing skip**.
- Syntax checks and scoped whitespace check pass.
- Isolated browser rehearsal: **97 assertions passed, zero runtime errors**. It checks connected and disconnected states, destination
  admission, protected start, explicit manual mode/WASD command emission, normal
  stop, emergency stop/recovery, safety intervention/fault, camera confirmation
  and rejection, exact-frame 2D overlays, preference persistence, circular map,
  details, Results and fullscreen. It performs **zero native mutations**.
- Responsive sizes: **1720×914, 1440×900, 1366×768, 1366×600, 1100×768,
  1024×768, 768×1024, 767×844, 390×844, 320×720**. Desktop fits the viewport;
  responsive Driving/Results have no horizontal overflow.
- Separate native check passes: real RGB decoding and advancing native frames,
  catalog-confirmed **Chase → Hood → Chase**, original camera restored, vehicle
  held at 0 km/h, RULE retained, contain-fit preserved and no browser runtime
  errors. Observed native frames: **87312 → 87323** in the existing CARLA session.

Early browser checks exposed and corrected a requested-camera timing race,
competing old/new safety renderers and a 320 px Results heading overflow. Initial
native page loads also intermittently refused separate stylesheet requests;
the final entry point serves a single compiled stylesheet, and fixture QA uses
its own static server. These failed intermediate checks are not counted as passes.

## 7. Remaining issues and unverified scope

- No supplied reference image was available for a direct visual comparison.
- Actual 3D bounding-box geometry is missing from the current sensor contract.
  Real 2D fallback and analyzed-frame access are implemented; 3D rendering is not
  claimed as completed.
- The native session reports intermittent safety freshness failure. The saved
  final native screenshot and follow-up observation show `SENSOR_FAULT_STOP` and
  **Fresh complete safety observations unavailable**, while connected and held
  at 0 km/h. The new interface correctly reports this instead of claiming active
  protection. Backend behavior and freshness thresholds were not modified.
- Native manual driving, autonomous arrival, real safety braking, recording/replay
  execution and server shutdown were not rerun during this presentation task.
  Their original handlers/contracts remain, Python/JS regressions pass, and
  applicable UI commands are checked in the isolated rehearsal. That coverage is
  explicitly separate from native driving validation.

Evidence logs are under `output/playwright/pastel-*.txt`; the follow-up native
state is `output/playwright/pastel-native-observation.json`. Compact machine-readable
results are `pastel-browser-result.json` and `pastel-native-result.json` in the same
folder. The temporary static QA server and task-owned Playwright browsers were closed.
The live application
is still served at `http://127.0.0.1:8000/`; CARLA is left running and held.
