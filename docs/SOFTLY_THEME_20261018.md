# Softly theme for the guided simulator — 18 October 2026

The guided simulator now uses the requested warm paper palette, Outfit typography,
Reenie Beanie welcome emphasis and coral actions. The visual theme covers the
opening, first-drive choice, preparation, live drive, saved outcomes, comparison
and Menu. The existing simulator state machine and driving algorithms are unchanged.

## Starting-scene popup follow-up

The starting-scene selector now has a themed combobox popup, replacing the
operating system's blue option menu. Its warm paper surface, coral selection,
sage hover and wrapped traffic-request description match the rest of the screen.
The hidden native select remains the source of the existing guided `scene` value.
Enter/Space, arrows, Home/End, typed initials, Escape, Tab and outside clicks are
handled explicitly. Opening retains keyboard focus and scrolls the options into
view on small screens; leaving the choice screen closes the popup.

`scripts/check_scene_picker_ui.js` verified the popup colors, keyboard selection
and cancellation, pointer selection, outside/Tab dismissal, 390×740 layout and
the `DENSE_CHAOS` guided-start payload in an isolated browser. Evidence and
desktop/mobile screenshots are in
[the popup evidence folder](evidence/softly-scene-picker-20261018/).
The dashboard was rebuilt; all 150 JavaScript tests and the 15 guided-flow
browser checks passed again. This follow-up adds no native driving evidence.

## Design and behavior

The visual thesis is a quiet, tactile paper surface around a real driving scene.
The opening centers the current task above the saved CARLA preview. Once driving,
the full live camera comes first, followed by the current mode, observation prompt
and next action. Sage and lavender distinguish the two choices and result panels.
Menu holds settings, diagnostics and history; Free GPU and Emergency stop retain
their existing independent actions.

- Background `#FDFCF8`, text `#292524`, muted text `#78716C`, coral `#FFB7B2`,
  sage `#E8EFE8` and lavender `#EFEDF4`.
- A floating translucent navigation pill, a coral circle with a white dot,
  rounded image frames and softly rounded controls. Mobile navigation fits within
  the viewport minus 32 px and wraps when active safety controls need more room.
- Both new fonts are hosted locally with their SIL OFL notices. The primary font
  is preloaded. Attribution is in [the asset register](../public/assets/ATTRIBUTION.md).
- A static tiled fractal-noise SVG uses frequency `.65`, overlay blending and
  opacity `.35`; it has no pointer events. It requires no animated canvas.
- Peach and lavender blobs float by 10 px over six seconds on the opening and
  choice screens. They are removed while driving or processing a session.
  Preview/help reveals move 30 px over 800 ms. All these motions honor reduced motion.
- Three optional, keyboard-operable questions below the opening explain the two
  drives, protection limits and GPU release. Their plus icons rotate and their
  answers expand over 500 ms; collapsed answers are inert.

The saved preview remains clearly labeled. The live camera uses `object-fit:
contain`, including expanded viewing. Real counts, shortened/collided attempts,
export-independent results and contextual recovery continue to come from the
existing guided flow. No wellness subscriptions, testimonials or waitlist were
added to the simulator.

## Verification and evidence

`npm run build:dashboard` regenerated the checked-in JavaScript and CSS.
`npm test` passed all **150 tests**, with no failures or skips. No Python/backend
source changed, so the Python suite was not repeated for this visual delivery.

The isolated Chromium fixture passed **15 guided-flow checks** and **8 theme checks**,
with no page exceptions. These exercise explicit first-mode selection, transition
identity, contact results, optional history review, all six preparation phases,
contextual retry, GPU release, expanded viewing and keyboard focus. The theme
probe checks local fonts, exact palette/grain configuration, FAQ keyboard behavior,
reduced motion and the emergency command reaching the isolated transport.

| Layout probe | Viewports | Observation |
| --- | --- | --- |
| Opening | 1440×1000, 1280×720, 390×740, 320×640 | Primary action visible; logo present; no horizontal overflow |
| Driving | 1920×1080, 1280×720, 850×600, 390×740 | Complete camera image; current action reachable by scrolling |
| Expanded camera | 390×740 | Current action and Emergency stop remain reachable; Escape restores viewing |
| Zoom reflow | 1280×900 with CSS zoom 2 | Action reachable; no horizontal overflow |

CSS zoom is a reflow probe, not an automated test of browser chrome zoom or OS
scaling. Native rendering cost, native driving quality and a new CARLA lifecycle
were not measured in this theme pass. The fixtures inject saved camera imagery
and representative metrics; screenshot numbers are **not a new native result**.
The [guided delivery's native findings and unaccepted stress/quality gates](GUIDED_SIMULATOR_20261018.md)
retain their original scope.

Evidence is preserved in [the theme evidence folder](evidence/softly-theme-20261018/):

- [Theme checks](evidence/softly-theme-20261018/theme-checks.json),
  [guided-flow checks](evidence/softly-theme-20261018/guided-flow.json) and
  [source hashes](evidence/softly-theme-20261018/manifest.json).
- Opening: [desktop](evidence/softly-theme-20261018/welcome-desktop.jpg),
  [mobile](evidence/softly-theme-20261018/welcome-mobile.jpg).
- [Choice](evidence/softly-theme-20261018/choose-desktop.jpg),
  [mobile drive](evidence/softly-theme-20261018/drive-mobile.jpg),
  [comparison](evidence/softly-theme-20261018/comparison-desktop.jpg),
  [Menu](evidence/softly-theme-20261018/menu-desktop.jpg) and
  [FAQ](evidence/softly-theme-20261018/faq-mobile.jpg).

The preserved images are compressed JPEG copies of browser screenshots. Original
PNGs, full CLI logs and captured fixture inputs stay in ignored `output/`.

For a repeat on this installation, serve the repository on port 8016 and open a
fresh named Playwright browser. Install `scripts/verify_guided_mission_ui.js`, then
run `scripts/check_guided_mission_ui.js` followed by
`scripts/check_softly_theme_ui.js` using the CLI's `run-code --filename` option.
The fixture installer requires the locally captured `observed-state.json` and
`observed-catalog.json` under `output/guided-ui-20261018/`, as documented in the
guided simulator report. Its transport is isolated from the native dashboard.
