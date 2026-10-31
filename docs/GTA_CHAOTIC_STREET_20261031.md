# GTA physical parking, motorcycles and road crossing — 31 October 2026

The owner's latest street-scene request passed a bounded native test in the
installed GTA V Enhanced. This establishes a scenario fixture; the production
provider, full required sensor qualification, moving-forecast accuracy, PPO
training/evaluation and CARLA/data retirement remain open.

## Actual observed result

| Measurement | Native result |
| --- | --- |
| Additional parked vehicles | 10, five per side; physical bodies, handbrakes; no freeze/invincibility commands |
| Traffic / on-foot walkers | 60 / 100 retained throughout the settled run; riders/drivers excluded from walkers |
| Designated nearby group | Six cars and four actual motorcycle models, initially left/right/rear and within 100 m; all moved more than 2 m |
| Parked geometric clearance | Minimum 3.17149 m, maximum 5.26819 m, versus actual ego model width 1.75871 m |
| Actual road crossing | All 24 designated crossers entered; 76 completed crossings in both directions |
| Conservative sampled road occupancy | 92.719 s; 99 assignments are not counted as completions |
| Retained failures inside the scene | Nine stalled crossing events; zero casualty events |
| Local congestion with traffic elsewhere | At 28.422 s, 15 previously moving vehicles queued / 17 slow nearby, while 29 moved in the distant zone |
| Real local YOLO through DirectML | 783 of 806 native RGB images; inference p95 90.917 ms; native snapshot to result p95 156 ms |
| Native ownership / cleanup | PID 30956, actual non-elevated token; owned job stopped, temporary files restored, protected inputs unchanged |

The ego was held under braking. Clearance describes parked model bounds, not
successful learned driving through the gap; moving traffic can obstruct it.
The reported 6.5 m road-membership band is a native proxy, not a pavement survey.
In population telemetry, `ego_spawn` is the road reference node; actual ego
position is recorded in `bridge.jsonl`. Road membership uses actual actor x/y,
the local native road-node height, and a 2.5 m vertical-layer guard. Internal
actor identities/positions serve scenario preparation and evaluation only;
the detector receives actual RGB, without actor truth.

## Inspectable evidence

- [Actual chronological video, 100.2 s / 1,002 decoded frames](evidence/gta_chaotic_street_20261031/chaotic-street-review.mp4)
- [Live game view](evidence/gta_chaotic_street_20261031/ui-chaotic-street-early.png), [later live view](evidence/gta_chaotic_street_20261031/ui-chaotic-street-late.png), [nine decoded video samples](evidence/gta_chaotic_street_20261031/video-contact-sheet.jpg)
- [Native result](evidence/gta_chaotic_street_20261031/sensor-result.json), [crossing events](evidence/gta_chaotic_street_20261031/crossings.jsonl), [actual parking bounds](evidence/gta_chaotic_street_20261031/parking.jsonl), [population/traffic samples](evidence/gta_chaotic_street_20261031/urban.jsonl)
- [Sealed contract](evidence/gta_chaotic_street_20261031/contract.json), [execution receipt](evidence/gta_chaotic_street_20261031/receipt.json), [same-agent review](evidence/gta_chaotic_street_20261031/review.json), [passing gate](evidence/gta_chaotic_street_20261031/gate.json), [curated hashes](evidence/gta_chaotic_street_20261031/curated-manifest.json)

The video selects the last available actual RGB image at each 100 ms wall-clock
timestamp; it does not interpolate future frames. Its full decode and transcode
hashes are retained. Raw RGB/depth, full ray scans, detections, protected-file
inventories and failed source snapshots remain local and ignored under
`integrations/gta/.runtime-proof/gta-chaos-crossing-20261031/`.

## Implementation and preserved failed attempts

`chaos_probe.cpp` builds this project's ASI with the installed compiler. It uses
local stock game assets, staggered curb parking, six slow local cars, four
motorcycles with physical drivers, and 24 timed walking tasks between opposite
pavements. Admission requires actual mid-road positions and opposite-side
arrivals, not task assignment. Stalls retry later without in-stage teleports.
The remaining walkers are distributed around the junction. A bad stop induces
a local queue while other controlled traffic continues away from it.

`chaos_probe.py` owns ordinary launch, bounded time/storage, single-owner command
lease, telemetry checks and cleanup. `chaos_vision.py` runs the existing local
YOLO ONNX on real RGB via the actual DirectML provider. It adds no game-driving
repository or replacement inference client. CV/tracking/Trajectron++ and the
independent safety architecture remain the parent design.

[Seven failed native attempts](evidence/gta_chaotic_street_20261031/failed-attempts.json)
are preserved: missed Story entry, collapsed/occupied local node placements,
overly restrictive straight-road selection, and insufficient unique extra
pavement spawns. Continuous local placements, native road checks and a wider
distribution of the extra walkers resolved the fixture. The attempted 84 m
straight-road eligibility check did not pass and is not claimed as verified.
The final actual view was inspected again after the successful measurements.

The final native run is `20261031T133526-19b148f020`; source digest
`c605b9156d5c328cafda646d2a04ddeefbf527b86aca7f8e0ba5f08e170abaac`.
Both TODOs and all three declared requirements passed the explicit Prove It gate
with `.venv-carla\Scripts\python.exe`. Review is same-agent, not independent.

## Limits and remaining admission

At this checkpoint the original GTA grant is charged **4,399.110 / 10,800 s**,
including failed native/model attempts; **6,400.890 s remain**. Downloads remain
**21,924,610 / 100,000,000 bytes**. No grant reset, additional weight download,
PPO training or CARLA/raw-data deletion occurred.

Software checks passed: **1,222 Python tests (four optional skips)**,
**70 GTA integration unit tests**, **221 JavaScript tests**, and
`npm run build:dashboard`. The build produced no frontend changes. These checks
do not substitute for native route/model acceptance.
These are shared-workspace results; pre-existing unrelated edits were preserved
outside this delivery commit. Evidence directories disable Git text conversion
so retained file hashes remain meaningful after checkout.

The earlier [full-field diagnostic](GTA_FIELD_MOTION_20261031.md) remains
unaccepted because some off-axis opaque reference intersections were missing.
That sensor gate, moving CV/forecast validation and actual provider/control
integration must be resolved before valid training. The 600–800 m route,
60-vehicle/100-walker driving density, three passes/returns and frozen held-out
model evaluation remain unverified. The original parent migration stays open.
