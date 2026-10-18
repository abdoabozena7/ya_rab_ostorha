# Consolidated delivery — 14 October 2026

## One place to work

The canonical branch is `main`, tracking `origin/main`. The only active Git
worktree is `D:\projects\Ai\ya_rab_ostorha`. The repository is
[abdoabozena7/ya_rab_ostorha](https://github.com/abdoabozena7/ya_rab_ostorha).

All 12 former local branch tips were integrated into the delivery history before
their redundant branch references were removed. Most were already ancestors of
the final delivery. `codex/gate5-world-foundation` contained three additional
commits and was merged explicitly. Its world-foundation report, native evidence,
verification scripts and collision-event regression are retained. Merge conflicts
preserve the newer journey recording, RL collision ownership, route-crowding and
pedestrian-placement behavior. The older native verifier's stopped-vehicle guard
and distinction between unmeasured and zero NPC collisions are retained.

The current workspace changes were committed together, including source,
configuration, research checkpoints, tests, generated frontend bundles and
recorded verification evidence. The two detached reconstruction worktrees held
historical versions already reachable in the integrated history. They and the
Gate 5 worktree were removed after their ignored files were backed up.

The commit history remains available on `main`; consolidation does not flatten
the project into one commit. Historical reports describe their own source and
runtime versions and should not be read as current capability guarantees.

## Implementation and evidence index

| Area | Entry points | Detailed report |
| --- | --- | --- |
| Softly palette, local typography, responsive guided screens and reduced motion | `frontend/mission.css`, `frontend/sequential-drive.js`, `scripts/check_softly_theme_ui.js` | [18 October visual theme and isolated browser evidence](SOFTLY_THEME_20261018.md) |
| Guided simulation phases, ordered explicit transitions, reconstructable roles and Dense Chaos audit | `frontend/mission-state.js`, `frontend/sequential-drive.js`, `backend/core/presentation.py`, `backend/carla/dense_chaos.py` | [18 October guided delivery, retained native failures and acceptance limits](GUIDED_SIMULATOR_20261018.md) |
| Browser-owned verification, independent stop evidence, approach slowing and display/transport repairs | `backend/core/comfort_control.py`, `scripts/audit_driving_stops.py`, `scripts/verify_driving_browser_ui.js` | [18 October follow-up verification and remaining acceptance gates](DRIVING_VERIFICATION_20261018.md) |
| Sequential interface and grouped Details navigation | `frontend/guided-details.js`, `frontend/details-state.js`, `frontend/drive-state.js` | [18 October UI behavior and isolated browser verification](SIMPLER_UI_20261018.md) |
| Observation watchdog, actor cleanup, precise control timing and visual evidence | `backend/core/service.py`, `backend/core/host_clock.py`, `scripts/audit_driving_repair.py` | [18 October iterative driving repair and native evidence](DRIVING_REPAIR_CHECKLIST_20261018.md) |
| Launch and simulator lifecycle | `Start-YA-RAB-OSTORHA.ps1`, `backend/server.py`, `backend/carla/start_helper.py`, `backend/carla/stop_helper.py` | [Simulation start](SIMULATION_START_20261013.md), [GPU release and UI stability](UI_STABILITY_GPU_RELEASE_20261013.md) |
| Camera-first dashboard, map, driving and results | `index.html`, `frontend/dashboard.js`, `frontend/light-cockpit.js`, `frontend/driving-studio.js` | [Latest dashboard redesign](LIGHT_DASHBOARD_REDESIGN_20261014.md), [UI implementation](UI_REDESIGN_IMPLEMENTATION.md) |
| RULE protection, NORMAL commands and brake recovery | `backend/core/service.py`, `backend/core/active_safety.py`, `backend/core/congestion_recovery.py` | [Brake decision repair](BRAKING_DECISION_REPAIR_20261014.md), [Congestion recovery](CONGESTION_RECOVERY_20261014.md), [Normal navigation](NORMAL_SENSOR_NAVIGATION_20261013.md) |
| Sensor-derived motion and collision prediction | `backend/core/control_scene.py`, `backend/core/prediction.py`, `backend/core/motion_scene.py`, `backend/core/maneuver.py` | [Motion reliability](MOTION_RELIABILITY_20261013.md), [Predictive avoidance](PREDICTIVE_COLLISION_AVOIDANCE_V2.md) |
| Research training, budgets and acceptance | `backend/learning/`, `scripts/run_core_repair_pilot.py`, `config/core-repair-pilot.json`, `artifacts/learned_safety/` | [Core repair pilot and failed or pending gates](CORE_REPAIR_PILOT_20261014.md) |
| Native city population and route traffic | `backend/carla/population.py`, `backend/carla/urban.py`, `backend/carla/route_crowding.py` | [Gate 5 foundation](GATE5_WORLD_FOUNDATION.md), [Route crowding](ROUTE_CROWDING_20261013.md) |
| Recording, replay and matched journey results | `backend/core/recording.py`, `backend/core/replay.py`, `backend/core/journey_comparison.py` | [Native journey repair](NATIVE_JOURNEY_REPAIR_20261011.md), [Final demonstration integration](RULE_DEMO_FINALIZATION_20261012.md) |
| Gated hybrid behavior, native baseline, MP4 and simplified discussion controls | `backend/core/hybrid_driver.py`, `backend/carla/hybrid_navigation.py`, `frontend/demo-drive.js` | [15 October implementation and unfinished native acceptance](HYBRID_DRIVING_IMPLEMENTATION_20261015.md) |
| Automatic presentation, English interface and journey continuity | `backend/core/presentation.py`, `backend/carla/presentation.py`, `frontend/presentation-run.js`, `backend/websocket_bridge.py` | [15 October presentation and continuity evidence](AUTOMATIC_PRESENTATION_20261015.md) |
| Static surfaces versus measured crossing motion | `backend/core/path_conflicts.py`, `backend/core/surface_motion.py` | [16 October motion repair and scoped evidence](STATIC_SURFACE_MOTION_REPAIR_20261016.md) |
| Ordinary stationary-obstacle bypass and route-focused Restart traffic | `backend/core/route_bypass.py`, `backend/core/hybrid_driver.py`, `backend/carla/route_crowding.py`, `scripts/validate_rule_bypass.py` | [17 October scoped repair and retained native attempts](RULE_ROUTE_BYPASS_20261017.md) |
| Trustworthy surface display, sequential controls, timeout recovery and strict driving-quality audit | `backend/core/control_semantics.py`, `backend/core/presentation.py`, `backend/core/driving_quality.py`, `frontend/sequential-drive.js` | [17 October reliable-driving repair; native acceptance failed](RELIABLE_DRIVING_20261017.md) |

The detailed reports link their JSON summaries, screenshots and measured results
under `docs/evidence/`. Raw simulator recordings remain local in ignored `runs/`
and `recordings/`; they are not supplied by an ordinary Git clone.

## Run and maintain

Run the native dashboard from the project directory:

```powershell
.\Start-YA-RAB-OSTORHA.ps1
```

The README contains simulator, perception, recording and replay setup commands.
Native CARLA and local model/dependency installations are required for live
operation. Offline tests do not require starting the simulator.

Continue routine work in this existing checkout on `main`:

```powershell
git pull --ff-only
# Edit the relevant source and reports, then verify the changes.
npm run build:dashboard
npm test
.\.venv-carla\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'
git add <reviewed-files>
git commit -m "Describe the completed change"
git push origin main
```

Regenerate both checked-in dashboard bundles after frontend changes. Use `npm ci`
when installing the locked frontend dependencies. Future work uses this branch
and checkout unless the user explicitly requests another branch or worktree.

## Verification and capability limits

Consolidation verification:

- Dashboard JavaScript and CSS builds passed.
- All **107 JavaScript tests** passed.
- After the Gate 5 merge, Python discovered **425 tests**: **424 passed**, and one
  existing optional test was skipped.
- The retained Gate 5 regression verifies collision callbacks and outcome event
  timestamps against the current service implementation.
- The final delivery must have one local branch, one registered worktree, a clean
  tracked workspace and identical local/remote `main` tips.

The verification transcripts and commit identity map are retained in
[consolidation evidence](evidence/consolidation_20261014/).

This consolidation performs offline software verification. It does not run a new
native journey, reset experiment budgets or promote an experimental model to
accepted control. RULE remains the normal protection choice. The documented
learned-policy, maneuver, prediction, freshness and general urban-driving
acceptance limits remain in force; refer to the individual reports for failed,
incomplete and successful bounded validations.

## Large weights and history preservation

Two old tracked language-model files exceeded GitHub's per-file upload limit:

```text
.cache/models/nlp/Qwen3-1.7B-Q8_0.gguf
.cache/models/nlp/Qwen3-4B-Instruct-2507-Q4_K_M.gguf
```

They total approximately 4.33 GB. Their bytes remain in the local model directory
and in the verified recovery bundle. They are ignored in the current checkout.
Only these paths were removed from the unpublished delivery history. Published
`origin/main` history is preserved, so the delivery uses a regular fast-forward
push. Commit identities above that boundary change; the identity map records the
original and rewritten commits. Other research checkpoints remain versioned.

## Local recovery archive

The recovery archive is outside the active project:

```text
C:\Users\A-plus\.codex\backups\ya_rab_ostorha-consolidation-20261014
```

It contains a verified `repository-before.bundle` covering the original branch
history, tags, the retained historical GitHub Desktop stash and the consolidated
source checkpoint. `refs-before.txt`, `worktrees-before.txt` and
`status-before.txt` record the original repository arrangement.
`ignored-files/` preserves ignored files from the three retired worktrees.
Verification transcripts and the history rewrite map are also retained there.
The old stash belongs to the obsolete Three.js implementation and was preserved
as recovery data rather than reapplied over the current CARLA application.

To inspect original history without changing the active project, clone the
bundle into a separate recovery directory:

```powershell
$archive = 'C:\Users\A-plus\.codex\backups\ya_rab_ostorha-consolidation-20261014'
git bundle verify "$archive\repository-before.bundle"
git clone "$archive\repository-before.bundle" D:\recovery\ya_rab_ostorha-original
```

The archive is a safety copy, not another active worktree. Retain it if original
commit hashes, old model bytes or retired-worktree outputs are needed later.
