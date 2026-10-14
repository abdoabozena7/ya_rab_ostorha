# Gate 5 — Urban world and research environment foundation

Verified on 8 October 2026. This report describes the isolated Gate 5 branch,
not concurrent Gate 6 work in the shared checkout. All application text and
project documentation are in English. No RL policy, training or autonomous
driving stack was developed in this milestone.

## 1. Current verified project status

CARLA server/API 0.9.16, Town10HD_Opt, native physics, seven ego sensors and the
existing web dashboard are operational. Living City and controlled Training
environments share the existing simulator and simulation worker. The dashboard
reports the safety interface as prepared with no policy connected.

The starting tree was clean at `2896e6f`, on `codex/live-native-validation`.
`bede5a0` is the preserved Gate 4 parent checkpoint. Tag
`gate5-prechange-20261008` preserves the starting state. Later concurrent changes
switched the shared checkout to a Gate 6 branch; final Gate 5 work uses the
attached `codex/gate5-world-foundation` worktree. Those RL changes are excluded.

## 2. What was already implemented

Real ego controls; RGB/depth/LiDAR/radar/IMU/GNSS/collision sensors; synchronized
canonical frames; manual driving; native routes; Traffic Manager; native walkers;
owned population cleanup; recording and offline Replay; ControlSafetyLayer;
CommandArbiter; lifecycle and experiment contracts; Gate 1–4 native validation.
The starting HEAD also had explicit official BasicAgent journeys and read-only
YOLO/OCR. These were preserved, with English text changes only, not developed
as Gate 5 safety intelligence. A stale API test expecting an unbundled dashboard
entry point was corrected to the actual checked-in bundle.

The previous map-reload workaround remains necessary on this Windows/DX12
installation: managed engine restart retires the old SDK process. Gate 5 native
reset/reconnect validation passed; no in-process map reload was reintroduced.

## 3. Urban traffic changes

NORMAL, BUSY, AGGRESSIVE and UNREGULATED settings select seeded mixtures of
stable per-actor driver profiles. They vary desired speed, following distance,
lane-change probability and traffic-light/sign compliance. Installed 0.9.16
methods were inspected, then exercised on the native server. All profiles retain
native vehicle/walker collision awareness, autopilot movement and full physics.
No custom NPC controller, unrealistic forces or driving teleports were needed.

Native driving-lane spawn points prioritize the ego and route, cover legal road
directions, avoid junction initial spawns and reject occupied locations. Actual
counts come from authoritative snapshots. Replacements are bounded and hidden
from active RGB camera views. Initial explicit population creation is visible.
Measured LIGHT 10/10, BALANCED 25/20 and DENSE 40/30 budgets are available without
silently changing sensors, graphics, timestep or scenario difficulty. New
sessions still start empty and stopped; applying a population is explicit.

## 4. Pedestrian world changes

Native navmesh walkers have valid sidewalk destinations, staggered starts,
0.9–1.9 m/s walking speeds, bounded waits and reselection. WALKING, WAITING,
CROSSING, IDLE and RESELECTING_DESTINATION states exist. Crossing candidates
require valid endpoints and a native driving lane between them; CROSSING is
reported only when the walker is actually on a road. Most activity remains
sidewalk walking. A native 15% crossing probe observed real crossings.

Complex group coordination and idle animation are not implemented. Native
navigation may fail to execute a particular destination. Some probes lost one
or two walkers; bounded replacement and honest actual counts remain in place.
Walker invincibility is inherited from Gate 4; this is not pedestrian injury
modeling. No pedestrians are teleported.

## 5. Realistic congestion results

A 120-second BUSY 25/20 probe observed 25 moving vehicles, 19 moving walkers,
22 vehicles stopping then resuming, six lane changes, queues of 2–18 vehicles,
and 0.660 m minimum sampled oriented-box clearance. The stopped ego did not
move, and native background activity continued.

A later five-minute probe observed all 25 vehicles and 20 walkers moving,
10 lane changes and queues of 0–21 vehicles. Temporary native collision sensors
on the initial NPC fleet recorded zero callbacks during that interval. Minimum
sampled planar box clearance was 0.224 m, with no sampled footprint overlaps.
The probes were cleaned up, returning one ego and seven sensors.

