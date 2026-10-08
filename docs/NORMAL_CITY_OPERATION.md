# Living city operation

The dashboard uses native CARLA 0.9.16. See [Gate 4 evidence](GATE4_NATIVE_VALIDATION.md),
[the journey extension](JOURNEY_PERCEPTION_VALIDATION.md), and the Gate 5 report
for checkpoint-specific validation. All current controls are in English.

## Start and drive

Launch `scripts/launch_carla.ps1`, then run:

```powershell
.\.venv-carla\Scripts\python.exe -m backend.server --carla --sensors --start-paused
```

Open http://127.0.0.1:8000/. A connection is separate from driving permission.
The ego starts braked, with cameras operating. Enable manual driving, then use
physical W/A/S/D. Shift+W requests full throttle; Shift alone does nothing.
S brakes before reverse. Space requests handbrake. D/N/R selects the gear.
Typing in a field, opening a dialog, losing focus or losing the command lease
stops driving. Stop driving brakes the ego while the surrounding world continues.
Emergency stop latches until acknowledged; acknowledgement does not resume
motion. Take control transfers command ownership to this page.

Choose a destination from the list or native road map. Route selection does not
move the car. Go to destination explicitly uses the existing official BasicAgent
with a 5–30 km/h target, bounded by the lower road speed limit. Manual intervention
stops the journey and preserves its goal. Resume replans from the live ego.
Clear route removes the goal. This baseline controller is separate from the
prepared YA RAB OSTORHA safety-policy interface.

## Population

Counts require explicit application; saved preferences never populate a new
session automatically. Actual counts come from native snapshots. Clear traffic,
clear pedestrians, respawn and clear all population use the ownership manager.
Native actor removals and failed spawn attempts remain visible.

Gate 5 provides NORMAL, BUSY, AGGRESSIVE and UNREGULATED driver mixtures with
stable per-actor settings. SLOW/NORMAL/FAST are reference desired-speed modifiers
of 30/15/0 percent below road limits; individual profiles add recorded variation.
Every profile retains vehicle and walker collision awareness and full physics.
Lane-change probabilities are small per-step probabilities. Light compliance
limits violation probability for applicable profiles; NORMAL and BUSY drivers
obey signals. These settings are not collision-avoidance guarantees.

Initial explicit population creation prioritizes native road/navmesh positions
near the ego. Replacements stay at least 90 m away. Bounded retirement occurs
beyond 300 m. Route points bias road selection. Existing actors never teleport.
Walkers use valid native destinations, 0.9–1.9 m/s speeds, staggered starts,
waiting and reselection. Optional crossing targets use a nearby valid sidewalk endpoint across a
confirmed native driving lane. Native navigation decides whether and when it can execute that
path. Complex group formation and idle animation are not implemented. Walker
invincibility is inherited from Gate 4; native ego collision events remain
observable, but injury modeling is not supported.

## Settings and lifecycle

| Control | Application |
|---|---|
| Five camera views | Move existing aligned RGB/depth sensors |
| Image expansion and appearance | Display only |
| Camera resolution/FOV/effects | Live; stopped ego required; recreate sensors |
| Vehicle/spawn | Live; stopped ego required; clean owned actors |
| Weather | Native preset or native fields |
| 10/20 simulation Hz | Live; stopped ego required; recreate matching sensors |
| Population | Explicit live application |
| Graphics quality/window resolution | Save then managed engine/backend restart |
| Nearby actors | Privileged diagnostic ground truth |
| Render FPS | Unavailable |

Low graphics may ignore camera effects. Sensor JPEG quality is 95. Offscreen
rendering preserves GPU camera output. Steps per wall second and renderer FPS
are different measurements. Profile changes never silently change sensors or
scenario difficulty.

End session cleans owned vehicles, walkers, controllers and sensors and restores
world settings. Reconnect starts stopped without population. Map reload retires
the SDK backend and restarts the engine through the existing supervisor. Avoid
in-process reload on this Windows/DX12 installation.

## Recording and replay

Recording stores canonical real frames, control, collision events, population,
privileged diagnostics and separate RGB/depth/LiDAR assets. Finish recording
before reconfiguring sensors or changing environment modes. Sensor assets can
consume substantial disk space and reduce throughput. Replay reads completed
real runs with CARLA stopped; driving, reconnect and scenario actions are
unavailable. Historical recordings and evidence hashes remain unchanged.
