# PAKO movement decision diagnostics

`pako-decisions-v1` records the start/end simulation ticks, elapsed seconds
(60 Hz), one wall timestamp, episode/session IDs, driver source/status and
checkpoint identity. Action provenance is `requestedAction` → optional
`shield` / `planner` → `submittedAction` → actual `appliedAction` and
`appliedCommand`. The accepted end pose, acceleration, yaw, observed scan and
physical guard restrictions are separate fields. Contact resolution and
terminal cleanup still belong to the existing World.

`stopReason` can be null while moving. It distinguishes an actual timeout,
terminal or capture, an actual collision response, pause, explicit driver
fault or stale scan, the physical guard, a shield substitution, and
policy/manual braking. `QUEUE_YIELD` means the queue planner supplied a full
brake that the driver had not requested; it does not replace a higher-priority
physical veto or terminal cause. `UNKNOWN` means speed was low with no recorded cause.
`NO_ROUTE` / `CURB_BLOCKED` require an explicit producer reason; a missing
optional route or a road rejection is not evidence of either. Fault, shield
and per-tick guard evidence remain available even when a terminal reason also
applies. Road support and measured surface clearance are not interchangeable.

The [paired full-density verification](../.runtime-proof/pako-queue-stop-provenance-20261121/runs/dense/20261121T201548-b52a4e2517/dense-stop.json)
matched both prior complete pose and command hashes. With a real civilian
surface ahead at tick 3654, positive PPO throttle was replaced by a queue
brake with no shield veto. `UNKNOWN` became `QUEUE_YIELD`; none of the
162 stationary queue ticks in the preview were mislabeled. This is a trace
correction. The blocked run still timed out.

In **Experiments → Metro Dispatch → Chase diagnostics → Save decision trace**
download a bounded JSONL trace for the current or most recent round. The
same Python server and City run; the trace does not inject replay commands.
Headless callers can pass a `PursuitDecisionTrace` to `GtaPursuitEnv.reset`
to collect interval reward components and steer/guard provenance. `worldReference`
includes authoritative nearby police actor IDs and poses for diagnosis only;
policy observations remain first-return surfaces with separate track IDs.

## Reproductions

| Development reproduction | Independent observation |
| --- | --- |
| Real rear patrol, clear front | The SUV moved **10.28 m** in 84 ticks in L01 with a visible closing tail and finite measured TTC. No forward shield stop. This is a known advancing control, not a learned response. |
| Front barrier at 7 m | A requested forward move was replaced by full brake. The guarded SUV stopped at **4.40 m** of travel; an isolated guard-off, low-health twin hit the solid at tick **32**, wrecking. |
| Road edge | An outward turn on University Avenue physically stopped at the supported pavement end without a contact. The trace keeps the positive throttle request and the actual plant brake as `ROAD_BOUNDARY`; it is not evidence of a curb veto or a shield decision. |
| Two close active patrols | With the two units placed within the physical sight/pin radius and slowed to isolate the timer, a held brake earned real capture at tick **132** (2.2 s). Earlier records say `POLICY_BRAKE`, the terminal record `POLICE_PIN`. This is not proof of a moving pressure case or absence of a way out. |
| Time limit | A 0.3 s round truncated at tick **18**, with a separate `EPISODE_TIMEOUT` reason. |
| Frozen policy throws / missing scan | Both can brake while World advances and phase stays `running`, but report `CONTROLLER_FAULT` vs `STALE_OBSERVATION`. The fail-closed action is not the requested policy action. |
| Transient vs persistent scan loss | The new opt-in driver brakes until observation returns. The temporary outage resumed on the new scan at tick **6** and accepted **0.154 m** by tick 30; persistent loss ended in `fault` at tick **18** with zero travel. A malformed frame still fails closed immediately. The legacy experimental behavior is unchanged unless the preview is selected. |
| Manual steering | On the original browser bundle and the same left-input oracle, ordinary and Dispatch moved **+0.073 m** and **+0.132 m** to screen-right. Arcade moved **−0.260 m** to screen-left as requested. Correct the key-to-action mapping only, not the plant. |

Reproduce: `node tools/verify-pako-stops.mjs --diagnostics`. Set
`PROVE_IT_OUTPUT_DIR` to a new directory to retain the full JSONL. Original
evidence is under `.runtime-proof/pako-convergence-20261121/runs/stops/` and
`steering-baseline/`; current-source results are distinct receipts.
The traffic and blocked/left/right/reverse cases must also verify contact-free
progress after the maneuver; `SAFETY_INTERVENTION` alone does not justify
staying stopped in a case with a physically viable exit.

### Dense City timeout diagnosis

The retained five-star development timeout has two separate delays. On Civic
Avenue the policy was **already requesting throttle**, but the guard held
it behind a measured slow sedan. The front return stayed around **2.75–2.90 m**
during the long stop, and the pavement guard reported clear. The later stop
near the static route endpoint was different: the policy itself requested
partial brake with **no** shield intervention after losing patrol tracking.

On the same full-density prefix, an early guarded lateral control crossed
the queue boundary at tick **2580** with no SUV contact or pavement reject
through tick 3540. Both lateral controls started later and failed to pass.
The attempted automatic bypass likewise failed and was not kept in the
game. Those outcomes rule out simply driving through the front return,
and do not identify every possible route. Raw inputs, requested/applied
controls and accepted movement are retained under
`.runtime-proof/pako-chase-safety-20261121/queue-*.json`.

Refreshing the public route cue before the late stop did not complete the
episode. Two counterfactuals met separation but reached the same 120 s
deadline before satisfying sustained loss. Keep that deadline and the
scoring rule unchanged; the earlier traffic delay is the useful target.