A different three-minute location probe did record a collision between two
aggressive NPCs: one actor pair, 898 paired/sustained callbacks, 22.65 simulation
seconds of contact and peak impulse about 12,460 N*s. Other vehicles continued
moving and the ego had zero callbacks. This evidence is retained; the world is
not collision-free. Callback count is not independent crash count. A transport
PASS must not be interpreted as a collision-free result.

The five-minute fleet spread out to 5–25 vehicles within 120 m. This prompted a
bounded local-density retention refinement: hidden vehicles beyond 180 m can
retire when local count is below 60% of the requested fleet; otherwise the
300 m retirement radius remains. No visible actor is retired by that rule.

The refined retention rule passed a further 180-second probe: 6–25 vehicles
within 120 m, 17 bounded replacements, one native vehicle removal, 12 observed
lane changes and queues of 0–20 vehicles. It had zero sampled footprint overlaps,
zero ego collision callbacks and zero new synchronization failures. That probe
did not instrument NPC collisions; its NPC collision result is unmeasured.
Useful local density still varies and is not guaranteed to remain at target.

## 6. Training environment architecture

The existing provider owns one world, ego lifecycle, population and tick worker.
LIVING_CITY enables continuous native background activity. TRAINING isolates
controlled scenarios, including validation/test episodes, on the same simulator.
Changing background settings/routes is rejected inside a controlled scene.
Recording blocks actor rebuilds/environment changes while allowing episode
start/stop and outcome collection. No duplicated simulator or lifecycle exists.
See [the contracts](GATE5_ENVIRONMENT_CONTRACTS.md) for the integration diagram.

## 7. Scenario system status

The reusable specification covers every requested configuration field, plus
dataset split and canonical/actual initial-condition identities. The manager
implements load/reset/start/step/stop/collect_outcome/cleanup through existing
provider reset, tick and cleanup paths. Strict spawns fail rather than falling
back to a different condition. Compiled initial/start states and runtime metadata
are recorded; seeds do not promise identical physics on arbitrary runtimes.

Front Obstacle and Sudden Braking passed native initialize/reset/repeat/cleanup
tests. Repeated initial positions deviated by 0 m in these runs, and actual-state
hashes matched. The leader reached 4.70 m/s, received native braking and stopped.
Standing still was correctly reported unsuccessful. Reset setup/first-snapshot
ready durations were 0.031/0.047 seconds for Front Obstacle and 0.094/0.109 seconds
for Sudden Braking. These exclude full camera readiness, engine restart and a
general-purpose physically settled-state guarantee.

A controlled 8 m front-obstacle impact verified real collision callbacks,
collision count, native impulse, failed outcome, recorded finish event and
cleanup. It was an expected regression impact, not an avoidance result.
The other seven scenario families and pedestrian scenario definitions remain
contracts. Difficulty labels do not yet change the prototype geometry.
All six curriculum levels have measurable proposed entry/progression criteria;
thresholds and higher-level native coverage still need research validation.

## 8. RL observation/action contracts

SensorObservation contains synchronized RGB/depth/LiDAR assets, radar, IMU,
optional GNSS and legitimate onboard speed/control state. Native IMU gyro gives
angular velocity. Bounded history defaults to four frames and clears on reset,
incomplete observations and excessive gaps. Real native packets and asset bytes
passed boundary validation. Exact actor poses/IDs, privileged ground truth,
global sensor poses, predictions and future trajectories are excluded.

ProposedSafetyAction reuses ControlCommand steering/brake/throttle. A future
real feasibility validator must supply fresh sensor-derived hazard and physical
limit evidence. Steering needs confirmed space on its requested side; increasing
throttle needs a confirmed acceleration path. Missing evidence is rejected.
Accepted proposals must still use existing safety validation and arbitration.
The interfaces contain no fake learned policy or feasibility oracle.

## 9. Reward/evaluation contracts

All eight requested reward components are declared with unset weights and null
uncomputed values. Recorded data supports later collision severity, progress,
time and control smoothness calculations. Positive progress is required for
success. Native impulse is a severity proxy, not injury or kinetic energy.

