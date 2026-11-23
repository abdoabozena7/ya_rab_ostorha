# PAKO research protocol — preregistration, no final scores

[BirdDreams (NVIDIA/KAIST)](https://research.nvidia.com/labs/sil/projects/birddreams/)
is motivation for metric BEV and evaluating traffic reactions to alternative
ego trajectories. The project is not a reproduction of its single-image
joint RGB/BEV generative world model. Start with the simulator's observed
metric surfaces; do not import external models or data as part of this correction.

Freeze source, observation variant, reward, PPO hyperparameters, evaluation
build, checkpoint hashes, contact/event schema and seed split before the
first final run. Keep the prior [Metro protocol](PURSUIT_RL_ACCEPTANCE.md) and
existing untouched seed custody intact. This corrective protocol requires
at least **108 full episodes per comparison arm** (36 each at levels 1, 3, 5;
12 dense at each level), fixed before fitting with separately owned unseen
seeds. Use 36/80 and 96/144 start populations, front/rear/opposing cohorts,
and independently adjudicated feasible open/enclosed routes. Do not drop an
episode because it was difficult, timed out, crashed, stuttered or lacked
a policy decision; report that outcome. Freeze any feasibility criterion
without looking at the candidate's results.

At identical evaluation seeds and comparable training transitions, compare:
untrained PPO and the current exact frozen predecessor, then PPO (A) without
prediction, (B) with temporal coordinate motion, (C) with short-horizon ego
and police trajectories, (D) with action-conditioned traffic predictions,
(E) with candidate comparison and independent safety veto. Separate changes
to rewards, map input, gradient budget and scripted assistance with matched
ablations. Use healthy active police and unchanged contact physics in all
scored full runs; guard-off safety negatives are isolated fixture controls.

Primary outcome: qualified `escaped` with zero ego physical contacts for
the whole episode. Report medium **≥70%** and five-star **≥30%** on the
adjudicated feasible cohorts; publish all raw denominators, independent
paired effects and 95% uncertainty intervals. Track all ambient impacts
separately and require zero pedestrian impacts in the specified deterministic
feasible safety suite. Also report escape/survival time, capture and
deadlock rates, intervention duration, contacts by actor class, timing and
capacity with both densities. Do not substitute development wins or score
improvement for escape.

For forecast evaluation, save the observation and frozen forecast issued
before the action. Score (0.5, 1, 2, 3, 5 s) at fixed matching target
definitions, report observed/resolved/missed denominators, ADE/FDE, TTC
error, interception/collision precision and recall, uncertainty calibration,
and track swaps/expiry. Compare each action-conditioned branch with its
accepted future in an isolated same-state/same-randomness continuation.
Do not use the future to generate the forecast. Preserve the original
evaluation trajectory unchanged.

No holdout was used for this corrective slice. No new model is eligible
for the PAKO release allowlist until the required evidence is reviewed.

## Retained development comparisons (not the A–E final study)

- **Inference-only ablation:** all three bounded adapter revisions used the exact
  same checkpoint and all four 120-second, standard/dense historical
  development cases. All three preserved the baseline's **3/4 qualified,
  zero-ego-contact escapes** (2/2 medium, 1/2 five-star), seven ambient
  pedestrian contacts, and identical accepted pose hashes. None of the
  revisions selected an alternative there; this is noninterference, not a
  benefit. See `planner-transfer-20261121-101601` and
  `planner-with-rear-transfer`, plus [the current matched comparison](../.runtime-proof/pako-convergence-20261121/planner-localized-stale-transfer/comparison.json).
- **Actual PPO continuation:** the headed crossing-with-patrol checkpoint
  trained for eight additional updates using only the existing development
  training seeds (**4 → 12** updates, **320 → 960** transitions). Its two
  matched validation drives decreased from **41.05/40.05 m** to
  **37.73/37.88 m**, versus **43.16/43.28 m** untrained. All timed out,
  no ego contact in these cases, and the updated returns also worsened.
  Retain both results and do not promote the continuation.
  Raw checkpoints and metrics: `ppo-crossing-predecessor` and
  `ppo-crossing-continuation` in the same directory.

The [earlier junction probe](../.runtime-proof/pako-convergence-20261121/counterfactual-junction.json)
identified a feasible reference: at Corniche/Station the approach that
began 7 m before the intersection reached the branch, continued 27.52 m,
and had no contacts through the five-second deadline. Brake and straight
controls collided. The exact frozen PPO, with or without the preview,
also collided in both starts; neither followed the demonstrated clean
branch. See [accepted paths and requests](../.runtime-proof/pako-convergence-20261121/counterfactual-junction-policy.json).
Several other turn timings failed, so retain them.

Two different guarded turn timings shared the initial accepted state
through tick 18 and then produced **3.59 m** divergence in the patrol's
actual position after two seconds, **7.95 m** after three. Even the
evaluator's privileged constant-velocity reference, fitted only at that
common starting tick, was **4.48/5.34 m** wrong after two seconds. This is
evidence that the simulator reacts to ego actions, not an implemented or
validated predictor of that reaction. The original trajectories were not
modified when scoring.

The next round should collect distinct training-only junction approaches
with this physical oracle and compare policy-only with an earlier guarded
lateral preview. Keep the original independent cases out of training and
do not open the untouched evaluation until development safety passes.

## City continuation: earlier intent and action-conditioned forecasts

- The [judged junction experiment](../.runtime-proof/pako-city-continuation-20261121/runs/junction/20261121T091518-c58cc31c17/junction-comparison.json)
  collected 350 approved teacher decisions from Civic, Gateway and Tahrir
  and made one PPO update on 450 sampled transitions. It used a new
  experimental public-map intent vector, odometry and the existing scan;
  no hidden actors or teacher drove the evaluated actions. On four different
  University/Station development starts, both warm and PPO passed **2/4**,
  versus **0/4** previous and **0/4** random initialization. Two cases still
  touched a physical road guard. This is improvement of the combined recipe
  versus the old actor, **not** improvement attributable to PPO alone or to a
  full City escape policy. The public checkpoint importer rejects the
  junction research observation schema.
- The [matched forecast experiment](../.runtime-proof/pako-city-continuation-20261121/conditioned-forecast-02/conditioned-forecast.json)
  fitted 60 training continuations and scored 56 on disjoint junctions
  (five horizons; all observed in the evaluation). Mean displacement error
  was **7.99 m** constant velocity, **5.64 m** learned without actions, and
  **1.93 m** learned with ego actions. On two sequences excluded from fitting
  it was **6.73/4.52/3.84 m** respectively. The training 90% residual band
  covered only **75%** at 2 s and **82%** at 5 s in the conditioned validation.
  Do not use those bands as a safety guarantee. This is a single-patrol
  approach study; collision calibration, action-conditioned civilian
  forecasts, replicated metrics under dense traffic, and the full A–E
  policy comparison remain open.

## Queue follow-through

The [sealed queue gate](../.runtime-proof/pako-queue-learning-20261121/contract.json)
kept the original 600-tick window and separated Corniche/Station/Tahrir fit
starts from University/Gateway development validation. The
[original comparison](../.runtime-proof/pako-queue-learning-20261121/runs/learn/20261121T111738-2c925e5e49/queue-learning.json)
used 890 examples from contact-free prefixes and made a real PPO update
on 900 new transitions. Warm-only and PPO both cleared the lead in all
four cases, but rear impacts followed. Prefix eligibility was used only
to choose demonstrations, not to shorten scoring. The unchanged oracle
gave zero passes to the teacher, predecessor, untrained, warm and PPO arms.

The follow-through probe tested a different physical action, a connected
turn past the lead, while retaining the same active patrol in each run.
On three shorter fit roads the selected scripted turn completed **9/9**
clean 600-tick windows, versus **0/9** for straight acceleration. That
made nine complete demonstrations available instead of partial ones.
The [branch experiment](../.runtime-proof/pako-queue-learning-20261121/connected-learning-01/queue-learning.json)
trained a separate actor from 900 demonstration decisions and 900 sampled
transitions. Its four added inputs describe the intended public branch
and ego speed, not hidden traffic or measured success. During inference
the actor generated both steering and longitudinal control; the script
never supplied actions to the frozen arms. The lab-only reward adds a
terminal bonus for actual clean branch completion, not for raw distance.
The PPO checkpoint weights changed, but none of its nine sampled episodes
qualified for that bonus. An optimizer update is not a performance gain.

The reference and frozen actors all failed on the longer development
starts. The script cleared the obstacle and reached the branch in four
cases, but first took a rear impact at ticks **373–378**. The learned
actors also attempted unsupported steering on the approach. The
[long-approach and opposing controls](../.runtime-proof/pako-queue-learning-20261121/follow-through-diagnostics-01/queue-follow-through.json)
showed that faster entry or earlier outer-lane alignment did not fix the
full-window result. Own-lane yielding avoided all direct hits on the
opposing sedan (**0/9** versus **5/9**), but it left too little room to
start a bypass once the sedan passed. All nine yield arms had a rear hit.
Keeping a measured 7.5 m standoff while waiting gave the SUV room to
pass once the opponent cleared, but on all nine starts the first patrol
hit preceded the accepted lead clearance. The raw traces and
[executed diagnostic source](../.runtime-proof/pako-queue-learning-20261121/standoff-diagnostics-02/executed-probe.mjs)
are retained; the failed variant is not used by the normal harness.

Neither research observation schema can enter public frozen playback.
The next candidate needs a demonstrated safe action before the queue
closes off the lateral setup, not another PPO update on the same late
approach. Rerun original development and opposing negatives without
shortening the window. No training used independent cases or protected
full-pursuit evaluation.

### Measured pass and return in the full City

The [matched final detour](../.runtime-proof/pako-measured-detour-20261121/runs/city/20261121T121257-1688ebd670/comparison.json)
and [additional paired transfer](../.runtime-proof/pako-measured-detour-20261121/accepted-distance-transfer-01/comparison.json)
show a change from three to four ego-clean qualified escapes. The opt-in
planner, not the weights, changed: pass a resolved slow lead, reattach to
the original lane before handing control back, and return behind the
same observed lead if it accelerates away. The phase trace records this
last outcome separately from overtaking. There is no automatic public
opt-in. The [independent physical retest](../.runtime-proof/pako-measured-detour-20261121/independent/runs/score/20261121T121926-18d39fd9c3/score.json)
still fails the whole pass and contact-free requirements.

A [separate PPO continuation](../.runtime-proof/pako-detour-learning-20261121/runs/learning/20261121T115727-ae29ee6cf1/report.json)
loaded the exact prior weights and optimizer, collected 2,400 actual
sampled decisions on two complete 120-second fit episodes, and changed
the weights (L2 delta 0.1088). Neither training episode escaped. With
the then-current assist, the unchanged and continued checkpoints both
scored **0/2** versus **2/2** for the exact prior without the assist.
On the [later fixed assist](../.runtime-proof/pako-detour-learning-20261121/frozen-on-corrected-detour-01/frozen-transfer.json),
the saved continuation ran *without additional training* and matched
the unchanged-assist score of **2/2**. It took 427 ticks longer on one
case and 219 fewer on the other. That is not improved escape probability
attributable to PPO. Use a new disjoint development split for further
policy fitting/selection; keep the independent case and the untouched
full-pursuit benchmark out of training.

### Closer tail and later oncoming traffic

The [lookahead screen](../.runtime-proof/pako-passing-corridor-20261121/runs/fit-reference/20261121T123445-0cc7d961ed/queue-lookahead.json)
kept the same moving patrol at a 25 m start gap and scored all 600 ticks
after staging. The earlier, higher-pace script passed the lead on clear
approaches much more often than the exact predecessor, but only **4/18**
arms completed contact-free branch motion; all were on Tahrir. The
opposing sedan physically started moving later. Seeing it in the
passing corridor before entry eliminated opponent contacts (**18/18
to 0/18**), but rear contact then occurred in every protected arm.
No new policy was trained from these trajectories. A contact-free
short pass, or avoiding just one contact class, is not an escape.

### Complete connected recovery and learned transfer

The [full-window fit reference](../.runtime-proof/pako-connected-window-20261121/runs/references/20261121T141656-df9fc42c77/connected-windows.json)
kept an active patrol 22 m behind and a stopped civilian in its original lane.
The guarded Station and Souq references escaped at ticks **1,148** and **875**,
with no contacts or road denials, and sustained motion after whole-body branch
clearance. Three other fit roads did not meet that terminal criterion.
The early static-corridor check prevented barrier contact across the blocked
controls, but did not prevent every patrol impact. Neither fit geometry nor
these references are release or held-out evidence.

The [frozen comparison](../.runtime-proof/pako-connected-learning-20261121/runs/learning/20261121T141656-55f847c5eb/learning-comparison.json)
used 1,014 demonstration decisions from complete fits and 1,702 decisions for
two real PPO updates. The guarded teacher escaped **4/4** on separate
development starts; the incumbent, untrained, warm-only and PPO actors each
scored **0/4**. [Replacing only steering or only pace](../.runtime-proof/pako-connected-learning-20261121/channel-ablation-01/controls.json)
left the terminal score at zero. This paired test diagnoses the coupled
steering and speed decision; it is not new training.

The [curve-input revision](../.runtime-proof/pako-curve-cues-20261121/runs/learning/20261121T142235-585fde99ba/curve-learning.json)
made lane alignment and curvature explicit. Both warm-only and PPO reached
**2/4** on new development starts, versus **0/4** for exact prior and
untrained. Both remaining PPO arms reached the game's `escaped` phase but
repeatedly triggered the road guard after overrunning the mapped endpoint.
The [signed endpoint comparison](../.runtime-proof/pako-endpoint-learning-20261121/runs/fit/20261121T142805-9050bdbbfe/endpoint-learning.json)
addressed that overrun: both Tahrir starts escaped clean, but warm-only,
standard PPO and stop-aware PPO all scored **2/4** overall. On Civic one
start had one road denial in each arm; another also defeated the reference
with a real patrol impact. All arms and denominators are retained. No new
release checkpoint or protected evaluation is admitted.

The [clean terminal reward continuation](../.runtime-proof/pako-clean-objective-20261121/matched-continuation-01/comparison.json)
collected the same dirty training escape in both arms: 4,369 ticks,
one patrol impact, and 729 sampled decisions. The previous objective
awarded the escape bonus; `clean-escape-v1` did not. The two updates
produced distinct frozen checkpoints before evaluation. Across the two
known development starts, the exact prior earned **1/2** clean escapes;
both continuations and the untrained control scored **0/2**. All Max
arms timed out. This isolates a real reward defect and confirms its
repair is not, by itself, a learned escape improvement.

The [matched post-turn continuation study](../.runtime-proof/pako-turn-continuation-20261121/fit-01/post-turn-continuation.json)
varied the start and approach on Station and Souq with an intact moving patrol
22 m behind. It changed only the public endpoint on the same exit street.
Both arms cleared the same turn in **4/4** pairs; the accepted pose and action
samples matched through that clearance. The local endpoint timed out every
time. The longer continuation finished **3/4** clean qualified escapes, while
the other Station case took contact in both arms after the turn. These are
scripted guard-on fit references, not a learned result. A route chooser now
needs fit cases in which the safe longer continuation is not always the
same option and the difference is observable without private actor state.

The [opposed onward-route comparison](../.runtime-proof/pako-onward-choice-20261121/runs/routes/20261121T185504-98e25361aa/onward-choice.json)
used two Station starts, with a moving patrol 22 m behind. After the same
accepted turn onto Civic, the SUV could continue on Civic or turn onto Souq
and continue on Corniche. Both routes completed the two open controls.
Blocking each route in turn made only its alternate finish cleanly, and the
range-based chooser found that alternate in all four opposed cases. In the
blocked Souq arm, actual contacts still occurred; the independent guard did
not make the route viable.

The [frozen categorical PPO comparison](../.runtime-proof/pako-onward-learning-20261121/runs/learned/20261121T185518-fb50dbf61d/onward-learning.json)
learned only the onward choice from 36 real terminal outcomes. All matched
arms used the same scripted follower and independent guard. With the same
weights, retaining a static return for less than 0.5 s improved **10/12 to
12/12** clean escapes. The scripted measured rule also scored **12/12**;
both fixed choices, exact untrained option policy and no-cue control each
scored **8/12**. Six starts are retests after the first latest-frame policy
failed, and six are separate transfer starts. On the transfer subset the
learned and measured choices scored **6/6**, latest-only **5/6**, fixed and
cue-off controls **4/6**. The rule took the shorter route on the open arms.
The low-level incumbent, tested separately without the common follower, did
not escape cleanly. No claim is made that the learner can steer, reverse,
drive among moving civilian traffic, or escape a full Max City.

Extending the original just-clear reverse reference to the actual terminal
showed it [stopped for the patrol and timed out](../.runtime-proof/pako-reverse-terminal-20261121/runs/terminal/20261121T165351-e431e696cc/reverse-terminal.json).
Changing the destination did not help when the routes shared the same
blocked lane. The [parallel-corridor comparison](../.runtime-proof/pako-reverse-terminal-20261121/runs/terminal/20261121T185643-2f9db6deeb/reverse-terminal.json)
maintained the original reverse and shared accepted poses until its
post-rejoin decision. One supported Civic corridor completed **2/2**
clean, qualified escapes at ticks **1,750 and 1,739**; the opposite
corridor contacted the patrol in both. The successful runs continued about
174 m after whole-route re-entry, and the intact patrols travelled
63 m and 107 m. These are scripted fit references on one junction.
The exact frozen low-level policy still did not finish the reverse.

The [learned post-rejoin motor comparison](../.runtime-proof/pako-reverse-motor-20261121/runs/motor/20261121T175358-d4d3b557b1/reverse-motor.json)
kept the same guarded reverse and physically supported right-side road path,
then transferred steering, throttle, brake and gear to the learned motor.
A range-dependent slower reference improved **4/8 to 5/8** clean escapes;
untrained and the old motor each got **0/8**. Both imitation-only and PPO
got **5/8**, including the same **3/4** new transfer starts. Their 3 misses
stopped before crossing Station with the original intact patrol. In the
five PPO successes **151–171** forward decisions after re-entry reached the
plant without a shield substitution and produced physical movement. This
does not show improvement from the PPO update or a learned reverse. The
[mirrored corridor check](../.runtime-proof/pako-reverse-motor-20261121/mirrored-diagnosis-01/mirrored-corridors.json)
confirmed that the opposite scripted corridor did not cleanly recover the
earlier misses: two escaped only after physical contacts. Do not fit or
promote another checkpoint against the same one-corridor assumptions.

The [population transfer probe](../.runtime-proof/pako-onward-learning-20261121/population-current-01/population-comparison.json)
used the same frozen option weights and follower, with actual 36/80 and
96/144 City populations and a single opening tail. Reset placement rejected
occupied berths before any action; no ambient actor was moved or removed to
enable a start. The two standard-density cases required opposite choices
despite producing identical empty obstruction inputs. The frozen option
chose the same route both times: **1/2** clean SUV escapes, with a real ego
contact in the other case. The measured rule won the other standard case.
The dense game reported two ego-contact-free escapes for the frozen option,
but both lost the original patrol by tick **1,440**, and the ambient log
recorded **five pedestrian contacts** across those episodes. Neither passes
the stricter probe. Ambient events are emitted once per fresh contact and
are retained separately from ego contacts; the earlier zero-ambient read
was a verifier filter error. The outcome does not establish Max readiness.

The [later-frame diagnostic](../.runtime-proof/pako-onward-learning-20261121/later-range-01/later-range.json)
let the two already-seen standard starts wait for another chance to observe
the obstruction before the mapped fork. None of the **56 and 64** sampled
frames respectively contained a positive static return on either candidate.
The shorter choice escaped in the first case, and timed out in the other.
Waiting for more of the same static cue does not resolve this comparison;
live occupation and unobserved space need to be distinguished before another fit.

Physically shifting within the lane [made the obstruction visible but caused
real taxi impacts](../.runtime-proof/pako-onward-learning-20261121/in-lane-visibility-01/in-lane-visibility.json).
The [fixed virtual corner comparison](../.runtime-proof/pako-mounted-visibility-20261121/runs/populated/20261121T185706-99a7b9de02/mounted-visibility.json)
kept the accepted approach unchanged. The two corners measured the obstruction
edges at tick 516; a fresh return confirmed one edge at tick 522, without
declaring the shadow between the returns clear or filled. Both 36/80
retests reached qualified escape with no SUV contact, while the center-only
and consecutive-complete-pair controls timed out in the obstructed scene.
The winning obstructed run still had three ambient pedestrian contacts. The
corner beams and route decision are experimental and not connected to the
normal Chase, frozen PPO inputs, or the independent guard.

The [surveyed curb comparison](../.runtime-proof/pako-surveyed-curb-terminal-20261121/runs/curb/20261121T185504-00e839f4df/surveyed-curb.json)
used three real static returns to select the physically supported Tahrir
shoulder. Moving the shutter 2 m moved the return point; the two sparse
runs climbed, returned to pavement, and finished qualified clean escapes
in **43.62 s and 43.00 s** with their original patrol. Paved-only timed
out; the clear-road control stayed paved; the actual range guard reduced
accepted speed from **2.406 to 1.706 m/s** at the occupied shoulder without
hitting the person. The populated stock run had two ambient patrol/civilian
contacts. Its exact same accepted SUV motion was clean when using the
existing opt-in NPC preview. The latter is a change in NPC commands, not a
learning gain or protection for a general full-population chase.

The [ambient pedestrian trace](../.runtime-proof/pako-ambient-pedestrian-20261121/trace-stock-v2/comparison.json)
reproduced all three contacts of the mounted-visibility run with identical
accepted motion. The civilian cars were already braking at their available
rate when they hit; they had started too late. The existing preview removed
all three in that case, but the [full old-preview ablation](../.runtime-proof/pako-ambient-pedestrian-20261121/full-city-v2/full-city.json)
retained only **1/4** of the previously clean City escapes. A time-matched
full-speed projection likewise yielded too often. The versioned stopping
reserve checks simultaneous pedestrian and NPC footprints during the
reaction-and-brake interval. It prevented the three named contacts and
retained that staged 36/80 escape, without reacting to an occluded or
parallel walker in the controls. On the [full City comparison](../.runtime-proof/pako-timed-pedestrian-yield-20261121/runs/transfer/20261121T192448-d77a3f72f4/timed-yield.json)
it reduced ambient pedestrian impacts **3 to 0**, but still retained only
**1/4** clean escapes versus **4/4** with the original timings. It remains
off by default. The SUV guard, contacts and frozen weights did not change.

The [observed route resumption](../.runtime-proof/pako-observed-route-resume-20261121/runs/resume/20261121T193617-45200f3e2d/observed-resume.json)
separates those timeouts. The bounded reference asks to finish a short
aligned map segment after a measured dwell, a fresh scan, and no last-decision
veto. It does not use an episode tick, scenario name or private actor pose.
With the normal guard it advanced **16.75 m** and finished a qualified
**69.42 s** escape with zero contacts in the standard late-open case.
The other stop had an actual police return around **3.08 m**; the reference
did not engage and preserved the whole motion hash and timeout. This
corrects one observed late policy-stop in a scripted development arm;
it doesn't clear an occupied route, prove learning, or admit the NPC preview.

The [standard interceptor trace](../.runtime-proof/pako-ambient-pedestrian-20261121/early-block-trace-01/early-block.json)
matches that real 3 m surface to the same patrol first seen at **38.31 m**.
The [earlier geometry test](../.runtime-proof/pako-early-patrol-alternative-20261121/runs/earlier/20261121T194632-9e9d4d13db/early-alternative.json)
forked from identical accepted motion and fresh range frames. Both east
paths failed the static pavement sweep before any action. The west path
passed the junction and reached the game's escape terminal, but hit the
actual interceptor on tick **1,224**. It is a failed clean-escape reference,
not evidence to install a west branch.

The [unchanged dense decision pair](../.runtime-proof/pako-dense-stop-classification-20261121/runs/stop/20261121T195302-001649c959/dense-stop.json)
matched both prior full pose/command hashes. Stock escaped in **74.10 s**;
the preview timed out at **120 s** with zero SUV and pedestrian contacts.
Unlike the standard interceptor stop, the longest upstream dwells were
**10.50 s and 7.40 s** behind an actually observed civilian vehicle about
**2.8 m** ahead. The PPO was asking to drive; the independent range guard
and existing queue planner took turns holding it. The stock pass started
and finished earlier. The preview eventually hit real pedestrian vetoes
further on. This diagnosis does not establish a clear adjacent lane or
qualify a new policy.

The [observation-only pace comparison](../.runtime-proof/pako-dense-queue-reserve-20261121/runs/pace/20261121T200055-ca4c795fb2/queue-reserve.json)
kept the approach identical until a fresh slow civilian return at **11.50 m**.
The same queue planner attempted its pass with **5.72 m** of lead range
instead of **3.82 m**, but both runs still timed out at **120 s** without
contact. The guarded queue stall remains; the extra approach distance alone
does not establish a lateral path.

The [earlier swept path](../.runtime-proof/pako-dense-queue-path-20261121/runs/path/20261121T200704-028c39a7e4/queue-path.json)
used consecutive fresh civilian returns and sampled entry rays at a gap
of **17.28 m**. The SUV actually moved into the adjacent paved lane
without contacts or road denials. Further on, the new lane carried a real
civilian return down to **2.74 m**, with nearby returns in the original
lane as well. The SUV never rejoined and timed out. Entry visibility proves
neither future lane availability nor the availability of a return gap.
Do not begin fitting a motor against this reference or choose a shorter
success window.
