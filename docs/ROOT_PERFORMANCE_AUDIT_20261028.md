# Root performance audit - 28 October 2026

## Status and scope

**ROOT GOAL: OPEN / NOT ACCEPTED.** The
[parent checklist](../ROOT_GOAL.md) is not closed by this report or by the
successful RULE smoke.

This investigation used **retained native recordings**, source inspection,
bounded offline profiling and a same-input inference comparison. **No new CARLA
run, ticket, budget extension, provider-default switch or driving-policy change
was made.** All native improvement claims remain **UNVERIFIED**.

The original completion request was reconstructed from its retained text and
the current scenario/evaluator contracts. It requires the complete Egypt
diagnostic/development/holdout/browser/delivery sequence. VLM integration,
new RL training, new maps and `PERFORMANCE_60` validation were explicitly
separate future work. They have not been added as new Egypt acceptance gates.

The 94.495 m, zero-contact smoke remains a valid **scoped child**. It is not a
600-800 m Egypt route, three completed overtakes/returns, a Normal comparison,
multi-scenario acceptance or real-time acceptance. Applying the unchanged Egypt
evaluators to that actual child, and to an isolated label-only altered copy,
correctly rejects both.

## Evidence and accounting

The primary corpus is the
[recording](../runs/normal_city/run_29798332bb19460fb233005b637c5d5d) and its
[original native capture](../.runtime-proof/rule-native-smoke-20261028/runs/native-smoke/20261028T163751-bcaae98dca).
These local, ignored artifacts are not included in a fresh clone.

- Base commit: `fcd12e5f5882c9f5a420ee753331744fce09c7de`.
- Driving fingerprint: `a7ece445d9eab71d4328f08bb1b25e245499eb39539461b573646271b3777933`.
- Preserved smoke proof digest: `b654bf9e30c0432bfb1c8bc89e6ba1c70952487754ba0b997e36d6f1d3569df9`.
- 1,094 submitted controls and 1,094 subsequent control observations.
- All 1,093 adjacent command cycles have ordered, nonoverlapping boundaries.
- All 1,094 control latencies remain included: no unmeasured, unaligned or
  over-250 ms samples were omitted.
- Sensor metadata contains 1,094 frames. Of these, 1,093 join exactly to their
  corresponding control-source timing records with no clock mismatch.
  Boundary frame 1217 has no following source-frame command in that recording;
  source frame 123 precedes the recorded frame index. These edges are disclosed,
  not silently dropped from the independent full-control audit.
- Original input, child-gate and protected-ledger hashes were checked before
  and after each offline check. They were not rewritten.

## 1. The dashboard is mostly following a slow producer

| Quantity | Actual retained measurement | What it means |
| --- | --- | --- |
| Configured LEGACY physics/decision/capture rate | 20 Hz | Requested simulation-time cadence, not wall throughput |
| Native physics observations | **7.7834 ticks/wall s** | 1,093 native frame advances over 140.4266 wall s |
| Independent HTTP observer cross-check | **7.7778 ticks/wall s** | Frame-ID advance, not the observer's 1.8124 polls/s |
| Command submission cadence | **7.7835/wall s** | Separate from renderer FPS |
| Reported decision-rate samples | Median **7.97 Hz**, mean 7.76 | Rolling, correlated measurements |
| Native real-time factor | **0.38917** | 54.6500 simulation s / 140.4266 wall s |
| Distinct dashboard images | **6.7 and 6.5 FPS** | Two complete ten-second presentation windows |
| Unreal renderer FPS | **Unmeasured** | Not inferred from physics, sensors, GPU load or video |

The existing [LEGACY meter](../frontend/camera-performance.js) requires
**>=15 distinct FPS**, **simulation/wall ratio >=0.9** and
**maximum gap <=250 ms**. Both windows failed. Their ratios were approximately
0.336 and 0.327; maximum gaps were 361.1 and 243.2 ms respectively.
This is not merely failure to meet the separate 60 Hz profile.

Aligning browser observations to the same native frame spans strengthens the
diagnosis:

| Native frame span | Native producer | Browser presentations | Presented/native frame advances |
| --- | --- | --- | --- |
| 143-215 | 6.701/wall s | 6.581/wall s | 71/72, **98.6%** |
| 215-283 | 6.525/wall s | 6.540/wall s | 68/68, **100%** |

