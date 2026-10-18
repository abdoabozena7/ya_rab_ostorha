# Guided simulator — 18 October 2026

## State and copy contract

The guided session is a mission: a quiet dark surface, a large complete driving
image, one current action, and a small Menu. The opening preview is a labelled
retained native image, never a live camera. A short screen entrance, a brief
stage crossfade and menu reveal respect reduced motion and add no WebGL work.

| State | Purpose and next action |
| --- | --- |
| Stopped | Preview; **Start simulation** only starts CARLA. |
| Starting | Actual launcher, camera and session readiness; no progress percent. |
| Choose | “Would you like to see the problem or the solution first?” Choose Normal or RULE protection, then explicitly start. |
| STOPPING / PREPARING / READY / STARTING | Hold, construct, verify and record. No unavailable action. |
| DRIVING, arm 0 | Observe the current mode; **See the solution now** or **See the problem now** stops and saves before restoring. |
| FINALIZING | Wait for measured standstill and recorder closure. |
| AWAITING_NEXT | First outcome, distance and contacts; explicitly start the other mode. |
| RESTORING / RECOVERING | Rebuild and verify the same initial description. |
| DRIVING, arm 1 | **End drive & compare** safely saves a shortened attempt. |
| RESULTS | Actual outcomes immediately; **Finish**. Video export is independent. |
| Releasing GPU | Save/close, stop engine, verify process exit, return to opening. |
| ERROR | Keep outcomes; retry the failed setup/restoration step or release GPU. |

Emergency stop is always separate during connected operation. Menu contains
settings, diagnostics and saved results. Problem/solution describes the two
protection modes; it promises neither a collision nor its prevention.

## Protocol

`presentation {operation: START_GUIDED, first_mode, scene, seed?, speed_kmh?}`
starts version 4. `scene` is `BUSY_ROUTE` or `DENSE_CHAOS`.
`NEXT` carries `id`, `expected_arm`, `expected_phase`. One request per arm is
consumed under the service lock. A delayed DRIVING request may still be accepted
after that same arm reaches FINALIZING/AWAITING_NEXT; it cannot consume arm 1.
`RETRY_STEP` carries the current id and ERROR phase. `FINISH` closes RESULTS.
Legacy RESTART and version 1–3 comparison files keep their original meaning.

Only the simulation worker prepares native state. Free GPU cancels presentation
intent before shutdown. Obsolete queued restoration/start completions must not
rearm a cancelled presentation. Shortened, collision, interrupted and arrived
outcomes retain separate meanings. Initial matching proves a configuration,
never identical reactive futures.

## Reconstructable starting scene

Guided pairs use comparison version **4** and fixture version **2**. The saved
description includes the map, route, destination, stationary ego pose, weather,
signals and durations, sensor calibration and camera settings, clock, population
seed, blueprint attributes, driver profiles, pedestrian destinations/speeds and
relative wait schedules. Each participant has a stable role. Native IDs are
bindings and are excluded from the description hash.

The worker returns the stopped ego to its saved start before rebuilding owned
participants. CARLA admits replacement actors above the road; they are held and
placed at the exact saved pose before the fresh-frame audit and camera release.
This happens only in preparation. Live stress motion uses physics and native
controls, with no actor relocation during the recorded drive. Missing actors
and failed construction retain the first outcome and expose restoration retry.
An occupied or mismatched start is rejected, not silently moved to a nearby one.

Legacy automatic RESTART still records Robosphere then Normal and waits for its
video playback acknowledgement. Existing comparison versions 1–3 are read as
saved; they are not migrated or rewritten. Guided results are ready after the
vehicle stops and the recorder closes. Encoder failure cannot erase a run or
start another arm. Optional playback and downloads remain in Menu → Results,
with Back to drive returning to the same current mission.

## Dense Chaos

The independent preset requests **40 native vehicles and 50 native pedestrians**.
It reuses the ordinary population manager's independent routes, side-road and
surrounding placement, full Traffic Manager physics, seeded compliance/lane
change profiles and crossing eligibility. A saved physical stress plan requests
a cut-in, sudden braking and an opposing-lane intrusion where native topology
supports it. The existing physical waypoint follower drives the latter; no
experimental ego policy, training or forced ego collision is enabled.

Initial admission requires actual counts, at least 15 vehicles / 20 walkers
within 120 m, at least 5 vehicles / 4 walkers in the forward 100 m viewing cone,
and observed displacement there for at least 3 vehicles / 2 walkers. Counts
describe geometry, **not an occlusion-tested visible-object count**. Camera
review remains necessary. Requested totals and measured totals are distinct.

Per-arm checks run once per simulation second. Their displacement baselines
reset after native IDs change; the first sample is unmeasured motion, not zero
motion. Rolling failure counts retain a density or motion failure even if a
later sample recovers. The final and saved-result screens expose those failures.
The stress preset is implemented; sustained density, complete maneuver diversity
and driving-quality acceptance remain separate gates.

## Executed verification

