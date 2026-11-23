# PAKO acceptance — OPEN

This matrix supplements, not replaces, the original pursuit acceptance.
An implemented control, development witness or isolated local fixture
does not complete a live City or holdout gate. Missing, failed and skipped
cases remain in scope.

| IDs | Behavior and falsifying control | Status / evidence boundary |
| --- | --- | --- |
| A01–A05 | Real wreck, pin and qualified escape → record outcome and reset; after one Start the second episode and real optimizer update occur; pause stops progress, stop preserves a checkpoint, resumed next update matches uninterrupted, evaluation cannot train. A timeout-only run does not close wreck or escape. | VERIFIED for the staged lifecycle plus the headed one-start, pause, checkpoint reload and frozen evaluation journey. The terminal fixtures use actual plant outcomes but do not prove that the policy can escape in live City. |
| A06–A07 | Controller fault, policy stop, road rejection, pause and episode end produce distinct requested/applied traces and visible reasons; a failed scan must not imply a clear road. | TESTING: [stop reproductions](PAKO_STOP_DIAGNOSTICS.md). Actual dense `QUEUE_YIELD` attribution is verified without changing accepted motion; comprehensive unexplained-stop coverage remains open. |
| A08–A13 | Physical rear closure, front obstacle with both mirrored exits, reverse-only and genuinely boxed scenarios. Same-state control demonstrates alternate path and no impact during continued travel; blocked twin cannot invent space. | TESTING overall. Measured pass-and-return recovered the original dense timeout. The longer observed corridor check prevented hits on the oncoming sedan in 18 staged stress trials, but every protected arm still took a rear hit. The independent Corniche pair remains failed. |
| A14–A15 | Real lateral movement/yaw with keys, touch, chase/cockpit, reverse and stationary. Archived controls remain stable, and tests may not infer accepted movement from the steering input. | TESTING overall; corrected ordinary, Arcade and Dispatch motion verified on desktop and Dispatch touch on 390×844. Release PAKO unavailable until a qualified checkpoint exists. |
| A16–A18 | Bounded curb entry, supported return and reverse; barriers, insufficient clearance and a pedestrian occupying bypass remain protected. | VERIFIED for both legacy `metro-survey-v1` and city-wide `metro-city-curbs-v2` (55 surveyed Metro v4 sidewalk spans across `x` and `z` streets on both sides, active in City Chase with strict pedestrian/solid protection and mandatory pre-junction asphalt rejoin). |
| A19–A22 | Measured relative motion and TTC against controlled physical trajectories; paired action-conditioned forecasts and actual subsequent reactions, including replan when tail changes direction. Impossible forecasts stay labelled unknown. | TESTING overall. A21 has 56 actual matched five-horizon continuations, including novel controls. General uncertainty calibration, collision classification and using the conditioned forecasts for safe live replanning remain open. |
| A23–A27 | Start a real populated PAKO chase, fair reinforcements, qualified escape with sustained loss/separation; accepted tick timer and persistent best time reject empty pursuit. | BLOCKED for public play: no qualified release checkpoint. Existing Dispatch behavior remains separately evidenced. |
| A28–A29 | One Chase entry with difficulty and Start; Labs and older variants are secondary, and no variant replaces the City. | The focused UX uses the single Chase entry in Grand Metro City v5 defaulting to the preloaded RL PPO driver (`RL AI` / `Manual` toggle) with `gta-tactical-v1` privileged police (`33.5–38.0 m/s`, lane-breaking overtakes, curb/alley pursuit, 8-branch frontier search), 3D building-occluded GTA star-by-star cooldown (`86–110 m` open road or `≥ 52 m` alley cover), and a screen-edge Red & Blue strobe vignette; old variants remain under Tools. |
| A30–A32 | Multiple distinct physical trajectories with outcomes; ghosts cannot affect colliders, and data/frames correspond to actually recorded states. | TESTING overall. Verified 100 actual buffered paths, registered City perspective using matching downloaded poses, two concurrent world cursors, and a separately tagged forecast-versus-actual view. Full scene replay and sustained dense batch timing remain open. |
| A33–A35 | Matched learned improvement on frozen baselines, ≥108 untouched episodes per arm and split custody. No playback or development leakage. | The measured pass and return improved full City outcomes **3/4 → 4/4 with unchanged weights**. A sparse route-choice PPO improved **8/12 → 12/12** under shared scripted steering, tying the measured rule. It did not reach the strict intact-patrol outcome in either populated high-density attempt. No qualified release checkpoint; the holdout was not opened. |
| A36–A37 | Actual dense City timing at 96/144 and functional behavior; if map expands, paired route-diversity gain. | TESTING: the current complete headed dense development test with active camera and frozen PPO averaged 59.57 physics ticks/s. This is not a rendering FPS or a held-out performance guarantee. No map expansion. |
| A38 | Old controls, replay digests, Lab presets and City assets retained. | TESTING overall: current asset build, **690 JS**, and **29 standalone Python** checks passed. Earlier [headed City/Lab compatibility](../.runtime-proof/pako-mounted-visibility-20261121/headed-compatibility-01/city-focus-browser.json) and archived one-update evidence are retained separately. Final release journey remains pending. |
| A39–A40 | Independent adversarial QA and full startup → actual trained escape/failure → restart with an eligible release policy. | A39 TESTING: the independent stationary-lead and late-oncoming pair remains failed. Explicit development tests now have a public UI entry; A40 remains blocked for a verified release checkpoint. |

