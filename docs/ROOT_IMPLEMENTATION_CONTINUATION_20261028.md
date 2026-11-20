# Root implementation continuation - 28-29 October 2026

**ROOT GOAL remains OPEN / NOT ACCEPTED.** This continuation implements
preservation and strict replay tooling, rather than claiming completion from
another child result. No new native session or budget extension was authorized
or executed.

## 1. Provisional storage admission restored without losing evidence

The existing [verified relocation mechanism](RECORDING_RELOCATION.md) preserved
the two closed smoke recordings in the already-used plain C-volume recording
archive. Their original D paths remain usable through exact registered aliases.

| Recording | Files | Preserved logical bytes |
| --- | ---: | ---: |
| `run_5898068dd56f4d68bc032200fdd4313c` | 4,097 | 1,204,882,706 |
| `run_29798332bb19460fb233005b637c5d5d` | 4,417 | 1,307,208,475 |
| Total | **8,514** | **2,512,091,181** |

Whole-batch C admission checked copy capacity plus 50% margin and an independent
4 GiB reserve. Every file's length/SHA-256 and empty directory was preserved.
Original and destination inventories were rechecked before releasing **only
the named verified staged duplicates**. No recording or recovery archive was
discarded.

Replay endpoint assets, first/last video decode and original video routes
passed. Independent requests to the existing stopped backend returned valid
HEAD 200 and Range 206 responses with matching original bytes for all four MP4
URLs. No CARLA launch was needed.

One closed historical JSON report was also transparently NTFS-compressed:
logical length and SHA-256 remained identical; reported storage decreased from
64,357,445 to 20,357,120 bytes. No report contents/path changed. The larger
prepared compression batch performed **zero** operations because measured free
space was already sufficient.

At the initial verified 28 October 19:23 UTC checkpoint:

| Actual volume / requirement | Bytes |
| --- | ---: |
| D free | **142,101,315,584** |
| Unchanged provisional native requirement | **140,049,743,825** |
| C free after preservation | **17,577,115,648** |

These are actual snapshots, not reserved capacity or a claim that the entire
free-space delta was caused solely by the measured logical-byte moves.
Subsequent replay artifacts consume some space; admission must be refreshed
before native work. Final acceptance sizing still requires successful complete
DEVELOPMENT. Protected allowance/ledger hashes did not change.

After retaining the complete replay evidence, a read-only check at **29 October
08:38:22 UTC** measured **140,770,906,112 bytes** free on D, still above the
unchanged requirement by **721,162,287 bytes**. This passes provisional storage
admission only; it is not permission, reserved capacity or final matrix sizing.

[Full preservation proof and actual HTTP checks](../.runtime-proof/root-driving-validation/storage-continuation/verification.json)
and [lossless compression pilot](../.runtime-proof/root-driving-validation/storage-continuation/ntfs-pilot.json)
are retained locally.

## 2. Implemented complete-output semantic replay

The new [comparison tool](../scripts/compare_perception_replay.py) extends the
existing [deterministic replay](../scripts/replay_urban_control.py), not the
production driving controller.

- DEVELOPMENT-only native input; HOLDOUT/DEBUG and unacknowledged fixtures are
  rejected.
- Bundles bind original metadata, control/frame logs, source implementation,
  complete frame inventory, model/profile, source RGB/depth bytes/calibration,
  original delivery schedule and controlled ages.
- Warmup is an explicitly identical recorded prefix. Every packet after
  activation is required in order; missing images or replacements cannot
  silently fall back.
- Only declared semantic observations/provider provenance may differ.
  Sensor/road/base-command context and clocks remain matched.
- Every complete **command, behavior, prediction, forecast, shield and road**
  payload is compared, with independently recomputed hashes. Differences are
  retained, not rounded or filtered into success.
- Compressed streaming artifacts avoid retaining all large outputs in memory.
  Truncation, missing summaries, duplicates, reordered/extra/missing rows,
  malformed payloads and stale claimed hashes fail.
