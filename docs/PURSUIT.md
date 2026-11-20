# Pursuit mode

In **City**, open **Pursuit** and select **Start pursuit**. The default
**Arcade chase** (`survival`) is an event in the existing Metro world. It uses
the same streets, original SUV, pedestrians, traffic, and City render scene.
It does not load a separate map. On **Run again** or **End pursuit**, only the
temporary pursuit state is restarted or removed; the City is not reset.

Two cruisers try to deploy initially. Backups switch to paired waves when there
is contact, room, and a safe street approach; heavier vans join later. Actual
patrol-on-patrol contacts can stop both as temporary physical wrecks. The
default driver is the existing self-driving planner. **I** enables manual
auto-throttle and drift with **A/D** or the arrows; **Space** brakes. The
original pedestrian guard and roadway limits still apply. Collecting a
world marker temporarily enlarges the SUV (**Giant**) or lets it phase through
vehicles and eligible street props (**Ghost**). Neither bypasses pedestrians,
buildings or road bounds. **E** or the **Use** button spends a held **Mine**
behind the SUV or **Pulse** ahead. A real, unprotected contact freezes the score
for the short impact review; **R** retries in place, and the browser saves
the best completed time. Music and effects are generated locally.

Choose **Tactical / training** for the previous `hunt` behavior. Levels 1–4 attempt to launch 5, 7, 9 and 11 patrols,
and cap the active force at 14, 18, 22 and 26 respectively. One more patrol
can deploy every three seconds of simulation while a patrol has the player in
sight and a safe spawn is available. The difficulty sets the starting wanted
level; each successful dispatch adds a star up to five. Patrols have higher
acceleration and speed than the SUV on open roads, follow the shared position
report through the street network, and try to make contact on a clear approach.
Patrols favor reachable approaches not already assigned to other units. A
blocked patrol can back up to find a different approach if its sweep is clear.
They still slow for bends, traffic, pedestrians, and obstacles. The elevated
chase view and `N/4 sides` readout show the current pack. **End pursuit**
removes the patrols and their temporary barriers but leaves the car, city
traffic and pedestrians where they are. Use **I** to switch between
autonomous and manual driving, **WASD** or the arrows to drive, and **Space**
to brake. Higher difficulties deploy more patrols; they do not replace the
existing city population.

The current City chase has three running states: **Contact**, **Searching**
and **Clearing**. When the game patrols lose sight, they can continue from their
last sighting, but not from the car's new hidden pose. After 2.5 seconds
without contact, cooling starts only if the SUV has moved at least 18 m from
the last report and is at least 17 m from every patrol. One star fades every
2.4 seconds of cooling. A new sighting stops the countdown without restoring
stars already lost. Zero stars ends the chase; reaching an exit marker alone
does not. Earlier `pack`, `arcade`, `cinematic`, `rush` and
unversioned commands keep their original rules for replay.

In the current `hunt` variant, the first swept patrol contact ends the round
with a −120 penalty. Pedestrian contact ends the round with a base cost of
240 plus roughly 8 per m/s of closing speed, capped at 360, and a brief
non-graphic impact pose. Guarded stops do not trigger the pose or the contact
penalty. Training rewards the first safely cleared crossing and costs reward
for maintaining speed into unsafe stopping room. The elevated camera reframes
around nearby street geometry and moves in for the pedestrian-impact review.
Use **Show camera** for the separate mounted view, or open the pursuit panel's
details for decision and safety readings. The driver's variable list of nearby entities comes from
**virtual ranging** with occlusion, motion measured over time and an explicit
unknown state. It is not the neural camera, and hidden actor positions or
scenario labels are not injected into the camera predictor or tactical
controller.

The agent compares time-dependent, full-body maneuver predictions on the same
vehicle plant. It can keep a shorter route or drive a longer connected one
around a closure. A forward, lateral or reverse candidate can beat holding
when its predicted path is clear. When no useful forward maneuver fits at low
speed, it checks back-out and turn combinations with the same physical
footprint. It can also use a shorter checked move with room to stop, rather
than rejecting a useful movement for a distant prediction. The rear sweep is
checked again before moving. In City the existing street-width,
passage-priority and collision checks still apply, and an explicitly started
camera pipeline may further limit forward speed. Full-width closures cannot be
placed immediately ahead on a stretch of the current street with no intervening
turn. Adjoining junction mouths without space to wait between them share one
reservation; a free entry is not enough if the exit is occupied. A curb is not automatically
drivable: raised shoulder bypass is tested in the legacy arena's registered
shoulder fixture. Contact, near misses, capture and escape are distinct outcomes.

## Legacy pursuit fixtures