These are endpoint-aligned spans, not identical boundaries to the ten-second
windows. They do not prove zero UI overhead, but they **do not support a primary
dashboard-renderer bottleneck**. Faster CSS/RAF or repeating the same image
cannot manufacture missing native frames. The original meter rejects duplicate
frame/time identities.

## 2. Most cycle time is before scene construction

Mean command-to-command cycle: **128.48 ms**; median 122.86 ms; p95 182.77 ms.
This is a different interval from sensor-receipt-to-application-check latency.

| Disjoint cycle portion | Mean ms | Share of accounted wall time |
| --- | ---: | ---: |
| Previous control RPC | 0.53 | 0.4% |
| RPC return to next first required sensor receipt | **46.74** | **36.4%** |
| First required receipt to complete sensor set | **44.30** | **34.5%** |
| Complete frame to scene-build start | 0.43 | 0.3% |
| Scene construction, inclusive of prediction | 18.35 | 14.3% |
| Published scene to application check | 18.09 | 14.1% |
| Application check to RPC | 0.03 | <0.1% |

Approximately **71%** is upstream of scene construction. The first large
portion includes post-application work, housekeeping, native advancement and
delivery; it is **not a GPU-only timer**.

The required-sensor portion can be further resolved:

- Receipt spread: mean **38.56 ms**, median 38.13 ms.
- Residual encoding tail after the last receipt: mean **5.32 ms**.
- Encoded-set to synchronization completion: mean **0.44 ms**.

The **depth camera is last to arrive in 1,077/1,094 frames (98.4%)**, and last
to finish encoding in 1,052 frames. Its mean receipt time is **70.10 ms after
the native tick request**, or **38.52 ms after the first required sensor**.
Front RGB arrives at mean 57.96 ms after tick request. Radar/LiDAR/IMU/GNSS
arrive around 31.6-33.1 ms.

This locates the dominant waiting boundary at native advancement and delivery
of the required camera/depth data. **It does not isolate Unreal game-thread
work, rendering/readback, networking, Python callback scheduling or paging.**
The captured clocks are host receipt/tick-request clocks, not GPU timestamps.
Those internal causes need controlled native profiling.

The [provider timers](../backend/carla/provider.py) separately sampled native
tick wall time at mean **40.47 ms**. Do not add this to the disjoint table:
it can overlap early sensor receipts, and its sample population differs.
`population` is already inside `before_native`; prediction is already inside
scene construction.

### Why the freshness pass is not a throughput pass

All-submission receipt-to-application-check timing was:
median 77.15 ms, p95 **120.87 ms**, p99 **161.04 ms**, max **243.66 ms**.
Those satisfy the scoped timing bounds but do not make a 128.48 ms full cycle
real-time. At the recorded 0.05 s physics step, RTF >=0.9 requires approximately
**18 native ticks/s**, or a roughly **55.6 ms** steady-state cycle.

Even hypothetically removing all scene construction would leave roughly
110 ms per cycle, still far short. That is a diagnostic bound, **not permission
to remove safety or scene processing**.

## 3. CPU, perception and encoding are distinct contributors

Distinct recorded process-counter samples showed:

| Process/counter | Median | Interpretation |
| --- | ---: | --- |
| Backend CPU, one-core scale | 99.58% | About one core of process CPU; not proof of which thread/GIL section |
| CARLA CPU, one-core scale | 193.97% | About 1.94 cores |
| Perception CPU, one-core scale | 232.92% | About 2.33 cores |
| Total system CPU | 47.62% of 16 logical CPUs | Shared-host measurement, not full-machine CPU saturation |

YOLO produced 268 distinct packets at **1.892 Hz**. Detector time was median
**391 ms**, mean 408.37 ms, p95 485 ms. At recording, labels were typically
five frames / **0.25 simulation seconds** behind; this is semantic-cache age,
not the current geometry/control scene's wall-age measurement.

The [perception worker](../backend/computer_vision/worker.py) is a separate
process. [The cache](../backend/computer_vision/service.py) publishes its latest
result; [scene construction](../backend/core/service.py) does not wait for a new
inference call on every decision. Treating 408 ms as a serial per-decision stage
would contradict the observed 7.78 decisions/commands per second. CPU contention
and semantic freshness can still matter and need separate measurement.

JPEG queues were not saturated: median queue waits approximately 0.10/0.12 ms,
maximum pending count one, and no encoder failures/drops. Front/driving encoding
wall times were mean 11.16/5.78 ms, but much overlaps sensor production; only
the residual tail belongs in the disjoint budget. Transport recorded zero
expired-image drops or acknowledgement timeouts. The recording finalized with
zero dropped frames/events/traces.

