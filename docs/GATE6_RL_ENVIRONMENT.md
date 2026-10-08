# Gate 6 environment protocol

This milestone provides a real CARLA 0.9.16 Gymnasium environment. It supplies no
neural network, trainer, learned safety intervention or production policy.
The executable acceptance evidence is produced by `scripts.native.verify_gate6_rl`.

## Running scripted episodes

Install `backend/requirements-rl.txt` in the existing Python 3.12 CARLA environment.
Start the existing backend with `--carla --sensors`. CARLA and this backend remain
the only simulator and tick owner. The Gymnasium client creates HTTP requests,
never a second CARLA client. Run from the repository root:

```python
from backend.rl.env import YaRabOstorhaEnv

with YaRabOstorhaEnv(profile='lightweight', split='TRAIN') as env:
    observation, info = env.reset(seed=42)
    while True:
        observation, reward, terminated, truncated, info = env.step(
            {'steering': 0., 'throttle': .4, 'brake': 0.})
        if terminated or truncated:
            break
```

`reset` also accepts `options={'scenario':'SUDDEN_BRAKING','parameters':{...}}`.
The same physical provider, scenario manager, sensor manager, synchronizer,
control contracts, safety layer, arbiter and recorder serve these episodes.

## Tick and command ownership

Acquisition queues a request to the existing simulation worker at an iteration
boundary. It stops navigation, clears old commands and grants one exclusive
token. Normal manual, journey, reset, settings, population and restart requests
are rejected during the lease. External emergency stop remains available.
The worker withholds normal iterations while RL is idle. Reset stabilization
and action steps execute on that worker. Each episode step checks the pre-tick
native frame, applies one accepted command, advances exactly one CARLA frame,
and waits for the complete corresponding sensor frame. A second lease is rejected.

The session expires after 120 wall seconds without a request; `heartbeat` renews
it without ticking. Use a context manager or `close()` to release promptly.
Close restores the original ego pose/blueprint, camera configuration, weather,
population request and route guidance, while leaving driving safely paused.
Journeys require their normal explicit Start Journey action to resume.

## Reset semantics and configurations

Only `FRONT_OBSTACLE` and `SUDDEN_BRAKING` are supported. Seeded project-managed
lane selection uses the existing demonstration compiler. Parameters include
ego speed (0–15 m/s), obstacle/following distance (12–45 m), lead speed (0–25 m/s),
lead brake (0.1–1), trigger time (0–30 s), episode time limit (0.05–120 s), road
spawn index, and heading offset (±2 degrees). Unsupported or curved corridors
are rejected. There is no background traffic in the controlled prototypes.

Reset removes the previous scenario actors and replaces the ego and its sensors
through their existing cleanup lifecycle. It stabilizes for 30 native ticks,
captures settled geometry, initializes physical velocities once with CARLA's
native velocity setter, and collects a complete initial frame. Thereafter actors
move through CARLA physics and VehicleControl only. The leading vehicle uses
the existing timed native throttle/brake schedule.

New native camera sensors can omit startup frames. These are allowed only during
the declared reset warm-up, excluded from the policy and episode recording.
After initialization, incomplete/mismatched/stale frames truncate with a distinct
infrastructure outcome. No adjacent sensor sample replaces the requested frame.

A seed reproduces intended configuration, not identical binary physics, absolute
frame numbers or timestamps. Metadata includes scenario specification, seed,
map, blueprint, poses, actual velocities, weather, timestep, profile, versions,
parameters and reward weights. The Gymnasium spec explicitly marks the reused
world nondeterministic. Existing seed namespaces are TRAIN 0–999, VALIDATION
1000–1999 and TEST 2000–2999. Held-out manifests reside in `backend.rl.evaluation`.

## Observation schema

The observation assembler accepts the audited `SensorObservation` contract and
an asset reader. It cannot accept SimulationFrame, scenario geometry, collision
actor identities, route geometry, future trajectories or reward context.
All profiles maintain four frames with left zero-padding. Missing history is
marked invalid. A history gap over 0.15 s clears history. Native sensor samples
must match the current frame and simulation timestamp exactly. Profile arrays
are separate copies, with declared Gymnasium spaces and fixed bounded sizes.

| Field | Shape | dtype | Units and range |
|---|---|---|---|
| ego | (4,4) | float32 | speed 0–100 m/s, IMU local angular velocity ±100 rad/s |
| imu | (4,6) | float32 | acceleration m/s² and gyroscope rad/s; clipped ±1000 |
| previous_action | (4,3) | float32 | applied steering [-1,1], throttle/brake [0,1] |
| radar | (4,32,4) | float32 | depth 0–100 m, azimuth ±π rad, altitude ±π/2 rad, radial speed ±100 m/s |
| radar_valid | (4,32) | int8 | populated detection mask, 0/1 |
| history_valid | (4,) | int8 | real complete history frame, 0/1 |
| frame_time | (4,2) | float64 | native frame index, elapsed simulation seconds |

Lightweight contains those fields. Multimodal adds RGB `(4,90,160,3)` uint8,
depth `(4,90,160)` float32 metres [0,1000], LiDAR `(4,512,4)` float32 local XYZ
metres ±100 and intensity [0,1], plus LiDAR validity. Evaluation uses 320×180
images and 2048 LiDAR points. Nearest-neighbor depth resizing preserves measured
depth samples; uniform deterministic LiDAR subsampling preserves angular coverage.
Radar detections are selected by measured depth. Saturation is declared, not an
inference of physical safety. All profiles capture the existing native suite;
lightweight limits policy tensors and reduces native camera resolution to 160×90.
GNSS is captured for diagnostics but excluded from these initial policy spaces.

