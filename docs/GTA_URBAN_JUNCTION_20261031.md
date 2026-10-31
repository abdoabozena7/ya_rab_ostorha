# GTA urban junction fixture — 31 October 2026

The earlier urban/local-jam milestone passed before the owner's additional
parking, motorcycle and bidirectional-crossing request. Its result must not be
used as acceptance of that later refinement; see the separate
[chaotic street report](GTA_CHAOTIC_STREET_20261031.md).

Native run `20261031T123644-0449f201d4`, PID 25144 with a non-elevated token,
retained 60 actual controlled traffic vehicles and 100 on-foot walkers. All
moved. One hundred population samples each recorded at least five visible
walkers and two visible controlled vehicles. The native road-membership band
was 6.5 m, a proxy rather than a pavement survey. Forum Dr / Grove St replaced
the airport as the user scene.

A scripted bad stop produced a measured local queue, with at least four
previously moving nearby followers slowing while at least three distant cars
continued over the fixed five-second admission interval. Peak 17 slow nearby
and 41 moving away are separate maxima, not a simultaneous observation.
Actual DirectML YOLO processed 788 of 810 RGB captures alongside depth/rays;
inference p95 was 82.900 ms, snapshot-to-result p95 141 ms. Owned cleanup,
temporary-file restoration and protected-input equality passed. Native runtime
was 231.781 s under the original shared GTA grant.

The first candidate's sparse 4.5 m alley view was rejected on actual visual
review despite its mechanical counters. That rejection and the revised source
are preserved. This milestone verified population, visible foreground and a
local bad-stop fixture. It did not verify parked rows, motorcycles, repeated
road crossings, learned ego motion, the full sensor gate, PPO training or CARLA
retirement.

[Native result](evidence/gta_urban_junction_20261031/sensor-result.json),
[population measurements](evidence/gta_urban_junction_20261031/urban.jsonl),
[sealed contract](evidence/gta_urban_junction_20261031/contract.json),
[receipt](evidence/gta_urban_junction_20261031/receipt.json),
[same-agent review](evidence/gta_urban_junction_20261031/review.json),
[earlier visual rejection](evidence/gta_urban_junction_20261031/earlier-visual-rejection.json),
[passing gate](evidence/gta_urban_junction_20261031/gate.json).

Both TODOs were verified on source digest
`6ac41f59a2e38a7bf00021f999a21ce78516276ba8235cadf5e0938871c51aea`
using the explicit Prove It gate and the same project interpreter. Raw native
sensor data and screenshots remain local/ignored in the isolated task.