These observations do not exclude serialization/GIL or writer CPU costs merely
because queues stayed short.

## 4. High VRAM is a resource problem, not an established FPS cause

All 27 NVIDIA samples exceeded the unchanged 4,608 MiB target:
**5,880-5,931 / 6,144 MiB** used; device utilization **1-58%**, median 31%.
WDDM separately attributed **5,880.3 MiB dedicated allocation** to CARLA PID
8572 at the end of the drive. WDDM allocations across adapters are not device
residency. The 19% CARLA 3D-engine reading was one end-of-drive sample, not a
whole-run utilization average.

CPU inference does not explain that allocation as a GPU model allocation.
The data also does not prove memory paging, a leak, GPU compute saturation,
or a texture-pool change as the fix. Memory was high within a narrow range and
returned to zero after shutdown; long-duration or internal allocation behavior
is not established by this short run. A texture pool is not a whole-device cap.

## 5. Bounded offline experiments

### Recorded control-pipeline profile

The existing profiler processed an 80-observation prefix with and without
cProfile. On the final repeat, plain scene/safety median times were
**12.54 / 7.88 ms** (combined 20.70 ms). These are **offline component times**.
Repeated timings varied with the same code; no code speedup is inferred.

Crucially, cProfile included **13.88 s in ReplayReader initialization**, which
validates/indexes the full 1,094-frame recording before the prefix loop.
The actual 80 scene builds took 1.524 s under profiling. Its top recursive
contract/decode functions therefore cannot be relabelled as live frame costs.

The plain/profiled selected-field output digest matched, but the profiler does
not reproduce the full recorded semantic-cache/service/route history and hashes
only selected track/decision fields. **This is not complete-output equivalence
proof for a production optimization.**

### CPU versus existing DirectML option

Twenty frames, chosen before inference at uniform chronological positions
from frame 124 through 1217, used identical saved RGB bytes, model hash and all
three V3 views. Execution order alternated. Both constructors used the same
installed optional ONNX Runtime **1.24.4** environment.

| Component-only result | CPU EP | DirectML EP |
| --- | ---: | ---: |
| Median predict time | **359.65 ms** | **40.32 ms** |
| p95 | 388.46 ms | 41.35 ms |
| Detection count across selected frames | 284 | 284 |

All 20 frames matched class-wise detection sets under the existing IoU >=0.9
comparator. **Zero frames had bit-identical complete detector outputs**:
maximum confidence difference was approximately 1.64e-6 and box-coordinate
difference 0.0001831 pixels. These differences are small, but they are not zero
and were not hidden behind a loose matcher.

This is an approximately **8.9x component timing improvement**, not an 8.9x
simulation speedup, whole-driver equivalence or native admission. The actual
smoke used production CPU ONNX Runtime **1.23.2**, and the comparison had no CARLA
load. Provider identity also does not prove exclusive NVIDIA placement or
absence of CPU fallback operators. Production stays CPU.

An earlier file-list-order sample is retained. The final sampler uses numeric
native frame order, and all offline checks were rerun on that corrected analysis
source. No protected/native attempt was repeated or discarded.

## Proposed corrections: acceptance remains conditional

No production performance patch was accepted in this investigation.

| ID | Measured failure | Independent expected result | Hypothesis and smallest justified action | Verification and status |
| --- | --- | --- | --- | --- |
| H1: required-camera delivery | 128.48 ms cycle; depth last in 98.4%; mean tick-request-to-depth-receipt 70.10 ms | Existing LEGACY cadence/RTF/gap limits and all original freshness/safety/coverage rules; unchanged rig/density/route | Localize engine/render/readback versus callback scheduling before changing code. No sensor removal, lower coverage or guessed scheduling patch | All receipt clocks and cycle boundaries audited. Internal cause still unresolved; **native confirmation BLOCKED** |
| H2: inference placement | CPU inference median 391 ms natively, 1.892 packets/s | Same model/views/inputs; explicit complete-output/decision equivalence assessment; then native end-to-end and resource gates | Use the already-existing DML opt-in only in an isolated candidate experiment; do not change defaults | Same-input component test performed; 359.65 -> 40.32 ms, tiny nonzero output differences. **Not accepted as a production/native fix** |
| H3: backend/recording contention | Backend near one core; 46.74 ms post-RPC-to-next-sensor bucket includes multiple operations | Same controls, recorded data and workload, with independently reconciled per-stage wall/thread CPU and native cycle reduction | Profile the unseparated post-application/callback work; do not assume queue health proves zero serialization cost | Existing data narrows the region but cannot apportion causality. **No speculative patch** |
| H4: GPU allocation | 27/27 samples above 4,608 MiB | Original resource target without reduced sensing/density, false residency accounting or new acceptance thresholds | Verify applied render settings and allocation contributors before choosing a render/resource correction | GPU/PID measurements retained; memory alone does not identify frame-time cause. **Native effect UNVERIFIED** |

