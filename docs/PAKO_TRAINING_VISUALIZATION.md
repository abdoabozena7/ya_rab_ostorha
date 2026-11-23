# PAKO Training, Testing and Ghost Fleet

The Lab runs on the same fixed-step Metro plant, not a new game map. In City,
choose **PAKO → Training**, a workload and bounded session limits, then
**Start training**. Termination completes an episode, not the session:
the worker records the actual outcome and prepares another World. A checkpoint
contains the real policy, optimizer state and update counters. **Testing**
uses frozen weights and development validation seeds, never the untouched
evaluation set. Previous one-update workflows and checkpoints stay available.

**Ghost Fleet** buffers up to 100 actual SUV paths per session.
The overhead view draws all selected paths. The optional perspective view
places a bounded subset (up to 12) on original Metro scenery, using recorded
poses and non-colliding, color-coded SUV meshes. **Watch last chase** focuses
on the most recent completed City episode. It plays actual accepted poses for
its surrounding traffic, people and patrols on the same timeline as the SUV,
using simplified models. Positions are sampled up to ten times per second and
interpolated between samples. This is a simulator replay, not the SUV's camera
or a prediction. The latest actor recording and any older recording currently
in focus are kept in memory; the other paths remain viewable without traffic.
**Save paths** continues to export the sampled SUV paths, not the surrounding
actors. One worker can interleave up to four
independent Worlds under one shared policy. A completed batch triggers one
update; stopping mid-batch preserves the last committed checkpoint. Output
distinguishes active worlds, retained paths and gradient updates.

Solid lines and end markers come from real pose samples. Contact diamonds
use the accepted decision-end position nearest the recorded impact, not a
precisely reconstructed impact pose. Focus, pause, seek, step and playback
rate affect replay, not the training Worker or its counters. Starting a new
session begins a new playback buffer. **Save paths** exports the actual
sampled positions, episode ID, outcome, and policy attribution. It is
a trajectory record, not a full action replay. Long traces may be downsampled.

In the headed development journey, one Start in the actual Lab ran four
crossing-and-patrol episodes, committed **320 transitions, four PPO updates
and 48 Adam steps**, and displayed four distinct paths. Frozen Testing ran
two episodes with no change in updates or optimizer steps. A downloaded
checkpoint loaded into a fresh browser session and continued to update five.
In a separate staged real-plant check, one session reset after an actual
qualified escape (tick 473), wreck (tick 15), and capture (tick 178).
The no-patrol control travelled 131.5 m and did not qualify. These verify
session semantics, not improvement in chase competence.

The separate [headed capacity run](../.runtime-proof/pako-convergence-20261121/fleet-capacity-after-review/pako-browser.json)
collected **100 maneuver-practice episodes / 6,000 real transitions** in
36.16 s on this host and rendered all 100 buffered paths. During a 2.01 s
playback sample, 82 browser scene frames rendered (~40.8 FPS), browser
frame-gap p95 was 27.9 ms, and playback reached tick 128. This was an
empty-traffic training workload, not 100 parallel environments and not
dense live City performance.

The continuation's [headed batch run](../.runtime-proof/pako-city-continuation-20261121/browser-batched-01/pako-browser.json)
used two simultaneously active conditionally independent worlds in one
Worker: four finished episodes, two PPO updates, 320 transitions. The
single-world checkpoint byte identity and two-world JSON resume were
verified separately. The [final browser run](../.runtime-proof/pako-city-continuation-20261121/runs/browser/20261121T091533-9d076537cb/pako-browser.json)
matched a perspective SUV's pose to a downloaded accepted sample, with zero
physics ghost colliders, and switched between two real forecast branches.
**Compare candidate forecasts** opens the bounded JSON exported by the
offline forecast verifier. It shows matched-time paths for a patrol surface,
not full traffic replays.

Still open: full replay of every physics and sensor state, sustained multi-world
dense browser timing, and a fully validated live PAKO release at target performance.
See [acceptance](PAKO_ACCEPTANCE.md) for the distinction between implemented
controls and proven behavior.
