import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clamp } from "../src/core/config.js";
import { initializeDistrictActor } from "../src/core/district-behavior.js";
import { planDistrictRoute } from "../src/core/district-navigation.js";
import { bodyOnRoad, corners, distance, overlaps } from "../src/core/geometry.js";
import { gtaLineClear } from "../src/core/pursuit-response.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { followPath } from "../src/core/vehicle.js";
import { World } from "../src/core/world.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";
import { applyFrozenDispatchAction } from "../src/rl/pursuit-controller.js";
import { resetPursuitEpisode } from "../src/rl/pursuit-rollouts.js";
import { guardDispatchAction } from "../src/rl/pursuit-shield.js";

const drive = { steer: 0, throttle: 1, brake: 0, gear: 1 };
const hold = { ...drive, throttle: 0, brake: 1 };
const contacts = new Set(["static_or_civilian_hit", "patrol_collision"]);
const mediumSeeds = ["route-dev-eval-00", "route-dev-eval-01"];

function start({ seed, level = 3, patrols = 7, counts = [36, 80], pose, closed, untracked, loading, screen }) {
  const [traffic, pedestrians] = counts;
  const world = new World({ cityVersion: 4, seed, traffic, pedestrians, chaos: 0 }, "metro");
  if (pose) Object.assign(world.player, pose);
  if (closed || untracked || screen) {
    world.statics.push({ type: "static", kind: "barrier", length: 1, height: 1,
      ...(closed ? { id: "opening-check-closed-civic", width: 12, x: -183, z: -103, heading: 0 }
        : { id: "opening-check-screen", width: 14, x: -252, z: -112, heading: Math.PI / 2 }),
      ...screen });
    world.staticIndex = new SpatialIndex(world.statics);
  }
  if (loading) {
    const road = world.drivingRoads.find(road => road.id === "civic-avenue");
    for (const x of [-187, -183, -179]) {
      const van = world.makeVehicle(`opening-loading-${x}`, "van", { x, z: -96, heading: Math.PI / 2 });
      Object.assign(van, { length: 3.8, width: 1.8 });
      initializeDistrictActor(world, van);
      Object.assign(van.district, { nextLoadingDistanceM: Infinity, loadingUntilTick: 1200 });
      assert.ok(bodyOnRoad(van, [road]) && ![...world.statics, ...world.actors]
        .some(other => overlaps(van, other, .08)));
      world.actors.push(van);
    }
    world.actorIndex = new SpatialIndex(world.actors);
  }
  const originals = [...world.actors];
  world.command({ type: "street-pursuit-start", level, variant: "gta", config: {
    ruleset: "dispatch-v1", wantedLevelStart: level, wantedLevelMax: level, maxActivePatrols: patrols,
    episodeMaxSeconds: 30,
    ...(untracked ? { surveillanceZones: [{ id: "far", minX: 10, maxX: 20, minZ: 10, maxZ: 20 }] } : {}),
  } }, false);
  return { world, originals };
}

function sample(world, ticks, select, guarded = true) {
  const { player, pursuit } = world, initial = [...pursuit.patrols];
  const starts = initial.map(unit => ({ unit: unit.unitType, radius: distance(player, unit), maxSpeed: unit.maxSpeed }));
  const events = [], reasons = new Set(), blocks = [];
  let maxSpeed = 0, northM = 0, tracking = 0, stoppedAtBlock = 0, block = null;
  let closestPatrolM = Infinity;
  const startingZ = player.z;
  while (world.tick < ticks && pursuit.phase === "running") {
    if (world.tick % 6 === 0) {
      const requested = select(player);
      const result = guarded ? guardDispatchAction(world, requested) : { action: requested };
      if (result.reason) reasons.add(result.reason);
      world.command({ type: "pursuit-drive", action: result.action }, false);
    }
    const before = { x: player.x, z: player.z };
    const staticIndex = world.staticIndex;
    world.step();
    const current = pursuit.gta.roadblock;
    if (current && current !== block) {
      block = current;
      const shapes = [...block.cars, block.barrier];
      const beforeMap = { staticIndex, statics: world.statics.filter(body => body !== block.barrier) };
      const footprints = shapes.flatMap(body => [body, ...corners(body)]);
      blocks.push({ tick: world.tick, x: block.barrier.x, z: block.barrier.z, detour: block.detour,
        ids: shapes.map(body => body.id), range: Math.min(...footprints.map(point => distance(before, point))),
        visible: footprints.some(point => distance(before, point) <= 55 &&
          gtaLineClear(beforeMap, before, point.x - before.x, point.z - before.z, distance(before, point))) });
    }
    if (block && Math.abs(player.speed) < .05 && distance(player, block.barrier) < 10) stoppedAtBlock++;
    tracking += Number(pursuit.response.lastSeen?.tick === world.tick);
    for (const unit of pursuit.patrols) {
      maxSpeed = Math.max(maxSpeed, Math.abs(unit.speed));
      closestPatrolM = Math.min(closestPatrolM, distance(player, unit));
    }
    northM = Math.max(northM, player.z - startingZ);
    events.push(...pursuit.stepEvents.filter(event => contacts.has(event.type)));
  }
  return { phase: pursuit.phase, x: player.x, z: player.z, speed: player.speed, distanceM: pursuit.metrics.distanceM,
    contacts: pursuit.metrics.collisions, maxSpeed, unitTravelM: initial.map(unit => unit.distance),
    starts, tracking, northM, blocks, blockCount: blocks.length, stoppedAtBlock, reasons: [...reasons], events,
    closestPatrolM, ticks: world.tick };
}

