# Gate 5 preservation audit

Date: 8 October 2026 (Africa/Cairo). Starting HEAD: `2896e6f` on
`codex/live-native-validation`; clean working tree. Preservation tag:
`gate5-prechange-20261008`. Gate 4 checkpoint `bede5a0` is its parent.

The current implementation retains seven native sensors, synchronized canonical
frames, manual command admission, ControlSafetyLayer, CommandArbiter, recording,
offline Replay, owned population cleanup and managed engine/SDK restart. The
later commit already supplies a destination BasicAgent and read-only perception;
these are preserved, not developed as part of Gate 5. Historical reports describe
their own checkpoint and are not assumed to describe current defects.

Population uses native TM, full physics and passenger blueprints. All drivers
currently use the same following gap, speed modifier and compliance settings;
lane changes are disabled. Walkers have native controllers, same-sidewalk
destinations, varied speeds and bounded retarget/replacement. Population counts
come from snapshots. Native removals are reported. Replenishment excludes 45 m
around ego. Global randomized spawn points do not prioritize useful local density.

Existing route, experiment, lifecycle, recording, collision and evaluation
contracts are reusable. SimulationFrame contains privileged ground truth and
must not become the deployed policy input. No RL policy exists.

Prechange regression: 127 Python tests, one failure and one skip; 24 JavaScript
passes. The failure was a stale API test expecting the source dashboard script
after HEAD switched to the built bundle. The assertion now checks the actual
entry point. No simulation behavior was changed for this repair.

Installed CARLA Python API exposes the per-actor TM methods required for driver
profiles. Native server validation is recorded separately in the Gate 5 report.
Detected physical RAM: 16,371,494,912 bytes (15.25 GiB usable). Previous evidence
used the RTX 3060 Laptop GPU with 6144 MiB VRAM; current measurements will be
reported from the running machine. No actor budget will be raised before a
native benchmark. The current engine uses Low/D3D12 at 1280x720.

The active dashboard and some diagnostics still contain Arabic text. Gate 5
will translate these to English while preserving layout and behavior. Historical
evidence hashes and recorded data will remain intact.
