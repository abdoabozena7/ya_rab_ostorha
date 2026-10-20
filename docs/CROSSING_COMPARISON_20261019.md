# Full crossing comparison — 19 October 2026

This revision keeps the existing Town10HD city and Softly interface. The displayed
project name is **Ya Rab Ostorha**. Internal `NORMAL` / `ROBOSPHERE` identifiers and
historical recordings retain their original identity.

## Accepted native matrix — 20 October

The [independent six-pair review](evidence/crossing-six-pairs-20261020.json)
passes all three fixtures in both driver orders. Each Normal trip ends at an
actual contact with the designated walker; each project trip reaches its
destination without any contact. All nine project crossing starts satisfy the
saved position/clock admission check. Finish is requested during export, then
all three videos are checksummed and decoded at their first and last frames
after independently verified cleanup and CARLA exit.

| Fixture | First driver | Normal contact / project arrival (s) | Measured peak, Normal / project (km/h) | Project longest standstill (s) | Forecast before path ingress (s) |
| --- | --- | --- | --- | --- | --- |
| A | Normal | 5.95 / 35.30 | 64.05 / 58.34 | 1.00 | 0.90 |
| A | Ya Rab Ostorha | 5.95 / 32.95 | 64.05 / 60.05 | 0.55 | 1.40 |
| B | Normal | 5.90 / 35.20 | 63.81 / 59.05 | 0.55 | 0.90 |
| B | Ya Rab Ostorha | 5.90 / 36.80 | 63.81 / 60.91 | 0.55 | 0.95 |
| C | Normal | 5.95 / 36.90 | 64.05 / 60.78 | 0.75 | 1.40 |
| C | Ya Rab Ostorha | 5.95 / 36.55 | 64.05 / 59.46 | 0.55 | 1.50 |

Both modes request 120 km/h in every manifest. Actual speed follows measured
road coverage, traffic and risk. Three of these six cases also satisfy the
additional, stricter first-foot-motion audit; the other three still brake
0.9–0.95 s before path ingress while ordinary measured forward risk is clear.
Those original first-motion failures remain reported, not relabeled as passes.

The [source and native-event provenance](evidence/crossing-six-pairs-provenance-20261020.json)
records every role's start error/time, rig configuration, exact source archive,
media checks and measured throughput. Four A/C pairs reuse their original
complete runs with identical control bytes and selected definitions; both B
orders were rerun after its waiting orientation changed. Exact catalogue-file
equality and independently verified selected-case compatibility are reported
separately. The three `validated` booleans were enabled only after all six
passed; these annotations do not affect the scenario definition or physics.

On this local LOW-profile CARLA/CPU-vision setup, native processing measured
4.95–6.89 observations per wall-clock second. Exported video uses the canonical
20 Hz simulation clock. The live simulation is therefore below real time on
this hardware; this delivery does not claim a 20/60 FPS live camera or general
avoidance performance beyond the three controlled fixtures.

## Actual browser acceptance

The [full native browser evidence](evidence/crossing-browser-native-20261020.json)
passes one Start for both natural endings, double-click protection, opening a
second dashboard as an observer, real focus loss for 1.8 s, reload during
driving, and a fresh actor rebuild to the comparison Mercedes. Normal records
one pedestrian contact; the project travels about 263 m to arrival with none.
The driver titles/details remain stable during each arm; the extra identical
Normal text observation is from the intentional reload.

Finish is double-clicked while all three exports are pending. Only one Finish
command is dispatched. The same three actual files play at their beginning and
end after verified CARLA exit, then play again after refresh with the same pair
and URLs. The [desktop](evidence/crossing-browser-native-results-20261020.png)
and [390 px mobile](evidence/crossing-browser-native-mobile-20261020.png)
captures show the real ready media, without fixture substitution or horizontal
overflow. Independent process inspection found no CARLA engine; NVIDIA's
after-stop reading was 0 MiB / 6144 MiB and 0% utilization on the RTX 3060 Laptop.
All 253 archived backend, frontend and probe files remained byte-identical
through this browser test.

No application exception or server-command error occurred. Connection-refused
status polls during the intentional backend startup/shutdown handoff are
retained as transport retries, not counted as drive failures. An earlier
[browser verification-probe failure](evidence/crossing-browser-focus-probe-20261020.json)
remains recorded: Playwright's default focus emulation prevented the hidden-page
assertion from measuring real focus. The final test disables that verification
override and observes `document.hasFocus() === false`. It records visibility as
`visible`; it does not claim to have tested native hidden-tab timer throttling.