- Dashboard JavaScript and CSS regenerated. **150 JavaScript tests pass**.
- Python discovers **623 tests: 621 pass, two optional tests skip**.
- **15 browser checks** pass, covering explicit start/transition commands,
  recorded contact metrics, export-independent results, optional result review,
  keyboard focus, expanded-camera controls, six preparation phases, restoration
  retry and GPU release.
- Camera containment, action reachability and no horizontal overflow checked at
  1920×1080, 1280×720, 850×600 and 390×740. Scrolling is available; the header keeps
  Menu and Emergency stop reachable. Reduced motion is supported. The smaller
  desktop viewport tests a zoom-equivalent layout, not native browser zoom.
- Offline regressions cover both orders, arrival, shortened/contact/technical
  endings, duplicate/stale transitions, old preparation completion/error,
  recorder closure, cancelled late restoration, export errors and retained
  legacy behavior. They do not count as native fault injection.

Native CARLA 0.9.16 verification used the production backend as the sole tick
owner, the actual browser and the production protocol:

| Probe | Observed result |
| --- | --- |
| Normal first, Busy route | Normal ended with one contact after 71.86 m. The interface waited for explicit continuation. Protected was shortened after 19.40 m, zero contacts. Both initial-condition audits passed and `conditions_match=true`. |
| Protected first, Dense Chaos | Actual 40/50 admission; protected was shortened after 32.33 m and Normal after 63.13 m, each with zero contacts. Both starting audits passed. Windowed motion was measured in both arms. Local density failed in 9/13 and 8/13 checks respectively. This is not a completed-route acceptance. |
| Start → drive → Free GPU → start again | Multiple actual cycles produced new native session IDs and a stopped opening screen; saved comparisons remained available. |
| NEXT racing Free GPU | Final protocol probe admits shutdown before closing its socket. Only the Normal recording exists; the second arm never starts. CARLA reports `process_exited=true`; independent native process inventory is empty. |

The following failed iterations are deliberately retained:

1. Native spawn checks rejected a settled tire pose. Fixed by admission above
   the road followed by exact held placement, with unchanged matching tolerances.
2. The stopped ego occupied a participant's saved start in Dense Chaos. Fixed
   by restoring the ego before participant reconstruction.
3. The initial stress auditor reused old native IDs after reconstruction,
   producing invalid zero-motion counts in the second arm. Fixed by resetting
   each arm's baseline and measuring displacement in a fresh one-second window.
   A subsequent velocity-proxy probe rejected the setup with zero reported
   walker velocity; that rejection is retained too. The final auditor uses
   measured positions for both participant types. Failed measurements remain
   evidence, not driving results. Rolling failures survive subsequent recovery.
4. The first cancellation verifier closed its socket before its unread GPU
   request was admitted. It measured a client disconnect instead of GPU release.
   The corrected verifier waits for STOPPING; the failed harness report remains.

The native stress probes have real nearby moving participants, including an
observed opposing-lane entry in a revised probe. A requested cut-in is not proof
of a completed cut-in, and full signal-violation diversity remains unaccepted.
Local density fell below the target in retained probes; these failures are
shown and must not be promoted to full stress acceptance. No freshness limit,
command age, RULE protection algorithm or safety threshold was relaxed.

No new native arrival/comfort/detector acceptance or new-user comprehension
study is claimed. Slow real startup and real GPU lifecycle were exercised;
several error/reordering cases remain offline verification. The existing driving
acceptance limits in earlier reports remain in force.

## Evidence and reproduction

[Compact verification, source hashes, actual metrics and retained failures](evidence/guided-simulator-20261018/verification.json)
links the ignored local recordings and source archives. Screenshots distinguish
[the actual stopped simulator](evidence/guided-simulator-20261018/stopped-native.png),
[actual Dense Chaos driving](evidence/guided-simulator-20261018/dense-native.png),
[an intermediate native result screen](evidence/guided-simulator-20261018/dense-results-native.png)
and [the isolated mobile UI fixture](evidence/guided-simulator-20261018/driving-390-fixture.png).
The [final saved native results](evidence/guided-simulator-20261018/dense-final-saved-results-native.png)
show the local-density failures and rolling check counts while CARLA is stopped.
Raw runs, scratch output, local preferences and virtual environments are not
committed. The new preview is a labelled, unchanged native RGB frame; its origin
is recorded in `public/assets/ATTRIBUTION.md`.

```powershell
npm run build:dashboard
npm test
.\.venv-carla\Scripts\python.exe -m unittest discover -s tests -p 'test_*.py'

# Explicitly authorized native verification only, with the local dashboard stopped:
.\.venv-carla\Scripts\python.exe -m scripts.verify_guided_native_lifecycle --output output/guided-native-new/race
.\.venv-carla\Scripts\python.exe -m scripts.verify_guided_dense_native --output output/guided-native-new/dense
```

The native scripts never tick CARLA directly and refuse an already connected
session. The isolated UI scripts use HTTP 8016 and an intercepted WebSocket on
8017; they require the retained observed state/catalog fixture in ignored
`output/guided-ui-20261018/`. `scripts/summarize_guided_simulator.py` rebuilds this
delivery's compact report from the retained local probe files.
