# Final reliability pass — bounded, partial native acceptance

Baseline commit: `2199161`. Existing UI edits, earlier evaluations, recordings,
models and preferences were retained. No model training, graphics changes or
dashboard features were added. RULE remains the default; LEARNED remains
experimental. The single simulation worker retains tick/lifecycle ownership.

1. **Sensor freshness root cause and fix.** Ordinary recording wrote each native
   asset, verified its checksum, then read/hashed those same assets again while
   writing/flushing every telemetry/event row on the simulation worker. Valid
   synchronized native frames consequently exceeded the wall receipt watchdog.
   Journey setup could also arm automatic control against observations collected
   before route/recorder setup finished. Recording now uses a nonblocking queue
   limited to 128 items and 64 MiB of sensor bytes. Disk/serialization work,
   including the comparison control trace, runs on its bounded writer; streams
   flush in batches and on idle/close. Admission stops on overload, reports
   dropped frames/events/trace rows and retains an ordered prefix. A durable
   incomplete marker is atomically replaced only after finalization; replay
   refuses incomplete/unfinalized recordings. Native receipt time is captured
   before decoding, independently of publication time. Driving arms after two
   new synchronized frames and checks receipt age again after safety processing.
   The original 0.25 s safety wall limit and 0.10 s simulation-age limit remain.

2. **Recording OFF/ON and replay.** Same spawn 152, destination 121, seed 2621,
   40 NPC vehicles / 30 walkers, BasicAgent at 20 km/h, RULE, seven existing
   sensors, 12 simulation seconds per run, unchanged native Low / D3D12 /
   1280x720. OFF: 12.36 steps/s (19.422 wall seconds), zero freshness failures,
   zero incomplete observations. ON: 11.89 steps/s (20.188 wall seconds), zero
   freshness failures, zero incomplete observations and zero dropped recording
   frames/events. The ON replay has 252 contiguous frames; all sensor frame IDs,
   timestamps, byte lengths and binary checksums verified. These measurements
   precede the final surface-registration refinement and comparison-trace
   hardening; they are evidence for the ordinary recording change, not final
   whole-product native acceptance. No 20 steps/s performance claim is made.

3. **Reversing SUV.** Archived collision frame 77714 involved the named
   `curb_return` Nissan Patrol. The existing roof LiDAR (z=1.9 m, 360 degrees,
   16 channels, 32,000 points/s) had relevant returns; the policy discarded
   surfaces outside its forward x>2.5 m / |y|<=1.35 m corridor. Front radar/depth
   did not cover this close flank. No sensor was added. The final policy tracks
   connected measured LiDAR surfaces, compensates ego motion with onboard
   speed/IMU, registers successive returns and predicts swept body overlap/TTC.
   It requests conservative braking; steering avoidance remains disabled.
   Unobserved/occluded side and rear space explicitly remains unverified.

   The first native seed-2604 run exposed excessive centroid-motion braking:
   zero collisions, 0.331 m minimum clearance to any actor, 15.846 m distance,
   14.024 m progress, 27 interventions in 60 simulation seconds. Its first side
   request was at 2.50 s; motion resumed at 3.55 s (1.027 m displacement), but
   ego never reached the reversing SUV. The named SUV was outside the recorded
   actor coverage throughout; SUV-specific clearance/intervention timing is
   therefore **not measured**. This is not a successful reproduction.

   Point registration replaced the centroid estimate to avoid treating changing
   visible surface bounds as actor velocity. The final offline replay detects
   a relevant right-side conflict at frame 77675, 1.95 simulation seconds before
   the original contact, with measured motion and TTC. This is a counterfactual
   decision, not a demonstrated prevented collision. The changed-condition
   seed-2605 observation first captured an old FINISHED result; it was explicitly
   excluded. The final attempt crashed during native reset before driving armed.
   Changed-condition collisions, clearance, intervention timing and resumed
   progress remain **not measured**. No general side/rear protection claim.

4. **Pedestrians.** Earlier published population was 26/30. Replenishment sampled
   nearby valid sidewalks but rejected every replacement within 120 m of ego,
   starving the eligible pool. Failed batch spawns also retried occupied points;
   missing controllers could leave owned walker entries unrepaired. Replacement
   now excludes the immediate 15 m region and camera frusta, uses spaced valid
   alternate locations across retries, and retires missing walker/controller
   pairs before replenishment, without creating another tick owner.

   OFF and ON each measured 30 walkers / 30 controllers immediately after spawn,
   after 3 simulation seconds of warm-up, and after the 12-second drive. Native
   walker spawn failures were 1 in OFF and 2 additional in ON; retries recovered
   all three. Controller spawn failures: zero. Lost walkers during these short
   drives: zero. A managed reset verified 1 ego / 0 walkers / 0 controllers /
   7 sensors. The mechanism that originally removed the four native walkers was
   not captured; the deficient retry/ownership paths were identified and fixed.
   Final cleanup after the interpreter crash could not be confirmed by native
   actor queries; no backend/CARLA/perception processes remained when inspected.

5. **Relevant regressions.** 97 focused tests pass: bounded overload and disk
   failure, explicit incomplete replay rejection, batched frame/trace order,
   unchanged freshness/rate gates, late processing fail-stop, sensor-only lateral
   and observed rear approaches, stationary/partial surface rejection, braking
   release without steering changes, alternate walker spawns, missing controller
   cleanup, existing comparison, sensor pipeline, command/lifecycle contracts and
   experimental learned-policy boundaries. No broad campaign was launched.

6. **Limits and blocker.** Six attempts including rejected/aborted setups;
   cumulative native test wall runtime 228.0 seconds. No further native episodes
   were started. Windows Application Error recorded backend Python PID 23792
   failing in `ucrtbase.dll`, exception `0xc0000409`, at 2026-10-10 00:23:42 Cairo,
   during the final controlled reset; the socket then disconnected without a
   close frame. There is no Python traceback establishing which native call
   caused that abort. The final revised LiDAR policy and trace hardening have
   offline regression coverage, but final native SUV acceptance is unresolved.
   Short population stability is measured, not long-duration stability.

7. **Startup and evidence.** From `D:\projects\Ai\ya_rab_ostorha`, use separate
   PowerShell terminals (the existing launcher waits for CARLA to exit):

   ```powershell
   .\scripts\launch_carla.ps1 -Profile Development -Renderer D3D12 -Quality Low -Resolution 1280x720
   ```

   Once CARLA is ready, in the second terminal:

   ```powershell
   .\.venv-carla\Scripts\python.exe -m backend.server --carla --sensors --spawn-index 152 --start-paused
   ```

   Raw evidence: `output/native-validation/final-reliability-20261010/validation.json`,
   `offline-suv-audit-registered.json`, `native-python-crash.json`, telemetry and
   backend logs alongside them. ON replay:
   `runs/normal_city/run_94df34c4e0c64e909a7dde1886ac8d83`.
   Preliminary SUV replay:
   `runs/normal_city/run_d7c1b561f7974060b25a7986e2345572`.