| Case | What the run is meant to measure |
| --- | --- |
| Short route open | Physically follow the useful shorter exit. |
| Short route closes | Drive the real longer route around the new barrier. |
| Rear approach | Move forward when the front is clear. |
| Rear approach with front blocked | Look for a clear side without driving into the forward actor. |
| Reverse then side | Reverse only along a clear sweep and attempt the lateral exit. |
| Incoming left or right | Evaluate both sides instead of blindly steering opposite the threat. |
| Front obstruction, rear traffic | Compare braking, moving and laterally escaping against both threats. |
| Pedestrian, no safe exit | Protect the person, even if holding leads to an incoming impact. |
| Moving gap | Check the timed full-body fit before changing lane. |
| Raised shoulder | Use the registered surface, clear the barrier, and rejoin. |
| Boxed in | Measure simultaneous threats, safe attempts and actual capture. |
| Occlusion and recovery | Do not assume missing observations are clear; reassess when visible again. |

These are different setups for **one** controller, not scenario-specific
player scripts. A time-limited, captured or collided run remains in the
results. The challenge setup, probe and learned-versus-unlearned outcome are
separate measurements.

## Lab and City policy

Open **Lab → Pursuit drills** and select **Thread the pack**, **Rear bumper
touch**, **Yield and resume**, or **Too close to stop**. These set initial
conditions; they do not script the steering, movement, or impact. **Train on
this drill** updates a tabular Q-policy from fixed-step transitions. Both
the prediction and the car apply the same speed-sensitive steering limit.
Training can rerank and explore checked maneuvers but cannot override contact
checks or the driving guard. Use **Restart drill** to repeat the setup.

City starts with hand-authored Q-values, not a pretrained model. They rank
only checked maneuvers and require no training on the first run. Choose **Learn
from this chase** to continue tuning those weights locally. When the run ends,
the browser saves the new checkpoint for the same site, including across reloads.
Choose **Use Lab policy** instead to evaluate the Lab values without changing
them; Lab training lasts for the open page. The recorded start command includes
any selected checkpoint so a replay can reproduce its decisions. Better escape
rates are not guaranteed.

```powershell
node --test tests\pack-pursuit.test.js tests\pursuit-policy.test.js tests\embedded-pursuit-world.test.js
python -S scripts\verify_pack_pursuit.py
python -S scripts\verify_pack_pursuit.py --hunt
python -S scripts\verify_city_survival.py
```

The headed verifier plays the public Lab cases, carries its actual checkpoint
back to the City, and samples the normal and maximum-density pursuit. The two
controlled City crossing checks use fixed starting poses on a real City avenue
with the production guard, simulation and rendering. The verifier retains
screenshots and a trace separate from old arena results.
The `--hunt` journey also exercises a blocked pose, separated patrol routes,
local checkpoint recovery after a reload and an autonomous escape through
gradual wanted-level cooling.

## Legacy arena and reproduction

**Lab → Settings → Experimental speed learning** still uses the original
speed-policy training path. The historical arena checkpoint and all twelve
scenarios remain available for seeded development and old replay; their
results below are not evidence about the City practice mode. No external
simulator or model download is needed.

```powershell
node tools\train-pursuit.mjs 32 public\threejs\pursuit.policy.json
node tools\evaluate-pursuit.mjs
node tools\verify-unified-city.mjs
node tools\verify-city-pursuit-engine.mjs
node tools\verify-pursuit-craft.mjs
python -S scripts\verify_city_pursuit_craft.py --camera
python scripts\verify_unified_city.py
```

The held-out evaluator compares the learned policy, the unlearned planner,
and a hold-only control. It reports survival, collisions, pedestrian
collisions, escape, travel distance and near misses per difficulty, plus
named challenge evidence. If the checkpoint is unavailable, the game
explicitly uses the unlearned planner. This is a fictional game mode, not a
real-road maneuver or safety system.

### Results for the bundled checkpoint

Two 32-episode training runs with the same seeds produced byte-identical
weights (4,054 Q updates per run). Evaluation used three separate ambient
seeds at each of the four levels, with the same conditions in each arm:

| Arm | Escapes | Runs with contact | Mean distance | Near misses |
| --- | ---: | ---: | ---: | ---: |
| Hold only | 0/12 | 12/12 | 0 m | 20 |
| Planner | 6/12 | 9/12 | 61.0 m | 19 |
| Learned ranking | 6/12 | 9/12 | 65.2 m | 17 |

The learned arm changed the action sequence in 8 of 12 pairs, but did not
raise the escape rate over the planner. No pedestrian was hit in this
comparison. That does not make the game collision-free or establish an
improvement across all difficulties.

The separate planner challenges exercised all twelve families in mirrored
layouts. A closure increased actual travel from about 87 m to 117–122 m.
Both reverse-then-side runs backed up about 9.7 m and escaped without contact.
Both curb runs rose 0.14 m and rejoined; blocking the backing sweep or the
shoulder denied escape without a collision. In the pedestrian-priority
family the driver yielded, was hit from behind, then could move again after
the person cleared. The boxed-in trials ended in capture.