ResearchMetrics covers requested safety/progress/intervention outcomes. Unknown
TTC, near misses, route fractions, intervention necessity, unsafe interventions
and aggregate rates remain null. Avoidability stays UNKNOWN unless independently
reviewed physical evidence is supplied. No enabled-policy comparison exists.

TRAIN/VALIDATION/TEST seed namespaces are disjoint. Matched comparisons require
held-out split, scenario and actual initial-condition identities, plus the same
reproducible driver protocol. Manual comparisons use a documented scripted trace;
autonomous comparisons later use the same identified baseline agent with/without
a real policy. Unseen geometry, actor combinations, speeds, density, pedestrians
and weather still require implemented variation factories and experiment plans.

## 10. Native CARLA test results

Live evidence includes Gate 4 preservation/population lifecycle, all four driver
profiles, increasing density levels, congestion/pedestrian probes, two scenario
repeat tests, real policy-boundary packets/assets, settings/manual/navigation,
real populated/scenario recordings, managed reset/reconnect and controlled
collision outcomes. Tests use production WebSocket/core paths and independent
read-only snapshots; diagnostic collision fixtures are identified and cleaned.

Evidence inventory and SHA-256 hashes are in `GATE5_EVIDENCE.json`. Raw runs live
in ignored `output/native-validation` and `runs`; historical recordings/hashes
were not replaced. Pass scopes and null unknown metrics remain explicit.

## 11. Performance measurements

Detected usable RAM: 16,371,494,912 bytes (15.25 GiB). GPU: RTX 3060 Laptop,
6144 MiB VRAM. Native conditions: Low/D3D12/RenderOffScreen 1280x720, RGB/depth
800x450, JPEG 95, 0.05 s fixed timestep and seven ego sensors.

| NPCs / walkers | Behavior | Median wall steps/s | VRAM MiB | Interval |
|---|---|---:|---:|---:|
| 0 / 0 | NORMAL | 16.67 | 5837 | 45 s |
| 10 / 10 | BUSY | 17.36 | 5918 | 45 s |
| 25 / 20 | BUSY | 16.59 | 5905–5908 | 45 s |
| 40 / 30 | BUSY | 15.27 | 5908 | 45 s |
| 50 / 35 | UNREGULATED | 15.61 | 5891 | 45 s |
| 25 / 20 | BUSY + 25 diagnostic collision sensors | 16.99 | 5861–5888 | 300 s |
| 25 / 20 | BUSY with hidden density retention | 16.37 | 5866–5870 | 180 s |

Short intervals vary with location, traffic, warmup and competing work; these
are measured samples, not universal FPS promises. The 25/20 five-minute run had
backend private RAM 703.5–718.9 MiB and CARLA private RAM 9621.4–9629.5 MiB.
Sensor wall rates were about 16.97–17.02 Hz, while their configured simulation
rate was 20 Hz. Median worker step time was 31 ms. Median rolling observation
pipeline latency was 93 ms from native step request to complete synchronized
publication, excluding display latency. No new steady-run sync issue/incomplete
frame occurred. GPU memory headroom remains small; BALANCED 25/20 is the practical
suggestion, not a basis for raising limits. Actual rendering FPS is unavailable.

The final retention sample used backend private RAM 685.5–697.5 MiB and CARLA
9706.7–9709.6 MiB, with median rolling observation pipeline latency 78 ms. These
are process private-memory measurements, not a claim that their sum describes
all physical memory use. Managed engine-reset total duration was not captured
in the completed reset proof; later timing instrumentation remains unverified.

## 12. Regression results

The isolated Gate 5 tree passes 141 Python tests (140 passes, one inapplicable
absence-of-CARLA test skipped because the native API is installed) and 24 JS tests.
The checked-in dashboard bundle was rebuilt. Tracked text was checked for Arabic
characters; application and documentation text is English.

Native manual motion, gear/control admission, five aligned camera views without
sensor leaks, vehicle/spawn cleanup, weather and 10/20 Hz changes passed. Native
route selection, explicit journey arrival, independent dashboard lease expiry,
manual takeover, live-origin resume, emergency-stop acknowledgement and real
collision-triggered journey stopping passed. Existing read-only perception was
preserved; no new model/perception behavior was developed or benchmarked.

