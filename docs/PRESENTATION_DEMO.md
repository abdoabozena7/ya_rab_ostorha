# Final interactive presentation

Run `./Start-YA-RAB-OSTORHA.ps1` from PowerShell, then open the dashboard at
http://127.0.0.1:8000/. Keep the dashboard focused; the existing journey heartbeat
stops motion when the page loses control or focus. Use one dashboard tab. If
another tab owns control, use Settings → Connection and session → Take control
from this page, then close Settings.

1. Click **WITHOUT SAFETY**. Reset, autonomous driving and recording start
   automatically. Wait for **FINISHED** and show the measured collision outcome.
2. Click **WITH YA RAB OSTORHA**. Watch the same car approach the obstacle, RULE
   brake, and the car resume when the obstacle physically moves away. Wait for
   **FINISHED** and show the comparison measurements below the buttons.
3. Click **Stop / Reset demo** to remove the hazard, reset the ego and return to
   stopped Living City operation with RULE enabled. Manual WASD and normal
   destination journeys remain available.

Clicking either mode during a run terminates and records that interrupted run,
removes its actors, and starts a fresh scenario. Interrupted results never
replace completed measurements in the comparison. The buttons are mutually
exclusive; the production simulation worker owns all scenario/control ticks.

The frozen experiment is `presentation_front_obstacle_v1`, seed 2589, existing
Town10HD_Opt map, Lincoln MKZ 2020 ego, zero starting speed, dry ClearNoon weather,
20 simulation Hz, 640×360 forward camera and the existing seven sensors. The
Tesla obstacle starts stationary about 21 m ahead, holds brake until 7 simulation
seconds, then uses throttle 0.45 to leave through native physics. Target speed is
28 km/h and the destination lies 45 m along the native road. The protected run
ends after 14 simulation seconds; the baseline ends on native collision. Safe
progress means at least 10 m without collision in that horizon, not arrival at
the navigation destination.

This is an explicit research comparison: BasicAgent vehicle/light/stop checks
are disabled identically in both arms to isolate the additional safety layer.
Normal journeys create a new agent with the original settings. RULE uses the
unchanged sensor-only feasibility/arbiter path; learned/hybrid controllers do
not participate. YOLO/OCR pauses during the comparison.

Recordings use the existing versioned layout under `runs/normal_city/`. Each
includes camera/depth/LiDAR assets, canonical frames and collision events,
`telemetry/comparison-controls.jsonl` with actual commands and applied controls,
and `comparison-result.json` with the complete configuration/outcome. The compact
latest comparison is `output/presentation-demo/comparison.json`. Demo disk writes
use a bounded queue; writer failures are reported and stop the experiment.

After running both buttons, the read-only native audit is:

```powershell
.\.venv-carla\Scripts\python.exe -m scripts.native.verify_presentation_demo
```

It compares recorded initial configurations, checks all recorded asset hashes,
collision events and accepted/applied RULE commands, verifies a replay camera,
and confirms one ego, one hazard and seven sensors. It never ticks CARLA.

Native rehearsal evidence and the final measured results are stored in
`docs/evidence/presentation_demo/native.json`.

## Final rehearsal — 9 October 2026

Clean startup through `./Start-YA-RAB-OSTORHA.ps1` passed with the matching CARLA
0.9.16 server/API on the existing map. Both real dashboard buttons were exercised,
including WITHOUT → WITH → WITHOUT switching before completion. The interrupted
recordings closed normally and all four previous ego/hazard actor IDs were absent
after replacement. The final world contained two vehicles and seven sensors.

| Measured result | WITHOUT SAFETY | WITH YA RAB OSTORHA |
|---|---:|---:|
| Native collision episodes | 1 | 0 |
| Collision impulse | 14,636.86 N·s | 0 N·s |
| Route progress | 16.214 m | 28.005 m |
| Distance traveled | 16.292 m | 28.017 m |
| Minimum planar clearance | 0 m | 3.746 m |
| RULE intervention episodes | 0 | 4 |
| Simulation duration | 3.8 s | 14.0 s |
| Outcome | COLLISION | SAFE_PROGRESS |

Both configurations have SHA-256
`87bda6c4b195f7332f9707d9bd50b294f440389b18fa8ea856531d7f692d2de8`.
All 78 baseline frames and 282 protected frames were complete; 1,080 recorded
assets passed checksum verification. The protected run resumed after the hazard
departure, and all 102 accepted/applied RULE control frames matched native pedals.
Both recordings replayed with their native camera. The visible dashboard showed
the actual results and correct live safety/controller selection.

The dashboard manual WASD check stayed in MANUAL, reaching 17.38 km/h. A normal
BasicAgent journey then ran in AUTOMATIC/NAVIGATION at 14.74 km/h with RULE
monitoring. Keyboard commands now follow fresh native frames so slow rendering
cannot create a backlog of stale samples; the existing timeout remains unchanged.
The affected Python regression suite passed 72 tests; frontend tests passed 25.

Additional evidence: `dashboard-comparison.json`, `dashboard-driving.json` and
`switching.json` in the same evidence directory. No blocking issue remained.
The camera briefly reinitializes during each actor/sensor reset. Keep the single
dashboard tab focused while presenting; the existing focus-loss stop remains active.

For offline replay, first stop the current backend to release its ports, as in the
README replay workflow, then select one of the final recordings:

```powershell
.\.venv-carla\Scripts\python.exe -m backend.server --replay runs\normal_city\run_c11cf1d23af84a05b4f11d2faac357ec
# Or the protected run:
.\.venv-carla\Scripts\python.exe -m backend.server --replay runs\normal_city\run_fcca8f47a88f4dc9b74482257837e500
```