function opening(seed, level, counts) {
  const { world, originals } = start({ seed, level, counts, patrols: level === 5 ? 12 : 7 });
  const result = sample(world, 240, () => drive);
  const retained = originals.every(actor => world.actors.includes(actor));
  const actualPopulation = [
    originals.filter(actor => actor !== world.player && actor.type === "vehicle").length,
    originals.filter(actor => actor.type === "pedestrian").length,
  ];
  return { seed, level, actualPopulation, retained, drive: result };
}

function laneController(path, body) {
  let cursor = 0;
  return ego => {
    const next = followPath(ego, path, cursor);
    cursor = next.cursor;
    const target = Math.min(11, next.targetSpeed);
    const brake = clamp((ego.speed - target) / 2.5, 0, 1);
    return { steer: clamp(next.steer / body.spec.maxSteer, -1, 1),
      throttle: brake ? 0 : clamp((target - ego.speed) / 1.8, 0, 1), brake, gear: 1 };
  };
}

const opened = mediumSeeds.map(seed => opening(seed, 3, [36, 80]));
const high = opening(mediumSeeds[1], 5, [96, 144]);
const pose = { x: -226, z: -109.3, heading: Math.PI / 2, speed: 8 };
const setup = { seed: "route-train-00", patrols: 3, counts: [0, 0], pose };
const alternateWorld = start(setup).world;
const path = planDistrictRoute(alternateWorld.district, alternateWorld.player,
  { x: -185.5, z: -88, heading: 0, roadId: "civic-avenue" });
assert.ok(path.length > 10, "The separately chosen physical route must exist");
const alternate = sample(alternateWorld, 780, laneController(path, alternateWorld.player));
const straightWorld = start(setup).world;
const straight = sample(straightWorld, 780, () => ({ ...drive, throttle: .65 }));
straight.blocked = straight.blocks.length > 0 && straight.reasons.includes("police") && straight.stoppedAtBlock > 60 &&
  straight.x < straight.blocks[0].x && straight.northM < 1;
const directContact = sample(start(setup).world, 600, () => ({ ...drive, throttle: .65 }), false);
const noBranch = sample(start({ ...setup, closed: true }).world, 120, () => ({ ...drive, throttle: .65 }));
const untracked = sample(start({ ...setup, untracked: true }).world, 120, () => ({ ...drive, throttle: .65 }));
const lateSetup = { ...setup, pose: { ...pose, x: -210 } };
const occupiedWorld = start({ ...lateSetup, loading: true }).world;
const occupied = sample(occupiedWorld, 540, laneController(planDistrictRoute(occupiedWorld.district,
  occupiedWorld.player, { x: -185.5, z: -88, heading: 0, roadId: "civic-avenue" }), occupiedWorld.player));
occupied.loading = occupiedWorld.actors.filter(actor => actor.id.startsWith("opening-loading-"))
  .map(({ x, z, speed }) => ({ x, z, speed }));
const screen = { x: -172, z: -112, width: 14, height: 3.8, length: .3 };
const hidden = sample(start({ ...lateSetup, screen }).world, 12, () => ({ ...drive, throttle: .65 }));
const tooLow = sample(start({ ...lateSetup, screen: { ...screen, height: .7 } }).world, 12,
  () => ({ ...drive, throttle: .65 }));
const partial = sample(start({ ...lateSetup, screen: { ...screen, x: -176, z: -111.6, width: 9 } }).world, 12,
  () => ({ ...drive, throttle: .65 }));
