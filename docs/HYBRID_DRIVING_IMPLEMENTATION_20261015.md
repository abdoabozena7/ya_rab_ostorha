# Hybrid driving implementation — 15 October 2026

Status: **in progress; native behavioral acceptance has not passed**. The new
driver is disabled outside a live, separately charged validation reservation.
The requested Town10HD, 50 km/h and complete maneuver scope is retained. None of
those capabilities is promoted merely because software tests pass.

## Implemented structure

| Component | Implementation |
| --- | --- |
| Single behavior owner | `backend/core/hybrid_driver.py`: follow, slow, wait, bounded reverse, lane exit, pass/return, replan requests; no learned action selection |
| Shared measured scene | `backend/core/control_scene.py`: synchronized depth, LiDAR and ego measurements, immutable tracking publication; display/model forecasts run separately |
| Experimental velocity evidence | `backend/core/control_radar.py`: calibrated local Doppler rays, finite ego/sensor motion compensation, observable two-dimensional velocity fit; no actor queries or inferred unobservable direction |
| Execution veto | `backend/core/maneuver_candidates.py`: actual proposed pedals/steering, 100 ms lease, complete stopping tail, predicted bodies and measured space; map body coverage is additionally checked |
| Road geometry | `backend/carla/hybrid_navigation.py`, `backend/core/drivable_corridor.py`: declared speed units, exact topology endpoints, whole-body road coverage and direction |
| Native baseline | `CARLA_BEHAVIOR_NORMAL`: official BehaviorAgent normal, with its obstacle/pedestrian handling enabled; separate from legacy NORMAL |
| Matched starts | `backend/carla/benchmark_fixture.py`: retained actor identities, exact sensor settings, stationary starts, signal states/durations, clock and seed, with admission audits |
| Recording | Proposed/applied decision traces, rejected maneuvers, native camera bytes, original fault references and measured vehicle response |
| Video | `backend/core/driving_video.py`: checksummed driving-camera frames, MP4 export after recording closes, simulation timestamps anchored to admitted journey start |
| Discussion UI | Destination, requested speed, traffic preset, start, compare, stop and emergency acknowledgement; research controls remain in details |
| Admission | `config/hybrid-driving.json`, `backend/core/hybrid_config.py`, `backend/core/hybrid_acceptance.py`: all native gates and matching source fingerprint required |

Legacy NORMAL still applies the user's pedals, or follows its route and signals,
without obstacle intervention. User stops, emergency latching and connection
watchdogs remain active. The separate learned BC/HYBRID research controller is
historical and is not the new deterministic hybrid driver. No new weights were
trained for this implementation.

The 50 km/h request limit applies to the new HYBRID/BASELINE protocol. It does not
raise legacy journey limits or assert that 50 km/h is accepted. Deployment speed
and surround-rig acceptance remain zero/false until the required native evidence
passes. The default reverse lease remains 1 m/s, 2 m and 4 s.

## Defects reproduced during implementation

1. Material registration and visible box geometry had different centers. Reusing
   a registered anchor with newly measured half sizes invented occupied space in
   the driving lane. Tracking now keeps a motion anchor separately from the
   currently measured occupied bounds.
2. Connected surfaces longer than 7 m were discarded. A row of parked cars could
   merge, disappear from tracking and return as uncertain fragments. Enhanced
   tracking now retains bounded measured pieces in an odometry-fixed partition;
   legacy forward-only tracking retains its previous behavior.
3. Unnecessary lower-ranked candidate checks consumed the scene freshness lease
   after a better candidate had already passed. Candidates are checked in utility
   order, with an independent execution check retained for every native frame.
4. Uniform road samples omitted short tails at topology boundaries. Whole-body
   checks could accept the stopped pose and reject a 1 cm forward motion on a
   continuous road. Exact native topology boundaries supplement the samples.
5. A display observer expected default ego forecasts that the control pipeline
   no longer needed. Those forecasts are now generated in the display worker.
6. Restoring a dashboard before the diagnostic Python process exited left native
   TrafficManager lifetimes overlapping. Native diagnostics now run in a child
   process which exits before restoration, followed by a continued-ticking check.
7. Micrometre duplicate route endpoints implied a spurious sharp bend and a
   2.875 km/h cap on a straight road. Curvature now requires supported segments.
8. The dynamic conflict window ended at 3 s even when the complete stopping tail
   continued beyond it. Physical hypotheses and equal-time conflict checks now
   cover that complete tail. A truncated forecast refuses admission.
9. Semantic labels were associated after forecasts were generated. Control
   forecasts now use the associated labels, including distinct pedestrian
   start/retreat hypotheses, without waiting for inference in the tick thread.
