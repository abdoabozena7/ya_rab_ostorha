# Deterministic saved-input continuation, 27 October 2026

This is an offline equivalence harness, **not native asynchronous/timing
reproduction or a native acceptance gate**. It does not open CARLA, inspect
holdout runs, reserve time or change budgets.

`scripts.replay_urban_control.py --deterministic` replays from recording start,
including all earlier complete sensor frames and driver decisions. Camera
semantics use the latest recorded evaluation frame, not original asynchronous
delivery. Road context is frozen before same-frame measured-space preparation.
Every recorded decision in the requested window must appear in the report;
missing/incomplete decisions fail rather than disappearing from metrics.
The 21-frame original window (900–920) and nine-frame latest window (700–708)
are explicit bounded replay samples, not replacements for the recorded
601-decision/633-submission native timing populations. No native late frame is
removed or reclassified by this comparison.

The synthetic receipt clock is `100 + frame_id` seconds. Build and internal
planning elapsed times are explicitly zero, behavior defaults to 100 ms age,
and the independent shield defaults to 150 ms age. These deliberately controlled
ages are identical across implementations, **not measured native wall ages**.
The offline harness replaces only module-local clock references, restoring them
on exit; it does not change runtime source, policies, freshness limits or proofs.
Real elapsed scene/behavior/shield timings are diagnostic only and never enter
the equivalence comparison or prove a gate improvement.

Reports retain exact complete command, behavior, scene prediction, forecast,
road and shield-result payloads plus canonical SHA256 hashes. This includes all
tracks, histories, physical modes and shield evidence, not just selected fields.
Comparison requires exact canonical values AND hashes, identical frame sets,
input-history hashes and explicit clock configuration. The history hash binds
all replayed frame metadata, actual sensor asset hashes, recorded decisions and
semantic values. Reports bind the harness hash and effective runtime source
fingerprint (substituting the loaded contracts oracle hash when supplied).

## Local baseline and comparison

Ignored artifacts live under `output\egypt-validation\continuation-20261027`.
The original contracts module was copied there before runtime edits:
`contracts_original.py`, SHA256
`b25d2477807c9133c11caa56f9ead5123b206c76b1f06db4512ee6f127b3c3dc`,
at HEAD `0414f7128af22eed58d13bd362121826ca1e00ce`.
`--contracts-oracle` loads this complete module before backend imports. Keep
this trusted local file with baseline evidence; never load untrusted Python
or pickle files.

On another checkout, recover those exact oracle bytes from the preserved Git
commit, not from the optimized working file:

```powershell
.\.venv-carla\Scripts\python.exe -c "from pathlib import Path; import subprocess; p=Path(r'output\egypt-validation\continuation-20261027\contracts_original.py'); p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(subprocess.check_output(['git','show','0414f7128af22eed58d13bd362121826ca1e00ce:backend/core/contracts.py']))"
```

Verify the SHA256 above before loading. Retained recordings must be available
locally. Use fresh output directories/names for additional trials; preserve
existing reports, including unfavorable experiments.

```powershell
.\.venv-carla\Scripts\python.exe -m scripts.replay_urban_control runs\normal_city\run_6328c6a903aa4881b8f12a1018a66698 --deterministic --first 900 --last 920 --contracts-oracle output\egypt-validation\continuation-20261027\contracts_original.py --live-sample output\egypt-validation\continuation-20261027\live-prediction.pkl --output output\egypt-validation\continuation-20261027\original-baseline.json
.\.venv-carla\Scripts\python.exe -m scripts.replay_urban_control runs\normal_city\run_c8d966cf0d16438180d3dd7e9e879bea --deterministic --first 700 --last 708 --contracts-oracle output\egypt-validation\continuation-20261027\contracts_original.py --output output\egypt-validation\continuation-20261027\latest-baseline.json
```

For optimized source, repeat each invocation **without** `--contracts-oracle`
or `--live-sample`, use output `original-optimized.json` / `latest-optimized.json`,
and add `--baseline` with the corresponding baseline path. A mismatch exits
nonzero while retaining its comparison report. Use the same explicit
`--wall-age-ms` and `--shield-age-ms` for both runs to examine another age;
never compare a faster implementation at a fresher age.

```powershell
.\.venv-carla\Scripts\python.exe -m scripts.replay_urban_control runs\normal_city\run_6328c6a903aa4881b8f12a1018a66698 --deterministic --first 900 --last 920 --baseline output\egypt-validation\continuation-20261027\original-baseline.json --output output\egypt-validation\continuation-20261027\original-optimized.json
.\.venv-carla\Scripts\python.exe -m scripts.replay_urban_control runs\normal_city\run_c8d966cf0d16438180d3dd7e9e879bea --deterministic --first 700 --last 708 --baseline output\egypt-validation\continuation-20261027\latest-baseline.json --output output\egypt-validation\continuation-20261027\latest-optimized.json
```

