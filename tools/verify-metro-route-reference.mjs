import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { clamp } from "../src/core/config.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { planDistrictRoute } from "../src/core/district-navigation.js";
import { bodyOnRoad, distance } from "../src/core/geometry.js";
import { PURSUIT_STOP } from "../src/core/pursuit-controls.js";
import { followPath } from "../src/core/vehicle.js";
import { isDispatchIncident, resetPursuitEpisode } from "../src/rl/pursuit-rollouts.js";
import { summarizeMetroArm } from "./evaluate-metro-pursuit.mjs";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set a new proof output directory");
const digest = value => createHash("sha256").update(value).digest("hex");
const priorSha256 = "ea75a17ac2664fef321a8cc65503a47f678a64fa910e8d1002adef25d893066c";
const prior = await readFile(new URL(
  "../.runtime-proof/pursuit-rl-contact-margin-20261120/paired-development-20261120-231118/development-pairs.json", import.meta.url));
assert.equal(digest(prior), priorSha256);
const original = JSON.parse(prior);

function smooth(value) {
  const u = clamp(value, 0, 1);
  return u * u * (3 - 2 * u);
}

// Offline comparison only. The controller receives the public map and its own vehicle data;
// every arm uses the unmodified independent scan guard in the shared environment.
function reference(district, ego) {
  const road = district.drivingRoads.find(road => road.id === "civic-avenue");
  assert.ok(road);
  const goal = { ...districtRoadPose(road, 78, 1), roadId: road.id };
  const base = planDistrictRoute(district, ego, goal);
  assert.ok(base.length > 10);
  const path = Object.freeze(base.map(({ x, z }) => {
    const shift = Math.abs(x - goal.x) < .02 ? 2.35 * smooth((z + 82) / 42) * smooth((77 - z) / 18) : 0;
    return Object.freeze({ x: x - shift, z });
  }));
  let cursor = 0, parked = false;
  return { pathSha256: digest(JSON.stringify(path)), action(player) {
    const command = followPath(player, path, cursor);
    cursor = command.cursor;
    const cruise = player.z > -88 && player.z < 78 ? 7 : 16;
    const target = Math.min(cruise, command.targetSpeed);
    const brake = clamp((player.speed - target) / 2.5, 0, 1);
    parked ||= player.z > goal.z - 1.6 && distance(player, goal) < 1.65;
    return parked ? PURSUIT_STOP : { steer: clamp(command.steer / player.spec.maxSteer, -1, 1),
      throttle: brake ? 0 : clamp((target - player.speed) / 1.8, 0, 1), brake, gear: 1 };
  } };
}

async function exercise({ seed, level, traffic, pedestrians, patrols, kind }) {
  const { env } = resetPursuitEpisode({ observation: "dispatch-route-v2", wantedLevel: level,
    wantedLevelMax: level, patrols, traffic, pedestrians, episodeSeconds: 120 }, seed);
  const { world } = env, { player, pursuit } = world;
  const { action, pathSha256 } = reference(world.district, player);
  const ambient = world.actors.filter(a => a !== player && !pursuit.patrols.has(a)).map(a => [a, a.id, a.type]);
  assert.equal(ambient.filter(row => row[2] === "vehicle").length, traffic);
  assert.equal(ambient.filter(row => row[2] === "pedestrian").length, pedestrians);
  const trace = [], incidents = [], motion = createHash("sha256"), patrolsSeen = new Set();
  let firstLost = null, peakPatrolM = 0, samples = 1, step;
  do {
    step = env.step(action(player));
    for (const unit of pursuit.patrols) patrolsSeen.add(unit);
    for (const unit of patrolsSeen) peakPatrolM = Math.max(peakPatrolM, unit.distance);
    const present = new Set(world.actors.filter(a => a !== player && !pursuit.patrols.has(a)));
    assert.ok(present.size === traffic + pedestrians && ambient.every(([a, id, type]) =>
      present.has(a) && a.id === id && a.type === type));
    assert.ok([player.x, player.z, player.heading, player.speed].every(Number.isFinite));
    assert.ok(bodyOnRoad(player, world.roads));
    const { state, lastReportTick } = pursuit.response.dispatch;
    firstLost ??= state === "LOST" ? world.tick : null;
    const row = [world.tick, player.x, player.z, player.speed, player.heading, step.info.appliedCommand];
    motion.update(JSON.stringify(row));
    incidents.push(...step.info.events.filter(isDispatchIncident));
    if (world.tick % 60 === 0 || step.terminated || step.truncated)
      trace.push([...row, step.info.shield.reason, state, lastReportTick]);
    samples++;
  } while (!step.terminated && !step.truncated);
  assert.equal(samples, Math.ceil(world.tick / 6) + 1);
  const measurements = { kind, seed, level, traffic, pedestrians, patrols, samples, pathSha256,
    phase: pursuit.phase, ticks: world.tick, pursuitQualified: pursuit.response.dispatch.escapeEligible,
    distanceM: pursuit.metrics.distanceM, firstLost, peakPatrolM, collisions: pursuit.metrics.collisions,
    nearMisses: pursuit.metrics.nearCollisions, pedestrianImpacts: pursuit.metrics.pedestrianCollisions,
    ambientCollisions: pursuit.metrics.trafficCollisions, ambientPedestrianImpacts: incidents.filter(event =>
      event.type === "ambient_collision" && [event.first, event.second].some(body => body.type === "pedestrian")).length,
    digest: motion.digest("hex"), trace, incidents };
  await appendFile(join(output, "episodes.ndjson"), JSON.stringify(measurements) + "\n");
  const { trace: _trace, incidents: _incidents, ...summary } = measurements;
  console.log(JSON.stringify(summary));
  return measurements;
}

const capability = await exercise({ seed: "route-train-00", level: 5, traffic: 96, pedestrians: 144,
  patrols: 12, kind: "historical-training-capability" });
const inactive = await exercise({ seed: "route-reference-inactive-development", level: 5, traffic: 0, pedestrians: 0,
  patrols: 0, kind: "inactive-patrol-control" });
const rows = [];
for (const { seed, level, density, arms } of original.results) {
  assert.ok(["city-route-dev-eval-00", "city-route-dev-eval-01"].includes(seed) && [3, 5].includes(level));
  const [traffic, pedestrians] = density === "dense" ? [96, 144] : [36, 80];
  const routeReference = await exercise({ seed, level, traffic, pedestrians, patrols: level === 5 ? 12 : 7,
    kind: "matched-development" });
  rows.push({ seed, level, density, arms: { ...arms, routeReference } });
}
const summarize = arms => Object.fromEntries(arms.map(arm =>
  [arm, summarizeMetroArm(rows.map(row => row.arms[arm]))]));
const report = { classification: "development-only reference; original untouched protocol unchanged",
  priorSha256, node: process.version, v8: process.versions.v8, casesCompared: rows.length, capability, inactive,
  totals: summarize(["frozen", "untrained", "scripted", "routeReference"]), rows };
await writeFile(join(output, "route-reference.json"), JSON.stringify(report, null, 2), { flag: "wx" });
assert.equal(rows.length, 4);
assert.ok(capability.phase === "escaped" && capability.pursuitQualified && !capability.collisions &&
  capability.peakPatrolM > 3 && rows.every(row => row.arms.routeReference.peakPatrolM > 3));
assert.ok(inactive.phase === "timeout" && !inactive.pursuitQualified && inactive.distanceM > 100 &&
  inactive.firstLost > 0 && !inactive.collisions && inactive.peakPatrolM === 0);
