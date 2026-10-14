# Core repair and predictive RL feasibility pilot 14 October 2026

The repaired sensor and command interfaces support a new mode-conditioned maneuver environment, independent future-position training and native behavioral grading. **Urban driving has not been accepted.** Two PPO runs collected 8,192 native transitions and performed 128 cumulative update epochs, with no completed journeys. The checkpoints and experimental sensor rig remain disabled in normal driving.

The final-source scripted physical probe completed **9/10 ordinary routes and 2/2 manual traces** without contact. The second curve case timed out after 62.44 m of movement. Its overall freshness was 2,850/2,950 decisions (96.61%), so the physical pipeline also fails admission. A prior 12 m check supplied narrow research readiness evidence; earlier 10/10 and 9/10 matrices used different source versions and do not qualify the final implementation.

## Sensor and command repairs

`ControlScene` version 1 owns synchronized ego measurements, native own-body geometry, measured tracks and motion hypotheses, immutable point samples, free/occupied/unknown space and original observation ages. Tracking follows native sensor publication. The maneuver task plans at 10 Hz in simulation time and revalidates the actual swept body before every native frame. Camera display, cached classification, OCR and optional learned forecast candidates do not publish the control scene.

Control and display share measured tracking. Supplementary learned forecasts are distinguished from the prediction used for an applied decision. Ground surfaces contribute to measured space; robust local ground-plane fitting prevents a sloping surface from becoming an actor track. Low curbs retain geometric obstacle protection. Surrounding geometry does not imply surrounding classification: front labels require measured association, and road/sidewalk segmentation remains unadmitted.

The cached-braking key includes gear, reverse, steering and intended controls/path. A sensor-byte regression reproduces forward braking followed by a reverse request in the same frame and verifies that it no longer becomes a sensor fault. Signed longitudinal speed also preserves rollback while forward gear is selected. Full-body certificates distinguish the exact current body from its unobserved grid-cell fringe; holding is known, while a millimetre of motion into unobserved external space is rejected.

Experimental depth cameras use calibrated wide views outside the native measured body. Failed boundary-mounted views are retained as failed experiments. The original camera configuration restores after each controlled episode. These wide views require the live pilot ticket and have not passed admission for normal driving.

The first learned rollout exposed native neutral gear despite forward proposals. Initialization now performs held R and D transitions while stopped, confirms native first gear and records actual initial controls. CARLA's tagged movement implementation explicitly changes target gear on reverse-state transitions. [CARLA 0.9.16 movement source](https://github.com/carla-simulator/carla/blob/0.9.16/Unreal/CarlaUE4/Plugins/Carla/Source/Carla/Vehicle/MovementComponents/DefaultMovementComponent.cpp#L20).

## New task and checkpoint identities

`YaRabOstorha-Maneuver-v1` uses one policy for `MANUAL_PROTECTION` and `AUTONOMOUS`. Its observation contains two seconds of measured history, mode, local route/driver intent, candidate descriptors and measured occupancy. Scenario IDs, seeds, actor truth and scripted future intentions are excluded. Historical rows are reindexed by current measured track IDs, so actors exchanging distance order cannot exchange histories.

The 18 candidate IDs, paths, masks and observations are frozen together and bound by hashes. Stage zero admits HOLD, DRIVER, CONTINUE, SLOW and STOP. The independent shield can brake or hold; it does not select useful driving for the neural policy. Proposals, rejected masks, fallback reasons, exact applied-decision predictions, native controls and independent labels are recorded. An unverified fallback remains `NO_VERIFIED_SAFE_ACTION`, including possible exposure to rear impact.

CPU MaskablePPO uses SB3/contrib 2.9.0, `MultiInputPolicy`, one environment, learning rate 3e-4, rollout 256, batch 64, four epochs, gamma .99, entropy .01 and actor/critic layers [128,64]. Fixed temporal history and the library's mask-aware evaluator follow the [official versioned documentation](https://sb3-contrib.readthedocs.io/en/v2.9.0/modules/ppo_mask.html).

The first checkpoint is `artifacts/learned_safety/maneuver_v1/2924d97b26dd428698b3d9c3791caf11/maskable-ppo.zip`, SHA-256 `d04d73727eeea12241d898924d67c9d5d471db737cbcbe14ed94f1ff0b76c364`. It is a failed behavioral baseline. The resumed checkpoint is `artifacts/learned_safety/maneuver_v1/9ec465b1ea7d4a35b43e5bfce4c92d54/maskable-ppo.zip`, SHA-256 `1892bdb763745908790e63a99cc0b7b7714719e0180b7b3558fa0394d35e204f`. It records the first checkpoint as its parent and adds 4,096 actual transitions and 64 update epochs under reward version 2 and native initialization version 3. Existing SAC/BC files are retained as historical baselines.

