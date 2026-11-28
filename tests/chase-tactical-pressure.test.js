import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { STEP } from "../src/core/config.js";
import { angleDelta, distance, overlaps, pointOnRoad } from "../src/core/geometry.js";
import { World } from "../src/core/world.js";
import { AGGRESSIVE_CHASE_PRESENCE } from "../src/core/pako-aggressive-police.js";
import { METRO_CITY_CURBS } from "../src/core/pako-curb.js";
import {
  TACTICAL_PURSUIT_MODE,
  planTacticalInterceptAim,
} from "../src/core/pako-tactical-police.js";
import { applyFrozenDispatchAction } from "../src/rl/pursuit-controller.js";
import { freezePursuitPolicy } from "../src/rl/pursuit-ppo.js";
import { resetPursuitEpisode } from "../src/rl/pursuit-rollouts.js";
import { SMART_ESCAPE_CONTROL } from "../src/rl/pako-smart-escape.js";
import { PURSUIT_SCAN_TICKS } from "../src/signal_processing/pursuit-scanner.js";

const chaseConfig = level => ({
  ruleset: "dispatch-v1",
  wantedLevelStart: level,
  wantedLevelMax: 5,
  maxActivePatrols: 14,
  curbSupport: METRO_CITY_CURBS,
  chasePresence: AGGRESSIVE_CHASE_PRESENCE,
  tacticalPursuit: TACTICAL_PURSUIT_MODE,
  policeFairness: "city-fair-v1",
  surveillanceZones: [],
});

