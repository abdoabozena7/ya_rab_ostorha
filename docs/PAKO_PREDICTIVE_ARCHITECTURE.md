# PAKO predictive architecture

The canonical physics still runs in `World` on Metro v4. At each scan decision
the learned PPO policy proposes a normalized action, a separately identified
experimental module may evaluate alternatives, the independent brake guard
can veto a request, and the unchanged plant commits accepted motion and
contacts. Do not claim that candidate construction or guard decisions are
learned. Legacy, stored PPO and unversioned replay behavior do not implicitly
opt in to predictive recovery.

Allowed data for prediction: the existing first-return scan and recent
associated motion, ego pose/speed/slip, SUV dimensions/dynamics, and public
static road geometry. Visibility is not occupancy certainty; missing and
stale observations are not proof that an exit is clear. Privileged actor
centers, scenario labels, future coordinates and private dispatch reports
are not inputs. Diagnostic `worldReference` is not connected to inference.

The live baseline predictor extrapolates associated observed surface points in
world metres, compensating for ego translation and rotation. It records
measurement age and expanding allowances. Stale or ambiguous tracks are
not treated as resolved motion. `node tools/verify-pako-tracks.mjs` scored
nine **0.5 s** forecasts against the corresponding material point carried
by the simulated tail: mean error **0.674 m**, all within the geometric
allowances. The mean instantaneous radial TTC error was **0.115 s**.
The longer horizons had no scored rows on this short fixture; neither
statistic establishes calibrated uncertainty or swept collision recall.
Vehicle surface forecasts now need two coherent velocity intervals from
consecutive tracked world-space returns. A moving viewpoint produced raw
speed spikes of 15.65 and 11.69 m/s on a stationary patrol; neither now
produces a confident forecast. The ray, track schema, frozen-policy inputs
and independent brake guard are unchanged. The [current moving-tail fixture](../.runtime-proof/pako-surface-motion-20261121/runs/tail/20261121T155352-9afbea87b7/motion-forecast.json)
resolved eight 0.5 s projections with mean error 0.787 m and all eight
inside the recorded allowances. Longer horizons remain unmeasured there.

The recovery adapter is opt-in under **Experiments → Metro Dispatch · PPO**.
It compares short, guarded same-gear candidates with a stopping envelope,
and has a separate conservative response to one measured closing tail
while held on the brake. A retained unseen surface uses an expanding
bound around its last measured world position; it does not block an
unrelated corridor simply because it is stale. Missing position evidence
does not grant movement. The final action still requires the unchanged
independent guard. A feasibility result does not assert reachable escape
or a globally boxed state. In mirrored staged openings, the SUV moved
**7.02 m** without contact while the brake-only control stayed still. The
paired rear fixture avoided a physical collision seen in the held-brake
arm through tick 60; the receding and obstructed-front negatives kept
braking. The connected-reverse pilot uses public road geometry to find an
available rear junction after a stationary, shield-vetoed request. It
rechecks the sweep and independent guard for one decision interval at a
time. A subsequent brake request cancels it. The paired L07-derived
development test backed **8.15 m**, turned **1.48 rad**, and reached
**16.01 m** into the connected road without contact or pavement denial;
both control arms stayed within **0.06 m** of the start. A scripted
forward request, not a consistently successful trained actor, took over
after the reverse phase. A [900-tick follow-up](../.runtime-proof/pako-reverse-transfer-20261121/runs/reverse/20261121T152723-75a9d9f726/frozen-reverse.json)
kept the full clearance, additional 10 m, and zero-contact requirements.
The scripted reference succeeded, but the exact frozen actor stopped
partway through the turn. The [rejected rejoin profile](../.runtime-proof/pako-reverse-transfer-20261121/runs/reverse/20261121T150306-84bbf91dc3/frozen-reverse.json)
entered the side street and had zero road denials, but still logged two
patrol contacts and only 8.14 m of further travel. It is not installed
in gameplay. High-pressure reverse safety remains open.

`verify-pako-conditioned-forecast.mjs` is a separate offline simulator
experiment. It compares a constant-velocity reference, a learned residual
without ego actions, and a learned residual conditioned on the requested
controls. Each branch starts at the same accepted pose and scan, and is
scored against the corresponding patrol surface in the independently
executed continuation. It is not part of the public movement guard.

This is not a learned interactive world model. Keep these outputs
visibly separate:

1. Forecasts from samples available at decision time.
2. Candidate trajectories under specified ego controls.
3. Action-conditioned traffic counterfactual predictions, once implemented.
4. Ground-truth accepted outcomes from a continuation or a separately
   initialized matched simulator. A predicted branch clearing is not escape.

`metro-survey-v1` adds one bounded physical shoulder to opt-in manual Metro
Dispatch. It admits only the original SUV footprint through a surveyed
Tahrir Boulevard envelope, limits lateral support speed, and checks traffic,
pedestrians and solids. Negative controls cover a tall solid, insufficient
clearance, an occupied walkway, and attempts outside the envelope. A
reconstructed 1,227-tick run reproduced the accepted poses exactly.
Ordinary City and replay without the versioned option retain paved-only motion.

The separate `patrolChainYield: "indirect-pedestrian-yield-v1"` option
checks for a second collision *before* a sufficiently aligned pursuing
patrol reaches the SUV. It uses accepted simulator geometry and speeds
at the NPC command boundary, a bounded forward projection after a rear
impulse, and static visibility to both the SUV and the potential secondary
impact. These plant calculations are not features in the learned observation
and do not modify the swept contact solver, health or score. The option is
recorded in replay and remains disabled by default. Run
`node tools/verify-pako-chain-safety.mjs` for the collision-positive default,
feasible protected crossing, harmless near-lane, and late-contact controls.

The `measured-queue-detour-v1` **environment-only** opt-in is a bounded
recovery controller, not a trained policy. Current associated first
returns and public bidirectional road dimensions identify a slow lead
away from the shared junction footprint. The planner compares the passing
lane with yielding, checks a road-supported stopping envelope, and
rechecks a measured home-lane gap. Return can follow a lead seen behind or
take place behind a lead now pulling away. Reattachment uses accepted
ego displacement plus a hard elapsed cap; stopped yield time does not
consume its travel allowance or override the independent brake guard.
The old `dispatch-route-v2` default, collision solver and City release
setting are unchanged. The research-only `clearance-corridor-v1` route
ablation picked an earlier geometric route but failed physically and
is not used by the detour. Neither is a joint learned world model.

The separate `measured-queue-corridor-v1` environment opt-in also rejects
entry when a measured vehicle, pedestrian, or patrol occupies the next
part of the passing lane needed to clear the lead. A visible stationary
return still occupies the corridor; a missing velocity does not make
that surface disappear. This longer test applies **before** lane entry,
not as a continual long-range brake. During the maneuver the existing
shorter receding check, road stopping envelope, and independent guard
still apply. Occlusion is not evidence of an empty lane. Neither option
is a public PAKO policy or a substitute for safety validation.