- The legacy same-input comparator remains strict. It does not waive history
  identity merely because a different inference provider is being studied.

The [new tests](../tests/test_perception_replay.py) and
[legacy replay regressions](../tests/test_replay_urban_control.py) exercise
these failure cases and the actual mathematical pipeline with explicitly
labeled fixtures. They are not native driving evidence.

### Actual retained-data study, not fixtures

Corpus: [current-source protected DEVELOPMENT recording](../runs/normal_city/run_ec5dd4a906a848c0bacfbee1780e8d32).
All **601** recorded decisions, frames **179-779**, were replayed with complete
preceding history and identical controlled 100/150 ms ages.

The initial evaluation-148/source-144 packet predates retained source pixels.
It is the declared identical warmup, not falsely recomputed input. Activation
at evaluation frame **160** binds **236** subsequent verified RGB/depth packets
before the first scored decision. This is not a provider replacement from
native startup, nor a test of faster asynchronous publication.

| Comparison | Input/context validation | Complete output result |
| --- | --- | --- |
| Recorded semantics vs repeat | Passed | **601/601 exact** |
| Controlled CPU vs repeat | Passed | **601/601 exact** |
| Recorded production CPU 1.23.2 vs controlled CPU 1.24.4 re-export | Passed | **601/601 exact** within this replay scope |
| Controlled CPU vs DirectML, both ORT 1.24.4 | Passed | **Not exactly equivalent** |

CPU/DirectML produced **10,188 complete-output differences** across all 601
decisions, in prediction/forecast track semantic-confidence values. Maximum
numeric difference was approximately **1.669e-6**. Commands, behaviors, shield
results and road payloads were identical in this corpus.

That is useful evidence, but **not full-payload equivalence**, production
provider admission, a native speedup, or a full-route safety result. The failed
exact-equivalence result and every difference remain preserved. Production
defaults stay CPU; no threshold or output rounding was changed to obtain a pass.

The original default replay implementation from Git and the current default
CLI were also run on 30 actual decisions with the same preceding history.
Complete payloads, original history and controlled context matched exactly.
Verifier identity and nonsemantic elapsed timings were separately recorded;
the original strict same-verifier comparator was not weakened.

[Complete study artifacts](../.runtime-proof/root-driving-validation/perception-study-v1),
[downstream differences](../.runtime-proof/root-driving-validation/perception-study-v1/downstream-difference-analysis.json)
and [default-CLI compatibility](../.runtime-proof/root-driving-validation/perception-study-v1/default-replay-compatibility.json)
are retained.

### Reproduction

These commands read DEVELOPMENT recordings only. They neither start CARLA nor
create a native allowance. Use a fresh output directory to preserve all attempts.
The installed optional perception environment is deliberately separate from
production CPU 1.23.2.

```powershell
$recording = 'runs\normal_city\run_ec5dd4a906a848c0bacfbee1780e8d32'
$out = '.runtime-proof\root-driving-validation\perception-study-next'
$scope = @('--first','179','--last','779','--wall-age-ms','100','--shield-age-ms','150')

.\.venv-carla\Scripts\python.exe -m scripts.compare_perception_replay export $recording @scope --activation-evaluation-frame 160 --provider recorded --output "$out\recorded.bundle.json.gz"
.\.venv-perception-dml\Scripts\python.exe -m scripts.compare_perception_replay export $recording @scope --activation-evaluation-frame 160 --provider CPU --model models\yolov8s-640.onnx --output "$out\cpu.bundle.json.gz"
.\.venv-perception-dml\Scripts\python.exe -m scripts.compare_perception_replay export $recording @scope --activation-evaluation-frame 160 --provider DML --model models\yolov8s-640.onnx --output "$out\dml.bundle.json.gz"

.\.venv-carla\Scripts\python.exe -m scripts.compare_perception_replay replay $recording @scope --bundle "$out\cpu.bundle.json.gz" --output "$out\cpu.replay.jsonl.gz"
.\.venv-carla\Scripts\python.exe -m scripts.compare_perception_replay replay $recording @scope --bundle "$out\dml.bundle.json.gz" --output "$out\dml.replay.jsonl.gz"
.\.venv-carla\Scripts\python.exe -m scripts.compare_perception_replay compare "$out\cpu.replay.jsonl.gz" "$out\dml.replay.jsonl.gz" --output "$out\cpu-dml.diff.jsonl.gz"
```

