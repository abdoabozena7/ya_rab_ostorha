# Guided driving delivery

Run `Start-YA-RAB-OSTORHA.ps1`, then open http://127.0.0.1:8000/.

1. Take vehicle control if another tab owns it.
2. Select **Prepare 40 vehicles**. The next step opens immediately.
3. Choose Calm, Mixed or Chaotic, adjust randomness/seed, then **Spawn 40 vehicles & continue**.
4. Wait for native confirmation. Partial or failed spawning holds driving and displays its reason.
5. Choose a destination on the map, then **Start driving**. The same button becomes **Stop driving**.

Driving and annotated YOLO/OCR images are visible together on desktop. Motion paths and a surroundings map are always visible without opening an inspector. Violet paths are actual Trajectron hypotheses; cyan paths use measured constant velocity. The display reports source, latency and model failures/fallbacks. The observer runs outside command arbitration: Trajectron display inference does not silently replace the RULE controller. Unknown objects remain unclassified.

**Advanced** restores the existing workspaces and research controls. The selected interface persists. `?mode=guided&rehearsal=1` selects a view for a separate browser rehearsal without overwriting the saved interface preference; it is still a live dashboard, not a simulator sandbox. Automated UI rehearsals additionally replace WebSocket with a browser-only command sink. They cannot spawn or drive native actors.

Camera view, resolution, effects, weather, simulation rate and city population survive backend reloads. Reload holds the vehicle, keeps the running graphics preset and never starts a journey. Background pages skip image/inference polling. Research experiment budgets and saved recordings are retained.

## Directional braking

`FORWARD_PHYSICAL_INGRESS_V3` requires registered lateral motion plus a coherent measured inward-edge trend, and predicts overlap with the physical forward corridor. Changing visible faces of parked cars, rear-only approach and adjacent proximity alone do not request forward braking. Ordinary forward sensing follows steering during turns. Front-obstacle/freshness protection remains independent. BasicAgent navigation now buffers the ordered route centerline rather than constructing a polygon from alternating edges; it retains forward footprint and traffic-light checks. Brake diagnostics distinguish navigation, red lights, RULE and communication/freshness stops.

## Verification

- Node: 67 passed.
- Python: 294 ran, 293 passed, 1 skipped.
- Browser flow: ownership → randomness → pending spawn → reject 39/40 → explicit retry → destination → start/stop; advanced switching, preserved view preference and mobile overflow passed, no JavaScript errors. Mutations were browser fixtures only. Evidence: `output/guided-browser-tests.log`, screenshots in `output/playwright/guided-*.png`.
- Native Computer Use: Prepare 40 completed and advanced automatically to destination selection; live annotated detections and Trajectron results appeared together.
- Native final smoke: actual destination reached in 46.0 wall seconds, 0.33 m remaining, 3 safety interventions, zero contact callbacks since start; settings file unchanged; final mode PAUSED. Evidence: `output/guided-drive/physical-v3-summary.json` and `physical-v3-telemetry.json`.

The earlier V2 smoke did **not** pass progress: 25 interventions and 29.4 m remaining after 60 seconds. It is retained as evidence of the failure that motivated edge-motion corroboration. The final smoke is a single normal-city route, not broad safety validation, a research comparison, or proof that every false stop is eliminated. Trajectron remains display-only and may fall back when classification/history or freshness is insufficient.
