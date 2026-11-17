# Portable game core: camera and people phase

The active runtime is the standalone Three.js game, not a CARLA/GTA integration.
The user asked to retain the game features developed during those earlier
experiments, while making camera understanding and embodied people the current
focus. Native engine callbacks, actor commands and old acceptance results are
not portable game features merely because their names appear in this repository.

## What stays in the game

| Capability | Current standalone mechanism | Historical source and boundary |
| --- | --- | --- |
| Manual driving, steering, stop and destinations | Recorded `World.command` actions, the fixed-step vehicle, phone/place selection and A* routes | Native goal/control adapters motivated the same user outcome; [GTA goal adapter](../backend/gta/goal.py) explicitly distinguishes its measured boundary from CARLA synchronous data. No native driver is imported. |
| Independent collision clearance | Existing swept/nonpenetrating geometry, safety arbitration and measured virtual ranges | Preserve the separation between forecast and safety in [the paired-prediction design](PREDICTIVE_COLLISION_AVOIDANCE_V2.md). Native depth/scan measurements do not become camera observations. |
| Seed, density, scheduled encounters and replay | Seeded `World`, explicit scenario commands and recorded events reconstructed through the actual fixed-step core | The reproducible recipes in [Egypt Urban Chaos](EGYPT_URBAN_CHAOS_V1.md) are design evidence, not a portable native population manager. A requested encounter still needs an observed outcome. |
| Actual camera recognition | Dedicated vehicle-front RGB capture, installed local YOLOX and strict pixel/calibration/ego envelope | [Historical camera evidence](GTA_CHAOTIC_STREET_20261031.md) and its local detector work informed the boundary. Its native camera frames and old model results are not current Three.js evidence. |
| Matching image and interpretation | The Camera screen pairs raw/annotated views by exact stream/frame identity; stale or missing images cannot inherit old boxes | Reuses the frame-decoding and matching principle of [the former perception view](../frontend/perception-view.js), not its simulator endpoint. |
| Motion history versus forecast | Observed pixel-derived tracks, bounded fitted future estimates and an independent applied-control reason | [The former prediction view](../frontend/prediction-view.js) separated camera projection from trajectories. The current predictor uses its own actual camera convention and admits no other-actor truth. |
| Visible car and instrumentation | Original faceted SUV, cockpit/running gear, ten virtual proximity mounts, front/rear cameras and local contact/repair bay | Kept as working game components. They are not calibrated hardware or soft-body crashworthiness models. |
| Human motion inspection | Existing articulated local human assets, body descriptors, bounded movement, distance-linked gait and explicit World-reference controls | Reuses the observed walk/wait/cross goals in [the earlier field-motion work](GTA_FIELD_MOTION_20261031.md). Native walker/task APIs are not imported, and diagnostic actor values never enter visual prediction. |

These are functional mappings, not a statement that every feature or native
experiment has passed. Current acceptance must exercise the actual browser
entrypoint, not approve a list of historical feature names.

## What is deliberately not merged as active behavior

- **New narrow Egyptian streets and alleys:** the user placed the road-network
  redesign in a later step. The current registered road/collision/navigation
  layout remains the authority.
- **Full chaotic crowd/traffic policy:** richer yielding, hesitation, sudden
  entry, cut-ins, reversing and congestion behaviors require their own physical
  scenarios and false-brake controls. The existing deterministic city/scenarios
  remain available; old native scenario schedules are not claimed as new
  standalone behavior.
- **Native sensor and engine lifecycle:** CARLA/GTA actor handles, synchronous
  ticks, depth surfaces, watchdogs, native admission and protected budgets stay
  historical and inactive.
- **Learned-model promotion:** saved Q/GRU policies and the existing Trajectron++
  runtime remain explicitly scoped experiments. A runnable model or an unranked
  crossing alternative does not establish that somebody will cross.

## Reading the camera honestly

Raw pixels, semantic detection scores, observed motion, future estimates and
the applied vehicle action are different evidence. Detector confidence is not
a calibrated probability of a person's intention. No OCR/text-reading feature
is claimed. World-reference body/speed values are for inspection and validation,
not facts inferred by the camera.

See [the exact vision boundary and limits](VISION_FIRST.md). Human movement is
a grounded kinematic game approximation with bounded ordinary acceleration,
braking and turning, not validated biomechanics, force dynamics or ragdolls.