`live-prediction.pkl` captures the actual dictionary passed into
`control_scene.freeze_json` at the first requested frame, before freezing.
Its custom trusted-local pickle preserves already-frozen point rows and shared
trajectory objects; unlike JSON reconstruction it is suitable as the input
graph for a representative freezing microbenchmark. Load with `pickle.load`
from this checkout so restoration helpers are importable.

Focused checks: `.\.venv-carla\Scripts\python.exe -m unittest tests.test_replay_urban_control`.
These cover complete-payload mismatch detection, matched ages/history/frame
sets, timing exclusion and frozen-type/alias-preserving graph capture.
The optimized-source results and their limits follow below.

## Captured original-source evidence

Both baselines bind effective source
`c2ec0594d7a0a80141820d0e2ffc0a448887e0f7f85a35da5a75e40a5fb90137`,
with unchanged effective source throughout each replay. Original replay traversed
582 saved frames through 920; latest replay traversed 389 through 708.
All 21 and nine requested decisions respectively are retained.

| Ignored local artifact | SHA256 |
| --- | --- |
| `original-baseline.json` | `e2c3a923fef906551814b74a86a8f66358f232f587cd718110643586d148a6cd` |
| `latest-baseline.json` | `0bcff7b2a01c10f7f8f2d5103ecd00ed3be71eaa687a253ae3024e2516a86229` |
| `live-prediction.pkl` | `233889b82122d639243bd6ab4f25b855792da8dc5b2ed1524d87ddddaca8c0fd` |

The actual live sample is evaluation frame 900: 48 tracks, 54 physical modes.
Its `trajectories` and `control_trajectories` are the same list object; mode
point containers and their numeric rows retain the internal frozen sequence
type after trusted-local pickle loading. Three focused tests passed.
`original-repeat.json` and `latest-repeat.json` independently reproduced all
21 and nine complete payloads and hashes exactly at the matched 100/150 ms
synthetic ages. This is original-source repeatability, not an optimized-source
or native timing result.

## Optimized source and live-graph measurements

Updated driving fingerprint:
`4486828db532a310fccffa90ec9d480246425c40fa4460a630c696abd8a5eea3`.
Optimized contracts SHA256:
`bd97cfe9b1350a16ab14bc15a5d235efb6fe25e9c7a6b082e66d2ac92272c24d`.
Both optimized reports now match their baselines exactly: **21/21 and 9/9
complete payloads and hashes**, no differences, at identical 100/150 ms ages.
Their input-history hashes match and their source remained unchanged.

`freeze_json` now dispatches exact builtin primitives/containers before general
ABC checks; subclasses and custom mappings still follow recursive validation.
It preserves finite values, string keys, cycle rejection, immutable copies,
alias sharing and trusted frozen rows. Two focused contract regressions cover
custom containers/numerics, mutations, aliases, invalid values and cycles.

The committed benchmark checks that all oracle helper/type definitions are
unchanged, evaluates the preserved original function using those same types,
checks complete frozen values and verifies the captured frozen rows/aliases.
It uses unprofiled `perf_counter_ns`, 20 warmups, alternating order and 1,000
samples **per implementation**, with cyclic GC disabled then restored.
Measurements ran without concurrent replay jobs.

```powershell
.\.venv-carla\Scripts\python.exe -m scripts.benchmark_freeze_json --sample output\egypt-validation\continuation-20261027\live-prediction.pkl --oracle output\egypt-validation\continuation-20261027\contracts_original.py --output output\egypt-validation\continuation-20261027\freeze-live-reproduction.json
```

| Actual live graph trial | Original median / p95 / p99 ms | Optimized median / p95 / p99 ms |
| --- | --- | --- |
| First measured trial | 1.60050 / 1.709145 / 2.444666 | 1.28635 / 1.366105 / 1.985420 |
| Committed-command reproduction | 1.62555 / 1.731330 / 2.045008 | 1.33070 / 1.426885 / 1.805833 |

The reproduction saves **0.29485 ms median (18.1%)** of freezing alone.
These are samples of one frame-900 graph, not native pipeline percentiles,
independent workloads or proof that the 200/225/250 ms gate will pass.
Scheduling variance and native sensor/detector/recorder interference remain
unresolved. No safety policy, deadline, scenario or driver behavior is relaxed.

Earlier reconstructed-graph exploration is also retained in
`freeze-experiments.json`: exact-type-only dispatch worsened p95/p99 in the
first trial and p99 in the second, so it was not selected. Its results are not
replaced by the favorable live-graph measurements.
The [tracked verification](evidence/egypt-urban-chaos-v1/freeze-continuation-verification-20261027.json)
indexes all baseline/repeat/optimized report hashes, both live trials, input
graph, original source, harnesses and fresh suite/build logs. Heavy reports
and pickle stay ignored. This closes the bounded software-equivalence check,
**not** native asynchronous reproduction or any native acceptance gate.
