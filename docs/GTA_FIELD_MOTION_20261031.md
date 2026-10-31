# Field, moving actors and concurrent perception: blocked qualification

The bounded diagnostic in `integrations/gta/scene_probe.py` remains unaccepted.
Its sealed `gta-field-motion-20261031` task is blocked at the off-axis reference
requirement; no training, production-provider admission or CARLA retirement was
performed. The failed native records and original sources are preserved locally.

The latest complete attempt `20261031T113206-1713f0abe2` actually ran the game,
custom ASI, ReShade capture,1080 geometric rays per scan and existing DirectML
detector together. Its collected result reports:

| Observed quantity | Measurement |
| --- | --- |
| Ring targets | All8 controlled buses intersected by actual game rays |
| Ray sampling | 2-degree azimuth steps; elevations-6,-2,-.5,0,2,6degrees;100m limit |
| Native scan p95/max | 16/16ms using coarse GetTickCount64 timing |
| Moving away bus | 22.301m displacement;99 settled samples |
| Approaching bus | 20.226m displacement;99 settled samples |
| Crossing pedestrian | 13.726m displacement;101 settled samples |
| Driver/moving actors | Alive; actual settled wanted levels were0 |
| Concurrent DML | 535 unique processed images of570 captures; actual person detection required in pedestrian phase |
| Inference p95 | 108.312ms under actual game/capture/ray load |
| Native snapshot to model result p95 | 171ms; asynchronous association, not exact exposure latency |

These are measured partial results. The common acceptance check failed, so no
individual mechanically accepted full-sensor or motion-prediction claim follows.
The 38.7ms unloaded recorded-image GPU result cannot stand in for this108.3ms
concurrent result. No Trajectron/native concurrency or density60/100 was tested.

At-25/+25degrees the chosen reference rays yielded17/19 valid depth comparisons,
with maximum errors.19071/.07825m. At-15/+15degrees the same eye-height line
missed the target geometry; the first fresh-35/+35degree targets yielded only1/0
valid intersections. The required10 comparisons per angle were therefore absent.
No errors or missing references were relabeled, and no threshold was relaxed.
Whether collision-mesh openings, target setup or another geometry factor caused
the missed reference lines still needs investigation. A valid individual no-hit
ray does not establish that an entire visible vehicle or intervening volume is
free. Unsampled space and pending/failed queries remain unknown. Native actor
handles are evaluation-only, and range rate is not measured by this probe.

Earlier preserved failures include startup before a window appeared, incorrect
auxiliary log paths, escaped record separators, and a world-readiness timeout
that incorrectly fired after capture had begun. Paths/separators and the timeout
latch were corrected; the latest run reached DONE and closed the owned game
before final evidence analysis. The geometric reference failure remains real.

The owner's subsequent instructions prioritize ordinary unattended relaunches
and a narrow urban street with congestion concentrated at junctions. The
[normal launch fix](GTA_STANDARD_LAUNCH_20261031.md) has separate evidence.
Airport diagnostics do not establish the final urban scenario or full migration.