## Action schema

The Gymnasium action space is a float32 Box with order
`[steering, throttle, brake]`, bounds `[-1,0,0]` to `[1,1,1]`.
The named dictionary form is an accepted convenience. Steering is right-positive.
Nonfinite values, boolean/string arrays, bad shapes and undeclared keys are rejected.
Finite out-of-range requests are clipped; a positive brake suppresses throttle.
Steering changes are limited to 1.5 normalized units/second (0.075 per 50 ms).
Only forward gear is admitted. Proposed and applied actions are both recorded.

Commands reference the exact most recent RL observation frame/time. Existing
freshness, command rate and safety arbitration checks still apply. `TRAINING`
commands are allowed only with the exclusive training lease; manual, navigation
and AI commands cannot compete. A completed episode immediately commands safety
braking and rejects subsequent steps until reset. This actuator guard is not a
sensor-derived maneuver feasibility validator for deploying a learned policy.

## Reward and outcomes

Weights are configurable initial hypotheses requiring experiments. Default
components: collision -100/contact step, native impulse severity -0.01/N·s,
clearance shortfall below 2 m -2 per metre-second, signed safe forward progress
+1/metre, delay -0.2/second (twice when nearly stationary), squared control
variation -0.1, unnecessary braking -0.1/brake-second, and success +25.
Positive progress is disabled with collision, unsafe clearance, TTC below 1 s,
unknown clearance or a lane departure. Negative progress remains penalized.
Component values, weights and raw measurements are independently logged.

Success requires positive scenario-specific progress, no collision, clearance
at least 2 m, and both vehicles stopped for 0.5 s. Sudden-braking success also
requires the braking trigger to have elapsed. These are safe approach-and-stop
tasks for lifecycle validation, not urban maneuver or navigation benchmarks.

| Outcome | terminated | truncated | Meaning |
|---|---|---|---|
| SUCCESS | true | false | supported safe approach-and-stop goal verified |
| COLLISION | true | false | native collision event meeting configured impulse threshold |
| ABORTED | true | false | departure from the supported straight-lane task |
| TIMEOUT | false | true | simulation time limit or maximum steps |
| ABORTED | false | true | reset, close, lease expiry or external emergency stop |
| SIMULATOR_FAILURE | false | true | tick conflict, missing/stale sensors or infrastructure error |

Infrastructure step failure returns the previous observation with all validity
masks cleared and `observation_valid=False`, reward zero, and a distinct reason.
A failed reset raises; it cannot supply a valid initial observation. No timeout
is reported as a collision. Default collision threshold is zero native N·s.

Reward risks: stopping just after the progress threshold; hiding behind sensor
occlusion in future variants; steering to exploit planar box estimates; rewarding
progress accumulated before a later impact; repeated low-impulse contacts; and
time-limit bootstrapping. Keep collision penalties dominant, inspect component
logs, and test stationary, oscillating, off-lane and crash trajectories. Missing
clearance never certifies safety. Planar boxes exclude mesh/pitch/roll details;
TTC is valid only for aligned closing traffic. Impulse is not injury severity.

## Recording and baselines

Each episode reuses RunRecorder under `runs/rl/{TRAIN,VALIDATION,TEST}/rl_<id>`.
Metadata records actual native provenance. Frames store existing RGB/depth/LiDAR
assets once; action and outcome events reference those assets without duplicating
sensor binaries. `outcome.json` preserves flags, reasons, duration, travel, reward
and metrics. Interrupted reset/close episodes retain ABORTED outcomes.
ReplayReader verifies the existing recording format.

Baselines: SCRIPTED_DIAGNOSTIC (fixed controls); CONSERVATIVE_RADAR_BRAKING
(permitted measured radar/ego speed only); BASIC_AGENT_NO_SAFETY (existing BasicAgent
route following with vehicle/signal/stop-sign hazard handling explicitly disabled).
BasicAgent uses privileged native planning in a labeled baseline context; its
state is never a deployable policy observation. These controllers are not
YA RAB OSTORHA. Compare the same compiled parameters and seeds; repeat and record
actual initial deviations. No policy-improvement comparison is available yet.

Native metrics include collision frequency and native impulse, scenario success,
minimum box clearance and valid TTC, signed forward progress, traveled distance,
mean speed, completion time, hard-braking transitions (≤ -4 m/s²), steering
direction-change variation, and intervention frequency where applicable.
An intervention rate is undefined for an ordinary base driver with no safety
intervention channel; it stays null. Evaluation aggregation rejects mixed split
or baseline groups. Held-out seeds are prepared, not proof of learned generalization.

## Perception isolation and future work

Episode stepping reads native sensors and assets directly. The display YOLO/OCR
worker is not a dependency or safety observation source. Prior audit measurements
show CPU YOLO around 114 ms/sample, OCR dominating processing, combined scheduling
around 1 FPS, and near-capacity GPU VRAM. That pipeline is not ready for active
collision avoidance. This milestone does not replace perception with privileged
actor geometry in production observations.

Future optimization should separate sensor capture, bounded timestamped queues,
detection scheduling, OCR scheduling, model inference and observation assembly.
Use independent budgets and latest-only queues for slow display/OCR work; safety
inference must validate source frame/time, age, completeness and history gaps.
Profile CPU/GPU/memory per stage before sharing scarce GPU capacity. OCR belongs
outside the time-critical path. Any future hazard estimator must derive permitted
features from sensors and pass the existing feasibility boundary before deployment.

References: [Gymnasium Env API](https://gymnasium.farama.org/api/env/) and
[CARLA synchrony/timestep documentation](https://carla.readthedocs.io/en/0.9.15/adv_synchrony_timestep/).