The [compact native attempt index](evidence/crossing-native-attempts-20261020.json)
preserves earlier calibration failures and source identities. Raw runs, source
ZIPs and local dependency/model installations remain ignored, as required by
the repository workflow.

Native ego construction and scenario stop calls pass the configured Traffic
Manager port explicitly (8050 in the dashboard, 8052 in isolated acceptance).
The former implicit `set_autopilot(False)` started an unused manager on 8000,
colliding with the ordinary HTTP dashboard when it tried to bind that port.
The actual browser startup now runs HTTP on 8000 beside the configured manager.

Owner/session-bound heartbeat messages are acknowledged independently of sensor
freshness; a previous-session heartbeat cannot renew any lease. Sensor freshness
continues to gate actuator commands. Read-only preload and an already admitted
matching choice also remain safe during sensor reconstruction. An actual browser
trial completed both natural journeys, Finish and three-video playback after exit
and refresh, but exposed a spurious heartbeat error during reconstruction. That
trial remains an interface failure and motivated these transport regressions.
The later full browser flow above verifies the repaired behavior.

Native calibration continued into 20 October. Accepted historical trials and
failed trials retain their original source hashes; a controller edit requires
fresh acceptance evidence.
In compact historical attempt summaries, `current_acceptance` is the legacy
field name for the additional first-motion gate. It does not mean that an old
attempt used the current controller; consult its source-set and source-archive
hashes. A retained calibration pass cannot substitute for the final six cases.

## Implemented behavior

Start records both drivers automatically, in the selected first-driver order.
There is no Next/shorten action during an automatic comparison. Recording ends
on actual destination arrival, collision, explicit cancellation or technical
failure. Both drivers request 120 km/h through native preparation, navigation
and the saved manifest. Actual speed remains governed by route geometry,
traffic, measured hazards and the original sensor freshness limits. Normal's
reactive obstacle brakes remain enabled; RULE adds sensor-derived anticipation.
Waiting-person alternatives retain walking/retreat and add a possible sudden
run, bounded to 3.5 m/s with 6 m/s² initial acceleration. These are unranked
physical possibilities, not probabilities or known pedestrian intentions. A
measured cleared crossing suppresses all speculative restart alternatives;
observed return motion still triggers protection.
Native crossing release uses the audited car half-width, the measured person's
body margin, maximum current depth uncertainty and an additional 0.5 m clearance.
It still requires an observed crossing and no measured return toward the lane;
legacy recordings without vehicle geometry retain their historical threshold.
If a newly identified person remains measured stationary outside the swept lane,
speculative restart hypotheses cannot hold an empty lane indefinitely. After
at least 0.6 s of stable position evidence, RULE tests 4, 3, 2 and 1 m/s approach
caps against current crossing trajectories and acceleration hypotheses.
For the verified stationary person alone, speculative intent is checked over
the configured reaction time plus a complete stop from the greater of current
and capped speed, with another 0.1 s observation margin. A three-second
open-loop launch was inappropriate for continuously re-evaluated crawling: a
revision-14 reverse-order A trial held for over two minutes beside a stationary
person. Its [native image and stop evidence](evidence/crossing-stationary-hold-revision14-20261020.json)
show the occupied sidewalk beside the empty lane. All actual motion, other participants and physical occupancy retain the
full forecast horizon. It selects the fastest clear response within measured
road and navigation limits, with throttle at most 0.5. If none is clear, braking remains.
This requires measured stopping space plus 2 m extra, clear body/uncertainty
margin, no physical hazard and no measured path conflict.
Actual motion, occlusion, insufficient coverage or a person in the lane retains
ordinary protective braking. The forecast and selected cautious speed remain
logged. The fixed 1 m/s override was rejected in native calibration
(`a46b0671ab024b398ca22eab098fa6d6`): it prevented a contact but produced excessive
roadside crawling. That attempt was explicitly aborted and is not a complete or
accepted comparison.