### Evidence and unresolved faults

- The revised [City browser journey](../.runtime-proof/pako-clean-objective-20261121/runs/browser/20261121T154621-b5eacabfaa/city-focus-browser.json)
  uses one Chase entry, one difficulty selection and the original City.
  Legacy modes still start under **Tools**. A compatible checkpoint is
  explicitly a **PPO test**, not an approved release. In a controlled
  crossing the installed detector recognized a person from the matching
  JPEG and the fitted motion displayed mint prediction ghosts in the
  street. The range view and raw camera remain visible with the detector
  off; no result is fabricated. Closing clears the display.
- That journey recorded a qualified Level 3 test escape in **58.1 s
  with zero ego contacts** using the exact existing trained checkpoint.
  The [separate headed Level 5 test](../.runtime-proof/pako-city-focus-20261121/max-chase-01/dense-max.json)
  used the same local checkpoint at **96 vehicles / 144 pedestrians**,
  with camera inference off. It escaped in **108.95 s** with zero ego
  contacts and 24 actual ambient contacts. These are known development
  seeds, not held-out generalization.
- The [earlier full Max with live camera test](../.runtime-proof/pako-city-focus-20261121/max-camera-on-01/dense-max.json)
  used that same checkpoint, known City seed and default rules, with
  **96 vehicles, 144 pedestrians, and ten opening patrols**. The actual
  installed front detector was active throughout the game; the display
  matched 662 frames and the control trace recorded 37 distinct camera
  brake frames. The SUV escaped in **114.30 s** with **zero ego
  contacts**; the simulator recorded **27 ambient contacts** separately.
  The live loop averaged 59.65 physics ticks/s; this does not measure
  rendering FPS. The full chase shows the combined stack can escape in
  this start, not that the camera improved escape odds or that new
  learning transferred. The optional patrol preview was not enabled.
- The [repeat on the current build](../.runtime-proof/pako-city-focus-20261121/max-camera-on-02/dense-max.json)
  escaped in **108.95 s** with zero SUV contacts and 24 ambient contacts.
  The same live detector was active (532 matched frames, 421 containing
  a person) but did not add a brake in this run. The controlled crossing
  comparison, not this repeated Max result, demonstrates camera-driven
  speed changes.
- The revised Lab ran a full 120-second City episode and actually updated
  PPO on **1,200** decisions. Both that run and the matching no-update
  evaluation timed out; the UI reports **0/1 clean escapes** for each.
  **Watch last chase** replays the accepted SUV pose history. The
  [latest headed Max check](../.runtime-proof/pako-actor-playback-20261121/runs/browser/20261121T162042-95145452d6/actor-playback.json)
  also replayed the surrounding 96 vehicles, 144 people and ten opening
  patrols at matching times on desktop and mobile. These are recorded
  simulator poses, not camera detections or live colliders. The full
  Max training and frozen test both timed out; newly trained,
  generalized contact-free pursuit is still unverified, including
  autonomous curb and reverse escape at Max.
