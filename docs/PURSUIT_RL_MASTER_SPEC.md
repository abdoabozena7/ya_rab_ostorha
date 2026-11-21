# Metro pursuit RL: master specification

**Status: OPEN.** The source of requirements is the user's “MASTER IMPLEMENTATION MISSION — YA RAB OSTORHA”, preserved verbatim by HarrTest under `.runtime-proof/root-goals/pursuit-rl-master-20261120/` (SHA-256 `c46d18826898886d6f25642a8ba0940eeda50adf5519a93e44f5010053f1dc5a`). This is not a replacement goal and a child gate cannot close it.

| Requirement | Source | Required outcome |
|---|---|---|
| Metro and preservation | User §§1–4, 17–19 | Extend the existing playable City and current Lab; keep all old modes, controls, populations, assets, replay, and saved policies. Do not start historical engines or alter their budgets. |
| Dispatch and pressure | User §5 | Overlapping inspectable City zones, legitimate information flow and escape; physically faster capable units; real lane changes, flanks, junction interception, roadblocks, surround, PIT, search and recovery; five measured pressure levels. |
| Living City | User §6 | Seeded and diverse civilian steering, turns, stops, congestion and pedestrian entries/reactions; retain 36/80 default, 96/144 high density, and a combined pursuit workload. |
| Sensing and safety | User §§7, 9 | Bounded all-direction geometric perception with uncertainty and closing motion, no hidden actor data; independently tested avoidance in combined hazards, including safe reverse, rear threats and stopping when genuinely blocked. |
| Actual RL | User §8 | Shared fixed-step plant; continuous controls, safety-aware reward and full curriculum; genuine updates, resume, evaluation, frozen inference and manual takeover. Do not label scripted fallback as learned; do not make a pursuit model the default ordinary pilot. |
| Arcade and presentation | User §§10–11 | Preserve Giant, Ghost, Mine and Pulse; make their effects tangible and synchronized. Keep the existing art/vehicle and deliver readable, responsive chase, collision, camera, audio, HUD and restart. Main RL benchmark has no powers. |
| Acceptance | User §§12–16, 18 | All L01–L20 with negatives and observable trajectories, safety and learning thresholds, unseen seeds, browser/density/timing/replay evidence, preservation, and adversarial independent QA. |

Baseline and preservation: [audit](PURSUIT_RL_AUDIT.md). Shared interfaces and milestone boundaries: [architecture](PURSUIT_RL_ARCHITECTURE.md). Fixed acceptance requirements: [acceptance](PURSUIT_RL_ACCEPTANCE.md). Current task/evidence ledger: [TODO](PURSUIT_RL_TODO.md).

HarrTest installed version **4.1.0 Gold**, not “5 Corporate”; Prove It **1.0.0**. Use the actual installed workflows. No model-client substitution, new branch/worktree, protected budget, or automated publication.