A subsequent browser trial (`run_f403f881243345f3b8f9cc522bd1747c`)
stopped inside the first additional walker's crossing while braking for another
crossing farther ahead. The first walker contacted the already stationary car;
this remains a failed project trip. The speed-candidate check now also handles
current measured crossing motion: below 4.5 m/s, with clear physical stopping
space and no immediate hazard, it may choose a 4/3/2/1 m/s cap only when every
current crossing mode is collision-free under that capped response. It never
overrides another LiDAR path conflict, an immediate physical brake or a missing
current measurement. If even the slowest response intersects, the brake stays.
Pedestrian paths, starts and physics are unchanged. Offline replay found capped
progress opportunities in the rejected input stream; closed-loop native evidence
is still required after this controller change.

`config/crossing-comparison.json` defines three versioned crossing fixtures in
Town10HD_Opt. Selection chooses a variant; its fixed seed reconstructs the same
Mercedes, eight-sensor rig, initial population, pedestrian roles, blueprints,
crossing locations, speeds and simulation-clock schedule for the other driver.
Native actor IDs may change.
The live dashboard normalizes its current car and sensor rig before capturing
the fixture, including when it starts with the ordinary Lincoln or an optional
surround rig. Old actor frames are discarded and fresh sensor frames are required
after rebuilding. Both recorded arms use the same Mercedes and eight sensors.
Their trip/result camera is a fixed 800×450 chase view with native camera
postprocessing and gamma 2.2. It shows the car and side contact; the former
forward trip view could lose the person from the frame at impact. The separate
1280×720 front camera remains the perception input and shared-prefix source.
Their 32-channel LiDAR retains 128,000 points/s and a 100 m range, with a -75°
lower vertical view. Native low-speed holds exposed an unverified strip around
the swept body with the former -30° view. The wider view measures near-body
ground with actual returns; unknown cells and physical hazards retain their
original protection. Existing rigs with the former view are rebuilt before
fixture capture, rather than relabeled as calibrated.
The critical walker is a fresh manually controlled
CARLA character, not a previously possessed AI walker. Revision 17 stages the
other foreground walkers on paired actual native sidewalk navigation points,
then crosses them in both directions after the critical event, with one
scheduled crossing per participant. The selected endpoints and exact schedule
are saved for the other driver. Waiting positions are separated by at least 2 m;
the other sidewalk endpoint remains within 6 m along the road, avoiding an
arbitrary diagonal through the city. They walk away
along the opposite sidewalk after crossing. Background walkers remain on native
navigation points outside the immediate roadside corridor. This separates the
critical predictive response from unrelated earlier pedestrian braking.
They do not restart an unbounded return loop after the critical event.
Construction retains 60 vehicles and 100
pedestrians, including nine explicitly scheduled crossing participants.
Background vehicles use the ordinary compliant city profile with lane changes
disabled, full actor/walker collision checks and the original population count.
This removes unrelated deliberate traffic violations from the controlled
pedestrian comparison; the historical unrestricted Dense Chaos preset remains
available outside the guided comparison.
Construction also relocates two-wheelers from the adjacent approach lanes:
their visible riders are legitimate person detections and otherwise explain an
earlier predictive slowdown unrelated to the critical walker. Counts and mixed
vehicle categories are retained. This is a matched fixture choice, not a rule
that suppresses detection or braking for riders in ordinary driving.
Owned parked vehicles on the critical sidewalk's approach are relocated before
capture too. Actual front-camera review also found a static map car obscuring
the original waiting location. Revision 13 used 65, 66 and 67 m. A full browser
trial exposed physical blocking at 67 m: the critical walker received its crossing
command but did not traverse; Normal arrived without contact, and the comparison
correctly failed. The [actual front image and event record](evidence/crossing-c-blocked-critical-20261020.json)
retain that rejected fixture. Revision 14 used 65, 64.5 and 64 m, with fixed starts
4.7, 4.65 and 4.6 s respectively, ahead of the parked car. Its C trials reached
the destination but lacked a sufficiently early reliable person classification;
they are not accepted predictive demonstrations. Revision 15 placed C at 65 m,
starting at 4.7 s and running at 3.5 m/s. Its full pair again completed the actual
collision/arrival and lifecycle gates, but the standing side profile was detected
confidently only after movement. Revision 16 keeps those timings and places the
waiting C participant facing incoming traffic, before native WalkerControl turns
him into the crossing. This initial orientation is saved and replayed for both
drivers, with no detector confidence or depth-support threshold reduction.
A retains 3.4 m/s and its own population seed, while B retains
64.5 m / 4.65 s / 3.5 m/s. B's unvalidated revision-17 candidate also lacked an
early speculative person forecast in both orders despite passing all physical,
origin-admission and lifecycle gates. Its [six-case calibration record](evidence/crossing-revision17-before-b-calibration-20261020.json)
retains those failures. The final B candidate faces incoming traffic while
waiting, like C; timings, speed, location and detector thresholds are unchanged.
Both B orders are rerun. A and C retain their exact selected definitions and
control bytes, with checksummed source archives verified before reuse.
Both modes reconstruct
the same selected definition; the static city remains unchanged. An early
sensor forecast cannot be required through an occluding vehicle. The retained
[native failure frame](evidence/crossing-occluded-walker-native-20261019.jpg)
documents why the former location was rejected.
One stable native Walker handle owns commands per role throughout each arm.
This preserves libcarla's control cache and actually transmits zero-speed stops
at the target; obtaining a new wrapper each tick incorrectly suppresses them.