const stationarySetup = { ...setup, pose: { ...pose, x: -196, speed: 0 } };
const idle = sample(start(stationarySetup).world, 780, () => hold);
const moving = sample(start(stationarySetup).world, 240, () => drive);
const learnedHigh = [];
let learnedIdle = null, checkpointSha256 = null;
if (process.argv.includes("--learned-high")) {
  const checkpointPath = process.env.METRO_HIGH_OPENING_CHECKPOINT;
  if (!checkpointPath) throw new Error("Provide the preserved high-opening development checkpoint.");
  const bytes = readFileSync(checkpointPath);
  checkpointSha256 = createHash("sha256").update(bytes).digest("hex");
  assert.equal(checkpointSha256, "3b6f668a0d30dd7fed9ab2309d2ba68e836c4ca824396228fa97d6e24040d4bb");
  const policy = freezePursuitPolicy(JSON.parse(bytes));
  const stage = { observation: policy.observation, wantedLevel: 5, wantedLevelMax: 5,
    patrols: 12, traffic: 96, pedestrians: 144, episodeSeconds: 20 };
  for (const seed of ["city-route-dev-eval-00", "city-route-dev-eval-01"]) {
    const { env } = resetPursuitEpisode(stage, seed);
    const { world } = env;
    const ambient = world.actors.filter(actor => actor !== world.player && !world.pursuit.patrols.has(actor));
    const driver = { policy, status: "active", lastTick: -1, decisions: 0 };
    const driven = sample(world, 600, () => {
      assert.equal(applyFrozenDispatchAction(world, driver), false);
      return world.pursuit.manualAction;
    }, false);
    learnedHigh.push({ seed, drive: driven, decisions: driver.decisions, capacity: world.capacity,
      retained: ambient.length === 240 && ambient.every(body => world.actors.includes(body)) });
  }
  const { env } = resetPursuitEpisode(stage, learnedHigh[0].seed);
  learnedIdle = sample(env.world, 900, () => hold);
}
const result = { opening: opened, high,
  detour: { alternate, straight, directContact, noBranch, untracked, occupied, hidden, tooLow, partial }, idle, moving,
  ...(checkpointSha256 ? { checkpointSha256, learnedHigh, learnedIdle } : {}) };
if (process.env.PROVE_IT_OUTPUT_DIR) writeFileSync(join(process.env.PROVE_IT_OUTPUT_DIR, "dispatch-opening.json"),
  JSON.stringify(result, null, 2), { flag: "wx" });
console.log(JSON.stringify(result));
for (const row of opened) {
  assert.deepEqual(row.actualPopulation, [36, 80]);
  assert.ok(row.retained && row.drive.distanceM > 10 && row.drive.maxSpeed > 5 && row.drive.contacts === 0);
  assert.ok(row.drive.starts.every(unit => unit.radius >= 35) &&
    row.drive.blocks.every(block => block.tick > 1 && !block.visible));
}
assert.deepEqual(high.actualPopulation, [96, 144]);
assert.ok(high.retained && high.drive.starts.length > opened[0].drive.starts.length);
assert.ok(high.drive.starts.some(row => row.unit === "swat") &&
  high.drive.starts.some(row => row.unit === "interceptor" && row.maxSpeed > 28));
assert.ok(alternate.blocks.length && alternate.blocks.every(block => !block.visible) && alternate.northM > 18 &&
  alternate.contacts === 0 && alternate.unitTravelM.some(travel => travel > 10));
assert.ok(straight.blocked && straight.blocks[0].ids.length === 3);
assert.ok(directContact.contacts > 0 && directContact.events.length > 0);
assert.equal(noBranch.blocks.length, 0);
assert.equal(untracked.tracking, 0);
assert.equal(untracked.blocks.length, 0);
assert.equal(occupied.blockCount, 0);
assert.ok(occupied.tracking === occupied.ticks && occupied.loading.length === 3 &&
  occupied.loading.every(van => van.z === -96 && van.speed === 0) &&
  occupied.northM < 15 && occupied.reasons.includes("civilian"));
assert.ok(hidden.blockCount === 1 && hidden.blocks[0].range < 55 && !hidden.blocks[0].visible);
assert.ok(!tooLow.blockCount || tooLow.blocks.every(block => block.range > 55 && !block.visible));
assert.ok(partial.blocks.every(block => !block.visible));
assert.ok(idle.contacts > 0 && idle.distanceM < moving.distanceM && moving.contacts === 0);
for (const row of learnedHigh) {
  assert.ok(row.retained && row.capacity.traffic === 96 && row.capacity.pedestrians === 144 && row.decisions === 100);
  assert.ok(row.drive.distanceM > 40 && row.drive.contacts === 0 && row.drive.phase === "running");
  assert.ok(row.drive.starts.length >= 10 && row.drive.maxSpeed > 12 && row.drive.closestPatrolM < 12);
  assert.ok(row.drive.starts.some(unit => unit.unit === "swat") &&
    row.drive.starts.some(unit => unit.unit === "interceptor" && unit.maxSpeed > 28));
}
if (learnedIdle) assert.ok(learnedIdle.distanceM === 0 && learnedIdle.phase !== "escaped" &&
  learnedIdle.closestPatrolM < Math.min(...learnedIdle.starts.map(unit => unit.radius)));
