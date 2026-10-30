# GTA continuation: completed download, CV architecture and startup blocker

Historical checkpoint before the owner's explicit exact-file allowance and UAC
continuation. The [later bootstrap report](GTA_UAC_BOOTSTRAP_20261031.md) records
actual native callbacks and clean shutdown; the full migration remains open.

**BLOCKED_UNVERIFIED — 31 October 2026, Cairo.** The original migration goal is
still open. No camera/perception/control capability, training or CARLA cleanup
has been accepted.

## The late download changed the evidence

The owner correctly reported that the browser download was still completing.
`ScriptHookV_3889.0_1158.13.zip` is now present locally, 1,722,210 bytes, SHA-256
`b64c97c3353906f14621e7e9511e4aec2a7d436ecc21ed124d3816585e2e6188`.
Its Windows download metadata identifies the original developer product page
and the original HTTPS archive URL. The earlier browser timeout was not proof
that a completed download could never appear. The
[earlier checkpoint](GTA_MIGRATION_PREFLIGHT_20261030.md) is historical.

The original exact-package contract is preserved unchanged and failed. A new
sealed bootstrap contract inspects the newer actual candidate rather than
requiring the old filename. It does not equate a changelog mention with native
support: the archive mentions `1013.20` in its changelog but omits that exact
version from its explicit Enhanced support list. Actual compatibility is still
unverified.

The completed download's conservative reservation was reconciled once against
its measured length, original HostUrl and SHA-256. Another unresolved browser
reservation remains charged. Total charged/reserved dependency payload at this
checkpoint is **11,723,114 / 100,000,000 bytes**; no budget was reset.

## Native attempts and protection state

The new C++ ASI was actually compiled with the installed MSVC tools. Its ABI
follows Script Hook V's public script/native declarations; it only reads
`GET_FRAME_COUNT` and `GET_GAME_TIMER`, tagged with run identity and real PID.
It does not spawn actors, change cameras, send controls, access game globals or
patch memory. A successful build is not an in-game callback.

A direct game-binary attempt exited with **4919 / 0x1337** before any probe
frames. Inspection found the owner's actual desktop shortcut targets
`PlayGTAV.exe`; the subsequent launch used that existing target, not an invented
replacement. Owned launcher/descendant membership and executable identity are
checked separately, and only matching native samples can qualify. A transient
occupied-host refusal is retained as a separate failed preflight.

The real ordinary-launcher attempt failed **WinError 5: Access is denied**.
Following the owner's Defender report, a read-only query found:

- `RUNE64.dll`: Defender classification **Trojan:Win32/Kepavll!rfn**.
- `PlayGTAV.exe` / `version.dll`: **PUA:Win32/Packunwan**, with an active
  project-related detection at inspection time.

These are observed Defender classifications, not an independent malware
analysis or a false-positive finding. The launcher refusal and related
protection records support an installation/protection blocker; they do not
prove Script Hook V incompatibility. No quarantined file was restored, no
exception added, no protection/security/account setting changed, and no file
was uploaded to a third-party scanner. The bootstrap now reads project-related
detection metadata and refuses another flagged launch before installation.

All newly installed bootstrap files were removed after confirmed owned-process
cleanup; protected project-input hashes matched before/after the attempts.
Windows itself may quarantine game files independently; this is not a claim
that every game file remains unchanged by protection. CARLA, research weights,
reports, numeric evidence and raw training/validation data were not retired.

Runtime ledger: **11.251 seconds charged / 10,788.749 seconds remaining** from
the same 10,800-second grant, including failed startup/supervision time. These
are ledger charges, not accepted simulation seconds. No training has started.

## Computer vision and trajectory prediction are central

The owner's clarification is retained: the target is visual perception and
prediction-assisted driving, with supporting sensors. The intended integration
is camera RGB -> detector -> tracked, calibrated metric histories -> Trajectron++
future trajectories -> RL maneuver proposal -> independent safety validation ->
real GTA actuation. Supporting depth/odometry helps establish distance and motion;
unknown geometry is not silently treated as clear space.

The existing project has a pinned `StanfordASL/Trajectron-plus-plus` adapter,
isolated worker environment and local weights. Its lock specifies 0.5-second
sampling and six future prediction steps, up to 16 objects. Trajectron++ consumes
object-track histories, not raw image pixels. Its retained status is
`BENCHMARKED_PARTIAL_GATE_ONLY`; file presence does not certify forecast accuracy
on GTA or promote it into the driving safety policy. The existing RL proposal
and deterministic arbitration/safety layers remain distinct from forecasting.

Repository assessment:

| Source | Useful part | Observed limit |
| --- | --- | --- |
| [aitorzip/DeepGTAV](https://github.com/aitorzip/DeepGTAV) | Vision-based driving bridge and Python command/data concept | Original installation specifies GTA 1.0.1180.2 or older |
| [bradenhurl/DeepGTAV-PreSIL](https://github.com/bradenhurl/DeepGTAV-PreSIL) | RGB/depth/LiDAR/labels for perception research | Documents the same old-game installation; Enhanced compatibility not established |
| [David0tt/DeepGTAV](https://github.com/David0tt/DeepGTAV) | More recent extraction/client implementation and custom scenarios | README's last working game is Legacy 1.0.3586.0; not evidence for Enhanced 1013.20 |
| [slevin48/gta](https://github.com/slevin48/gta) | Collection/training/driving demonstrations | A demonstration repository is not validation of this project's forecasting/control or installed build |

Decision: retain the project's CV/forecast/RL modules and adapt the GTA
image/control boundary; use the DeepGTAV family as an implementation reference,
not an unverified drop-in driving model. Do not download their datasets, old
bundled game dependencies or substitute privileged actor labels for policy
perception. Respect source licenses if code is subsequently reused. No claim is
made that a custom Enhanced bridge is already complete or necessarily faster.

## Resume and evidence boundary

A trusted working game installation must launch without bypassing the observed
protection block before native bootstrap, camera/metric calibration, prediction
evaluation or RL training can resume. No game update/download, protection
exclusion, budget extension, lowered safety criterion or CARLA deletion is
implied. The parent 600–800m / 60 vehicles / 100 pedestrians / three passes and
returns, separate evaluation and existing timing criteria remain open.

The local bootstrap task is
`integrations/gta/.runtime-proof/gta-bootstrap-20261031`. Its tests and candidate
inspection are software/input evidence; its native gate remains failed. The
earlier compiler quoting failure, direct-launch failure, occupied-host refusal
and blocked launcher attempt are preserved. Same-agent artifact inspection is
explicit; no other model client, native Copilot callback or hidden worker is
claimed. The repository-root task and old CARLA ledgers were not overwritten.
