# Stage 1: playable driving foundation

## Repository audit

The application is plain JavaScript, Three.js 0.152 from an import map/CDN, and a dependency-free Python HTTP/telemetry server. There is no bundler, Rapier, or physics engine. `src/main.js` composes the simulation and UI.

- Player: existing Kenney sedan GLB, primitive fallback, independent front-camera mount.
- World: irregular road graph, GLB buildings/street lights, simple road meshes, named Arabic place signs, fuel stations, automatic expansion after five trips.
- Traffic: cloned vehicle and tuk-tuk models, lane drift, following and player avoidance; independent intersection timers.
- Pedestrians: existing animated Kenney models, sidewalk walking and unsignalled crossing, player avoidance.
- Safety: seven raycasts, predicted dynamic motion and circle sweeps, mesh-bound collision checks.
- Navigation/UI: A*, lane-following auto mode, Arabic phone destination lookup, route values, orthographic minimap, scissored front camera, Python observation and JPEG endpoints.
- Existing tests cover routing, road bounds, dynamic safety, destination lookup and the API.

Baseline browser: scene and assets load; no captured warning/error console entries. The distant rigid chase camera, disabled shadows, neon debug overlays and overlapping roads make it feel like a debug demo. Player physics advances once per rendered frame while traffic scales by elapsed time. HUD speed conversion is inconsistent with metres and a 60 Hz simulation. Asynchronously loading the street lamp rebuilds the whole city and respawns traffic; car asset completion can overwrite tuk-tuk visuals.

## Implementation order (this change only)

1. Add a bounded 60 Hz fixed-step clock, retaining the existing AI and actor APIs. Separate predictable manual acceleration, brake-to-reverse, steering, drag and emergency braking into a small testable module.
2. Wire WASD and existing arrows, Space, C, P and 1; clear held controls on focus loss. Keep the existing alternate front view. Provide pause and reset for local driving iteration.
3. Use a damped chase camera with a closer, lower gameplay composition; preserve the independent front-camera feed.
4. Use sRGB output, simple matte materials, hemisphere fill and a bounded directional shadow area. Reuse every current GLB. Clean road overlap/markings, add simple shoulders, and retain the existing street layout.
5. Reorganize the existing HTML HUD around the gameplay view, keep debug information available, and display measured FPS/frame time. No fake labs or detection boxes.
6. Run unit/API checks and browser checks for loading, input, reverse/braking, collision boundaries, alternate camera, pause/resume, phone/auto regressions, console and rendering performance. Inspect screenshots and record limitations.

## Asset plan for later stages

No asset downloads or replacements are needed for Stage 1. Keep the current asset paths to avoid breaking the dependency-free server. A single asset manager/manifest and the requested public asset layout belong with the Stage 2 loading work.

Verified available sources (2026-09-27): Kenney Car Kit, City Kit Commercial and Blocky Characters are CC0; Quaternius Ultimate Stylized Nature is CC0 and includes glTF. Search these for additional vehicles/props and vegetation in the corresponding later stages. A motorcycle and suitable microbus still need individual style/license checks. Do not represent the existing delivery van as a finished microbus. Existing tuk-tuk attribution is retained from `assets/LICENSES.md`; this stage does not newly verify or download those assets.

## Out of scope

New player model, wheel rigging, new cockpit/interior, extra camera modes, complete shop streets, new traffic behavior/types, new pedestrians, seeded scenarios, city expansion redesign, new phone/map navigation, ground-truth CV, Test Lab, Decision Lab, and full asset-pipeline migration. Preserve existing versions of these systems where present.
