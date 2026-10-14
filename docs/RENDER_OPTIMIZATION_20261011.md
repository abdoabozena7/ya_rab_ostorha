# Simulator Display and Rendering Validation

## Changes

- The driving workspace uses the desktop width rather than a height-dependent
  narrow page limit. The inspector is 240-264 px wide.
- The camera frame uses at least 70% of desktop width and fits in the first
  viewport. The native image is contained, never stretched or cropped.
- High remains native Epic, with an 800x450 RGB camera, post-processing and
  bloom enabled. It has not been silently replaced by Low or no-rendering mode.
- Native startup writes budgeted rendering settings into CARLA's local user
  Engine.ini: texture streaming, bounded shadow cascades/resolution, reduced
  distance-field atlas size, and disabled distance-field AO and volumetric fog.
- Preset identity now survives validation, process startup and UI inspection.
  Native startup detects an early engine exit without waiting the full timeout.
- INI updates are atomic and preserve unrelated settings and duplicate native
  array entries, including when Unreal removes managed comment markers.
- D3D12 is retained. A D3D11 offscreen experiment did not keep GPU sensors alive
  and is not the production launch path.

The installed CARLA package was not edited. The original local user config is
backed up at `output/native-runtime/user-engine-before-optimization.ini`.
The modified user file is
`%LOCALAPPDATA%/CarlaUE4/Saved/Config/WindowsNoEditor/Engine.ini`.

## Measured Results

Hardware: RTX 3060 Laptop GPU, 6144 MiB VRAM; CARLA 0.9.16;
Town10HD_Opt; 40 traffic vehicles, 30 pedestrians and 7 registered sensors.

| Measurement | Previous working Low | Tuned High |
| --- | ---: | ---: |
| Sample duration | 20.7 s | 90.1 s |
| Native quality | Low | Epic |
| Native window | 1600x900 | 1280x720 |
| RGB camera | 1280x720 | 800x450 |
| Actual simulation ticks / wall second | 16.31 | 14.21 |
| GPU memory median / peak, MiB | 5871 / 5871 | 5842 / 5857 |
| GPU utilization median | 28% | 31% |
| Sensor errors | none | none |

High also passed the existing 60-second native restart verification with all
required sensors, real camera frames and an advancing native simulation.
An additional 60-second journey probe observed 38.10 m of vehicle movement,
22.14 km/h maximum speed and no sensor errors, with the same 40/30 population.
It finished paused with the temporary destination cleared. This is a rendering
smoke test, not evidence of route completion or a driving-safety evaluation.
Evidence: `output/render-optimization/high-verified/summary.json`, `samples.json`
and `camera.jpg`; restart tickets are in `output/native-runtime/`.
The journey observer is `output/render-optimization/high-drive-summary.json`;
the overlapping read-only 60-second sample recorded 13.83 ticks/wall second,
5818 MiB median VRAM and 5820 MiB peak VRAM in
`output/render-optimization/high-driving-verified/summary.json`.

These are not matched-quality before/after FPS benchmarks. They establish that
the previously failing High mode now starts and survives the measured interval.
The reduction in total observed VRAM is small. This does not establish GTA V
efficiency, 60 FPS, Ultra stability or long-duration freedom from allocation
failures. Native render FPS is not exposed; simulation tick rate is not render
FPS, and 20 sensor samples per simulation second is not 20 per wall second.
The configured texture pool is a requested engine budget, not a cap on all GPU
memory; CARLA quality commands may override individual CVars at runtime.

## Automated Verification

- Python: 232 tests run, 231 passed, one skipped.
- JavaScript: 51 tests passed; dashboard bundle rebuilt.
- Playwright: six viewport sizes from 320x720 to 1920x1080, no horizontal
  overflow; complete desktop scene fits; native image uses `object-fit: contain`.
- Live camera pixel check: 800x450 image, red-channel range 232/255 and 98%
  non-black pixels. Desktop/mobile screenshots are in `output/render-optimization/`.

## References

CARLA supports only Low and Epic native quality; their draw-distance behavior
differs. See [CARLA rendering options](https://carla.readthedocs.io/en/latest/adv_rendering_options/).
Texture streaming pool controls concern only part of total rendering memory:
[Epic UE4 texture streaming configuration](https://dev.epicgames.com/documentation/en-us/unreal-engine/texture-streaming-configuration?application_version=4.27).
