YA RAB OSTORHA — integrated rule-based safety prototype

The live CARLA service now automatically supervises forward MANUAL and
AUTOMATIC BasicAgent commands when the existing seven-sensor suite is enabled.
Normal commands remain unchanged when measured forward space is sufficient.
Additional braking passes the existing SafetyFeasibilityValidator contract,
admit_proposal, ControlSafetyLayer and CommandArbiter. Accepted safety commands
use the existing acknowledgement barrier with tick=False, then the same service
worker advances physics. The supervisor is suspended during the exclusive RL
lease. There is no learned policy activation or training in this checkpoint.

The unchanged Experiment 2B/2C teacher supplies its five sensor-driven states:
MONITORING, PROTECTIVE_BRAKING, SAFE_RELEASE, FINAL_APPROACH and SAFE_STOP.
The runtime adapter additionally checks radar/LiDAR/depth surfaces in an
ego-local forward corridor and measured road coverage. Missing detections
without positive road support remain unknown and request braking. Missing,
stale or invalid required sensor assets stop driving through the existing
watchdog, expose SENSOR_FAULT_STOP, and require explicit driving resume.

Parameters are in `config/ya_rab_ostorha_safety.json`; edit and restart the backend.
The full loaded parameter set is included in new recording/scenario metadata.
Historical teacher/configuration, radar fixes, 47-dimensional Gym policy
projection, rewards, demonstration data and frozen SAC weights remain unchanged.

| Parameter | Initial value and justification |
| --- | --- |
| Stopping envelope | 3 m + 0.35 s × speed + speed²/(2 × 5 m/s²). Preserves the teacher used by the 11 successful Experiment 3A TRAIN demonstrations. At 8 m/s this is 12.2 m; at 10 m/s, 16.5 m. |
| Additional brake | 1.0; preserves demonstrated emergency braking. Emergency onset is immediate. |
| TTC | Trigger 2 s; release 3 s; closing speed must be ≥0.25 m/s. Approximately 1.6 s stopping time at 8 m/s plus reaction allowance supports the initial trigger. Only spatially matched measured radar Doppler supplies TTC. LiDAR/depth motion remains unknown. |
| Clearance/release | 3 m minimum, 2 m clearance hysteresis; teacher low-speed stop 0.2 m/s and stationary-lead estimate 0.5 m/s. Preserved validated values. |
| Smoothness | Minimum brake hold 0.15 s; brake release ≤3 normalized units/s, approximately 0.33 s from full brake. Driver steering is preserved exactly. |
| Freshness | Maximum 0.10 s simulation age, 0.25 s wall age; required channels must match the observation frame/time. Existing 0.35 s base-command watchdog and 50 Hz admission limit remain enforced. |
| Sensor geometry | Ego front 2.5 m, corridor half-width 1.35 m, foreground height 0.25–2.5 m, maximum considered range 45 m. Initial calibration targets the default Lincoln MKZ. |
| Steering intervention | Zero permitted adjustment; no verified side-space/lane certificate exists. |
| Rewards | Unchanged. These driving checks provide no justified reward correction. |

The existing UI displays rule-based safety status, risk, intervention reason,
active override and count beside the existing driving mode/source. Settings has
a research comparison switch; changing it requires exclusive ownership and a
stationary vehicle. Replay remains unable to control the simulator.

Real CARLA 0.9.16 verification used production WebSocket controls, not RL steps
or a second tick owner. Final checks after preserving rate/order admission:

| Check | Result |
| --- | --- |
| MANUAL sudden braking, seed 1781 | SUCCESS; 23.80 m progress, zero collisions/impulse, 6.81 m minimum planar clearance, 1 safety activation, 15 recorded safety-control frames with exact native application. |
| BasicAgent front obstacle, seed 1782 | SUCCESS; 27.59 m progress, zero collisions/impulse, 4.02 m minimum clearance, 5 override activations, 70 recorded safety-control frames with exact native application. Default BasicAgent hazard handling was retained. |
| Recovery | Both cases resumed motion after the controlled vehicle moved away. The existing actor schedules supplied a resume segment at 7 s; that schedule was never passed to the supervisor. Original success conditions were unchanged. |
| Clear road | Real forward progress without a new safety activation; disabling/re-enabling at rest succeeded. |
| Traffic/pedestrians | Spawned 10 native traffic vehicles and 5 walkers/controllers alongside all 7 sensors; cleanup restored one ego and seven sensors. |
| Command/sensor isolation | Native command/application mismatch lists empty; sampled recorded sensor observations and geometry results invariant when all actors/ground truth were removed. No steering adjustment by the safety layer. |
| Chatter | No applied brake pulses/edges separated by ≤150 ms. Two rapid autonomous source changes occurred when BasicAgent independently requested the same full brake; source-count changes are distinct from physical pedal chatter. |

The first manual check failed progress because the new depth adapter normalized
axial depth into unit rays, projecting road pixels above ground. Corrected
`K^-1 [u,v,1] × depth` projection passes a dedicated plane regression and recorded
native checks. The failed recording/trace remains under
`output/native-validation/active-safety/initial-attempt/`. CARLA describes this
data as a [depth buffer/z-buffer](https://carla.readthedocs.io/en/0.9.16/ref_sensors/#depth-camera);
the recorded native plane independently verified the projection correction.
An initial autonomous harness assertion also incorrectly rejected PAUSED while
journey STARTING; it was corrected without changing driving behavior.

Verification, reloads, diagnostics and final restoration consumed a conservative
612.7 s wall ledger, exceeding the authorized ten-minute cap by 12.7 s. Native
testing stopped. The final normal `backend.server` host is connected, PAUSED,
sensor-complete, with rule-based safety enabled and no RL owner. No neural
training, weight edits, graphics changes or model allocation by the safety path.
Display inference was suppressed only in the temporary verification host;
normal display processing was restored afterward. Native step timing includes
sensor capture and recording, and is not a measurement of safety inference alone.

Necessary regressions: 99 Python tests and 25 JavaScript tests pass; dashboard
bundle builds. Native active observations were complete and error-free. The
cumulative reset/lifecycle diagnostics contain 12 missing-frame issues; there
were no stale, duplicate, out-of-order or timestamp-mismatch issues. These checks
do not establish a general zero-dropout claim. Detailed recordings, commands,
timings, configuration and preservation evidence are referenced in
`docs/evidence/active_safety/verification.json`.

Limitations: this is a forward braking research prototype. Reverse/rear threats,
safe lane changes, sharp turning paths, sparse/occluded returns, small obstacles,
slopes and unusual vehicle dimensions are not broadly validated. Braking
deceleration assumes dry-road behavior and must be recalibrated for changed
physics/weather. A persistently blocked path remains stopped until measured
clearance opens; driving through an obstacle is not recovery. Two native
conditions do not establish urban reliability or collision-proof behavior.

Git started at `f190f39c8e5fc977fe1919db9b7803a09f41474a` on an isolated
`codex/final-active-safety` branch. The nine pre-existing modified files and
untracked Gate 5 script were preserved byte-for-byte outside this scoped commit.
The frozen SAC SHA256 remains
`9b3bceb0c77aaea8a6cad71600d36f90b1dfbf2277ffad94ea6b91f42f5ac679`.