Reward version 2 projects actual ego position onto a frozen ordered route, with initial progress zero and signed reverse progress. It removes initial standing credit and nearest-waypoint discontinuities. Positive episode credit is capped at 30, below collision penalties of 100/200; completion pays once. Manual intervention compares applied physical controls with the driver's proposal, rather than candidate IDs. Required driver waiting is excluded from unexplained-stop accounting.

Training admission is separate from deployment admission. The explicit stage-zero feasibility flag requires current-source native motion, valid construction, no contacts and usable sensor publication. It permits a bounded diagnostic fraction of stale scenes; every stale action still meets the independent fail-closed shield. Full admission retains 10/10 ordinary completions, 99% freshness and all other required gates.

Neither training run completed a journey. In the resumed run, six completed TIME_LIMIT episodes moved only 0.009–0.366 m, and the final partial episode was recorded as ABORTED. No abort or time limit counts as a successful training episode. Native first gear was confirmed before those rollouts, so neutral initialization cannot explain their lack of progress. The scripted physical motion probe selects available forward/manual candidates directly; the retained planner weights are configuration baselines, not a completed matched comparison against a weighted maneuver optimizer.

## Independent prediction and mixed traffic

Two TRAIN pedestrian episodes produced 1,000 transitions with scheduled, eligible and physically realized crossings. Both ego episodes timed out and count as driving failures. Their future native actor positions trained a separate residual MLP for 300 epochs on 288 examples. Separate VALIDATION recordings supplied 186 scored examples.

| Horizon | Baseline endpoint error | Candidate endpoint error | Relative improvement |
|---|---:|---:|---:|
| 1 second | 1.133 m | 1.369 m | -20.8% |
| 2 seconds | 1.685 m | 1.566 m | 7.0% |
| 3 seconds | 2.289 m | 1.920 m | 16.1% |

The predictor fails admission: its one-second result worsened, scoring coverage was 63/98 at one/two seconds and 60/98 at three seconds, and no matched driving ablation passed. Missed, ambiguous and missing-future actors stay in the denominators. The checkpoint `independent_prediction_v1/760ec313329b430388c30708eba6e62f/residual-mlp.pt` has SHA-256 `b82848b5192a124efa277835147a19fba3191cc31830c6ea434af9010990dcd4`; it is not loaded into control.

