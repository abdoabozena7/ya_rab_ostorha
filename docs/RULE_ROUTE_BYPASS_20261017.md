# Ordinary route bypass and automatic route population

The reported blockage had a real implementation gap: the ordinary Robosphere
route follower had forward RULE protection, but no admitted owner of a passing
maneuver. Enabling the entire experimental hybrid would also have enabled
capabilities that still lack native acceptance. This repair introduces a separate,
limited stationary-obstacle overlay around the existing route follower.

## Decision and execution

* Ordinary cruising and traffic signals retain their native route follower.
* A sustained measured stationary blockage prepares synchronized motion tracking
  and slows the vehicle before a maneuver. Missing Doppler can use a short
  ego-motion-compensated range history; missing/stale range cannot arm a pass.
* The limited owner can follow a verified route around a blockage, change into a
  legal same-direction lane, pass and return, or request the existing road-graph
  detour search around a sensor-measured obstruction. Reverse is disabled here.
* During the maneuver, a per-frame execution shield checks the actual proposed
  command, body footprint, stopping tail, current measured surrounding space,
  dynamic forecasts and driving-road geometry. Unknown space remains unknown.
  A denied maneuver holds and records its reason. No actor identity, evaluator
  fixture label or future scenario script enters the controller.
* Maneuvers target at most **2 m/s (7.2 km/h)**. This is separate from the ordinary
  requested cruise speed and Restart's 50 km/h request. Neither is a promise of
  measured speed. Return/handover restores the native route follower.
* Deployment requires the separate source-bound scoped report in
  [acceptance.json](evidence/route-bypass-20261016/acceptance.json).
  Full hybrid acceptance in `config/hybrid-driving.json` remains independent.

Several defects were found during live debugging: the slow three-second preview
was too short to decide whether a distant car belonged to the route; timed
lateral blending made the low-speed curve too sharp; recomputing that curve
every decision moved the target away. The repair uses a geometric route lookahead
and a committed spatial curve transformed using onboard odometry. A lost object
ID alone can no longer complete a pass. The ordinary overlay also retains a
target that becomes confirmed just after engagement, so a naturally avoiding
native route can hand control back after measured travel clears it.

A lane-level graph detour previously handed back control after only eight
metres, before clearing the blockage; the ordinary guard then stopped again.
Completion now requires clearance of the measured target instead. A separate
negative geometric check rejects an escape lane or graph route already known
to contain a stationary blockage farther than the short actuator preview. This
does not certify unknown space as free or replace dynamic/execution admission.

The retained front-radar teacher accepts one audited front mount. Its adapter now
selects that channel **before** retention/teacher evaluation when a surround rig
is present. The original observation, surround scene and recording retain every
channel. Historical teacher source bytes are unchanged.

## Automatic traffic and English feedback

Restart establishes its route before population placement. It requests up to
**40 native mixed vehicles on the route and 30 native pedestrians**. Cars use
safe road slots distributed from the nearby road to the destination; actual
capacity/spawn limits remain visible. Existing validated native sidewalk/navmesh
locations are ranked along the route ahead for pedestrians. People are not
fabricated in a driving lane, and native crossing behavior controls eligibility.
Both recorded arms continue to restore their recorded initial conditions.

Automatic setup compares the supported routes' native road capacity and chooses
the busier usable route. It admits the number of vehicles that CARLA actually
spawned, retaining requested/planned counts and any native shortfall. The initial
arm then waits for actual actor/controller readiness, rather than failing after
a fixed ten frames. Explicit manual road crowding keeps its strict count rule;
the restored comparison arm keeps its intentionally frozen walker controllers.

The English cockpit distinguishes startup measurement, preparation to pass,
passing, returning, and an actual execution-shield pause. Restart reports actual
population counts against its requests rather than implying all requested actors
were successfully spawned.

The first real Restart attempt exposed a setup failure: one unavailable vehicle
slot prevented admission even though 19 cars and 30 people existed. Its saved
failure led to the explicit native-capacity admission above. The next attempt
started with 27 cars and 30 people, including 12 cars and 20 people ahead, but
failed with `ControlSceneTimeout`: display work competed with the synchronized
control owner and decisions exceeded the existing 250 ms deadline.

The display observer now captures the exact measured scene under the same lock
as its observation and publishes a small measured view during a critical
maneuver. It skips duplicate scene construction, graph copying and supplementary
display scoring. Complete control forecasts and all freshness limits remain in
force. A 30-sample offline replay of the saved 37-track frame reduced median
display-copy cost from 13.50 ms to 0.25 ms; this is a component measurement, not
native timing acceptance. The cockpit also reports a stale/deadline control hold
as "Waiting for a fresh control frame" even when navigation owns the command.

## Verification and retained attempts

The reproducible native commands use `scripts.validate_hybrid_native` in
`ROBOSPHERE` mode with `RULE_BYPASS_LEFT`, `RULE_BYPASS_RIGHT`,
`RULE_BYPASS_OCCUPIED` and `RULE_BYPASS_RED_SIGNAL`. The parent disconnects the
ordinary backend, gives one child tick ownership, archives the exact source,
retains failed reports, restores signal settings and the operator session, and
checks continued ticking after restoration. These diagnostics use the existing
independent four-hour hybrid ledger, without resetting older allowances.

The user separately authorized a further **20 minutes** for the dense Restart,
recording and playback rehearsal. It uses an expiring RULE validation ticket;
the original four-hour ledger and all earlier failed attempts remain preserved.

`scripts.validate_rule_bypass` summarizes the retained reports and checks the
limited left/right passing, occupied-lane, traffic-stop and ordinary-resumption
gates. Arrival by itself does not prove a pass or restored cruising speed. The
compact report identifies raw report hashes, source archives and earlier failed
revisions; multi-gigabyte recordings remain ignored locally.

