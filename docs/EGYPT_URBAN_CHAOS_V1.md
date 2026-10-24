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

## Separate allowance and stopped-engine status: 24 October follow-up

The first follow-up implemented validation infrastructure without starting
native execution. The user subsequently authorized the remaining native
development and acceptance validation. The [native execution report](EGYPT_NATIVE_VALIDATION_20261024.md)
records the normal dashboard handoff, actual development attempts, repairs and
remaining failures. Development has not passed, so reserved acceptance has not
started. Egypt is still locked and the historical crossing remains the default.
There is no native acceptance artifact.

The separate [Egypt ledger](../backend/learning/egypt_budget.py) was allocated
once at `output/egypt-validation`, with **14,400 s originally allocated**: at most 7,200 s for
development and 7,200 s protected for final acceptance. It does not modify the
hybrid research ledger, sleep adjustments or RULE authorizations. Allocation is
not a reservation and does not start CARLA. Reallocating an existing directory
is rejected; the runner never creates or extends an allowance implicitly.

On an authorized native run, the parent acquires exclusive cross-process
simulator ownership before saving the current dashboard snapshot and requesting
its ordinary `stop_simulator` recording/SDK/engine shutdown. It waits for engine
exit before launching validation. Startup, scenario construction, both trips,
exports, playback checks and native cleanup are inside the reservation.
Workers receive `--egypt-budget`, the exact reservation ID and a delegated
monotonic deadline. The parent terminates a worker at its deadline; native
cleanup and decoding use bounded timeouts. Actual elapsed time is recorded,
including overruns rather than hiding them at the cap. An overrun fails
validation. Failed and interrupted attempts retain their reports, raw data,
source archive and charges. An abrupt parent exit leaves the full reservation
crash-charged and blocks automatic reuse. Unverified engine cleanup retains
the ownership lock; recovery requires inspection, not an automatic refund,
retry or extension.

The runner uses Town10/LOW, the unchanged 60/100 request, shared Mercedes/sensors
and 60 km/h ceiling. Development defaults to 1703, 2707 and 3709 in both orders.
Focused development checks may use `--development-seed` and `--first`; their
successful exit is explicitly **development success**, never deployment
acceptance. Only the complete latest six-pair current-source development matrix
can admit final acceptance. Repair attempts and old-source results remain in
their original reports but cannot certify the repaired source.

Acceptance reserves exactly 7,200 s, freezes per-file source/configuration
hashes and runs 961103, 961109 and 961121 in both orders, once. It cannot be
resumed selectively or rerun under the allowance after failure/interruption.
The six-pair/twelve-trip gate, all physical driving gates, actual Normal outcome,
LOW/Town10 identity, exports, post-engine-exit playback and independent cleanup
must pass. Publication occurs only after the reservation has finalized, and
rechecks the development snapshot, frozen hashes and separate allowance.
Changing any driving/backend/runner source invalidates deployment admission.

`GET /api/simulation/scenarios` is read-only and requires neither a provider nor
a live simulator. It preserves `default_id`, `options` and existing option
fields, adding validation phase/state, completed trips, failed gates, blocking
reasons and simulator ownership. The chooser refreshes this endpoint every two
seconds while visible, also on the stopped welcome screen. A validation block is
status text, not a disabled action with an arrow. GPU measurements are advisory
and cannot unlock it. Acceptance changes the default only for new comparisons;
active drives, explicit historical choices and saved media retain their IDs.
The backend must be restarted normally to load the new implementation; this
delivery does not reload or retire the current native host.

For a fresh, separately authorized setup, allocation is an explicit one-time
operation (already performed in this checkout; do not repeat it):

```powershell
.\.venv-carla\Scripts\python.exe -m scripts.native.validate_egypt_urban --allocate-egypt-budget --egypt-budget output\egypt-validation
```

Read-only preflight is safe before native execution is authorized:

```powershell
.\.venv-carla\Scripts\python.exe -m scripts.native.validate_egypt_urban --egypt-budget output\egypt-validation --acceptance --report output\egypt-validation\acceptance-preflight.json
```

After explicit native execution authorization, the separate phases are:

```powershell
.\.venv-carla\Scripts\python.exe -m scripts.native.validate_egypt_urban --run --egypt-budget output\egypt-validation --report output\egypt-validation\development-matrix.json
.\.venv-carla\Scripts\python.exe -m scripts.native.validate_egypt_urban --run --acceptance --egypt-budget output\egypt-validation --report output\egypt-validation\acceptance-matrix.json
```

Do not run the second command if development is incomplete or its allocation is
exhausted. A nonzero acceptance exit retains the lock and exact failed gates.
`--rule-ticket` now supports read-only legacy preflight only; it never funds
Egypt execution. Raw attempts remain ignored under `runs`/`output`, not committed.
The compact [follow-up software evidence](evidence/egypt-urban-chaos-v1/validation-infrastructure.json)
and [browser evidence](evidence/egypt-urban-chaos-v1/validation-browser.json)
distinguish intercepted fixtures and offline checks from native acceptance.

Follow-up verification:

| Check | Result | Scope |
| --- | --- | --- |
| Dashboard build | Passed; checked-in JavaScript/CSS regenerated | Software |
| `npm test` | 207 passed | Offline software |
| Python discovery suite | 942 discovered: 938 passed, 4 skipped | Offline software |
| Isolated browser workflow | 12 checks; no browser errors | Intercepted status/commands and software-fixture media |
| Separate Egypt allowance | Allocated once; 14,400 s remain; no reservations | No native execution |
| Development / reserved acceptance | 0 / 12 native trips in each partition | Deferred; no driving acceptance |
| Default promotion | Not performed | Requires the frozen native matrix |

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
Its [selectable route rows](SCENARIO_CHOOSER_20261024.md) allow inspection of Egypt
without native commands. A locked selection shows validation requirements;
preparing and starting the scenario still require admission. Refreshing access
does not automatically prepare an inspected selection.
Until native acceptance, Egypt is available only inside an existing live
validation reservation. The historical crossing choice remains available, with
its original protocol and results. The backend also accepts the new
`scenario_id` with `guided=False`; selecting the interface does not select or
rewrite the scenario.

Read-only authorization preflight (does not launch CARLA or create a ledger):

```powershell
.\.venv-carla\Scripts\python.exe -m scripts.native.validate_egypt_urban --acceptance --report output\egypt-urban-chaos\preflight.json
```

The original runner used a genuinely available existing authorization. Its
`--run --acceptance` froze
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

## Original implementation evidence and remaining native gates

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
authorization at the original implementation could not cover them. The separate
follow-up allowance above now records actual development charges; the native
execution report records the remaining failed gates and untouched acceptance
window. The historical budget, failures and evidence are preserved. Legacy remains the primary default; no prototype or
synthetic/browser result is promoted to accepted native control.