function startChase(level, seed = `tactical-pressure-${level}`) {
  const world = new World({ seed, cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  world.command({ type: "street-pursuit-start", variant: "gta", level,
    config: chaseConfig(level) }, false);
  return world;
}

function localPose(origin, target) {
  const dx = target.x - origin.x, dz = target.z - origin.z;
  const sin = Math.sin(origin.heading), cos = Math.cos(origin.heading);
  return { forward: dx * sin + dz * cos, right: dx * cos - dz * sin };
}

test("Level 3 and 5 open with a close multi-angle police ring and forward interceptors", () => {
  const results = [];
  for (const level of [3, 5]) {
    const world = startChase(level);
    const patrols = [...world.pursuit.patrols];
    const close = patrols.filter(patrol => distance(patrol, world.player) <= 65);
    const forward = close.filter(patrol => localPose(world.player, patrol).forward > 0);
    const allForward = patrols.filter(patrol => localPose(world.player, patrol).forward > 0);

    assert.ok(close.length >= 3, `Level ${level}: expected >=3 patrols within 65m, got ${close.length}`);
    assert.ok(forward.length >= 2, `Level ${level}: expected >=2 forward interceptors within 65m`);
    assert.ok(allForward.every(patrol => localPose(world.player, patrol).forward >= 34),
      `Level ${level}: every forward opening patrol needs >=34m launch room`);
    assert.ok(patrols.every(patrol => !overlaps(world.player, patrol)));
    for (let i = 0; i < patrols.length; i++) {
      assert.ok(patrols.slice(i + 1).every(other => !overlaps(patrols[i], other)));
    }
    assert.ok(patrols.every(patrol => patrol.gtaAI.beat?.roadId));
    assert.deepEqual(world.audit(), []);
    results.push({ level, patrols: patrols.length, within65M: close.length,
      forwardWithin65M: forward.length, unitsInContact: world.pursuit.response.unitsInContact });
  }
  console.log(`TACTICAL_OPENING ${JSON.stringify(results)}`);
});

test("Level 5 dead-stop launch keeps forward cruisers beyond 34m and evades without a sandwich", () => {
  const world = new World({ seed: "standstill-live", cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  Object.assign(world.player, { x: -337, z: -109.1, heading: Math.PI / 2, speed: 0 });
  world.player.previous = { ...world.player };
  world.command({ type: "street-pursuit-start", variant: "gta", level: 5,
    config: chaseConfig(5) }, false);
  world.pursuit.cityChase = true;
  world.pursuit.pako = true;

  const openingPatrols = [...world.pursuit.patrols];
  const openingForward = openingPatrols
    .map(patrol => ({ patrol, ...localPose(world.player, patrol), range: distance(world.player, patrol) }))
    .filter(item => item.forward > 0);
  assert.ok(openingForward.every(item => item.forward >= 34));
  assert.ok(openingForward.filter(item => item.range <= 65).length >= 2);
  assert.ok(openingPatrols.filter(patrol => distance(world.player, patrol) <= 65).length >= 3);

  const policy = freezePursuitPolicy(JSON.parse(readFileSync(
    new URL("../public/threejs/pako-chase-ppo.json", import.meta.url), "utf8")));
  const driver = {
    policy, sha256: "shipped", status: "active", lastTick: -1, decisions: 0,
    recoverStale: true, evasion: true, evasiveControl: SMART_ESCAPE_CONTROL,
  };
  world.pursuit.frozenDriver = driver;
  const openingHeading = world.player.heading, roadIds = new Set();
  let maxClose55 = 0, maxHeadingChange = 0;
  for (let tick = 0; tick < 900 && world.pursuit.phase === "running"; tick++) {
    applyFrozenDispatchAction(world, driver, null);
    world.step();
    maxClose55 = Math.max(maxClose55,
      [...world.pursuit.patrols].filter(patrol => distance(patrol, world.player) <= 55).length);
    maxHeadingChange = Math.max(maxHeadingChange,
      Math.abs(angleDelta(world.player.heading, openingHeading)));
    for (const road of world.drivingRoads) if (pointOnRoad(world.player, [road])) roadIds.add(road.id);
  }

  assert.equal(world.pursuit.metrics.collisions, 0);
  assert.equal(world.pursuit.metrics.pedestrianCollisions, 0);
  assert.equal(world.pursuit.phase, "running");
  assert.ok(world.pursuit.metrics.distanceM > 80);
  assert.ok(maxClose55 >= 3);
  assert.ok(maxHeadingChange >= .5);
  assert.ok(roadIds.size >= 2);
  console.log(`TACTICAL_STANDSTILL ${JSON.stringify({
    minForwardM: Math.min(...openingForward.map(item => item.forward)),
    forwardWithin65M: openingForward.filter(item => item.range <= 65).length,
    maxClose55, maxHeadingChange, roads: [...roadIds],
    distanceM: world.pursuit.metrics.distanceM, collisions: world.pursuit.metrics.collisions,
  })}`);
});

test("active legal reports produce lead, bilateral pincer, cutoff aims and force maneuvering", () => {
  const world = startChase(5, "tactical-aim-roles");
  const report = world.pursuit.response.lastSeen;
  assert.ok(world.pursuit.response.unitsInContact > 0 && report);
  const patrols = [...world.pursuit.patrols];
  const aims = Array.from({ length: 6 }, (_, slot) =>
    planTacticalInterceptAim(world, patrols[slot], report, slot));
  const relative = aims.map(aim => localPose(report, aim));

  assert.deepEqual(aims.map(aim => aim.role), [
    "LEAD", "PINCER_LEFT", "PINCER_RIGHT", "CUTOFF_INTERCEPT",
    "CROSS_AMBUSH_LEFT", "CROSS_AMBUSH_RIGHT",
  ]);
  assert.ok(relative[0].forward > 0 && relative[0].forward <= 18);
  assert.ok(relative[1].forward >= 18 && relative[1].forward <= 38 && relative[1].right < -3);
  assert.ok(relative[2].forward >= 18 && relative[2].forward <= 38 && relative[2].right > 3);
  assert.ok(relative.slice(3).every(pose => pose.forward >= 35 && pose.forward <= 95));
  assert.ok(aims.slice(3).filter(aim => aim.junctionIntercept).length >= 2);

  const { env } = resetPursuitEpisode({
    cityVersion: 5, traffic: 0, pedestrians: 0, episodeSeconds: 9,
    wantedLevel: 5, wantedLevelMax: 5, patrols: 14,
    observation: "dispatch-route-v2", curbSupport: METRO_CITY_CURBS,
    chasePresence: AGGRESSIVE_CHASE_PRESENCE, tacticalPursuit: TACTICAL_PURSUIT_MODE,
    policeFairness: "city-fair-v1", evasiveControl: "pako-smart-escape-v3",
  }, "pressure-live");
  const live = env.world, openingHeading = live.player.heading;
  let maxClose55 = 0, maxHeadingChange = 0, visualContactSamples = 0;
  const roadIds = new Set();
  for (let n = 0; n < 120 && live.pursuit.phase === "running"; n++) {
    env.step({ steer: 0, throttle: .8, brake: 0, gear: 1 }, PURSUIT_SCAN_TICKS);
    maxClose55 = Math.max(maxClose55,
      [...live.pursuit.patrols].filter(patrol => distance(patrol, live.player) <= 55).length);
    maxHeadingChange = Math.max(maxHeadingChange,
      Math.abs(angleDelta(live.player.heading, openingHeading)));
    visualContactSamples += Number(live.pursuit.response.unitsInContact > 0);
    for (const road of live.drivingRoads) if (pointOnRoad(live.player, [road])) roadIds.add(road.id);
  }

  assert.ok(visualContactSamples >= 75, `expected sustained legal visual contact, got ${visualContactSamples}`);
  assert.ok(maxClose55 >= 3, `expected >=3 patrols inside 55m, got ${maxClose55}`);
  assert.ok(maxHeadingChange >= .30, `expected tactical maneuvering, got ${maxHeadingChange}`);
  assert.ok(roadIds.size >= 2, `expected road changes, observed ${[...roadIds]}`);
  assert.equal(live.pursuit.metrics.collisions, 0);
  assert.equal(live.pursuit.metrics.pedestrianCollisions, 0);
  console.log(`TACTICAL_MANEUVER ${JSON.stringify({ maxClose55, maxHeadingChange,
    roads: [...roadIds], visualContactSamples, collisions: live.pursuit.metrics.collisions })}`);
});

test("zero-contact search cannot peek at the player and fair patrol identities and speed stay fixed", () => {
  const source = startChase(5, "tactical-zero-contact");
  const report = source.pursuit.response.lastSeen;
  const patrol = [...source.pursuit.patrols][0];
  const auditedWorld = {
    tick: source.tick + 180,
    pursuit: { ...source.pursuit, response: { ...source.pursuit.response, unitsInContact: 0 } },
    drivingRoads: source.drivingRoads,
    roads: source.roads,
    statics: source.statics,
    staticIndex: source.staticIndex,
    get player() { throw new Error("hidden player coordinates accessed without contact"); },
  };
  const hold = planTacticalInterceptAim(auditedWorld, patrol, null, 3);
  assert.deepEqual({ x: hold.x, z: hold.z, heading: hold.heading, roadId: hold.roadId, role: hold.role }, {
    x: patrol.x, z: patrol.z, heading: patrol.heading,
    roadId: patrol.gtaAI.beat.roadId, role: "HOLD",
  });
  for (let slot = 0; slot < 8; slot++) {
    const aim = planTacticalInterceptAim(auditedWorld, patrol, report, slot);
    assert.equal(aim.role, "SEARCH");
    assert.equal(aim.junctionIntercept, false);
  }

  const world = startChase(5, "tactical-fixed-identities");
  const units = [...world.pursuit.patrols];
  const ids = units.map(unit => unit.id);
  let maxTickTravelM = 0;
  for (let tick = 0; tick < 180 && world.pursuit.phase === "running"; tick++) {
    const before = units.map(unit => ({ x: unit.x, z: unit.z }));
    world.command({ type: "pursuit-drive", action: {
      steer: tick > 60 ? .35 : 0, throttle: .8, brake: 0, gear: 1,
    } }, false);
    world.step();
    assert.deepEqual([...world.pursuit.patrols].map(unit => unit.id), ids);
    units.forEach((unit, index) => {
      maxTickTravelM = Math.max(maxTickTravelM, distance(unit, before[index]));
      assert.ok(distance(unit, before[index]) <= 32 * STEP + .03);
    });
  }
  assert.ok(units.every(unit => unit.maxSpeed <= world.player.maxSpeed));
  assert.ok(units.every(unit => unit.gtaAI.beat?.roadId));
  console.log(`TACTICAL_FAIRNESS ${JSON.stringify({ ids: ids.length, maxTickTravelM,
    patrolMaxSpeedMps: Math.max(...units.map(unit => unit.maxSpeed)), playerMaxSpeedMps: world.player.maxSpeed })}`);
});