- The [matched terminal reward check](../.runtime-proof/pako-clean-objective-20261121/runs/outcomes/20261121T154617-a48a8f0c1e/clean-objective.json)
  confirms new focused sessions get the same +12 after the clean Station
  escape and no escape bonus after two real patrol impacts in Gateway.
  Accepted motion, contact events and other reward terms were identical
  across score profiles. This changes what the optimizer rewards, not the
  qualified escape rules, old checkpoint resume or collision physics.
- The [live hybrid comparison](../.runtime-proof/pako-hybrid-causality-20261121/runs/hybrid/20261121T154845-930670bbdd/chase-hybrid.json)
  recorded all **480 ticks** in each controlled City approach.
  With a fresh matching JPEG, the camera added a brake at tick **19**,
  while the unchanged range-only policy first braked at **37**. Both
  saw the walker enter at tick **56**. The minimum longitudinal bumper
  clearance during the crossing increased from **1.04 m** to **4.45 m**.
  Neither crossing hit the person, but both had patrol contact. The
  parallel control did not report a crossing brake. The SUV was already
  stationary with the independent pedestrian brake applied when patrol
  contact at world tick 528 moved it sideways. The walker was hit three
  ticks later. The narrower runtime gate proves that vision changed
  physical behavior, not that the full pursuit is safe.
- The [matched exploration continuation](../.runtime-proof/pako-hybrid-causality-20261121/exploration-comparison-01/comparison.json)
  saved one real PPO update per arm before comparing frozen actors on
  two disjoint City development starts. Training was a timeout for
  standard exploration and an escape with patrol contact for narrower
  exploration. At Level 3 the exact incumbent escaped clean at 6,452
  ticks; standard escaped at 3,303 ticks with a patrol contact, while
  narrower and untrained timed out. The narrower arm had two patrol
  contacts. At Level 5 every arm timed out at 7,200 ticks, with zero
  ego contacts and nonzero ambient pedestrian contacts in all four
  arms. Neither faster arrival after a contact nor less ambient
  contact in one timeout qualifies the new weights.
- The [versioned side-impact pilot](../.runtime-proof/pako-lateral-contact-20261121/runs/lateral/20261121T135540-1551afb0e9/lateral-contact.json)
  reproduced the chain on a separate Station Avenue start. Default and
  v1 had identical right-side impact at tick 29, a **2.47 m/s** lateral
  impulse despite the SUV holding brake, and a pedestrian hit at tick 36.
  v2 predicted that lateral displacement and braked the same approaching
  patrol; it moved 1.54 m and the stationary-walker pair recorded no
  contact through 150 ticks. The moving-walker arm let pursuit resume
  after the person cleared; it still had patrol contact at tick 101.
  Absent and farther-away walker controls retained the same motion,
  the physically late case still registered damage, and the original
  and new recorded variants reconstructed exactly.