The final scoped cohort passed all five gates, with zero contacts and usable
measured scenes in every captured sample:

| Case | Native probe | Result |
| --- | --- | --- |
| Clear legal left lane | `867847ce2d094304be982dd42f9847b5` | Arrived after 63.07 m; 3.38 m lateral clearance; ordinary cruising resumed, peak 30.72 km/h; longest unexplained stop 1.55 s. |
| Clear legal right lane | `4da17b17b61045a68c13155ee6e3be85` | Arrived after 64.41 m; 3.51 m lateral clearance; ordinary cruising resumed, peak 30.74 km/h; longest unexplained stop 1.55 s. |
| Occupied escape lane | `a40de7155c96487fb6208e6e0176fbfb` | Held before the blockage for 14.5 s; lateral displacement 0.033 m. Holding is the expected result here, not a completed pass. |
| Frozen red signal | `736f63211f7b4c84ba72932edf754409` | Stopped at the red signal, including 241 stopped-red samples and a held final sample; no passing action. |

All actuation dependencies match those four source archives. One subsequent
display-only API correction adds the publication timestamp required by the
existing observer snapshot method. The evidence generator permits only that
exact single-line addition when comparing the display module: removing it must
reproduce the archived SHA-256; any other difference fails compatibility. The
exception is listed per case. Deployment still fingerprints the complete current
sources, including the display observer. The API/mutation regression and the
subsequent dense browser rehearsal exercise the corrected publication.

Offline verification: **126 JavaScript tests passed; 556 Python tests discovered,
555 passed and one optional dependency test skipped**. The dashboard bundle was
rebuilt. These checks do not establish native driving acceptance.

## Dense rehearsal: failed, retained, not accepted

The separately authorized rehearsal used one real browser Restart click, with
seed `320418473`, presentation `a021fce3370643a1bdab82bb4c6675d7`, and requested
50 km/h. Native setup admitted **24 vehicles and 30 pedestrians**, including
**10 vehicles and 27 pedestrians ahead**. It started the Robosphere recording
automatically. Earlier failed attempts also remain in
[presentations.json](evidence/route-bypass-20261016/presentations.json).

This run advanced **18.10 m in 146.05 simulation seconds**, with a measured peak
of **6.15 km/h** and zero contacts during its recorded arm. It repeatedly missed
control freshness and then stalled on a stationary rear-corner prediction. The
reported rejected FOLLOW and left-change candidates referenced track `383` near
`[-3.89, -2.52]` m in ego coordinates, with source `STATIONARY`, rather than a
classified person starting to cross. The predicted padded body intersection
still prevented a maneuver; this is a remaining recovery/geometry problem, not
proof that the object was safe to ignore.

A retained frame (`94927`) now has a compact, reproducible offline diagnostic:
`python -m scripts.replay_rule_rear_corner`. Its measured surface rectangles are
0.416 m apart, yet growth of the uncertainty envelope plus padding predicts a
held-pose intersection after 0.6 s. A separate left-change candidate is also
rejected for uncertain track `393`. This isolates an uncertainty/recovery
interaction; measured visible surfaces do not establish complete actor bounds.
See [rear-corner-replay.json](evidence/route-bypass-20261016/rear-corner-replay.json).

The attempt ultimately stopped with `ControlSceneTimeout` at frame `96705`:
"Current synchronized sensor scene unavailable for one second". The failed arm
finalized with **2,924 written frames, no dropped frames/events/trace rows**, and
an actual 146.10 s native camera MP4 whose SHA-256 was verified. **Normal did not
run, and paired export/playback was not verified.** A complete Restart is not
claimed. Subsequent surrounding traffic contacted the held ego after recording
closed; zero recorded contacts does not establish safe post-stop exposure.

The display repair removed duplicate work and some recent decisions met the
250 ms limit, but it did **not** establish the required 99% fresh-decision rate
under this load. No freshness limit or uncertain-space rule was relaxed.
The UI now names the synchronized-sensor timeout despite generic cleanup labels,
and distinguishes an admitted stationary rear-corner conflict from a moving
crossing. A stale-control hold takes precedence over that geometry message.
The brake percentage keeps the original sensor-timeout explanation after page
cleanup. A failed automatic presentation offers Restart; its camera overlay no
longer offers an ordinary Resume that could not preserve the comparison.

The real failure screen passed **13 browser checks**, including original
exception retention, finalized native video, the unexecuted Normal arm, English
recovery text, enabled Restart, and 1600/390 px layout. See
[failure-ui.json](evidence/route-bypass-20261016/failure-ui.json),
[desktop](evidence/route-bypass-20261016/route-bypass-native-failure-1600.png) and
[mobile](evidence/route-bypass-20261016/route-bypass-native-failure-390.png).
The verification does not fabricate a successful results/playback screen.

Remaining P0 work is to reproduce the rear-corner deadlock from its saved sensor
frame and compare physical clearance against the growing uncertainty envelope,
then profile dense control-stage tail latency. Both need a new native cohort
after a control change. Ordinary isolated passing is admitted only by its scoped
report; dense recovery, alternate-street completion, requested 50 km/h operation
and the full automatic comparison remain unaccepted. The original four-hour
ledger retains **138.16 s**; the separate 20-minute rehearsal was stopped before
expiry and did not increase that ledger. Detailed counts, budgets and original
fault are in [verification.json](evidence/route-bypass-20261016/verification.json).

This scoped verification does **not** establish full hybrid acceptance,
unrestricted dense-city autonomy, high-speed passing, reverse recovery or a
guaranteed alternate street when no legal forward graph route exists.
