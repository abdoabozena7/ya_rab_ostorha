import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STEP } from "../src/core/config.js";
import { distance } from "../src/core/geometry.js";
import { AGGRESSIVE_CHASE_PRESENCE } from "../src/core/pako-aggressive-police.js";
import { METRO_CITY_CURBS } from "../src/core/pako-curb.js";
import { PATROL_LATERAL_YIELD } from "../src/core/pako-patrol-yield.js";
import { CITY_FAIR_POLICE, CITY_PACK_PRESSURE, TACTICAL_PURSUIT_MODE } from "../src/core/pako-tactical-police.js";
import { OBSERVED_CORRIDOR_MEMORY } from "../src/core/pursuit-controls.js";
import { DISPATCH_DAMAGE_FEEDBACK, PATROL_TRAFFIC_PREVIEW } from "../src/core/pursuit-gta.js";
import { KING_LONG_MICROBUS_ID } from "../src/core/vehicle-spec.js";
import { World } from "../src/core/world.js";
import { SMART_ESCAPE_CONTROL } from "../src/rl/pako-smart-escape.js";
import { applyFrozenDispatchAction } from "../src/rl/pursuit-controller.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set PROVE_IT_OUTPUT_DIR to a fresh evidence directory.");
const incumbent = process.argv.includes("--incumbent");
const bytes = await readFile(new URL("../public/threejs/pako-chase-ppo.json", import.meta.url));
const sha256 = createHash("sha256").update(bytes).digest("hex");
assert.equal(sha256, "181705df35baa1c9cee3a9b78a2ab231c5c25123deb1a1aa76c171486a148608");
const policy = freezePursuitPolicy(JSON.parse(bytes));
const defaultConfig = {
  ruleset: "dispatch-v1", wantedLevelMax: 5, maxActivePatrols: 14, curbSupport: METRO_CITY_CURBS,
  damageFeedback: DISPATCH_DAMAGE_FEEDBACK, chasePresence: AGGRESSIVE_CHASE_PRESENCE,
  tacticalPursuit: TACTICAL_PURSUIT_MODE, policeFairness: CITY_FAIR_POLICE,
  cityPackPressure: CITY_PACK_PRESSURE, patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW,
  patrolChainYield: PATROL_LATERAL_YIELD,
};
const ticks = s => Math.round(s / STEP);
const pose = body => ({ x: body.x, z: body.z });
const rows = [];

function episode(seed, candidate) {
  const world = new World({ seed, cityVersion: 5 }, "metro");
  assert.ok(world.command({ type: "player-vehicle", model: KING_LONG_MICROBUS_ID }).changed);
  const original = [...world.actors];
  world.command({ type: "street-pursuit-start", level: 5, variant: "gta",
    config: candidate ? { ...defaultConfig, routeMemory: OBSERVED_CORRIDOR_MEMORY } : defaultConfig });
  const { player, pursuit: run } = world;
  const driver = { policy, sha256, status: "active", lastTick: -1, decisions: 0,
    recoverStale: true, evasion: true, evasiveControl: SMART_ESCAPE_CONTROL };
  run.frozenDriver = driver;
  const poses = [], changes = [], bumps = [];
  let earlyM, lateEntry, goalKey, nitroViolations = 0, lowSpeedTicks = 0, reverseDecisions = 0;
  let contacts = 0, lastDecisionCount = 0;
  while (world.tick < ticks(120) && run.phase === "running") {
    applyFrozenDispatchAction(world, driver);
    world.step();
    const goal = run.gta.escapeGoal;
    if (goal?.id !== goalKey) {
      goalKey = goal?.id;
      changes.push({ tick: world.tick, id: goalKey, roadId: goal?.roadId, ...pose(player) });
    }
    if (run.metrics.collisions > contacts) {
      bumps.push({ tick: world.tick, impact: run.metrics.impact, ...pose(player) });
      contacts = run.metrics.collisions;
    }
    nitroViolations += Number(player.nitroActive && player.nitroSuppressedByPedestrian);
    if (world.tick === ticks(18)) earlyM = run.metrics.distanceM;
    if (world.tick === ticks(110)) lateEntry = pose(player);
    if (world.tick > ticks(110)) {
      lowSpeedTicks += Number(Math.abs(player.speed) < 1);
      if (lastDecisionCount !== driver.decisions) reverseDecisions += Number(run.manualAction?.gear === -1);
    }
    if (world.tick % ticks(.5) === 0)
      poses.push({ tick: world.tick, ...pose(player), speed: player.speed,
        plan: driver.lastDecision?.planner?.maneuver ?? null });
    lastDecisionCount = driver.decisions;
  }
  const { metrics } = run;
  const stats = {
    seed, candidate, seconds: world.tick * STEP, phase: run.phase, decisions: driver.decisions,
    escaped: run.phase === "escaped" && run.response.dispatch.escapeEligible === true,
    earlyM: earlyM ?? metrics.distanceM, distanceM: metrics.distanceM,
    lateNetM: lateEntry ? distance(lateEntry, player) : 0,
    lateLowSpeedS: lowSpeedTicks * STEP, lateReverseDecisions: reverseDecisions,
    impacts: metrics.collisions, pedestrianImpacts: metrics.pedestrianCollisions,
    civilianImpacts: metrics.civilianVehicleContacts, ambientContacts: metrics.trafficCollisions,
    nitroViolations, sameCity: original.every(actor => world.actors.includes(actor)), bumps, changes, poses,
  };
  assert.equal(driver.status, "active", `${seed} controller error: ${driver.error ?? driver.status}`);
  assert.ok(stats.sameCity && world.capacity.traffic === 68 && world.capacity.pedestrians === 190);
  console.log(JSON.stringify({ ...stats, poses: undefined, changes: undefined }));
  return stats;
}

for (const seed of incumbent ? ["cairo-42"] : ["cairo-42", "metro-pressure-market"]) {
  const baseline = episode(seed, false);
  const candidate = incumbent ? baseline : episode(seed, true);
  rows.push({ baseline, candidate });
}
const report = {
  engine: "fresh standalone World with actual frozen shipped PPO; no rendering, training or real vehicle",
  sha256, seeds: rows.length, incumbent,
  improvementM: rows[0].candidate.lateNetM - rows[0].baseline.lateNetM,
  worseContactCases: rows.filter(({ baseline, candidate }) => ["impacts", "pedestrianImpacts", "civilianImpacts"]
    .some(field => candidate[field] > baseline[field])).length,
  earlyRegressions: rows.filter(({ baseline, candidate }) => candidate.earlyM < baseline.earlyM * .95).length,
  nitroViolations: rows.reduce((total, { candidate }) => total + candidate.nitroViolations, 0),
  rows,
};
await writeFile(join(output, "route-memory.json"), `${JSON.stringify(report, null, 2)}\n`);
assert.ok(report.improvementM >= 10, "No qualifying improvement in the late recovery window");
assert.equal(report.worseContactCases, 0, "Candidate increased player contacts");
assert.equal(report.earlyRegressions, 0, "Candidate regressed early progress");
assert.equal(report.nitroViolations, 0, "Pedestrian Nitro hold was violated");
