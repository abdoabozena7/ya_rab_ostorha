# Urban Chaos final rehearsal — 9 October 2026

The comparison was run through the real dashboard buttons on CARLA **0.9.16**, Town10HD_Opt, using the existing simulation worker as the sole tick owner. The machine reports an RTX 3060 Laptop GPU with 6 GB VRAM. Startup used `./Start-YA-RAB-OSTORHA.ps1`; the delivered setting is **Low / ClearNoon**. These are measured rehearsal results, not promised outcomes for every later run.

## Final complete comparison

Both runs admitted the same 40 traffic vehicles plus ego, 30 pedestrians, seven ego sensors, seed 2589, 0.05 s timestep, approximately 185 m native route, 20 km/h target and zero initial horizontal velocity. The compiled manifests, weather, BasicAgent research settings and hazard schedules matched. Native initial pose, rotation and velocity audits reported **zero maximum difference**, with matching blueprint identities. Actor IDs change on reset. Subsequent traffic trajectories can diverge after ego interventions.

| Actual measurement | WITHOUT SAFETY | WITH YA RAB OSTORHA |
|---|---:|---:|
| Controller | BasicAgent; protection disabled | BasicAgent + RULE |
| Ego collision | YES | NO recorded contact |
| Collision episodes / callbacks | 2 / 69 | 0 / 0 |
| Total native impulse | 23,135.712 N·s | 0 N·s |
| Peak native impulse | 9,072.834 N·s | 0 N·s |
| Route progress | 50.445 m | 114.326 m |
| Distance traveled | 53.236 m | 116.103 m |
| Minimum planar clearance | 0 m | 0.210 m |
| Intervention episodes | 0 | 8 |
| Simulation duration | 60.000 s | 60.000 s |
| Route fraction | 27.21% | 61.66% |
| End outcome | COLLISION | SAFE_PROGRESS |
| Completed experiment interval | YES | YES |

The protected vehicle resumed native navigation after the first hazard, then later held behind an obstacle. **SAFE_PROGRESS does not mean destination completion** or protection against every chaotic or lateral collision. Both experiment intervals reached their 60 s deadline; neither completed the full route. The collision arm stops ego navigation after a contact while the timed hazard scenario continues.

Recordings:

- WITHOUT: `runs/normal_city/run_5311ebe0ed9e42b6b4800495c6e5e6c2`
- WITH: `runs/normal_city/run_71b297ee49be4acb8aec16d3cb378661`

Each recording contains **1,202 complete synchronized frames and 3,606 checksummed sensor assets**. Native collision events and impulses, controls actually applied, RULE commands, hazard controls, the full initial manifest, measured progress and end reason were audited. There were **zero safety-command/application mismatches**. The existing replay reader and ReplayService successfully sought to the middle of each recording and returned the recorded camera. The full compact pair is saved at `output/presentation-demo/urban-comparison.json`; after startup it is explicitly labeled **Archived comparison** until a new pair is run.

Primary evidence: [native audit](evidence/urban_chaos/native.json) and [comparison snapshot](evidence/urban_chaos/comparison.json).

## Genuine hazard observations and limits

- Sudden braking and the cut-in occurred through native vehicle controls. The cut-in reached its target in both runs.
- The curb-ascent SUV physically reached the sidewalk in both runs. The returning SUV physically reentered the road at **43.15 s WITHOUT**, then became blocked during its forward merge. **WITH**, it reached the sidewalk but became blocked during its reverse exit; road reentry was not observed. No vehicle was teleported to manufacture a result.
- One scheduled pedestrian crossed and arrived on the opposite side in both runs. The other was observed on the road at 35.65 s and was lost by CARLA at 35.70 s. A background walker was also lost later. Those losses are recorded, and actors are not replaced during comparison. The post-run native inventory was 39 vehicles, 28 walkers, 28 walker controllers and seven sensors; admitted starts were 41/30/30/7. Counts shown in the UI follow the live inventory.
- After completion, a separate native observation confirmed all four scripted hazard cars held brake 1.0 and traveled zero additional distance over two simulation seconds. Completion freezes the comparison timer and outcome.

See [post-completion audit](evidence/urban_chaos/post-completion.json). Clearance is a planar CARLA bounding-box evaluation metric, not a claim about CV accuracy. Native impulse is a contact severity proxy, not injury severity.

## Acceptance checks

