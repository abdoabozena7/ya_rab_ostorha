# Egypt urban chaos V1: behavior and acceptance contract

## Scope and evidence boundary

`EGYPT_URBAN_CHAOS_V1`, definition version 1, is an independently selected
scenario on `Town10HD_Opt`, not a synonym for the guided interface. It models
traffic behavior, not Egyptian road geometry, measured Egyptian driver
distributions, or a learned/RL policy. The requested maximum is **60 km/h**;
visibility, road rules, curvature, vehicle control and stopping space can impose
lower speeds.

The [World Bank Cairo Traffic Congestion Study executive note (2014)](
https://www.worldbank.org/content/dam/Worldbank/TWB-Executive-Note-Eng.pdf)
motivates passenger pickup/drop-off stops, double parking, informal pedestrian
crossings and capacity bottlenecks. The personas, counts, probabilities, distances
and timings below are **test parameters**, not measurements from that study.
The [CARLA 0.9.16 Traffic Manager API](
https://carla.readthedocs.io/en/0.9.16/python_api/#carlatrafficmanager)
documents that forced lane changes ignore possible collisions. This scenario
therefore uses physical vehicle/walker controls and measured event completion,
not `force_lane_change` as proof or as its scripted cut-in controller.

Zero contact is an acceptance requirement, not a guarantee for every possible
scene. Remaining stationary for the whole trip cannot pass route completion.
Normal is allowed to arrive safely: **a Normal collision is not a requirement**.

## Environment behavior, specified before implementation

All actor selections and persona parameters come from a local seeded generator,
ordered by stable participant roles rather than native actor IDs. Both arms
reconstruct the same poses, blueprints, profiles, signals, route, seed and sensor
rig. Events trigger from route progress and observed traffic gaps under the same
rules for either driver; their eventual wall times and trajectories may differ.

| Situation | Actors and visible cues | Trigger and physical action | Evidence required |
| --- | --- | --- | --- |
| Stop/go queue | A cautious or impatient lead vehicle; visible closing speed and brake lights | Near-route approach, followed by bounded braking, waiting and physical acceleration | Recorded moving sample, speed reduction, stopped interval and subsequent displacement |
| Passenger stop / double parking | A stopped car with brake/hazard lights; adjacent lane may be occupied | A selected lead physically stops at an admitted route slot; it remains an obstacle for a bounded interval | Measured low speed, sustained pose, eventual release and displacement; a command alone is insufficient |
| Gradual/hesitant cut-in | Adjacent car signals before steering; may wait for a gap | Only after the gap test, steer along a native same-direction lane transition; otherwise wait or expire visibly | Actual lateral displacement, body/lane entry and subsequent forward travel |
| Pedestrians among cars | Waiting, ordinary crossing, hesitation, retreat and emergence from behind a stopped car | Native sidewalk endpoints, observable approach/wait, then physical WalkerControl segments | Measured displacement across the road corridor; hesitate/retreat phases need separate observed samples |
| Opening/closing gaps | Slow same-direction cars and a changing adjacent stream | Physically varied pace and bounded lane transitions; no opposing-lane escape | Measured speed/gap changes and lane transitions, separately from ego overtakes |
| Overlapping hazards | A crossing person plus a braking or merging car | Two independently controlled actors in the same local progress window | Both physical events realized within the overlap interval; not merely two requests |

Driver personas are cautious, ordinary, impatient and hesitant. Pedestrian
personas are waiting, steady, hesitant, retreating and brisk. A persona changes
test speed, pause, signaling and gap parameters, never collision enablement.
No scripted actor is teleported, granted invulnerability, or moved by pose
interpolation during an admitted drive. Staging/reconstruction with physics
held is allowed only before recording release and is audited separately.

Each event retains `REQUESTED`, `EXECUTING`, and `COMPLETED` transitions with
simulation frame/time and measurements. An unavailable gap, lost participant,
missed progress window or unrealized action is retained with a reason; it cannot
be silently replaced by a successful event. Requested density starts at
60 vehicles and 100 pedestrians. Actual counts and displacement-based movement
are measured; requests and controller activity are not movement evidence.

## Route and maneuver contract

The planned connected route must measure 600--800 m. Ordered intermediate
destinations are part of its identity and must survive reconstruction and
navigation startup; replacing it by the shortest start-to-finish route is invalid.
Before release, verify native driving-lane connectivity, bounded segment gaps,
same-direction legal adjacent space for three separated passing opportunities,
and a sidewalk/crossing bottleneck. Refuse a missing capability rather than
substituting a short crossing fixture.

The protected driver has a new versioned profile. It consumes only the existing
frame-bound sensor scene, ego telemetry, public road rules and route geometry.
It may follow, slow, stop, change lane, pass a moving or stopped lead, and return.
It does not consume actor identities/poses from the world, scenario plans,
persona labels, progress triggers, held-out seeds or event targets. Native actor
truth is permitted only for environment control and explicitly labeled scoring.

A maneuver needs a useful measured lead-speed advantage, legal lane permission,
fresh front/side/rear coverage, complete-body swept free space, all physical
motion hypotheses and a braking continuation. A partial three-second prefix is
not evidence for a longer lane change. Unobserved or occluded space stays unknown;
missing/stale data blocks admission. Speed follows verified visibility,
curvature and actuator limits below 60. A selected physical curve is anchored
in measured odometry and retained through a veto/temporary wait to prevent
left/right oscillation.

A lane-change request is not an overtake. Completion requires observed ego
progress beyond the entire measured lead body, in the same travel direction,
plus lane alignment; a moving lead lost from tracking cannot be treated as a
stationary anchor. When return is required, it needs its own fresh full-corridor
proof and observed alignment. Stopping for a closed exit is a safe outcome, not a
completed overtake. Overtake count is reporting only, never an input to planning.

Normal keeps reactive sensor braking and its route/signals controller. The
protected arm changes both maneuver selection and prediction. Describe this as
a comparison of **complete drivers**, not a causal brake-only experiment.

## Results, compatibility and acceptance

Record scenario ID/version/definition hash, seed, driver profile, actual density
and motion, requested and realized events, complete maneuvers and waits. Retain
contact callbacks of any magnitude, route completion, actual maximum/mean speed,
minimum body separation (native scoring, not actor-center distance), sensor
simulation/wall ages and measured simulation/wall ratio. Unmeasured values remain
null. Existing recordings, fixture identities, videos and historical crossing
assessments retain their original protocols.

Software tests cover cut-ins, fast rear traffic, occupied side lanes, occlusion,
pedestrian hesitation/retreat, closed roads, stale data, release after obstruction,
deterministic construction, reconstruction and the no-privileged-input boundary.
Run the repository JavaScript and Python suites and rebuild checked-in dashboard
JavaScript/CSS after frontend changes. Browser loading, mode switching, emergency
stop and persistent video/export behavior must be checked separately.

Native acceptance uses three reserved seeds, both complete drivers and both
orders: **six pairs / twelve trips**. Reserved seeds must not be used to tune
parameters or to select a successful attempt. Freeze source/configuration hashes
before admission; preserve every failed/interrupted attempt and all exports.
For each protected trip require arrival, zero contact callbacks, actual scenario
diversity and at least three measured completed overtakes, with a verified return
where required. Also verify actual common starts, density/motion, telemetry and
the 60 km/h ceiling. Display Normal's actual outcome without prescribing contact.
Closed-road unit/native fixtures can pass a separate safe-stop check; timeout of
the main trip is still a route-completion failure.

Promotion to the default requires the complete source-bound native acceptance
report, not a configuration boolean, offline tests or a single successful video.
Until then the legacy scenario remains the default and the new driver requires
an existing live bounded validation reservation.

## Verification status at implementation start (24 October 2026)

Read-only inspection found no CARLA listener on port 2000. The existing hybrid
ledger contains 34,449.7832502 s gross charges and 20,187.9445429 s of previously
verified sleep exclusions: **138.1612927 s remain** of its 14,400 s cap. No ledger,
sleep exclusion, allowance or expired RULE ticket is reset or extended by this
work. That remainder does not fund twelve 600--800 m native trips, including
construction and cleanup. Native acceptance and promotion therefore remain
**pending** unless an existing authorized window can cover the complete work.
Offline verification and browser-only checks must not be reported as native
driving acceptance.

## Implementation and operation

- [Scenario contract and native scoring](../backend/core/egypt_urban.py) keep the
  identity, seed partition, physical-evidence checks, six-pair matrix and
  source-bound promotion separate from interface mode.
- [Native environment](../backend/carla/egypt_urban.py) uses the existing
  population, stable-role benchmark reconstruction and physical waypoint
  follower. Ordered route destinations survive startup and restoration.
  Connectivity, passing sections and the captured route are checked again
  before release; missing native sidewalk endpoints fail construction.
- [Urban maneuver driver V2](../backend/core/urban_driver.py) reuses the sensor
  scene, actuator helpers and independent execution shield, not the old
  stationary-bypass speed limit. Complete lane-change/return geometry includes
  a stopping continuation. Longer physical hypotheses retain the original
  measurement frame/age and include braking, acceleration, combined lateral ingress and pedestrian
  retreat. Proof-cache identity distinguishes these hypotheses. Expanding ray
  processing never creates new measurements or declares occlusion free.
  An unverified emergency hold reports rear-impact safety as unknown, not as a
  successful safety certificate.
- Both drivers retain the 60 km/h ceiling with a 58 km/h controller target margin;
  posted limits, visibility and curvature may reduce it further. This margin is
  not native speed acceptance. Provisional actuator response and actual native
  latency still need the reserved acceptance matrix.
- Version 7 recordings identify complete drivers, actual physical events,
  body-cleared/returned maneuvers, waits, stale/missing sensor scenes and measured
  simulation/wall ratio. Any contact callback, including zero impulse or a late
  terminal callback, invalidates zero-contact acceptance. Requested signaling or
  lane changes cannot certify realization. Missing or unhealthy collision
  measurement also prevents acceptance. Egypt audits report actual total
  density/movement rather than borrowing the old short-crossing frustum quota.
- Raw Egypt attempts use `KEEP_RAW`; the guided two-raw-run retirement policy
  does not erase the native acceptance corpus. Raw and annotated MP4 exports,
  shared-view handling, Finish, refresh and historical protocols remain separate
  from native driving acceptance.

The guided screen has a **Road scenario** choice separate from the first driver.
Until native acceptance, Egypt is available only inside an existing live
validation reservation. The historical crossing choice remains available, with
its original protocol and results. The backend also accepts the new
`scenario_id` with `guided=False`; selecting the interface does not select or
rewrite the scenario.

Read-only authorization preflight (does not launch CARLA or create a ledger):

```powershell
.\.venv-carla\Scripts\python.exe -m scripts.native.validate_egypt_urban --acceptance --report output\egypt-urban-chaos\preflight.json
```

With a genuinely available existing authorization, `--run --acceptance` freezes
source/configuration, runs the three reserved seeds in both orders without
retries, saves each failure and evaluates all twelve trips. `--rule-ticket` may
identify an **existing** unexpired RULE repair ticket; no ticket is manufactured.
Without it, the existing independent hybrid ledger is used. The default
reservation includes 900 s per pair plus 300 s per pair for bounded cleanup and
media verification (7,200 s total); it is not a newly granted allowance.
Development accepts only 1703, 2707 and 3709. The reserved 961103, 961109 and
961121 were planned by preflight, **not executed or used for tuning**.
Ordinary interface requests cannot select reserved seeds; the harness-only
admission records `HOLDOUT`, and the matrix checks the recorded partition.

Successful source-bound matrix evaluation writes the acceptance artifact used
by the catalog/default gate. A partial matrix, duplicate order, changed source,
unmeasured event, missing return proof, timeout, missing timing or any protected
contact keeps promotion closed. Normal's actual outcome is retained without
an expected collision. Historical crossing success checks apply only to their
own older protocol.

## Verification evidence and remaining gates

| Check | Observed result | Scope |
| --- | --- | --- |
| `npm run build:dashboard` | Passed; checked-in JS/CSS regenerated | Software |
| `npm test` | 197 passed | Software |
| Approved Python discovery suite | 923 discovered: 919 passed, 4 skipped | Software |
| Isolated Chromium workflow | Eight checks, no browser errors; both fixture MP4s played after reload | UI and software-fixture media only |
| Reserved native acceptance | **0 / 12 trips executed; pending** | Existing 138.1613 s cannot fund the matrix |
| Promotion to primary default | **Not performed** | Requires complete source-bound native acceptance |

- [Native authorization preflight](evidence/egypt-urban-chaos-v1/native-preflight.json)
  records the requested twelve trips, current ledger hash, unchanged
  authorization and insufficient remaining allowance. **No new native trip
  or engine launch occurred.**
- [Browser verification](evidence/egypt-urban-chaos-v1/browser-check.json) uses
  intercepted commands and explicitly labeled software-fixture MP4s, not CARLA
  driving evidence. It covers independent scenario selection, loading, driver
  choice, the 60 km/h request, emergency stop, version 7 results, both videos to
  their real ends, Finish, disconnected reload and desktop/mobile containment.
  [Mobile results screenshot](evidence/egypt-urban-chaos-v1/browser-results-mobile.png)
  depicts that **UI fixture**, not a successful native trip.
- [Software verification summary](evidence/egypt-urban-chaos-v1/software-verification.json)
  records the actual repository commands, results and delivered bundle hashes.
  Tests include dynamic cut-in/rear/occupied-lane rejection, stale and occluded
  measurements, safe closed-road hold and resumption, stable committed intent,
  measured pass/return, real control commands for queue/hesitation/retreat/merge,
  deterministic plans/rebinding, route preservation, admission, late contact
  callbacks, anti-forged realization flags and both real MP4 exports.

The original full-suite run exposed a diagnostic-only fixture without a provider;
the optional maneuver-owner lookup was made compatible without changing its
legacy braking semantics. A video-fixture preparation attempt used a relative
root unsupported by the existing overlay exporter; the fixture generator was
rerun with the same canonical absolute-root convention as production recordings.
These were software verification issues, not discarded native driving attempts.
The accelerating-rear hypotheses also correctly rejected the earlier positive
return fixture: the test now verifies waiting first and returning only after a
larger measured rear gap, without weakening the execution shield.

Native route feasibility on the actual map, dense-scene timing, behavior
realization, actuator response, three complete overtakes and zero-contact arrival
across all twelve reserved trips remain **unverified/pending**. The only native
authorization available cannot cover them. The historical budget, failures and
evidence are preserved. Legacy remains the primary default; no prototype or
synthetic/browser result is promoted to accepted native control.
