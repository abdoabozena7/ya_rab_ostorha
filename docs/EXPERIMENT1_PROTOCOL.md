# Experiment 1: bounded safety-supervisor feasibility

This is one user-authorized experiment on real CARLA 0.9.16, based on Gate 6
`d0bd8d6`. No production manual/journey controller loads or invokes the model.
The existing service owns all native ticks. All comparisons use the same
BasicAgent route follower with its vehicle/light/stop-sign hazard logic disabled;
its privileged map/route data stay on the service worker.

## Registered design, before learning

Only Sudden Braking is used. Ego initial speed 8 m/s, following distance 18 m,
lead initial speed 5 m/s, lead braking 1.0 at 2 s; time limit 12 s, timestep
50 ms, maximum 240 steps. These are intended speeds; native initialization
transients are recorded. Project-managed seeds choose supported straight lanes.

TRAIN seeds: 42–49. VALIDATION seeds: 1042–1045. TEST seeds: 2042–2049.
No test result selects the model. The last checkpoint is the final model,
regardless of its performance. There is no reward or hyperparameter search.

Stable-Baselines3 2.9.0 SAC runs on CPU PyTorch 2.14.1+cpu with two CPU threads.
The actor has two 64-unit ReLU layers, Gaussian mean/log-standard-deviation
heads and squashed continuous actions. Twin critics use two 64-unit ReLU layers.
Learning rate 0.0003, batch 64, replay capacity 10,000, warm-up 500 steps,
gamma 0.99, tau 0.005, one gradient update per step and automatic entropy
coefficient initialized at 0.1. Random/model seed is 12345.

Training is capped at 10,000 actual environment steps or 3600 wall seconds,
whichever comes first. Intermediate evaluation at 2500/5000/7500/10000 steps
uses VALIDATION only. The wall clock includes intermediate evaluation; a 65 s
reserve prevents a blocking native request from consuming the final margin.
Infrastructure failure stops the single job and preserves its current weights.
An experiment marker prevents accidental reruns or automatic extension.

## Supervisory observation and action

The fixed float32 observation has 47 entries: four histories of eleven
sensor/onboard features, plus current proposed base steering/throttle/brake.
Each history contains speed/15, IMU longitudinal acceleration/10, local yaw
rate/2, previous applied controls, nearest measured forward radar range/50,
radial velocity/20, bounded range/closing-speed time proxy/10, detection validity
and history validity. All entries saturate to [-1,1]. Missing history is zero.
Absolute frames/time, world poses, routes, actor identities, seeds, scenario
parameters, collision identities and reward-only measurements do not enter the
policy. Detailed units remain in the audited Gate 6 sensor contracts.

The three continuous outputs are gate [-1,1], additional brake [0,1], and
steering-adjustment proposal [-1,1] scaled by 0.15. A gate <= 0 means
NO_INTERVENTION and preserves the base ControlCommand. A positive gate can
increase braking, suppressing throttle; it cannot reduce base braking, increase
throttle, reverse or change gear. Every proposal is independently assessed.

The minimal TrainingRadarFeasibilityValidator implements the existing protocol
and calls existing `admit_proposal`, ControlSafetyLayer and CommandArbiter.
It inspects current synchronized radar and IMU and normalized actuator limits.
It does not infer side/rear coverage from an empty radar cone. Consequently,
this first profile cannot justify steering adjustments: that axis is recorded
and rejected; independently admissible braking can still proceed. This limits
the experiment to longitudinal supervision. It is not a validated production
maneuver feasibility system. The core admission check now requires side evidence
for a *change* in steering, allowing braking while retaining a small base steer.

On each step the base command is prepared once for that exact native frame.
The previous safety proposal and its receipt are removed. Either the base
TRAINING command or admitted SAFETY command wins existing arbitration, then
one real native tick occurs. Applied native controls are checked against that
selection. Proposed base, intervention, feasibility decision and actual final
control are separately recorded. `policy_active` continues to describe
production activation as false; `training_policy_id` identifies experiment use.

## Reward and measurements

All Gate 6 weights and success criteria remain unchanged. Every component is
logged: collision, native impulse severity, proximity, gated signed progress,
delay, smoothness, unnecessary braking and success. Success requires progress
at least 10 m, no collision, valid clearance >=2 m, lead and ego stopped for
0.5 s, and the lead trigger elapsed. Always braking can avoid collision but
cannot earn useful-progress success. Constant steering proposals are rejected
without observed side-space evidence. Their measured outcomes are recorded
before learning; no weight changes follow them.

An unnecessary intervention is an accepted changed-control step that meets
the existing reward's unnecessary-braking criterion (ground-truth gap >12 m
and TTC absent or >5 s). Counts are *steps*, while intervention_count counts
contiguous intervention starts. Both are logged; evaluation ground truth never
enters features or feasibility. Native impulse is a severity proxy, not injury.

After weights freeze, matched TEST comparisons cover BasicAgent alone,
BasicAgent plus the named rule-based radar baseline, BasicAgent plus trained
SAC, and the saved untrained SAC reference. Eight seeds are a small feasibility
sample, not population reliability or proof of collision immunity. Reports
include collision/completion, impulse, useful progress, clearance, speed,
unnecessary intervention, hard-braking frequency, inference/step latency,
actor inventory, bounded buffers and process memory.

## Artifacts and reproducibility

The single run saves initial/final/checkpoint model zip files, replay buffer,
configuration, versions, seeds, source hashes/snapshot, SB3 CSV, per-step rewards
and commands, episode outcomes, intermediate validation and held-out results
under `runs/experiments/experiment1_<UTC>`. Existing native recordings remain
under `runs/rl/{split}` with asset references. Configuration reproducibility
does not imply binary deterministic physics or sensor samples.

Create the isolated `.venv-rl`, install CPU PyTorch from its official wheel
index first, then the versions in `backend/requirements-experiment1.txt`.
Use `python -m scripts.native.verify_experiment1_adapter` for native preflight.
The authorized one-shot command is `python -m scripts.native.run_experiment1`.
After the marker exists the command refuses further training. Normal driving
must remain usable and paused after the job; the learned model stays an artifact.

References: [SAC library API](https://stable-baselines3.readthedocs.io/en/master/modules/sac.html)
and [CARLA 0.9.16 radar velocity implementation](https://github.com/carla-simulator/carla/blob/0.9.16/Unreal/CarlaUE4/Plugins/Carla/Source/Carla/Sensor/Radar.cpp).
The native velocity is target-minus-sensor projected along the outgoing ray;
negative values close range, which determines the sensor-derived time proxy.