Rejected shortcuts: raising requested Hz, duplicating displayed frames, lowering
quality/coverage/density to pass, dropping required depth, extending freshness,
optimizing offline file-validation totals as if they were live costs, and
automatically promoting a faster isolated detector.

## Actual root blockers and next authorized action

At the read-only checkpoint **2026-10-28 18:21:38 UTC**:

- The separate RULE ticket is expired; no native work is authorized now.
- Egypt diagnostic spendable: **342.997 s**, versus a **480 s** next minimum
  reservation: **137.003 s short** (at least +138 whole seconds for that next
  admission only). Protected 7,200/480/7,200-second windows are unchanged.
- D free: **136,996,605,952 bytes**, provisional requirement:
  **140,049,743,825 bytes**, shortfall **3,053,137,873 bytes**. Final sizing must
  still use a complete successful development matrix.
- Normal 1703/3709 diagnostics, full development/holdout, maneuver/event coverage,
  the complete native UI gate and final delivery remain unresolved.
- Existing traces cannot identify engine/GPU/readback/callback causal costs
  sufficiently to accept a native performance correction.

Authorized work is still offline retained-data/source investigation and
appropriately scoped equivalence analysis. A controlled, unchanged-workload
native timing/resource comparison is the next required confirmation, **not an
authorized action**. Obtain valid separate permission/funding and storage
admission before executing it. Do not borrow the Egypt windows or reuse the
expired RULE ticket.

## Reproduction and evidence index

The deterministic local analysis adapter is retained at
`tmp/root-driving-validation/audit_performance.py` as verification source for the
open root task, not as a production dependency.

These selectors perform only the declared offline checks; **do not run any
`native-*` selector without new valid authorization**:

```powershell
.\.venv-carla\Scripts\python.exe .\.agents\skills\prove-it\scripts\proof.py run --task .runtime-proof\root-driving-validation --check child-cannot-close-root
.\.venv-carla\Scripts\python.exe .\.agents\skills\prove-it\scripts\proof.py run --task .runtime-proof\root-driving-validation --check retained-performance-audit
.\.venv-carla\Scripts\python.exe .\.agents\skills\prove-it\scripts\proof.py run --task .runtime-proof\root-driving-validation --check recorded-pipeline-profile
.\.venv-carla\Scripts\python.exe .\.agents\skills\prove-it\scripts\proof.py run --task .runtime-proof\root-driving-validation --check recorded-provider-comparison
```

- [Current full timing/resource audit](../.runtime-proof/root-driving-validation/runs/retained-performance-audit/20261028T182035-6bbbee27d8/performance-audit.json).
- [Sensor receipt audit](../.runtime-proof/root-driving-validation/sensor-arrival-audit.json).
- [Native/display endpoint alignment](../.runtime-proof/root-driving-validation/display-producer-alignment.json).
- [Plain recorded-input profile](../.runtime-proof/root-driving-validation/runs/recorded-pipeline-profile/20261028T182139-ec40c5a819/plain.json)
  and [instrumented profile](../.runtime-proof/root-driving-validation/runs/recorded-pipeline-profile/20261028T182139-ec40c5a819/profiled.json).
- [Actual CPU/DirectML comparison](../.runtime-proof/root-driving-validation/runs/recorded-provider-comparison/20261028T182209-6593c7f171/inference-comparison.json)
  and [preselected image identities](../.runtime-proof/root-driving-validation/runs/recorded-provider-comparison/20261028T182209-6593c7f171/inference-inputs.json).
- [Child-to-root negative controls](../.runtime-proof/root-driving-validation/runs/child-cannot-close-root/20261028T182033-009ee93418/hierarchy-negative.json).
- [Root gate](../.runtime-proof/root-driving-validation/gate.json): expected to
  remain **UNVERIFIED**, not to inherit the child's passing result.