- The [independent Corniche first attempt](../.runtime-proof/pako-lateral-contact-20261121/independent/corniche-01.jsonl)
  falsified the initial lateral preview: it resumed as the patrol slowed,
  and still hit the pedestrian. The [independent repair retest](../.runtime-proof/pako-lateral-contact-20261121/independent/corniche-02.jsonl)
  and [coordinator's same-oracle final repeat](../.runtime-proof/pako-lateral-contact-20261121/independent/corniche-03.jsonl)
  had no pedestrian contact, but actual patrol contact remained, at
  ticks 123 and 171 respectively. The unrelated moving-away control
  retained identical motion. This is an experimental simulator command,
  not a modified learned policy; it is not enabled in normal City, Chase,
  or the focused Lab curriculum. Independent zero-contact transfer and
  autonomous escape remain open.
- In the [same-clock headed parallel retest](../.runtime-proof/pako-hybrid-causality-20261121/runs/hybrid/20261121T135727-edb697646f/chase-hybrid.json),
  the default arm reproduced the walker hit at tick 531. The explicit
  v2 arm had no walker hit but had two actual patrol contacts. Both
  ran all 480 ticks from the same accepted start and neither credited
  a camera crossing brake for the parallel walker. This separates
  the experimental NPC response from the measured camera intervention.

- The [original queue gate run](../.runtime-proof/pako-queue-learning-20261121/runs/learn/20261121T111738-2c925e5e49/receipt.json)
  reproduced the failure on the rebuilt source. The frozen PPO passed the
  stationary lead at ticks **186–198** in all four development cases (exact
  predecessor: none), but recorded rear impacts at **374–379**; warm-only
  behaved similarly. No arm passed the unchanged 600-tick oracle.
- The [connected teacher screening](../.runtime-proof/pako-queue-learning-20261121/connected-reference-03/queue-connected-reference.json)
  obtained nine full clean windows on Corniche, Station and Tahrir at the
  matched turn setting; straight acceleration passed zero. The
  [connected PPO comparison](../.runtime-proof/pako-queue-learning-20261121/connected-learning-01/queue-learning.json)
  used nine complete demonstrations and 900 new sampled transitions, but
  both trained actors scored **0/4** on the longer approaches. The scripted
  reference also took a rear hit on every such approach. Both research
  observation schemas are rejected for City playback.
- The [follow-through diagnostics](../.runtime-proof/pako-queue-learning-20261121/follow-through-diagnostics-01/queue-follow-through.json)
  kept all failures: neither a faster approach nor earlier outer-lane setup
  gave a clean longer branch. Yielding in the original lane let the moving
  sedan travel **54.44–60.72 m** versus **7.48–12.06 m** in the premature-turn
  arm, and eliminated hits on that sedan (**5/9 → 0/9**). All nine yield
  cases still took a rear impact; this is not a joint safety or progress pass.
- A [measured standoff trial](../.runtime-proof/pako-queue-learning-20261121/standoff-diagnostics-02/queue-follow-through.json)
  let ego pass the lead in all nine opposing cases, but each clearance
  occurred **after** a patrol hit (hits at ticks 387–391, clearance at
  402–408). Zero hits on the civilian did not make the full window clean.
  The tested variant was not retained in the verifier or enabled in play.
- The [independent upstream probe](../.runtime-proof/pako-queue-learning-20261121/independent-upstream/REPORT.txt)
  took a registered Civic-to-Souq turn before the queue. The clear arm
  entered the branch at tick 152 and continued 22.08 m over the next 120
  ticks, but the same moving patrol had already hit it at tick 109.
  The occupied twin was rejected by the guard at tick 102 and never hit
  the barrier. It also took a rear impact. The reviewer left the
  contact-free upstream criterion open.
- The [fresh headed journey](../.runtime-proof/pako-queue-learning-20261121/runs/browser/20261121T111926-0f1b2cff7a/pako-browser.json)
  observed accepted keyboard, reverse and touch movement in the original
  City, four real PPO updates, frozen Testing, checkpoint continuation and
  an inspected non-colliding recorded Ghost Fleet view. PAKO correctly
  remained unavailable; this is compatibility, not a trained playthrough.
- The [current dense baseline](../.runtime-proof/pako-queue-learning-20261121/current-dense-preservation-01/current-dense.json)
  replayed all 7,200 ticks with the exact prior checkpoint and 96 vehicles /
  144 pedestrians. Accepted pose hashes and contact counts matched the
  prior baseline: timeout, zero ego impacts, four ambient pedestrian
  contacts. No ambient actor disappeared. This confirms preservation on
  this development seed, not a remedy for the timeout.
- The [complete dense counterfactuals](../.runtime-proof/pako-dense-routing-20261121/runs/dense/20261121T113538-4db734ce8d/comparison.json)
  found that the early pass alone stopped behind a second civilian before
  surveillance was lost. A route cue that selected an earlier public
  corridor [also failed to transfer](../.runtime-proof/pako-corridor-routing-20261121/runs/transfer/20261121T114203-28f50b105f/comparison.json).
  A later [scripted pass and return](../.runtime-proof/pako-dense-routing-20261121/lane-return-01/comparison.json)
  led to real escape at tick **4,426** with zero ego contacts.
- The opt-in [measured recovery check](../.runtime-proof/pako-measured-detour-20261121/runs/city/20261121T115319-a1f684b1cb/comparison.json)
  reproduced the mechanism with no scenario timing or private actor poses.
  It completed qualified escape at tick **4,446** in the dense case, with
  **zero** ego contacts, ambient pedestrian contacts and road denials;
  its paired normal-density start retained the exact motion hash. A
  separate standard start regressed when a briefly stopped lead accelerated
  away and the detour did not know to return behind it. This keeps the
  scope to the exercised starts; the pilot is not enabled in public play.
- The [current recovery gate](../.runtime-proof/pako-measured-detour-20261121/gate.json)
  and [separate transfer retest](../.runtime-proof/pako-measured-detour-20261121/accepted-distance-transfer-01/comparison.json)
  cover all four known full development starts. After recognizing a lead
  pulling away and separating the bounded reattachment budget from the
  pass budget, the two previously regressed starts both escaped again.
  At 96 vehicles / 144 pedestrians, the timeout became **74.1 s** and
  the other escape improved from **108.0 s to 87.5 s**. At 36/80, one
  motion hash matched exactly; the other escaped **4.03 s later**. All
  four candidate runs had zero ego contacts or pavement denials; actual
  ambient pedestrian contacts fell from seven to three across the pairs.
  These were the same frozen weights, not a learning gain.
- [Independent late-oncoming QA](../.runtime-proof/pako-measured-detour-20261121/independent/verdict.md)
  found no full pass on an unseen Corniche setup; in both arms the guard
  arrested the initial movement before the live patrol hit the SUV and
  the SUV contacted the lead. The oncoming sedan was untouched. The
  [current-source repeat](../.runtime-proof/pako-measured-detour-20261121/independent/runs/score/20261121T121926-18d39fd9c3/score.json)
  still fails the same gate. Do not interpret the oncoming veto or the
  four City outcomes as general rear safety.
- The [longer corridor gate](../.runtime-proof/pako-passing-corridor-20261121/gate.json)
  verified that an observed distant sedan can reject entry before the
  short independent stopping check would block the turn. The
  [matched 600-tick references](../.runtime-proof/pako-passing-corridor-20261121/runs/fit-reference/20261121T123445-0cc7d961ed/queue-lookahead.json)
  used separate training-development starts with a tail 25 m behind.
  The opponent was hit in **18/18** unreserved arms and **0/18** reserved
  arms. All 18 reserved arms still took a rear impact. Only four of
  18 clear scripted arms completed the full contact-free branch,
  all on Tahrir, so this is narrower than a recovered pursuit.
- The [current optional City pair](../.runtime-proof/pako-passing-corridor-20261121/city-admission-only-01/comparison.json)
  retained the previous **74.1 s** clean dense escape and the exact
  standard motion hash. An [in-motion long-range check](../.runtime-proof/pako-passing-corridor-20261121/city-projection-01/comparison.json)
  instead yielded to a distant pedestrian and timed out; the additional
  check is now only applied before entry, with ordinary continuous safety
  checks unchanged. The new environment opt-in is not used for public play.
- The [headed build after the corridor change](../.runtime-proof/pako-passing-corridor-20261121/compatibility-01/pako-browser.json)
  again ran ordinary and Dispatch controls, four actual PPO updates,
  frozen Testing and checkpoint resume. Its inspected desktop and mobile
  frames preserve the unavailable release pane and recorded Ghost Fleet.
- The [upstream branch probe](../.runtime-proof/pako-passing-corridor-20261121/upstream-opportunity-01/opportunity.json)
  took a supported Station-to-Civic turn before the queue at a 22 m
  rear start gap. The full SUV reached the branch at tick 216, but the
  moving patrol caught it at tick 401; the separate Corniche attempt
  was hit before whole-body clearance. The blocked twins never completed
  the turn. This did not produce a clean reference for further fitting.
- The [fresh headed compatibility run](../.runtime-proof/pako-measured-detour-20261121/compatibility-after-return-01/pako-browser.json)
  rendered the City and recorded Ghost Fleet, ran four PPO updates,
  exercised frozen Testing and resumed the optimizer. The release pane
  stayed unavailable. The Python suite had one transient Windows socket
  error in the initial concurrent run; all 29 cases passed on the
  [unchanged serial retest](../.runtime-proof/pako-measured-detour-20261121/compatibility-after-return-01/python-retry-serial.log).
- The [chain-safety gate](../.runtime-proof/pako-chase-safety-20261121/gate.json)
  passed on source `bf568dc5189c35fef2a39a42827d0f05fbe64c2af69ceb1ec73f4848e28c9ead`.
  The matched Corniche fixture removed the patrol hit at tick 24 and resulting
  pedestrian hit at tick 33 when explicitly enabled; the same moving patrol
  closed to a 0.65 m gap. No-risk matched motions were unchanged, replay
  reconstructed 180 accepted ticks, and a physically late approach still
  recorded both contacts. This is separate from release-policy safety.
- The [independent retest](../.runtime-proof/pako-chase-safety-20261121/independent/cross-heading-1158-d29/batch-after-lateral-envelope/summary.json)
  retained three crossing preventions on University/Civic. The correction
  also preserved both patrol contacts in the independent near-edge case
  that the first version had suppressed; later motions still differ in
  that arm. Static occlusion stayed an exact negative. The late-active
  arm still made real contact and does not count as successful avoidance.
- In the [final full-City chain ablation](../.runtime-proof/pako-chase-safety-20261121/full-city-final-chain/comparison.json)
  all four pose hashes matched the unchanged plant, with three ego-clean
  escapes and seven ambient pedestrian contacts in each arm. The new
  intervention did not trigger in these four cases. The dense timeout
  remains; see [the separate queue and policy stops](PAKO_STOP_DIAGNOSTICS.md).
- The [City continuation gate](../.runtime-proof/pako-city-continuation-20261121/gate.json)
  passed on exact code and rebuilt browser assets for the manual curb
  pilot, scoped junction development and headful compatibility. The current
  [4-pair full-City comparison](../.runtime-proof/pako-city-continuation-20261121/full-city-final-development/comparison.json)
  matched all four baseline pose hashes: 3/4 ego-clean qualified escapes
  in each arm, no preview activations, and seven ambient pedestrian
  contacts per arm. A zero-change arm is not evidence of safer or better
  release performance. The earlier independent shove failure also
  reproduced on the continuation.
- The [scoped Prove It gate](../.runtime-proof/pako-convergence-20261121/gate.json)
  previously passed for diagnostics, steering and the continuous training journey on
  source `5ac34d7f140fec77dfd6e5a90610fdb16b76495d05142f041c885be63a7ce534`.
  It is not the parent gate or a learned escape claim. The installed HarrTest
  recorded the real native handoffs and integration receipt; formal native
  attestation still asks for a Codex parent thread UUID on this Copilot host.
- [Independent headed QA](../.runtime-proof/teams/pako-corrective-slice-20261121/qa-evidence.txt)
  confirmed that Stop during episode three left the previous checkpoint
  byte-for-byte intact and the same unapproved model ran only in Experiments.
  It also reported visible layer overlap, sparse map context and spurious
  `UNKNOWN` reasons for accepted creeping. A subsequent
  [headed retest](../.runtime-proof/pako-convergence-20261121/runs/browser/20261121T084139-06e6004cbc/pako-browser.json)
  measured a 73 px gap between the stopped diagnostics and minimap, and
  the inspected frames show an opaque Lab drawer with street name,
  distance scale, articulated icons and separate end markers. Accepted
  low-speed displacement no longer classifies as an unknown stop. These
  repairs do not convert independent full-release QA to a pass.
- [Independent safety evidence](../.runtime-proof/pako-convergence-20261121/independent-recovery-qa/HANDOFF.md):
  in an open-front faster-tail fixture the preview deferred an actual rear impact
  by one tick with no damage reduction. In the pedestrian case both modes
  braked but a real rear impact pushed the SUV into the person at tick 33.
  Do not treat zero unsafe throttle as zero pedestrian impacts. A separate
  malformed-scan finding did get repaired: [rerun trace](../.runtime-proof/pako-convergence-20261121/independent-recovery-qa/trace-after-atomic-repair.json)
  shows the error at the same tick with brake latched, not requested throttle.
- The [same-state counterfactuals](../.runtime-proof/pako-convergence-20261121/counterfactual-late-vs-early.json)
  on Corniche compared held brake, straight throttle, mirrored turns and
  reverse using intact physics and the guard. All five late arms took a
  rear hit at tick 24; the earlier setup gave the tested forward controls
  more motion and delayed first rear contact but did not clear all contacts
  in three seconds. Neither set establishes global infeasibility.
  A separate 30-control, full-throttle/countersteer sweep on the same
  earlier setup also had a rear contact in every arm. Its nearest junction
  was 20.18 m away, behind the opening heading. In a **separate earlier
  approach** to Corniche/Station, a guarded scripted arm crossed the actual
  branch at tick 174 and drove **27.52 m** over the next **2.10 s** with
  no ego impact while the patrol moved **35.37 m**. Matched brake and
  straight controls were hit. The same turn start did not transfer to
  another approach two metres back. This is a feasible development witness,
  not a learned or independent acceptance result.
- The [anti-stall city-curb chase gate](../.runtime-proof/pako-chase-unstick-20261122/gate.json)
  verified seamless cross-street curb transitions, close-contact sensor
  unsticking, wedged-patrol reverse recovery, and clean post-chase curb
  snap-back across 12 Level 5 Max 60 s runs (`stuckRuns: 0`,
  `medianDistanceM: 269.85 m`, `0` pedestrian hits, `12/12` post-chase
  audit + `Run again` ready) and a 26.9 s headed Chromium Max chase
  (`367.3 m`, `0` pedestrian hits). Bundled development PPO remains labeled
  `RL PPO` rather than `Verified PPO`; patrol/vehicle contacts still occur
  under high heat and the 108-episode protected holdout stays untouched.
- The [alley-shortcut & anti-oscillation K-turn gate](../.runtime-proof/pako-alley-kturn-20261122/gate.json)
  extended `METRO_CITY_CURBS` with enclosed interior courtyard/alley terrain
  matching the 3-layer `world-view.js` surface (`-0.05 m` courtyard Y) and
  added 360-scan alley-shortcut discovery plus a 2-phase `reverse -> forward-commit`
  K-turn with nimble `7.2 m/s` chase reverse and pedestrian-avoiding braking
  steering. Across 12 Level 5 Max 60 s runs, `stuckRuns: 0`,
  `oscillatingRuns: 0`, `medianDistanceM: 686.15 m` (`110` curb/alley entries),
  and `0` pedestrian hits; headed Chromium ran 27.0 s (`306.7 m`, `62 km/h`,
  `maxRunningWaitS: 0`, `oscillated: false`, `0` pedestrian hits).
- The [Grand Metro City v5 gate](../.runtime-proof/grand-city-v5-20261122/gate.json)
  upgraded the default playable Metro City to `cityVersion: 5` (`765,615 m²`,
  `32` driving roads including `5` true diagonal avenues/slash streets, `231`
  monumental buildings up to `56 m`, `66` curbside `parked-vehicle` statics,
  and `3` crowd/traffic/parked hotspots, while keeping `cityVersion: 1..4`
  intact). Verified full-width crowd wait-then-proceed (`minSpeedMps: 2.15`,
  `0` pedestrian hits), diagonal parked-car chicane weaving (`0` contacts),
  `8/8` non-stalling non-oscillating v5 Level 5 chases (`574.85 m` median,
  `0` pedestrian hits), and headed Chromium `Behind car` vs `Chasing` camera
  switching (`362.9 m` at `25.1 s`, `0` contacts, `0` pedestrian hits).

The mission remains open until all applicable rows pass on the exact release
source and evaluated checkpoint. A child gate, clean unit suite, screenshot,
or a local escape cannot close it.