10. An axis-aligned square around a bounded acceleration admitted an impossible
    faster diagonal approach. Uncertain reach now uses exact rectangle separation
    and a circular acceleration radius; the acceleration bound is unchanged.
11. Candidate previews could alter a provisional actuator integral, and a fixed
    startup pedal ceiling caused admitted movement to stall. Previews are pure;
    onboard response updates at native cadence while behavior retains its 100 ms
    lease. Longitudinal response coefficients remain provisional and unaccepted.
12. Identical geometric checks were repeated for the same immutable scene,
    command, path and road. A bounded per-scene proof cache reuses those
    calculations. Freshness is checked again at execution; changes to controls,
    frame, trajectory, road or traffic stop invalidate lookup.
13. Signal resets became visible on different ticks between comparison arms.
    Frozen starts are reasserted before ticking and independently audited after
    measurement. The ego pose and zero velocity are also checked.
14. Historical learned-controller identity leaked into deterministic HYBRID
    diagnostics. Its public policy identity is now distinct and explicitly
    records that learned control was not used.
15. The same synchronized sensor boundary was constructed twice per tick, and
    full dashboard JSON was serialized before the next control decision. History
    now shares the validated immutable observation; rich display serialization
    runs on snapshot requests outside the control lock.
16. Control/display aliases of the same forecasts were frozen into duplicate
    immutable copies. Per-publication identity memoization keeps one validated
    frozen object, rejects cycles, and preserves all numeric wire values.
    Bounded surface registration and cell deduplication now use equivalent
    batched/scalar-key calculations; numerical parity is independently tested.
17. During an automatic transmission shift, observed native gear zero could
    become an application command for manual Neutral in a protective hold or
    deceleration. These automatic commands now retain D/R selection. A regression
    reproduced the incorrect Neutral command before the fix. Native response
    after this change remains to be measured.
18. Navigation-origin hybrid braking could be displayed with the generic reason
    NAVIGATION. The original behavior decision now accompanies the applied brake;
    the dashboard distinguishes processing delay, unmeasured space, predicted
    conflict and controlled deceleration in plain language.
19. Exported MP4 URLs were blocked by the server's raw-recording restriction.
    The actual HTTP handler now exposes only the two declared video assets of
    a native recording, verifies the export hash, and streams byte ranges for
    seeking. Incomplete exports retain their errors. Playback follows the
    longer journey so the shorter video's ending cannot truncate it.

These fixes are individually reproduced or software-verified. Their combined
native acceptance remains a separate requirement.

## Evidence boundaries

Native reports and original assets are retained locally under
`output/hybrid-driving/probe-*`, `runs/normal_city/`, and the explicit diagnostic
recording disk `C:/Users/A-plus/.codex/native-evidence/ya_rab_ostorha/normal_city`.
Diagnostic journeys use their own result directory and do not overwrite the
operator's ordinary journey result index. Original files remain out of Git.

The diagnostic versions are different source revisions and cannot be aggregated
into the required 10/10 acceptance matrix. One earlier revision arrived after
59.47 m without contact, at a maximum 14.36 km/h for a 20 km/h request. Later
revisions reproduced long unexplained stops at road representation seams. The
source-frozen `ce586100feaf4d88b2085aae468bd304` diagnostic reached 18.69 km/h but
stopped after 60.83 m and failed arrival; its maximum unexplained stop was 35.2 s.
Zero recorded contact in those incomplete runs is not a successful crisis exit.

One zero-NPC pair at a 20 km/h request completed both arms with passing initial
condition audits (`2fc048ebb0554d06847d6b17203fc124`): BASELINE traveled 90.85 m
and HYBRID 88.19 m, with no recorded contact. HYBRID's largest unexplained stop
was 1.05 s, peak speed 19.25 km/h, and measured execution freshness 99.11%.
It sustained speed within 3 km/h of the request for only 2.20 s; the 5 s criterion
failed. This single pair does not establish performance in traffic or superiority.
Its camera MP4s both exported successfully with admitted-start time alignment.

A subsequent 20 km/h diagnostic (`b24362269e2847e1b97bfa9acc424441`) arrived after
109.31 m with a 1.10 s maximum stop and 99.53% execution freshness. Its sustained
speed criterion still failed. A 30 km/h diagnostic reached 30.97 km/h but stopped
for 6.10 s and did not arrive (`be566da3737f484799c0b327fb4936d5`). An additional
actuation revision also failed arrival. None of these changing-source runs is
part of a frozen 10/10 cohort.

