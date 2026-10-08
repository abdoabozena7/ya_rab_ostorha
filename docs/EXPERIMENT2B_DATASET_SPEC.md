**YA RAB OSTORHA — future safety-supervisor imitation dataset specification, v1**

This specifies a future dataset; it does not train or authorize a model.
Experiment 2B provides four VALIDATION and four TEST teacher demonstrations.
They retain those assignments and must not become TRAIN examples. New TRAIN
demonstration collection requires a separate authorized experiment.

**Model input boundary**

Use the existing audited 47-element float32 projection from `policy_features`.
Its source is the lightweight sensor-only observation plus the current BasicAgent
proposed steering, throttle and brake. Absolute time, frame ID, episode ID, seed,
scenario parameters, route, global pose, actor identity/box/transform, ground-truth
clearance/TTC, reward, outcome and future events are forbidden model features.
The loader must reject undeclared input keys instead of flattening whole JSON.
Sensor asset paths are references for auditing, not numerical/string model inputs.

| Input | Dimensions | Scale/meaning |
|---|---:|---|
| Four bounded history rows | 4×11 | Oldest to newest, invalid history rows zeroed |
| Ego speed | 1 per row | m/s divided by 15 |
| IMU longitudinal acceleration | 1 per row | m/s² divided by 10 |
| IMU yaw angular rate | 1 per row | rad/s divided by 2 |
| Previous applied steering/throttle/brake | 3 per row | Existing normalized control bounds |
| Foreground radar range | 1 per row | m divided by 50, calibrated sensor-derived screening |
| Foreground radial velocity | 1 per row | m/s divided by 20; negative means closing |
| Radar TTC proxy | 1 per row | min(10, range/max(0.1,-radial_velocity)) divided by 10 |
| Foreground validity/history validity | 2 per row | Binary indicators |
| Current BasicAgent proposed controls | 3 | steering [-1,1], throttle/brake [0,1] |

All 47 values are finite and clipped to [-1,1]. Missing foreground uses existing
numeric padding (50 m, zero velocity, TTC proxy 10 s) with validity zero. Padding
must never be interpreted as a valid clear-road measurement. This proxy is not
the evaluation channel's footprint-clearance TTC.

**Per-step channels**

Store one immutable record per current pre-action sensor frame:

1. `model_inputs`: only the 47 sensor/proposed-control features above.
2. `teacher_targets`: public decision enum NO_INTERVENTION,
   BRAKE_INTERVENTION or RELEASE_TO_BASE_DRIVER, intervention tuple, and proposed
   safety `ControlCommand` if present. These are labels, not inputs.
3. `validated_actions`: admission accepted/rejected and reason, feasibility
   validator version, current base proposed command, final arbitrated command,
   and acknowledged native applied control. Include clipping/rejection flags.
4. `sensor_provenance`: exact current frame ID, simulation timestamp, per-channel
   timestamps/validity, local calibration version, history validity and references
   to the original Recorder assets. Never duplicate image/point-cloud binaries.
5. `episode_context`: split, episode/scenario IDs, seed, initial configuration,
   map, software versions, controller/configuration SHA256 and timestep. Context
   is for reproducibility and grouping, never deployable model input.
6. `evaluation_only`: collision events/impulse, footprint clearance/TTC, progress,
   distance, speed, outcome, termination/truncation reason and independent reward
   components. This channel may contain privileged geometry and must be excluded
   from the training input loader.
7. `teacher_diagnostics_only`: state, previous state, braking envelope, range,
   motion estimate and reason, for label review. Do not feed teacher state as a
   shortcut to imitation of the teacher itself.

NO_INTERVENTION and RELEASE both decode to gate -1 and no brake/steering
intervention; retain the separate enum for transition diagnostics. BRAKE uses
gate +1, additional brake 1.0, steering adjustment zero in teacher v1. Accepted
applied control is not interchangeable with an intervention target: most steering
and progress come from BasicAgent. Imitation must learn supervision rather than
replace that base driver. Rejected proposals, missing-observation guards and
unnecessary-braking heuristic labels must remain visible for quality review.

**Existing evidence mapping and time alignment**

The 2B run is `runs/diagnostics/experiment2b_20261008T213139Z/`. Each
`<split>_<seed>_TEACHER-steps.jsonl` contains `policy_inputs.sensor_features_47`,
`policy_inputs.base_proposed_control`, `teacher`, admission/applied fields in
`info`, reward components, current source frame/time and a Recorder reference.
The final applied control and reward in `info` refer to the step resulting from
that current input. Do not pair a label with the following observation instead.
Terminal observations have no subsequent action target.

Existing files contain diagnostic channels together for audit; a future loader
must explicitly project their allowlisted inputs and labels into separate model
and evaluation datasets. Do not ingest the full `info` object as an observation.
Native telemetry contains actors/ground truth and must pass through the existing
`sensor_observation` boundary before any sensor feature projection.

The teacher has persistent phase state and a three-measurement motion median.
Four history frames may not uniquely distinguish all state-dependent decisions.
Measure contradictory labels for equivalent bounded histories before choosing an
imitation architecture. Preserve ordered episode sequences; never shuffle away
transition context or add a privileged task-phase flag to resolve ambiguity.

**Quality and split protocol**

Split by whole episode and designated seed/condition, never by frames from the
same episode. Preserve all historical TEST exclusions. Train-only balancing may
increase the representation of braking/release examples, but keep complete
unmodified trajectories for reward/outcome audit. Capture successful progress,
conservative dropout handling and failures; do not erase failures or label all
teacher actions as optimal. Record retention/dropout flags and brief chatter
events for manual label review, rather than automatically imitating them.

Required automated checks: strict input key allowlist, 47 shape/finite bounds,
ground-truth replacement invariance, current sensor/base/action frame alignment,
source/calibration/configuration hashes, monotonic time, admission/application
match, no cross-split episode reuse and asset-reference integrity. Evaluate both
classification/actuator disagreement offline and native collision/progress
performance on new frozen held-out conditions. A low imitation loss alone is not
evidence of collision avoidance.

A future small CPU behavior-cloned policy could initialize the supervisory actor
or provide demonstration replay for separately authorized RL. Save it under a new
version/configuration; preserve Experiment 1 SAC. Supervised imitation is not RL
improvement. No model or demonstration collection is launched by this specification.