The scorer requires an actual collision-sensor event identifying the critical
walker in Normal, actual destination arrival without any collision in Ya Rab
Ostorha, verified matching initial conditions, matching detector profiles and
realized crossing events. A wall contact, timeout, absent recording or a
collision in both modes fails. Expected outcomes never create collision events
or enter the driving policy. Native role/pose evidence is evaluator-only.
Revision 17 additionally requires every scheduled project crossing to begin
within 0.75 m of its saved origin and within 0.11 s of its simulation-clock
trigger. Normal's later events remain unstarted when its recording ends at
contact. Arrival alone cannot conceal a displaced or late crossing. Native
tests retain the measured start positions and command times for every role.

The [revision-16 additional-contact failure](evidence/crossing-revision16-crossing04-failure-20261020.json)
motivated this admission gate. Its synthetic sidewalk approach drifted far
outside the planned segment before the fourth crossing; the project then had
an actual pedestrian contact. That remains a failed control outcome. A separate
revision-16 reverse-order A trial arrived without contact, but does not satisfy
the later scheduled-origin audit either. Native navigation endpoints replace
the synthetic approach; population counts, crossing times, commanded crossing
speeds, actual collision physics and Normal's reactive protection remain intact.

Camera reads during construction no longer release autonomous controls. The
tick owner still enforces observation and transport leases. Held start-up waits
for fresh synchronized frames without admitting stale controls. An automatic
pair survives a brief page reload within the existing one-second
transport lease; a permanent lost connection still expires that lease. Page
unload and client close do not submit manual release pedals during automation.
The occupancy ray calculation uses bounded batches with identical free and
occupied cells and coverage decisions. Replay profiling on 49 native frames
reduced mean safety evaluation from about 98 to 67 ms; this is a profiling
measurement, not a guaranteed real-time rate. Population housekeeping runs
before the next physics tick, outside the next sensor publication's critical path.
Measured 3D display volumes are prepared after the native command is applied,
using the same immutable depth/LiDAR support and frame identity. The control scene
does not wait for box construction. Native, dashboard and video rendering still
consume the same resulting geometry.
Both guided arms also share a native steering bound of 0.35. A retained failure
showed saturated low-speed steering turning the Mercedes toward a parked curb
car, followed by a legitimate unknown-space hold. The bound changes the shared
route controller; it does not relax measured clearance, freshness or braking.
The runtime clears a legacy teacher stop latch only when the current target,
radar and measured road all exceed the existing stopping and release margins.
An old object leaving the path therefore cannot transfer its stop state to an
unrelated distant return. Physical hazards and unknown coverage retain braking.
The retained teacher's foreground range must also agree with the current full
radar foreground. A nearer ground point reclassified by its smaller retained
set cannot become a new object. Independent current depth/LiDAR hazards still
apply full braking even if that supplementary proposal is rejected.
The camera detector is CPU ONNX YOLOv8s at 640 pixels, using the full image,
a central quarter-width enlargement on every frame and one alternating roadside
enlargement (`YOLOV8S_640_FRONT_AND_FOCUS_V3`). Canonical frame parity selects
the roadside crop, so live inference and missing-frame export reproduce the
same preprocessing. The extra roadside view addresses a native failure where
late classification of a lateral walker left the stopped vehicle in its path.
The three CPU views run concurrently with at most three workers and one ONNX
thread per graph; no detector GPU allocation is added. See the official
[ONNX Runtime thread controls](https://onnxruntime.ai/docs/performance/tune-performance/threading.html).
A [recorded-image CPU check](evidence/crossing-cpu-views-profile-20261020.json) produced identical serial/concurrent detections and
reduced its measured latency from 851 to 344 ms. This is an isolated profiling
measurement; native throughput and acceptance are measured separately.
During stopped READY preparation the real simulation clock may pause while
vision catches the current frame. Its packet ages are not rewritten. STARTING
resumes the clock and still requires fresh synchronized sensor frames before
any movement is admitted.
Recorded historical V1 and legacy profiles keep their own preprocessing on export.
OCR is loaded only when its text-reading panel requests it.
Control RGB is 1280×720, depth is 640×360, and LiDAR has 32 channels at 128,000
points/s. Native depth-resolution probes found that the former 320×180 depth
could not support a reliable body-core measurement of the critical pedestrian
at about 30 m. The 640×360 probe measured 22 consistent core returns at 29.87 m.
Association converts calibrated pixel centers,
checks their shared field of view/mount/aspect, and requires matching frame/time.

Confirmed, current semantic tracks receive volumes measured from current depth
and LiDAR support. Their image classification must also have matching metric
depth evidence from its exact source frame. A native visual review found a
2D-only motorcycle label assigning a street fixture a tall volume; that label
cannot create a 3D box or a classified forecast arrow. Implausibly tall person,
car or two-wheeler support is rejected as merged/uncertain, rather than clipped
into a fabricated body. These are visible measured extents, not invented complete
occluded bodies or CARLA actor bounding boxes. Relevant crossing hypotheses get
one animated arrow per object; an applied avoidance path is shown only when
actually selected. The former global two-line limit is removed. Main view,
native server HUD geometry and annotated MP4 consume the same recorded overlay
payload; full hypotheses remain in Menu. Native drawing uses CARLA's
[server-only HUD primitives](https://carla.readthedocs.io/en/latest/python_api/#carladebughelper),
so annotations do not enter RGB model inputs or appear twice in exported frames.

Results have an independent shared-camera export above the two complete trip
videos. The upper video is an actual verified common prefix, with exact-frame
2D RGB detections. It ends at the first measured scene/vehicle divergence or
missing alignment. It does not imply that the full trips share identical views.
A real 1.5-second held recorded prelude permits a common prefix even when native
traffic begins reacting differently on its first released tick. Missing prelude
detections are computed from original checksummed images after the drive, outside
the control path. Each export has independent persisted preparation/error state.

Finish is idempotent and waits for both annotated trip videos and the shared
prefix before closing CARLA. The comparison reference, export status and results
survive shutdown and refresh. Start a new drive explicitly creates a new attempt.
Old videos are unloaded from the new live comparison without deleting archives.
Trip encoding waits until both automatic arms finish, so annotation/encoding
from the first trip does not compete with the second trip's sensor deadline.
Recording finalization remains independent; a cancelled or failed comparison
also releases its retained recording for export.
Trip status publication retries transient Windows reader locks before declaring
an export failure. A retained native trial exposed this during Finish; raw
recordings and failed status remain available rather than counting it as a pass.

## Verification and acceptance

A retained full native trial (`a5310cda768741f5b0ba83fbe02c5cff`)
avoided the designated critical person but struck the third additional crossing
participant at 20.3 s. Its original front-camera image shows that person clearly;
this is a controller failure, not an occlusion or successful comparison. The
recorded depth track disappeared from published control inputs when its RGB
classification expired, although current measured body motion remained present.
The old single 2 m/s² acceleration hypothesis also missed an intermediate launch
into the person's path. The fixture timing and physical braking remain unchanged.

Person depth seeds now use the torso rather than the gaps between moving legs.
Current depth measurements can continue as unclassified moving geometry after
the 0.75 s semantic lease expires; they cannot retain a person label or acquire
speculative human intent. Missing current depth still removes the geometry.
Prediction considers 2, 4, 6 and 8 m/s² forward responses, capped by the actual
navigation limit and, when coverage is limiting the applied controls, the speed
permitted by current measured stopping space. A reverse-order calibration
(`f06d9fa91ce445b389961885414fbd33`) exposed a false hold for a stationary person
36 m ahead: the forecast accelerated beyond the current 15 m coverage even
though the controller prohibited that speed. This incomplete attempt remains
rejected. Both control and displayed predictions now use the effective measured
coverage cap; no measurement, physical brake or freshness limit is bypassed.
Intermediate responses matter because a faster launch
can pass before a crossing while a slower one reaches it too late. A replay of
the original sensor bytes and recorded camera results recovered conflicts in
13 of 14 sampled frames from 16.8–20.0 s. That replay is offline diagnostic
evidence and does not establish closed-loop avoidance; native reruns are required.
The [scoped sensor replay](evidence/crossing-secondary-sensor-replay-20261020.json)
retains the original failure identity, current measurement proofs, classification
expiry and the recovered conflict at each sampled frame.

Software checks and native acceptance are separate. See the accompanying
evidence for exact source hashes, actual native terminal events, speeds, stop
diagnostics, common-prefix boundary and playback after engine exit. A variant
must not be marked validated until complete native comparisons in both orders
pass the scoring and lifecycle gates. Failed calibration runs remain locally
retained under ignored `output/crossing-pairs/`; full native recordings remain
under ignored `runs/normal_city/`. Multi-gigabyte raw data and model files are
not part of the source delivery.

The rebuilt dashboard passes 178 JavaScript tests. Python discovery passes 759
tests with two documented skips (757 executed passes). The final source checks
are recorded in `output/crossing-js-tests.txt` and `output/crossing-python-tests.txt`.
The [final software-check record](evidence/crossing-software-checks-20261020.json)
retains the commands' outcomes, test counts and local-log checksums.
The skips are the optional OpenCV detector check in the control environment
(the production detector runs in its separate perception environment), and the
API-absence check because the native CARLA wheel is installed here.
The OpenCV detector-quality test was also run separately in `.venv-perception`
and passed there; its skip in `.venv-carla` does not omit that check.
The [18-check browser fixture](evidence/crossing-ui-fixture-20261020.json) covers
duplicate Start/Finish, slow loading/reconnection, blur and reload during driving,
no shortening action, three independent export placeholders, media playback,
saved results and 1440/390/320 px layouts without horizontal overflow.
Its [desktop](evidence/crossing-results-fixture-desktop-20261020.png) and
[mobile](evidence/crossing-results-fixture-mobile-20261020.png) screenshots use an
explicit historical media fixture. In particular its top image is substituted
solely for layout/playback testing; it is not evidence of a shared native camera
prefix or a successful crossing. Actual native exported media is checked separately.

Useful entry points:

- `backend/carla/crossing_comparison.py`: physical scenario reconstruction.
- `backend/core/crossing_result.py`: observed comparison acceptance gates.
- `backend/core/presentation.py`: automatic arms, retained results and Finish.
- `backend/core/visual_geometry.py`: measured volumes and relevant hypotheses.
- `backend/core/shared_perception.py`: verified-prefix export and status.
- `scripts/native/validate_crossing_pair.py`: full production pair and shutdown
  probe; no injected contact, Next action or shortened route.
- `scripts/check_crossing_comparison_ui.js`: isolated browser fixtures, responsive
  result layout, double requests, three playable media elements and refresh.
  These fixtures are explicitly not native driving acceptance.

Reproduce a native pair with the ordinary dashboard disconnected:

```powershell
.\.venv-carla\Scripts\python.exe -m scripts.native.validate_crossing_pair --seed 1701 --first NORMAL --seconds 900 --render-profile LOW
```

Use seeds 1701, 1702 and 1703, each with `NORMAL` and `ROBOSPHERE` first. The
validator archives exact source bytes, waits for natural terminal events, sends
Finish twice during export, independently checks cleanup, verifies CARLA exit,
then verifies checksums and decodes the first and last frames of all three MP4s.
Its additional first-motion audit associates the actually applied sensor forecast
to the critical walker after the drive. It requires braking from at least
20 km/h before that walker's first observed native motion. Its original reports
and strict `native_acceptance` results remain unchanged, including failures.
Native poses are evaluator-only and never enter the controller.

The [rejected revision-14 matrix](evidence/crossing-revision14-rejected-matrix-20261020.json)
retains all six real cases: three satisfied the selected predictive/lifecycle
policy, one ended in the stationary hold and a subsequent sensor fault, and two
C cases completed physically without proving early speculative person braking.
The [complete revision-15 C trial](evidence/crossing-revision15-rejected-c-20261020.json)
also remains rejected on that prediction gate despite successful physical
endings and all three playable exports after shutdown.

The user's predictive crossing requirement and this additional first-motion
condition are reported separately. A foot beginning to move is different from
a person entering the car's path. `scripts/crossing_user_acceptance.py` reviews
the recorded evidence after driving: an applied, frame-aligned speculative
person-crossing brake from at least 20 km/h, associated within 1.2 m of the
designated person, while ordinary measured forward collision risk is still
clear. The person must remain outside a conservative 2 m route corridor, with
at least 0.5 s before both actual path ingress and Normal's actual contact.
A watchdog/processing-deadline brake, ordinary reactive hazard, wrong person,
missing ingress or late forecast cannot satisfy this check. The first-motion
timing is retained beside it. This review changes no control bytes, native
outcome or historical report; it is explicitly a post-drive review, not a claim
that every forecast preceded the person's first step. All arrival, collision,
fair setup, complete recording, export, independent cleanup and playback-after-exit
gates remain required.

`scripts/native/validate_crossing_matrix.py` runs all six pairs sequentially.
Its default remains the historical strict first-motion audit. Passing
`--acceptance-policy before_ingress` explicitly selects the user-plan review
above and records both results, the selected policy ID and a pinned copy/hash
of its evaluator. Acceptance is never silently changed in an original pair.
It can reuse a complete passing report only when its control-source hashes are
unchanged and its selected scenario, common city settings and library version
match the current configuration. A calibration edit to a different scenario
does not invalidate an unchanged case. Such reuse verifies the checksummed
original source archive; it never rewrites the historical report or its hashes.
The six actual runs and any configuration-only differences remain explicit in
the matrix evidence.
The matrix saves the exact catalogue bytes beside its report. Independent
review verifies that snapshot and each original source archive by SHA-256,
retains `source_matches_matrix` for exact-file equality, and separately checks
selected-case compatibility. Changed control code, a changed selected fixture,
common city/version changes or a corrupt archive/snapshot are rejected. Thus an
edit to B cannot silently redefine a previously measured A or C result.

The [revision-16 native media review](evidence/crossing-delivered-native-media-review-20261020.json)
retains exact report/archive/media hashes for C with the project driver first.
It passed both the user-plan gate and the additional first-motion diagnostic:
the associated speculative brake began at 4.45 s from 45.32 km/h, 1.4 s before
path ingress and 1.6 s before Normal's actual contact. The project continued
262.69 m to arrival in 52.7 s without contact; the longest observed standstill
was 0.6 s. Both drivers requested 120 km/h; their measured peaks were 62.98 km/h
for Normal and 59.22 km/h for the project. Finish was requested during export,
and all three checksummed MP4s decoded at both ends after verified engine exit.
These original critical-crossing/media gates precede the revision-17 audit of
every staged crossing origin. This remains historical evidence, not acceptance
of the later complete fixture.

Actual exported frames: [Normal contact](evidence/crossing-delivered-native-normal-end-collision-20261020.png),
[measured forecast](evidence/crossing-delivered-native-project-forecast-20261020.png),
[physical crossing](evidence/crossing-delivered-native-project-crossing-20261020.png),
[project arrival](evidence/crossing-delivered-native-project-end-arrived-20261020.png),
and [common front-camera detections](evidence/crossing-delivered-native-shared-front-detections-20261020.png).
Older files whose names include `crossing-final-native` belong to the exact
archived revision-14 controller and remain historical; the `delivered-native`
review above records the later source identity explicitly.

The [revision-17 native media review](evidence/crossing-verified-native-media-review-20261020.json)
records A with the project first, including the new scheduled-origin gate for
all nine crossing participants. Actual exported frames show [Normal's contact](evidence/crossing-verified-native-normal-contact-20261020.png),
[measured volumes and the selected risk](evidence/crossing-verified-native-project-forecast-20261020.png),
[the person crossing safely](evidence/crossing-verified-native-project-crossing-20261020.png),
[arrival](evidence/crossing-verified-native-project-arrival-20261020.png), and
[the verified front-camera prefix](evidence/crossing-verified-native-shared-front-detections-20261020.png).
These images and their source archives are identified by checksums in the review.

The optional detector setup downloads pinned official YOLOv8s source weights
and exports CPU ONNX locally. Its source SHA-256 is
`1f47a78bf100391c2a140b7ac73a1caae18c32779be7d310658112f7ac9aa78a`;
the runtime model hash is saved with every new comparison. Models remain ignored.
