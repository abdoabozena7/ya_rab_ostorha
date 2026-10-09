# Signals and Sensors

This section contains the real sensor decoding, synchronization and radar signal screening used by the project.

## Inputs and outputs

Input: native CARLA callbacks from RGB, depth, radar, LiDAR, IMU, GNSS and collision sensors (seven actors total). Output: calibrated canonical sensor packets and synchronized simulation observations. Collision events are event driven and retain their native impulse vectors; they are not a required periodic channel.

## Algorithms and files

- `decoders.py`: RGB/depth pixel decoding, metric depth conversion, radar polar detections, LiDAR point decoding, IMU vectors and GNSS fields with explicit coordinate frames and calibration.
- `timing.py`: bounded frame synchronization, required/optional channels, completeness and timeout reporting.
- `radar.py`: calibration validation and foreground-return selection.
- `radar_retention.py`: bounded retention and screening of valid radar detections.

Depth stays 640×360 while RGB resolution follows the graphics preset. Each sensor decoder uses its own actual dimensions and intrinsics. Compatibility imports remain at `backend/carla/sensor_decoders.py`, `backend/core/timing.py` and `backend/rl/radar*.py`.

## Runtime call and demonstration

The native sensor manager in `backend/carla/sensors.py` owns callbacks and delegates decoding. `backend/core/service.py` synchronizes packets before observation publication, RULE evaluation and recording. Safety/features call the shared radar screening functions. Start the project and open Details to inspect actual frame IDs, rates, calibration and sensor errors. Open the files in this folder to explain the pipeline.

## Limits and expected questions

Why synchronize? Combining measurements from unrelated frames can create a false obstacle estimate. How are stale signals handled? The existing freshness/completeness checks remain active and may hold the car. Is minimum clearance sensed? The comparison's recorded planar clearance is a separate CARLA ground-truth measurement, not a claimed camera perception result. Collision impulse is a native contact proxy in N·s, not injury severity. Depth projection and radar filtering are approximations; they do not guarantee detection of every side collision.
