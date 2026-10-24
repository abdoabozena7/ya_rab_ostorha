# Scenario availability and GPU action status — 24 October 2026

The Egypt road option was disabled because the running backend catalog reported
`available: false`, `native_accepted: false` and
`validation_window_active: false`. Its reason was “Twelve source-bound native
trips have not been accepted.” GPU pressure does not cause this scenario gate.
The required acceptance matrix remains pending; this interface change does not
grant a validation reservation or promote the scenario.

The selector now labels unavailable and validation-only options, shows the
backend reason beside the control, and offers **Refresh availability** to reload
the catalog without refreshing the page or preparing a drive. Missing catalog
data is described as unknown availability. The existing independent driver and
scenario selections remain.
If a refresh reports an expired validation window for a prepared Egypt scene,
its Start becomes unavailable and the historical selection remains accessible.

`drivePrimaryAction` now names its current native preparation step and shows a
busy **Closing CARLA…** state during shutdown. Scenario replacement also stays
busy until acknowledged. Start remains governed by native city/sensor readiness.
On the choice screen, the action and its resource context precede the preview;
ordinary telemetry updates preserve keyboard focus.

The adjacent GPU section uses the existing `performance.gpu` counters:

- Reported device name, GPU utilization, used/total VRAM, percentage and remaining
  MiB. The values cover all applications on the reported GPU, not CARLA alone.
- Measured VRAM fill, with advisory high pressure at 90% and nearly full at 95%.
  These thresholds do not block a ready drive or admit an unprepared drive.
- Sample age, using the backend's existing six-second freshness boundary.
  Missing, invalid, undated, future and stale samples cannot claim current usage.
  Replay does not display recorded GPU counters as live measurements.
- The backend-provided VRAM target, explicitly advisory. A met memory target is
  not an assertion that the FPS, real-time or native driving gates passed.
- Shutdown follows verified CARLA process exit. Other applications may continue
  to use VRAM after CARLA closes; the UI does not manufacture a zero reading.

## Verification

`npm run build:dashboard` regenerated both checked-in bundles. All **203
JavaScript tests** passed. The offline Python suite ran **923 tests**, with
**919 passing and four optional skips**.

[Browser checks](../scripts/verify_gpu_action_ui.js) intercepted every API and
control WebSocket before opening the dashboard on a static asset server. They
checked the unavailable gate, explicit availability refresh, independent scenario
and driver selection, 97% VRAM versus 29% GPU load, native preparation despite
zero VRAM usage, stale/missing readings, shutdown with nonzero remaining VRAM,
keyboard focus, reduced motion, and 1440px/390px layout containment. The final run
had zero browser errors. An earlier fixture omitted requested population fields;
it failed before rendering and was corrected before the recorded passing run.

[Verification summary](evidence/gpu-action-ui-20261024/verification.json),
[desktop fixture screenshot](evidence/gpu-action-ui-20261024/desktop.png) and
[mobile fixture screenshot](evidence/gpu-action-ui-20261024/mobile.png) retain
software evidence. GPU numbers in those screenshots are deliberately supplied
fixtures, not measurements of a new native drive. No native trip or acceptance
matrix was run, and no validation allowance or acceptance artifact was changed.
