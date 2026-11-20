# Egyptian neighborhood

The current public game incorporates these physically narrow streets, named
destinations and traffic behaviors into [one connected City](../README.md#one-connected-city).
From the default avenue start, choose **الفرن البلدي** on the Phone to drive
through both street types. The standalone district described below is a
legacy replay and development fixture, not a second public environment.

The district extends the standalone Three.js game. It does not start CARLA,
GTA or another external simulator, download a model, or replace the original
city. The SUV, articulated people, local camera worker and independent safety
guard remain the existing game components.

## Legacy district workflow and fixtures

Older district recordings can still be imported from Settings and use their
original roads, stops, spawn capacity and Phone destinations. **Return to city**
restores the saved City rather than generating a replacement. The separate
district verification tools cover that historical profile, not the current
unified City.

The normal district uses the configured population. Selecting an isolated
encounter is an explicitly different workload: its actual traffic/person
counts appear in the HUD. Those clean camera experiments are not substituted
for default-population performance measurements.

Choose the encounter before editing its seed, then apply the settings.
Changing encounters immediately resets that district using its applied
settings; it does not apply an unsaved seed draft.

**Run encounter** explicitly starts the installed camera worker when the
camera-first driver is selected, waits for a new matching observation and
records a run event. Opening the district or raw Camera view alone does not
silently start inference. Reset recreates only the district. The same layout
version, seed, recorded observations and commands are required for replay.
The district saves compact JSON and can reload recordings up to 16 MB, so a
long drive can retain its observations and commands without sampling them down.
Other environments keep their existing 2 MB import limit.

The Camera and People workspaces retain their separate authorities:

- **Camera:** actual source JPEG, detector findings, observed motion, uncertainty
  and fitted forecast with exact stream/frame identity.
- **People:** World-reference body/motion inspection, never evidence supplied
  to the detector or prediction policy.

## What the speed reasons mean

The applied record is computed after independent safety arbitration. A request
to slow is not itself proof that it was the cause of the final vehicle speed.

| Source | Meaning |
| --- | --- |
| `camera-pixels` | A fresh actual pixel-derived observation/track supports the visual speed cap. It does not reveal a person's private intention. |
| `static-map` | A registered fixed blind-corner prior or road constraint calls for caution. This is not a camera measurement and cannot depend on a hidden person. |
| `both` | Camera and map caps tie; the result is not attributed exclusively to vision. |
| `behavior` | Following, queueing, merging or passage priority limits the command. Actor knowledge here is game traffic logic, not perception. |
| `requested` | No stricter source currently reduces the ordinary driving request. |
| `physical-guard` | The independent collision/clearance guard imposes a stricter command. It retains full emergency braking and is not relabeled a predictive success. |

Map corner caution has explicit approach/heading/lateral bounds and a positive
travel-speed floor; it does not invent an unseen pedestrian or hold everyone
forever. A fully hidden person with no visual cue cannot be predicted as a
confirmed crossing. The same static geometry with and without that person
must produce the same map caution.

Visual slowing uses resolved observed motion and the available stopping time
and distance, not a percentage of a possibly already limited speed request.
Localization covariance is projected onto the vehicle's lateral and forward
axes. Two points fitting a line exactly do not establish reliable motion when
their displacement is smaller than the measurement error. Object-class
confidence is not confidence in a person's intention.

Ordinary slowing is distinct from a genuinely qualified visual stop. The
existing stop commitment is preserved: risk reduction caused by braking does
not by itself mean the road is clear. Missing or older-than-750ms visual
evidence is unavailable, not a renewed confident observation. The explicit
camera-first autonomous mode uses a conservative stop/recovery policy; the
baseline arm keeps the same map caution and independent safety, without
claiming a camera decision.
The tracker can retain older samples to associate a person across frames,
but fits the district's actionable motion only from observations within the
750 ms freshness window.
Vehicle-view caution uses the latest observation of that vehicle rather than
an older motion window. An expired pedestrian stop still requires positive
clearance: while stopped, the district can use a fresh, later observation of
the same track. Expiry or a missing track does not clear the stop.

## Physical and behavioral boundaries

The road profile is shared by rendering, navigation and body-clearance checks.
One-way roads and narrow single-lane passages are actual route constraints,
not signs over an unchanged two-way path. The unchanged SUV footprint, steering
and swept-body checks determine whether a route is traversable.

Pedestrians keep their grounded, distance-linked articulated rigs and bounded
ordinary motion. Seeded hesitation, crossing and queue events are world-side
behavior. They are never transported as future paths, scenario labels or
perfect actor identities to visual inference.

An occupied passage reservation is not expired merely to let conflicting
traffic enter. Holds need an observable owner/blocker and actual progress.
New ambient traffic trips account for demand at both mouths of the shared
passage. They prefer a legal alternative when the passage already has
committed traffic, and retain a reachable destination when no alternative
exists. A queue detour cannot add another visit to the same reserved passage.
Actors are not teleported, deleted or respawned to create a successful route.
Unsupported density, unreachable goals and unsupported replay layout versions
fail explicitly rather than silently dropping actors or changing the route.

## Verification

Use the existing dependencies and build command:

```powershell
npm run build:dashboard
npm test
python -S -m unittest discover -s tests -p 'test_threejs_*.py' -v
node tools\verify-legacy-district.mjs
python scripts\verify_egypt_district.py --core
python scripts\verify_egypt_district.py --browser
python scripts\verify_egypt_district.py --cases
python scripts\verify_egypt_district.py --negative-control
python scripts\verify_egypt_district.py --prior-product
```

The negative control intentionally returns exit code 3 after detecting the
injected fault and observing the required explicit failure/recovery. The route
evaluator uses the actual offline World/vehicle plant; it is not live camera
inference. The browser cases execute actual rendered JPEGs and the installed
local model. Requested scenario labels or state changes alone do not prove
that a person crossed, the car stopped or a destination was reached.

Debug against development seeds before using the locked acceptance seeds:

```powershell
node tools\evaluate-egypt-district.mjs --development
$env:DISTRICT_DEVELOPMENT_ALL = "1"
python scripts\verify_egypt_district.py --case-checkpoint
Remove-Item Env:\DISTRICT_DEVELOPMENT_ALL
```

The development case checkpoint then exercises all twelve families and their
same-map causal controls on `district-dev-a`. Without that flag it runs only
the two mirrored visible crossings. Neither mode substitutes for the full
three-seed acceptance matrix or changes its thresholds. Save each run in a
fresh `PROVE_IT_OUTPUT_DIR` so failed attempts remain available.

For a bounded diagnostic, set `DISTRICT_DEVELOPMENT_CASES` to a comma-separated
list of exact family IDs instead of `DISTRICT_DEVELOPMENT_ALL`. The report
explicitly identifies partial development coverage. This selector is rejected
by the full `--cases` acceptance run; it never replaces the complete matrix.

Measured acceptance is finite and source/profile-qualified. It does not
certify public-road driving, force-calibrated human/vehicle physics, universal
intention recognition or zero real-world false positives. See
[the visual data boundary](VISION_FIRST.md) and
[portable versus native-only features](GAME_CORE_FEATURES.md).
