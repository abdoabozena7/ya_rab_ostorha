import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { STEP } from "../src/core/config.js";
import { gtaLocal, gtaVelocity } from "../src/core/pursuit-gta.js";
import { GtaPursuitEnv } from "../src/rl/gta-pursuit-env.js";
import { forecastPursuitSurface } from "../src/signal_processing/pursuit-scanner.js";

const env = new GtaPursuitEnv();
env.reset({ seed: "pako-motion-qualification", scenario: "L01", traffic: 0, pedestrians: 0, shield: true,
  config: { ruleset: "dispatch-v1", wantedLevelStart: 1, wantedLevelMax: 1, maxActivePatrols: 1, episodeMaxSeconds: 2 } });
const { world } = env, [patrol] = world.pursuit.patrols;
const action = { throttle: 0.8, steer: 0, brake: 0, gear: 1 };
const selectRear = () => world.pursuit.gta.scan.tracks.find(track => track.kind === "police" && track.forwardM < -3);
assert.ok(patrol);
assert.equal(forecastPursuitSurface(selectRear()).status, "motion-unresolved");

const recorded = [], comparisons = [], ttcErrors = [];
while (world.tick < 84 && world.pursuit.phase === "running") {
  env.step(action);
  const tick = world.tick;
  for (const { issueTick, anchor, trackId, forecast } of recorded) {
    for (const point of forecast.points) {
      if (tick !== issueTick + Math.round(point.secondsAhead / STEP)) continue;
      const h = patrol.heading;
      const actual = { xM: patrol.x + Math.cos(h) * anchor.right + Math.sin(h) * anchor.forward,
        zM: patrol.z - Math.sin(h) * anchor.right + Math.cos(h) * anchor.forward };
      const errorM = Math.hypot(point.xM - actual.xM, point.zM - actual.zM);
      comparisons.push({ issueTick, tick, trackId, forecast: point, actual, errorM, withinAllowance: errorM <= point.allowanceM });
    }
  }
  const track = selectRear();
  if (!track?.motionKnown || track.ageS || tick > 54) continue;
  const forecast = forecastPursuitSurface(track);
  assert.ok(forecast.points.every((point, i) => !i || point.allowanceM >= forecast.points[i - 1].allowanceM));
  const anchor = gtaLocal(patrol, { x: track.observedXM, z: track.observedZM });
  const egoV = gtaVelocity(world.player), patrolV = gtaVelocity(patrol);
  const dx = track.observedXM - world.player.x, dz = track.observedZM - world.player.z;
  const closing = -((patrolV.x - egoV.x) * dx + (patrolV.z - egoV.z) * dz) / Math.hypot(dx, dz);
  if (track.ttcS !== null && closing > 0) {
    const actualTtcS = Math.hypot(dx, dz) / closing;
    if (actualTtcS < 6) ttcErrors.push({ tick, observedS: track.ttcS, instantaneousReferenceS: actualTtcS });
  }
  recorded.push({ issueTick: tick, trackId: track.trackId, anchor, forecast });
}
const short = comparisons.filter(row => row.forecast.secondsAhead === .5);
assert.ok(short.length >= 4 && ttcErrors.length >= 3, "Insufficient independently scored closing-tail forecasts");
assert.ok(new Set(short.map(value => value.trackId)).size < short.length, "Track IDs were not carried across samples");
const summarize = seconds => {
  const rows = comparisons.filter(value => value.forecast.secondsAhead === seconds);
  return { seconds, n: rows.length, meanErrorM: rows.length ? rows.reduce((sum, row) => sum + row.errorM, 0) / rows.length : null,
    covered: rows.filter(row => row.withinAllowance).length };
};
const report = { setup: "L01 tail with sustained legal forward motion; transform the initial observed surface point with future patrol poses",
  tick: world.tick, position: [.5, 1, 2, 3, 5].map(summarize), comparisons, ttcErrors,
  meanInstantaneousTtcErrorS: ttcErrors.reduce((sum, row) => sum + Math.abs(row.observedS - row.instantaneousReferenceS), 0) /
    ttcErrors.length };
if (process.env.PROVE_IT_OUTPUT_DIR)
  writeFileSync(join(process.env.PROVE_IT_OUTPUT_DIR, "motion-forecast.json"), JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ position: report.position, meanInstantaneousTtcErrorS: report.meanInstantaneousTtcErrorS }));
assert.ok(report.position[0].meanErrorM < 1.8, "Short-horizon forecast was too inaccurate in the controlled rear approach");