| Check | Result and evidence |
|---|---|
| Both real dashboard buttons | PASS; complete pair above |
| Matching reset | VERIFIED; full manifest and native pose audit |
| Switch while driving | PASS; previous recording ended with `switched`, previous actor/sensor IDs were absent, new admission was 41 vehicles / 30 walkers and zero initial interventions. [Switch audit](evidence/urban_chaos/switching-final.json) |
| Stop / Reset | PASS; PAUSED / IDLE, RULE ON, zero interventions, stopped recording, zero ego speed, 41/30/30/7, no prior actor IDs. [Reset audit](evidence/urban_chaos/stop-reset.json) |
| Clean PowerShell startup | PASS; populated moving city near ego, stopped ego, ClearNoon, Low, seven sensors. [Startup audit](evidence/urban_chaos/startup.json) |
| Manual driving | PASS; 5.898 m native motion, maximum 7.329 km/h, MANUAL / SAFETY control sources |
| Ordinary destination journey | PASS; ARRIVED after 30.605 m, maximum 15.783 km/h; ordinary BasicAgent hazard checks retained. [Driving audit](evidence/urban_chaos/driving.json) |
| Validated Front Obstacle | PASS using production backend script; WITHOUT collision at 3.8 s / 16.214 m progress; WITH no contact / 28.005 m / four interventions / 14 s, with resumed progress. Recording and replay PASS. [Legacy audit](evidence/urban_chaos/legacy.json) |
| Dashboard accuracy | PASS; real controller, safety, reason, actual controls and measured outcome; archived results explicitly labeled |
| Screen layout | PASS at CSS 1366×768 and 1920×1080; no page overflow; Setup has internal scrolling, main camera and comparison buttons remain visible. Keyboard phase navigation PASS. [Layout audit](evidence/urban_chaos/responsive.json) |
| Product/course separation | PASS; Project Modules and course tabs removed. Actual implementation remains in four source folders with English READMEs |
| Regression checks | 212 Python tests run: 211 passed, one inapplicable native-absence check skipped; 25 JavaScript tests passed; bundle built; Git whitespace check passed |

## Actual graphics verification

| Preset | Actual result |
|---|---|
| Low | PASS: native Low, render 1280×720, RGB 640×360, depth 640×360, postprocessing off, blur zero, seven sensors |
| Balanced | PASS: native Low, render 1600×900, RGB 800×450, depth 640×360, postprocessing off, blur zero, seven sensors |
| High | Requested Epic / 1280×720; native world readiness failed after 90 s. **Rollback PASS** to previously working Balanced, with native camera and seven sensors verified |
| Ultra | Requested Epic / 1920×1080; native world readiness failed after 90 s. **Rollback PASS** to Balanced. CARLA's crash context recorded an access violation; the underlying cause was not established |

All four choices remain available. There is no automatic downgrade based on load. Use **Low or Balanced for this machine's presentation**; High and Ultra were tested but are not validated as working here. Evidence: `graphics-low.json`, `graphics-balanced.json`, `graphics-high.json`, `graphics-ultra.json`, and `graphics-ultra-crash.json` under `docs/evidence/urban_chaos/`. The final startup returned to Low and ClearNoon.

## Lightweight processing

The existing Nano weights were exported once to ONNX 320. Live inference uses CPU, one thread, at most 20 road-class detections and approximately one admitted image per second. English generation-2 OCR recognizes at most two candidate crops every three seconds without CRAFT or Arabic model loading. The latest-image worker runs independently of the UI phase; immutable frame tokens and timestamps keep overlays attached to their source image. Its cache remained bounded to four JPEGs; expired files from previous worker sessions are cleaned at startup. [Live audit](evidence/urban_chaos/perception-live.json).

Three identical recorded native images were measured offline:

| Median | Previous pipeline | Lightweight pipeline |
|---|---:|---:|
| Detection wall time | 29.859 ms | 31.893 ms |
| OCR wall time | 725.287 ms | 186.450 ms |
| Combined process CPU time | 5,187.500 ms | 218.750 ms |

OCR and total process CPU demand decreased in these samples; detection wall time did **not** improve. This is a small measurement, not a general benchmark or an accuracy equivalence claim. None of these sample images produced confident OCR text. NLP uses deterministic cleanup, tokenization and instruction extraction; it is not an LLM or a trained language model. The frozen 4,611-parameter supervised NumPy model and experimental RL remain separate from the RULE comparison. No training or CUDA inference was introduced. See [old measurements](evidence/urban_chaos/perception-old.json) and [new measurements](evidence/urban_chaos/perception-new.json).

## Presentation files

Use [the English presentation guide](URBAN_CHAOS_PRESENTATION.md) for the exact live sequence. Discuss courses by opening the actual source folders and READMEs in the editor:

- [Computer Vision](../backend/computer_vision/README.md)
- [NLP](../backend/nlp/README.md)
- [Learning](../backend/learning/README.md)
- [Signals](../backend/signals/README.md)

Final interface captures are `dashboard-1366.jpg`, `dashboard-1920.jpg` and `results-1366.jpg` in the evidence folder. `rule-intervention.jpg` preserves the real braking moment from the complete pair before the final course-UI removal; the newer screenshots show the delivered integrated product.
