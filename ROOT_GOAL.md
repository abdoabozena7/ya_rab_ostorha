# Active goal: continue the standalone Three.js game

On 16 November 2026 the user changed direction: recover the earlier Three.js
driving game, make it the canonical `main` project and continue without CARLA,
GTA, BeamNG or another external simulator.

The active implementation is `src/` with the isolated
`python -m backend.threejs.server` entrypoint. See the current [README](README.md)
and [contributor instructions](AGENTS.md). Recovering this baseline does not
declare the unfinished game complete or certify its safety.
