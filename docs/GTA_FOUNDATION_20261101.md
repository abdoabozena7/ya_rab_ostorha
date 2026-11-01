# GTA foundation check — 1 November 2026

This is a bounded vehicle and sensor qualification, not acceptance of GTA as a replacement for CARLA. No policy, training, demonstration recording, or route-driving work was run during this check. CARLA and its training data remain in place.

## Observed runtime

The normal unelevated `PlayGTAV.exe` launch was tested twice from a closed game. The agent used the desktop computer-use tool to select **Story**, then **Resume Story**, on each landing page. The two launches reached an advancing Story world and live capture; no physical user input was observed. This is an agent-operated launch route, not a standalone zero-interaction launcher or a saved direct-to-Story preference. A third owned launch ran the vehicle calibration.

The GTA window and the dashboard were visible together in a real desktop capture. In the main calibration capture, the game window partially overlapped the dashboard's left edge. A separate stationary live run moved the game window left with the desktop computer-use tool, leaving both the game and dashboard fully visible without overlap; its local capture is `.runtime-proof/gta-foundation-20261031/setup/layout-review-01/side-by-side-clear.png`. This arrangement is agent-operated, not a persisted window-position preference. The application could show its built-in local dashboard, though automated browser access reported that local browser use was disabled in Work settings. Screenshots are retained locally and not published in git because they also contain the user's application window.

In the calibration, native position and velocity showed 15.99 m of forward displacement, 17.76 m in reverse, and heading changes of 12.98° and 11.91° for the left and right tests. Four different real RGB views and their depth images were saved with matching native camera frame/yaw metadata. The run recorded 1,060 captures and 986 geometry observations, each sampled observation containing 1,080 rays. Observed capture intervals had 0 ms median and 16 ms maximum between the reported capture start and end timestamps; these are not end-to-end perception or driving latency claims. Lease-loss and capture-loss experiments showed braking at rest.

The current run's local evidence is under `.runtime-proof/gta-foundation-20261031/runs/native-foundation/20261101T120552-a43d26d3b8/`; inspect `foundation-result.json`, `launch-3/side-by-side.png`, `launch-3/CAM_*-metadata.json`, and the associated RGB/depth images. Earlier failed runs remain preserved. The local GTA/model runtime budget remains capped at 10,800 seconds; the ledger is `integrations/gta/downloads/native-runtime-ledger.json`.

## Supplemental native command rejection

The separately sealed `native-protocol-20261101` child exercised the unchanged foundation native bridge through real UDP sockets. A test-only wrapper around the real provider transport sent brake-only invalid packets: same-sequence replays, wrong nonce, wrong source port, expired deadline, excessively future deadline, nonfinite steering, truncated packet, and wrong protocol version. Each phase had an independently observed increase in the corresponding native rejection counter; an aggregate counter alone was insufficient. The injected camera changes and high sequence numbers were not accepted.

The actual run recorded 396 native observations and 378 captured frames. After settling, maximum measured speed was 0 m/s with zero throttle and full brake throughout. Command loss and capture loss both activated their native watchdogs; new commands and captures were acknowledged after recovery. The run reached `DONE`, closed its owned processes, restored the temporary game files, and preserved the protected file inventory. It consumed 250.281 seconds, leaving 517.562 seconds of the original aggregate allowance. A further launch requires the existing 600-second reservation; the allowance was not reset or expanded.

Eleven adversarial offline oracle tests passed separately. They reject absent phase-specific responses, a different run/process, repeated frames, accepted sentinel sequences, a changed camera, missing braking/recovery and missing measurements. They are synthetic tests of the verifier, not native evidence. Local live evidence is in `.runtime-proof/gta-foundation-20261031/setup/native-protocol-20261101/runs/native-protocol/20261101T160901-b0f1e6164c/`. This child uses the repository Prove It engine directly; the older foundation child's HarrTest seal remains preserved and is not rewritten to hide the engine mismatch.

During the separate layout review, this documentation was edited before the owned run exited. Its protected-input comparison correctly recorded this documentation file as changed; no other protected input was different, and the owned game process and installed files were cleaned up. That supplemental layout run is not represented as a clean protected-input qualification.

## Limits

- The non-overlapping desktop layout was arranged by the agent during the live test; automatic persistent window positioning has not been demonstrated.
- Screen-space depth at image edges, occlusions, all obstacle sizes, real traffic, collision-free driving, and behavior at route scale are not qualified by these stationary/open-space tests. A missing measurement is not free space. The observed far clip was 10,000 despite the script requesting 150; no claim of calibrated edge distances or equivalent real sensors follows from receiving depth pixels.
- The supplemental command-rejection result applies to `foundation_runtime.cpp`. Other native scenario/controller implementations require their own runtime qualification; this is not acceptance of every GTA bridge variant.
- Opening the game and moving the car do not establish safe urban driving, learning quality, CARLA retirement, or the original held-out route and training goals. Those remain separate unverified work.