Comparison exit 0 means valid exact complete outputs; exit 1 requires inspecting
`valid` versus `equivalent` to distinguish invalid context from a valid unequal
candidate. Input/CLI failures exit 2. None is a native acceptance certificate.

## 3. Software verification and root boundary

- Targeted replay regressions after review hardening: **30 passed**.
- Full Python suite after hardening: **1,098 tests, 1,094 passed, 4 optional skips**.
- Full JavaScript suite: **221 passed**.
- Dashboard build: **passed**.
- Default replay compatibility and the five complete recorded-data replays above
  were executed, not inferred from unit tests.

The driving fingerprint remains
`a7ece445d9eab71d4328f08bb1b25e245499eb39539461b573646271b3777933`.
Verification-tool source changed. Prior smoke/replay certificates remain
historical, source-qualified evidence; they were not rewritten or promoted as
certificates for the new whole-checkout/tooling source.

No new official native/software admission certificate, source freeze, native
diagnostic, development/holdout matrix, or final browser gate was issued.
Full parent performance and physical behavior remain unverified.

### Independent review correction

A separate read-only review found a real false-positive: a recorded-repeat
artifact could claim a different actual history hash and regenerate its
metadata checksum without being rejected. The fix requires recorded semantics'
actual/original histories to agree and compares actual history whenever the
effective semantic histories are identical, including unscored warmup,
regardless of producer-only metadata changes. The reproductions failed before
the fix and pass as rejection regressions afterward.

The original producing source and all V1 artifacts are preserved. Hardened
comparison results identify their evaluator separately as
`comparator_source_sha256`; old producer identities are not rewritten to imply
new execution. Real truncated-artifact and altered-clock copies were also
specifically rejected, while their originals remained unchanged.

All four 601-decision comparisons were rerun with the hardened comparator
`d7a6e2ffe0611004ec00c2d0970834c70bc6cb0f62ba2db255e03df5c64c3408`.
Both repeats and recorded/CPU outputs remain exact; CPU/DirectML remains valid
but unequal. The five V1 producer runs were not regenerated or relabeled.
The [current offline evidence index](../.runtime-proof/root-driving-validation/implementation-evidence-index.json)
binds all four hardened summaries/difference artifacts, the preserved producer
sources and replay hashes, real-data negative controls, software results, and
fresh recording-alias/ledger/process/storage checks.

[Review finding](../.runtime-proof/root-driving-validation/perception-study-v1/review-finding-v1.json),
[producing source archive](../.runtime-proof/root-driving-validation/perception-study-v1/producer-source/manifest.json),
[real-data negative controls](../.runtime-proof/root-driving-validation/perception-study-v1/negative-controls/results.json)
and [current software results](../.runtime-proof/root-driving-validation/software-implementation-validation.json)
are retained.

## Remaining authorization blocker

Storage now passes provisionally, but the RULE ticket is expired. Egypt still
has **342.997 diagnostic seconds** against the **480-second** next minimum.
Protected DEVELOPMENT/browser/ACCEPTANCE allocations remain unchanged.

A separate additional diagnostic authorization was requested, with an explicit
append-only allocation proposal and unchanged protected caps. No affirmative
user response was available. **No approval was inferred and no extension was
applied.**

Keep [ROOT_GOAL.md](../ROOT_GOAL.md) open. Completing these implementation
children does not satisfy the remaining original native gates or authorize
running them.
