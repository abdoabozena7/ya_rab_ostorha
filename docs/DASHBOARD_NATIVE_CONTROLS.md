# Historical dashboard control milestone

These instructions describe the dashboard milestone before Gate 4. Current
operation is in [Living city operation](NORMAL_CITY_OPERATION.md). Historical
results remain in [Dashboard V2 validation](DASHBOARD_V2_VALIDATION.md). The later
keyboard/journey extension is documented in [Journey validation](JOURNEY_PERCEPTION_VALIDATION.md).

The dashboard connected to CARLA 0.9.16 and reused safety, recording and
synchronization. Manual controls, explicit destination journeys, emergency stop,
command ownership, native cameras, weather, map topology, saved places,
recording and managed graphics restart were introduced. Later milestones changed
population controls, removed on-screen pedals and restored explicit BasicAgent
journeys. Use checkpoint-specific evidence to reproduce historical behavior.

CARLA owns vehicle motion and camera data. Dashboard maps show 2D native road
topology. Route selection alone never moves the ego. Privileged actor inspection
is diagnostic data, separate from camera inference. The prepared YA RAB OSTORHA
policy is not an active learned controller. Raw evidence and recordings remain
preserved; the current project uses English text.