The subsequent source-frozen 30 km/h diagnostic
`632a5cf78c5c4b6da32af9dde8e37532` remained incomplete after 162.81 m. Its peak
was 24.74 km/h, maximum stop 2.25 s and execution freshness 94.79%. It did not
sustain the requested speed. A prior batched-registration revision also failed
arrival after 148.61 m with 94.00% freshness. These failures are retained; the
later Neutral/immutable-publication fixes do not retroactively pass them.

Failed light phase audits remain failures. Graphics trials using Low/D3D12 and Low/D3D11 also
failed; missing native exception details are not replaced with an inferred cause.
Epic/D3D12 is the retained working renderer for diagnostics.

MP4 encoding has been exercised with actual native camera recordings. Isolated
browser rehearsals verified the simplified controls, comparison sequencing,
emergency acknowledgement, unavailable-capability gating and responsive layout.
Those rehearsals use labelled fixtures and do not establish driving behavior or
native performance while inference/display are active.
The latest isolated browser rehearsal passed 53 existing checks and 12 new
hybrid-flow checks without browser exceptions. It is explicitly labelled as a
synthetic UI fixture.
Three additional playback checks used the retained native camera exports from
the successful diagnostic pair: approximately 21.8 and 28.3 seconds in the browser.
The longer video continued playing after the shorter video ended. The dashboard
state in this playback rehearsal is synthetic; this is not another native drive.
The final rehearsal streamed through the production HTTP handler, with native
metadata/checksums and actual byte-range requests rather than mocked file URLs.

The current experimental rig has the original front sensors, four corner depth
cameras and four corner Doppler radars (16 sensor actors including collision and
the presentation camera). The added radars do not add render targets. Their
motion fusion remains uncalibrated and requires native static/moving-target and
crisis validation. Outside admitted/ticketed hybrid operation the original
eight-sensor rig is retained. Earlier diagnostic results used a different rig.

## Remaining acceptance work

- Measure execution-time freshness on at least 99% of decisions under the
  existing 100 ms simulation / 250 ms wall limits.
- Calibrate measured longitudinal, steering and gear response, and complete
  10/10 ordinary journeys including sustained requested speeds up to 50 km/h,
  curves, no contact and no unexplained stop over 3 s.
- Complete native reverse, lane change, pass/return and alternative-street
  journeys. Verify feasibility independently before computing the 90% recovery
  fraction; report fully blocked cases separately.
- Exercise all eight crisis classes with three frozen seeds, record interaction
  validity and full progress outcomes, and assess comfort outside emergencies.
- Complete matched initial-condition audits for both drivers, and measure
  throughput with display, inference and recording active.

The current corner rig still needs near-side coverage measurement and target
motion calibration. Matching measured stationary poses does not prove identical
hidden transmission/engine state between comparison arms. Scripted high-speed
crises must also verify actual interaction speed, rather than merely a 50 km/h
request. These limitations remain part of the missing acceptance work.

`backend/learning/hybrid_budget.py` owns the independent 14,400-second allowance.
Reservations are crash-charged until reconciled, and completed reservations are
settled to elapsed time. Older experiment ledgers are not reset or transferred.
The remaining allowance is a resource limit, not a readiness percentage.

Windows recorded system sleep from 03:51:25 to 09:27:53 UTC on 15 October. This
interrupted diagnostic `e4ecc75b25114bc6830bc98fb59ef111`; its incomplete arrival
cannot be attributed solely to the driver. The biased monotonic clock originally
charged 20,312.56 s for that reservation. The original charge is retained, with
an append-only exclusion of the proven 20,187.94 s sleep interval and hashes of
the raw power event and native report in
[the reconciliation](evidence/hybrid_driving/budget_sleep_reconciliation.json).
New budget settlement uses Windows working-state time. Control-ticket expiry
continues to use elapsed monotonic time, so sleep cannot revive an expired drive.
The API's exclusion of sleep is documented by
[Microsoft](https://learn.microsoft.com/en-us/windows/win32/api/realtimeapiset/nf-realtimeapiset-queryunbiasedinterrupttime).

## Verification and admission

`npm run build:dashboard` regenerates the checked-in assets. `npm test` passed
112 checks. The full Python run discovered 483 tests: 482 passed and one optional
test was skipped. These are software checks, separate from native admission.

`python -m scripts.evaluate_hybrid_readiness` publishes explicit failed/missing
native gates. Its current report is **0/11 gates accepted**, with accepted speed
zero. The missing frozen cohort is not replaced by the successful diagnostic
pair or browser fixtures. Invalid cases remain in gate evaluation and in the
failure list; they cannot silently disappear from the denominator.
