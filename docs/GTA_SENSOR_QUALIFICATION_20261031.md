# GTA camera, center depth and physical control qualification

**PARTIAL — this native qualification gate passed; full migration remains open.**
The production provider, full sensor coverage/timing, CV tracking/forecasting,
MaskablePPO training, complete routes and CARLA retirement are not accepted yet.

The actual installed Enhanced game loaded the custom Script Hook V ASI and a
ReShade 6.8.0 API20 addon built locally. The official setup executable was never
executed: its embedded runtime was extracted as a candidate and installed only
temporarily with hash-owned files. Its certificate thumbprint matches the
published value; Windows reported **UnknownError**, not a verified signature.
The complete SDK archive download failed after2,621,440 bytes. Eight needed
headers from the same pinned tag replaced that download route. Every failed
payload charge remains. Aggregate dependency payload: **21,924,610/100,000,000 B**.

## Actual native result

Task `gta-sensor-calibration-20261031`, native run
`20261031T100444-65fa96e16f`, game PID36468,
run identity `e942ecc7bd49431fa556b4b9800aba9d`.

The addon captures the actual1920x1080 D3D12 backbuffer into640x360 RGB and
raw depth. It never calls game natives from the render thread. Native and
renderer records carry actual frame identities and host/game timestamps.
Association is asynchronous; no fixed/synchronized stepping is claimed.

The first real depth test failed because requested far clip150 was treated as
the renderer's projection. The actual final rendered camera reports near.15
and far10000. The correction uses those measured values. Projection selection
uses10/30m only. Previously observed60/100m cases remain disclosed regressions;
fresh80/120m targets were fixed before the revised run and were not fitted.

| Center target | Settled samples | Maximum depth/ray difference |
| --- | ---: | ---: |
| 10m calibration | 28 | .00649m |
| 30m calibration | 27 | .00655m |
| 60m regression | 27 | .01757m |
| 100m regression | 28 | .00682m |
| 80m fresh holdout | 28 | .01479m |
| 120m fresh holdout | 27 | .01631m |
| Nearer occluder | 27 | .00653m |

These are controlled center-ray/camera checks. They do not establish accuracy
across the entire image, all materials, dynamic scenes,360-degree coverage or
the realism of physical automotive sensors. Unknown depth remains unknown.

The local-only UDP protocol uses a random owner token, one bound peer,
monotonic command numbers and deadlines of at most500ms. Measured outcomes:

- Throttle displacement30.543m, peak11.331m/s; brake ends at.00195m/s.
- Left/right yaw changes+.7196/-.7487rad after declared setup settling.
- Actual socket silence triggers brake1/throttle0; final speed.00927m/s.
- Actual capture interruption overrides fresh commands; final speed.00902m/s.
- Rejected43 replays,105 stale packets and30 foreign-peer owner attempts.
- Deliberate collision:45 target-contact samples,21.628 body-health loss and
  an8.15334m/s speed span. The driver remained alive. This impact is a diagnostic,
  not a driving-policy success or an accepted collision-avoidance episode.

The earlier airport pursuit killed the driver and failed contact qualification.
It remains preserved, including its WASTED image. The revision requested wanted
response suppression and required measured driver survival and target-identified
contact. Wanted HUD symbols remain visible in the captured video; clean isolation
of that game state still needs validation before training. No vehicle
invincibility or collision suppression was used. Declared between-stage resets
are excluded from measured actuation; no teleport is counted as movement.

Owned job shutdown, temporary-file restoration and protected-input hashes pass.
The first timed-out menu attempt exposed a transient file-sharing lock; verified
dead-owner/hash-matched recovery is retained, and removal now retries boundedly.

The source-bound tests, real build/native checks and artifact review passed
`proof.py verify --write-report`. This gate is not parent P02/P06 acceptance.
The original3-hour runtime ledger has **1512.143/10800s charged** at this
checkpoint; no budget reset or transfer from CARLA occurred.

## Media and remaining work

The retained subset is in `docs/evidence/gta_sensor_20261031/`. The77.1s video
resamples actual capture timestamps to10fps using the last observed sensor frame.
The deliberate capture outage therefore holds an old image; it does not invent
fresh observations. The timeline and original native records remain local with
all failed attempts and raw data under `integrations/gta/.runtime-proof/`.

Capture-duration measurements use coarse Windows GetTickCount64 timestamps;
they are not exact end-to-end CV latency or proof of the full performance target.
Next: test existing vision weights on actual GTA images, qualify dynamic metric
tracking/Trajectron++ and required sensor coverage, then implement/admit the
production provider and independent GTA route/scenario/training protocol.
CARLA, its raw datasets, project code, prior reports/videos and model weights
remain retained. No GTA policy training has started.
