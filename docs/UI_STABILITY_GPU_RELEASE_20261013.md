# Stable motion UI and CARLA GPU shutdown

The measured surroundings map no longer disappears when an RGB frame has no
exactly matching forecast. It uses the measured forecast's own freshness,
while image overlays still require exact frame/time alignment. The map has a
permanent placeholder and prediction text has a fixed height. Transient
inference waits retain the last analyzed image with a visible waiting label.
Numeric cells are updated in place instead of rebuilding the DOM every frame.
New camera images decode before the previous image URL is released.

The header now has **Stop CARLA · Free GPU** beside the connection status.
It stops driving, finalizes the session, retires the Windows libcarla host,
terminates verified CARLA processes for this session's RPC port, then starts an
SDK-free dashboard displaying **CARLA — STOPPED**. An observing tab can request
this explicit shutdown without acquiring driving control. Remote simulators and
replay cannot kill a local engine. Other CARLA RPC ports are excluded.

The initial direct shutdown released VRAM but its retained Windows SDK host
subsequently exited. That failure is retained in
`output/ui-stability-native-initial-error.json`; the external retirement helper
replaces that approach. The successful final native check recorded:

- VRAM **5849 MiB → 0 MiB**, GPU utilization **44% → 0%** (`nvidia-smi`).
- No remaining verified CARLA processes.
- Four consecutive successful HTTP snapshots with `STOPPED` and a live dashboard.
- No cleanup warning, and saved preferences unchanged.

CARLA is intentionally left off after the test. Run
`Start-YA-RAB-OSTORHA.ps1` to start it again; startup now prefers the user's
saved graphics settings to a historical GPU-training launch file. Saved
recordings and model weights are unaffected.

The latest screenshot's `UNKNOWN_SPACE` risk now produces **Insufficient data**
in the motion strip instead of **No predicted intersection**. This changes
presentation only; it does not weaken the safety coverage requirement.

Verification: **325 Python tests (324 passed, one skipped)**, **73 JavaScript
tests**, dashboard build, and browser layout checks. The browser stress fixture
alternates missing image-aligned forecasts and perception waits: measured layout
shift **0 px**, map/image remain visible, numeric node identities remain stable,
and mobile overflow is absent. Browser fixtures do not send native mutations.
The actual stopped host is also checked independently after the real shutdown.

Evidence:

- `output/ui-stability-browser.log`
- `output/ui-stability-native-final-before.json`
- `output/ui-stability-native-after.json`
- `output/ui-stability-python-tests.log`
- `output/ui-stability-node-tests.log`
- `output/playwright/ui-stability.png` (browser fixture)
- `output/playwright/carla-stopped.png` (actual stopped host)

Repeat browser checks with `scripts/verify_ui_stability.js` and
`scripts/verify_stopped_dashboard_ui.js` through `playwright-cli run-code`.