The broad reconfiguration test recorded nine explicitly incomplete frames and
36 missing-channel diagnostics across sensor/vehicle/timing changes. Incomplete
observations do not enter policy history. Stable dense/scenario runs had no new
sync failures. First connection warmup/reconfiguration diagnostics are not hidden.

Managed world reset returned one stopped ego/seven sensors and empty population.
Disconnect removed all owned actors; reconnect recreated one ego/seven sensors
and stayed stopped. The native reset path did not reuse an in-process map reload.

Replay of the new 85-frame populated recording passed with real camera bytes,
recorded counts/provenance and native controls disabled. Every CARLA Client
construction was blocked in that replay process and zero were attempted. The
shared engine remained running for the other experiment; Gate 5 did not repeat
the engine-stopped variant. Delayed, duplicate, reordered and missing real
recorded packets exercised the synchronizer's diagnostic paths.

## 13. Limitations and blockers

The world and introductory scenario foundation are operational. Aggressive NPC
collisions, walker losses, location-dependent density/throughput and limited VRAM
remain practical limitations. Local-density recycling is conservative about
camera visibility and may fail to replenish the exact target. Actor counts
remain actual rather than fabricated. Five-minute endurance is not proof of
unlimited always-on stability; Gate 4's earlier longer runs remain historical.

No RL network/training, neural perception development, complete autonomous agent,
custom Egyptian map/assets, policy intervention results or zero-collision claim
is included. No validated TTC/near-miss estimator, intervention necessity model,
physical avoidability oracle or final reward weights exist. Only two native
scenario factories are implemented; curriculum difficulty/generalization coverage
is prepared, not demonstrated learning capability.

Concurrent Gate 6 edits/runtime activity were found during final verification.
They are preserved outside this isolated milestone. Engine/native checks require
one owner; active experiments must finish before reset/replay shutdown tests.
During final work, a sequencing error stopped CARLA even after the active
experiment guard rejected shutdown. This interrupted the concurrent experiment.
The other chat restored the engine/backend and a new active experiment was
observed. Its interrupted episode was not resumed or represented as passing.
No additional native ownership/reset actions were taken afterward. The last
density-retention interval overlapped a shared backend restart; its raw scope
is retained, but it is not exclusive validation of the isolated final checkout.

## 14. Files changed and commits

Preservation/audit: `docs/GATE5_AUDIT.md`, stale API entry test. Urban work:
`backend/carla/urban.py`, `population.py`, `geometry.py`, provider integration and
`config/urban-world-profiles.json`. Scenarios: core/native scenario modules,
ego strict spawn, service/WebSocket lifecycle integration. Future contracts:
`backend/core/safety_policy.py`, `research.py`, agent boundary and curriculum/
scenario-library/research configuration. Dashboard: English HTML/frontend text,
world/scenario controls, state updates and rebuilt bundle. Native verification
scripts, focused contract tests and operation/evidence reports accompany them.

| Commit | Verified stage |
|---|---|
| `bb02c9c` | Audit/checkpoint Gate 4 |
| `3225cda` | Native stable driver profiles |
| `0bc4729` | Local density/congestion |
| `f5d7283` | Native scenario lifecycle and environment separation |
| `c756161` | Sensor-only future safety/research contracts |
| `5ffdb4b` | Pedestrian activity and English functional dashboard |
| `3ed6205` | Native collision outcome adapter and regression |
| `339797a` | Native regression, replay guard and bounded density retention |
| `bfb01d9` | Worker collision forwarding and event timestamp regression |

Verified robustness changes and the final report are committed separately.
Concurrent RL files/core changes are not included in the Gate 5 branch.
The exact file inventory and implementation/test commits are listed in
`GATE5_EVIDENCE.json`. A final documentation commit contains this report and the
evidence index; it can be found with `git log -1` on the Gate 5 branch.

## 15. Next milestone readiness

Ready for further controlled environment research and implementation of additional
verified scenario factories, observation preprocessing, a real feasibility
validator and experimental reward/evaluation studies. The prepared interfaces
support manual or a separate baseline driver and actions beyond braking alone.
Policy-connected experiments still need real intervention evidence, matched
held-out runs and physically reviewed unavoidable cases. No RL training was
started in this milestone. Work stops at Gate 5.
