# Urban Chaos presentation

## Start and present

1. From the project directory, run `./Start-YA-RAB-OSTORHA.ps1` in PowerShell. Wait for CONNECTED, native camera, 40 traffic vehicles and 30 walkers. The ego is stopped and RULE is ON.
2. Click **Take control** if shown. In **Setup**, select **Urban Chaos**, seed **2589** and **Low**. Graphics changes restart CARLA and leave the car stopped; select your graphics before the pair.
3. Open **Driving**, expand **Run a safety comparison** and click **WITHOUT SAFETY**. It resets the entire experiment and starts BasicAgent automatically. Allow 60 **simulation** seconds; wall time is longer on this laptop. A native collision stops ego navigation, while the remaining city hazard schedule continues to the time limit.
4. Click **WITH YA RAB OSTORHA**. It resets the same compiled starting manifest, sensors and histories. RULE uses synchronized depth/LiDAR/radar observations, and can brake, hold and release when physically safe. Allow the entire run to finish.
5. Open **Results** after completion. Collision outcomes lead the page, followed by route-progress bars and exact measurements. **Technical evidence & recording references** contains the starting-condition verification and native-pose audit. Archived comparisons are explicitly labeled and remain separate from the current session counters. Traffic trajectories may diverge after the protected ego changes its motion.
6. For code discussion, open the four backend folders and their READMEs in your editor. This is one integrated driving product; course organization exists only in the source tree.
7. **Emergency stop** immediately latches the vehicle stop and requires acknowledgement before driving again. It never resets the experiment. **Reset simulation**, under the comparison controls, separately restores the populated city, stopped ego and RULE after confirmation. The primary action starts manual driving or resumes a selected destination; **Manual controls & destination speed** exposes the keyboard, gear and speed settings.

Stop the active drive before starting the next comparison; start buttons are disabled during an active comparison. Leaving the Driving workspace stops the vehicle and blocks manual keyboard input. Changing seed, scenario or graphics creates a new comparison group; previous recordings remain in the archive. **Front Obstacle** retains its original 28 km/h / 14 second research recipe.

The live **Safety timeline** records intervention starts and releases observed while this page is open, including reason, brake and speed. It is a partial current-session log, not archived playback. Full traces remain in each recording's `telemetry/comparison-controls.jsonl`; the current API does not expose archived event playback. Detection is display only, and its delay notice starts at 0.5 simulation seconds; it does not change the safety controller's freshness limits.

Frontend verification: run `npm run build:dashboard` and `npm test`. With the backend available, run `npx --yes --package @playwright/cli playwright-cli -s=workspace-smoke open http://127.0.0.1:8000/`, then `npx --yes --package @playwright/cli playwright-cli -s=workspace-smoke run-code --filename scripts/verify_workspace_ui.js`. The browser smoke test uses an isolated WebSocket fixture; its commands never reach CARLA. Close that test browser afterward.

## What the experiment does

The existing SimulationService worker remains the only CARLA tick owner. Town10HD_Opt runs with fixed 0.05 second steps and seven ego sensors. Urban Chaos has 36 seeded Traffic Manager drivers, four VehicleControl hazard cars and 30 pedestrians. Twenty-eight walkers use native AI controllers; two scheduled crossings switch from their held AI controllers to native WalkerControl, with physics and collisions re-enabled. SUVs follow native road/sidewalk targets using throttle, brake and steering. Vehicles are never teleported to manufacture an event; blocked or reached states are measured from their actual motion.

Seed 2589 schedules braking at 8.41 s, cut-in at 16.58 s, crossings at 20.21/21.21 s, curb ascent at 29.48/30.48 s and reentry at 38.73 s. The ego target is 20 km/h over a native route approximately 185 m long, with initial horizontal speed zero. Spawn poses, blueprint attributes, physics start states, weather, route, controller settings, timer plan and seed are saved beside each recording. Both research arms disable BasicAgent vehicle, light and stop-sign checks equally. Ordinary journeys create a fresh agent with its normal settings.

The outcome is measured, never predetermined. RULE is a forward braking controller; this demonstration does not establish protection against all side impacts, pedestrians or chaotic crashes. SAFE_PROGRESS means zero recorded ego contacts and measured forward progress at the time limit; it does not mean the destination was completed. Ground-truth clearance is a planar bounding-box measurement for evaluation, not a safety-controller input. Collision impulse is a native N*s severity proxy, not injury severity.

## Graphics

| Preset | Native engine | Render | RGB | Depth | Postprocessing / bloom |
|---|---|---|---|---|---|
| Low | Low | 1280×720 | 640×360 | 640×360 | Off / 0 |
| Balanced | Low | 1600×900 | 800×450 | 640×360 | Off / 0 |
| High | Epic | 1280×720 | 800×450 | 640×360 | On / 0.15 |
| Ultra | Epic | 1920×1080 | 1280×720 | 640×360 | On / 0.5 |

Motion blur is zero throughout. CARLA has two engine quality levels; these are four real combinations of engine settings and camera calibration. Weather is independent and fixed between the two arms. A failed launch restores the previous working engine/camera settings and shows its reason. There is no automatic load-based downgrade.

CARLA quality reference: [official rendering options](https://carla.readthedocs.io/en/0.9.16/adv_rendering_options/). Native walker controllers disable physics/collisions at start, so scripted crossings explicitly restore both after stopping AI navigation; see [CARLA 0.9.16 WalkerAIController source](https://github.com/carla-simulator/carla/blob/0.9.16/LibCarla/source/carla/client/WalkerAIController.cpp).

## Study and evidence

- `backend/computer_vision/README.md`: existing Nano ONNX 320, one CPU thread, 1 Hz detection, crop-only English recognition.
- `backend/nlp/README.md`: raw OCR, normalized tokens and conservative deterministic road instructions; no trained NLP model.
- `backend/learning/README.md`: frozen 4,611-parameter NumPy behavior cloning and separate experimental RL.
- `backend/signals/README.md`: seven sensor decoders, synchronization and radar processing.
- `docs/evidence/urban_chaos/native.json`: measured final pair, native actor inventory, checksummed recording/replay audit and initial-condition proof.
- `docs/evidence/urban_chaos/perception-old.json` and `perception-new.json`: offline CPU measurements on the same three recorded native images. These are small presentation measurements, not a general benchmark.
- `docs/URBAN_CHAOS_REHEARSAL.md`: final actual outcomes, graphics verification and remaining limitations.

Recordings remain under `runs/normal_city/`, in the existing replay format, with RGB/depth/LiDAR assets, telemetry, collision events, full manifests and `comparison-controls.jsonl`. The buffered writer has a bounded queue and reports disk errors rather than silently dropping frames. Run `python -m scripts.native.verify_urban_chaos` after both real Urban Chaos runs to re-audit them. The optional `run_urban_chaos.py --mode PAIR` sends the same production backend requests and never creates a simulator or tick owner.
