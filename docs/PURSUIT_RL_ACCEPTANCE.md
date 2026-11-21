# Acceptance contract

Keep the original specification by reference to the [master](PURSUIT_RL_MASTER_SPEC.md). Do not use any of the headless development/negative fixtures below as holdouts. Pass/fail attaches to the exact code, browser bundle, environment, seed set and checkpoint hash used. Distinguish real engine ticks, browser, replay, fixtures, and source audit.

## First runnable slice (M1)

| Check | Independent outcome and negative control |
|---|---|
| `foundation`: dispatch | Zone report through a solid; exit freezes the last report; local reacquisition resumes updates. Unsighted twin accepted runs with different hidden ego motion must preserve identical patrol poses, paths, roles, IDs and roadblocks until reacquisition; the same divergence when tracked must matter. Reach `ESCAPED` with actual mobile pursuit; braking, low-speed/disabled units or a trivial boundary exit cannot pass. Under `--legacy-control` the same idle input exposes the known legacy false escape. |
| `foundation`: physical speed | On a usable Metro avenue, a one-second saturated straight-line plateau of accepted motion, with ego >=27.5 m/s, gives a capable unit **10–25%** advantage and a closing gap over three seconds. Compare legacy with the same physical start/action fixture. Independently exercise path-following pace rather than assuming it inherits the direct speed cap; this does not prove fleet difficulty or safe turning. |
| `foundation`: perception | Simultaneous front and rear returns plus side/diagonal bearings. First-return occlusion, unknown motion/age, TTL removal, finite bounded TTC on approach but not recession. The **whole flat learner vector** ignores hidden-only body/FSM/dispatch edits; a corresponding visible change affects it. No frame means an error, not privileged fallback. Confirm finite/range/angle limits and maximum five stale ticks at shared cadence. |
| `browser`: integration | On the unchanged rendered City, start legacy GTA and then new dispatch through real controls. Demonstrate accepted movement, visible live tracking/phase, pause/stop and same ambient actor identity. Inspect gameplay captures, no browser/HTTP errors, and stopped owned server. Headless checks do not certify UI. |
| `legacy`: preservation | Compare baseline verifier output and sampled legacy engine/observation/replay digests across seeds and five levels, both unversioned and explicitly `legacy`. Do not replace the previously pinned 468-tick legacy ending or weaken any historical test. |

## Final acceptance (not satisfied by the first slice)

Freeze separate train/validation/holdout manifests before training; holdout identities are only opened for final scoring, never debugging or checkpoint selection. At least **100 untouched full scenarios** with per-level 1/3/5 counts; initial minimum legitimate escape **60%** medium and **30%** highest, plus simultaneous collision-free escape rate and uncertainty, matched untrained/scripted baselines, real pursuit data and complete failure classification. No reduction of these targets because a smoke experiment fails. Report zero pedestrian impacts in feasible deterministic safety critical scenarios, zero civilian impacts in feasible avoidance scenarios, physical contacts/impact severity and near misses, finite values, no hidden observation data or collisions bypassed, and correct stopping when boxed with no feasible exit.

| ID | Real positive/negative measurement (pending unless evidenced) |
|---|---|
| L01 | Registered headless Lab case: single unit moved 36.11 m and closed 14.80 m in 144 ticks; its no-patrol twin matched SUV motion without qualifying. |
| L02 | Faster unit gains measured distance on open road; unchanged legacy pace negative. |
| L03 | Registered headless Lab case: both directions closed for 144 ticks and appeared together in a fresh scan. Guarded straight requests stayed clean; the unguarded twin hit. Both units moved in the two-rear control without a front return. |
| L04 | Side-street entry and effective flank across unseen layouts; state label alone fails. |
| L05 | Physical junction interception under target route changes; stationary intercept label fails. |
| L06 | Real roadblock changes decisions while alternate path remains viable; solid wall/no exit fails. |
| L07 | Surrounded ego reverses and turns into viable path; stationary/unsafe contact fails. |
| L08 | Civilian congestion physically changes escape action; empty-road control. |
| L09/L10 | Left/right sudden pedestrian entry safely resolved independently; non-entry and unsafe-late controls. |
| L11 | Dense mixed population retained while safety is measured; despawn/far-cull negative. |
| L12 | Real police reaches scene during pedestrian yielding; police disabled/control. |
| L13 | Rear closing unit observed while front blocked; no-rear-input negative. |
| L14 | Hidden obstacle does not leak; stale track uncertainty and expiry; always-clear and never-expiring controls. |
| L15 | Shared-zone entry, occlusion, exit, meaningful separation and search; stationary/empty and trivial boundary negatives. |
| L16 | Local reacquisition after loss with no fresh hidden positions; solid-occluded negative. |
| L17 | Five-star roles and actual multidirectional pressure; compare same seeds lower levels and state-label-only negative. |
| L18 | Narrow oncoming conflict resolved within actual room; no invalid lane or building cut. |
| L19 | Stop when infeasible without invisible obstacle removal; add viable exit and require it taken. |
| L20 | Seeded full randomized city, all hazards and no powers; reject disabled or dropped threat categories. |

Predeclare performance workload, hardware, viewport, graphics and sampling after a real baseline and before tuning. Aim for 30 steady rendered FPS on supported high-density hardware, not callback counts or fewer NPCs. Retain frame-time percentiles, accepted ticks per wall second, actors, memory and inference latency. Capture/inspect browser start, active maneuver, recovery/end; exercise manual, ordinary and experimental modes, missing checkpoint, Lab → trained checkpoint → City, pause/resume/restart, touch and replay. Independent QA must be able to fail any item; an unresolved root cannot be reported complete.

Run `node tools\verify-metro-lab-approaches.mjs` for the actual L01 and L03 Lab checks. These scoped physical results do not establish learned maneuvering, automatic City deployment, or held-out escape performance.