The pinned [SegFormer-B0 Cityscapes model](https://huggingface.co/nvidia/segformer-b0-finetuned-cityscapes-1024-1024) ran on three recorded CARLA frames at 320×180 with a median 115.5 ms CPU inference time. Independent semantic labels were unavailable, so CARLA mIoU is unmeasured and segmentation is not admitted.

Explicit traffic preparation defaults to 25 vehicles and 20 pedestrians, with zero supported. Native mixed-traffic validation admitted 25 vehicles and 20 ready walkers/controllers: 7 cars, 6 motorcycles, 6 bicycles and 6 vans. The installed blueprint set lacked buses. Local right-side vehicles and side-sector walkers were absent in that fixture and are reported as coverage limits. Mesh-only tuk-tuks are not counted as functional native traffic. The mixed journey timed out without contact; its usable-scene fraction was below 99%.

Scenario schedules use simulation time and retain scheduled/eligible/realized evidence, routes, profiles, actual initial conditions and condition hashes. Evaluation labels include all native vehicles and pedestrians; unmanaged actors invalidate controlled construction. Unsupported occluded-pedestrian, left/right exit, pass/return and alternate-street constructors fail explicitly. Town03 is required by the frozen manifest and cannot be substituted with Town10. Matched comparisons remain pending: initial traffic-light phases and complete sensor attributes still need explicit condition identity coverage.

Three final-source VALIDATION construction probes completed without contact and physically realized sudden braking, a true cut-in and pedestrian hesitation/retreat. The sudden-braking actor's measured pre-event speed reached 5.68 m/s; the cut-in actor's body entered the ego road corridor. These checks establish the sampled event mechanics. They do not establish matched hazard exposure, anticipation lead time or learned protection, and cannot replace unrun TEST cases.

## Native evidence and unfinished admission

Fixed-driver checks after gear initialization completed both traces without contacts: 5.22 m and 3.35 m of recorded native movement, with aggregate action-time freshness of 98.33%. This falls short of the 99% admission threshold. The recovery probe moved 2.59 m in total planar distance, with only 0.095 m of negative displacement projected on its native heading, and then timed out. Its 286 reverse proposals produced 104 native reverse-throttle commands, but no useful completed recovery or subsequent route progress. Full lane changes, pass/return, alternate streets, traffic-rule exceptions and general surround protection remain disabled or pending validation.

`output/core-repair-pilot/frozen-test-v2.json` contains 28 required TEST cases and an implementation fingerprint. `evidence-index.json` reconciles reports, initialization failures, source/checkpoint hashes, native traces and clip sources. `acceptance.json` and the nonzero acceptance validator preserve failed and unfinished gates. Reward, contact count or a stationary episode cannot substitute for useful native movement. Collision preventability remains UNKNOWN without independent counterfactual evidence.

The latest checkpoint's frozen evaluation completed all twelve selected cases: **0/10 autonomous route completions and 2/2 completed benign manual traces**, without contact. All autonomous cases timed out after 60 simulation seconds and had zero planar movement. The approximately 1.36 mm reported by their three-dimensional distance metric is vertical settling, not driving. The manual traces moved 2.36 m and 2.30 m and each recorded 0.4 seconds of unnecessary intervention. Native completion of these traces does not satisfy the full matched manual acceptance protocol.

Action-time freshness was **6,046/6,180 decisions (97.83%)**, below the required 99%. The evaluator verified unchanged manifest and checkpoint hashes and restored the normal eight-sensor configuration. The remaining sixteen required hazard, recovery and Town03 cases are unrun and remain explicit missing cases. The final unscored reset created by the library's vector wrapper is recorded as ABORTED and is excluded from scored outcomes.

The compact command audit binds back to the full native JSONL recording by SHA-256. In the first autonomous case, HOLD was selected on all 600 decisions even though CONTINUE was admitted on all 600; all 1,200 native commands applied full braking. That observation identifies a policy behavior failure without attributing useful driving to the shield.

The audit verified all ten autonomous recordings: 6,000 HOLD selections and zero planar movement. Both learned manual traces selected DRIVER on all 90 decisions; their unnecessary interventions came from the independent stale-scene shield. The physical replay reached the destination on nine routes, including one curve with 71.73 m of movement. These are descriptive comparisons of the frozen protocols; incomplete condition identity prevents full matched-comparison admission.

Native RGB clips and their sidecars identify original frames, simulation timestamps, outcome and image/clip checksums:

- [Final-source physical curve progress](../output/core-repair-pilot/clips/frozen-physical-curve-progress.gif): successful native physical route, not an RL result.
- [Learned benign manual input](../output/core-repair-pilot/clips/learned-benign-manual.gif): completed DRIVER trace, without full protection admission.
- [Failed learned autonomous episode](../output/core-repair-pilot/clips/learned-autonomous-failed.gif): TIME_LIMIT, zero planar movement.
- [Pedestrian response](../output/core-repair-pilot/clips/pedestrian-response.gif): historical native response evidence; anticipation acceptance remains pending.
- [Failed recovery probe](../output/core-repair-pilot/clips/recovery-probe-failed.gif): TIME_LIMIT, no accepted recovery.

## Budget and reproducibility

The independent SQLite ledger has a four-hour combined cap. The user approved transferring 20 minutes from RL to control validation, producing phase caps of **65 minutes control, 45 scenario/prediction, 70 RL and 60 frozen evaluation**. Reservations are crash-charged; completed reservations settle to elapsed wall time. The transfer is audited. Implementation and offline unit-test work are outside the experiment allowance.

Historical motion, congestion and predictive-v2 ledgers retain their recorded SHA-256 hashes. Each experiment records before/after values. Unique checkpoint directories preserve prior weights and failures. Final elapsed usage, learned transition/episode counts, evaluation outcomes and all unfinished gates are recorded in the evidence index.

| Phase | Used minutes | Authorized cap |
|---|---:|---:|
| Physical/control validation | 64.74 | 65 |
| Scenario/prediction | 25.47 | 45 |
| RL rollout/training | 39.52 | 70 |
| Frozen evaluation | 44.89 | 60 |
| Combined | **174.62** | **240** |

Final verification passed 398 Python tests with one optional skip (399 discovered), all 103 JavaScript tests and the dashboard build. These checks establish software contracts, not driving acceptance. `frozen-source-v2-delivery.zip`, its checksums and the two dependency inventories preserve the local pilot implementation without committing existing workspace edits. Earlier snapshots remain preserved; the delivery snapshot includes the corrected offline report reader and reset-failure indexing. `restored-state.json` records the inactive pilot runtime, PAUSED driving state, preserved destination, eight normal sensors and zero reported sensor errors.

The acceptance validator exits 1. Ordinary learned driving, recovery, the full manual protocol, complete scenario coverage, prediction, freshness and matched throughput remain unfinished or failed; frozen artifact identity alone passes. Dedicated response calibration, occlusion emergence modeling, pedestrian anticipation metrics, identity-switch/missed-hazard measurement, lane/pass/street execution, manual hazard protocols and Town03 evaluation require further work before any capability can be admitted.

The current source supports a feasibility pilot, not general urban acceptance. Normal driving keeps unaccepted learned capabilities disabled.
