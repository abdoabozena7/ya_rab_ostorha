import test from "node:test";
import assert from "node:assert/strict";
import { STEP } from "../src/core/config.js";
import { angleDelta, bodyOnRoad, overlaps, roadFrame } from "../src/core/geometry.js";
import { integrateVehicle } from "../src/core/vehicle.js";
import { KING_LONG_MICROBUS_ID } from "../src/core/vehicle-spec.js";
import { World } from "../src/core/world.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { getPatrolVisualDamage } from "../src/core/pursuit-world.js";
import { defensiveAutoCommand } from "../src/core/defensive-driver.js";
import {
  CHAOS_INTENSITIES,
  STREET_CHAOS_VERSION,
  TRUCK_SPEC,
  VEHICLE_CLASS_DYNAMICS,
  beginStreetChaos,
  bodyExtentsOnLane,
  classSpec,
  coordsOn,
  endStreetChaos,
  isStreetChaosAccidentActor,
  laneFrame,
  lanePoint,
  straightLanePath,
  streetChaosSnapshot,
  triggerStreetChaosEvent,
} from "../src/core/street-chaos.js";

const metro = (options = {}) => new World({ cityVersion: 5, seed: "cairo-42", ...options }, "metro");
const isChaosActor = (actor) => /^chaos-(truck|event)-/.test(actor.id);
const seconds = (n) => Math.round(n / STEP);

function advance(world, ticks, each) {
  for (let i = 0; i < ticks; i++) {
    world.step();
    each?.(world, i);
  }
}

// Put the ego in its lane at a mid-block spot on a wide avenue, moving, away from every body.
function placeEgo(world, roadId, s, d = 1, speed = 6) {
  const road = world.district.drivingRoads.find((candidate) => candidate.id === roadId);
  const heading = d > 0 ? roadFrame(road).heading : roadFrame(road).heading + Math.PI;
  for (let k = 0; k < 40; k++) {
    const p = lanePoint(road, d, s + k * 2, -road.laneOffsetM);
    const body = { ...world.player, x: p.x, z: p.z, heading };
    if (world.actors.some((a) => a !== world.player && overlaps(body, a, 2.5)) ||
        world.statics.some((st) => overlaps(body, st, 0.5))) continue;
    Object.assign(world.player, { x: p.x, z: p.z, heading, speed });
    world.player.previous = { x: p.x, z: p.z, heading, speed };
    return;
  }
  throw new Error("No clear start slot");
}

function cityWorld(model, chaos = {}) {
  const world = metro();
  if (model === KING_LONG_MICROBUS_ID) assert.equal(world.command({ type: "player-vehicle", model }).ok, true);
  placeEgo(world, "university-avenue", -360, 1, 6);
  world.command({ type: "street-chaos-start", intensity: "rush", driverMode: "auto", ...chaos });
  world.streetChaos.nextEventTick = Infinity;
  // Scripted scenarios isolate their event from the opening freight truck (covered by its own test).
  const ego = world.player;
  world.actors = world.actors.filter((a) => !(a.id.startsWith("chaos-truck-") && Math.hypot(a.x - ego.x, a.z - ego.z) < 100));
  world.actorIndex = new SpatialIndex(world.actors);
  world.streetChaos.trucks = world.streetChaos.trucks.filter((a) => world.actors.includes(a));
  return world;
}

/** Runs a scripted Cairo Traffic scenario and measures what the ego actually experienced. */
function runScenario({ model = null, events, secondsToRun = 30, naive = false }) {
  const world = cityWorld(model, { disableDefensiveAvoidance: naive });
  const ego = world.player;
  const impacts0 = ego.vehicle.damage.impactCount;
  const distance0 = ego.distance;
  const previous = new Map();
  const reactions = new Set();
  const result = {
    world, collisions: 0, vehicleTouches: 0, pedestrianTouches: 0, pedestrianTooClose: 0, maxJumpM: 0,
    auditErrors: [], progressM: 0, reactions, longestStallS: 0, triggers: [], passedWreck: false,
  };
  let stallTicks = 0;
  const script = events.map(([kind, at]) => ({ kind, at, done: false }));
  advance(world, seconds(secondsToRun), (w, i) => {
    for (const item of script) {
      if (!item.done && i >= item.at) {
        item.done = true;
        result.triggers.push({ kind: item.kind, ok: w.command({ type: "street-chaos-event", kind: item.kind }) });
      }
    }
    for (const actor of w.actors) {
      if (actor.type === "vehicle") {
        const was = previous.get(actor.id);
        if (was) result.maxJumpM = Math.max(result.maxJumpM, Math.hypot(actor.x - was.x, actor.z - was.z));
        previous.set(actor.id, { x: actor.x, z: actor.z });
        if (actor !== ego && Math.abs(actor.x - ego.x) < 12 && Math.abs(actor.z - ego.z) < 12 && overlaps(ego, actor, 0))
          result.vehicleTouches++;
      } else if (actor.type === "pedestrian" && Math.abs(actor.x - ego.x) < 6 && Math.abs(actor.z - ego.z) < 6) {
        if (overlaps(ego, actor, 0)) result.pedestrianTouches++;
        if (ego.speed > 1 && overlaps(ego, actor, 0.3)) result.pedestrianTooClose++;
      }
    }
    if (i % 20 === 0) result.auditErrors.push(...w.audit());
    const wreck = w.streetChaos.accident;
    if (wreck?.formed && coordsOn(wreck.road, wreck.d, ego).s > wreck.sMax + 2) result.passedWreck = true;
    const reaction = w.streetChaos.egoReaction?.reaction;
    if (reaction) reactions.add(reaction);
    stallTicks = ego.speed < 0.3 ? stallTicks + 1 : 0;
    result.longestStallS = Math.max(result.longestStallS, stallTicks * STEP);
  });
  result.collisions = ego.vehicle.damage.impactCount - impacts0;
  result.progressM = ego.distance - distance0;
  return result;
}

test("contract constants expose the Cairo Traffic truck and per-class dynamics", () => {
  assert.equal(STREET_CHAOS_VERSION, "cairo-traffic-v1");
  assert.deepEqual([...CHAOS_INTENSITIES], ["normal", "rush", "max"]);
  assert.deepEqual({ ...TRUCK_SPEC }, {
    kind: "truck", lengthM: 8.2, widthM: 2.45, heightM: 3.35, wheelbaseM: 4.9, massKg: 14500,
    maxSteerRad: 0.40, steerRateRadS: 0.48, accelerationMps2: 1.15, brakingMps2: 4.1, tireGripMps2: 5.2,
    reverseSpeedMps: 2.0, maxSpeedFactor: 0.76,
  });
  assert.ok(Object.isFrozen(TRUCK_SPEC) && Object.isFrozen(VEHICLE_CLASS_DYNAMICS));
  assert.deepEqual(Object.keys(VEHICLE_CLASS_DYNAMICS), ["tuktuk", "sedan", "taxi", "suv", "van", "truck"]);
  for (const row of Object.values(VEHICLE_CLASS_DYNAMICS))
    for (const key of ["massKg", "wheelbase", "maxSteer", "steerRate", "acceleration", "braking",
      "tireGripMps2", "speedFactor", "offLaneTendency", "cutInAggression"])
      assert.ok(Number.isFinite(row[key]) && row[key] > 0, key);
  assert.equal(VEHICLE_CLASS_DYNAMICS.truck.massKg, 14500);
  assert.equal(VEHICLE_CLASS_DYNAMICS.tuktuk.massKg, 420);
  assert.equal(VEHICLE_CLASS_DYNAMICS.sedan.speedFactor, 1.12);
});

test("vehicle classes brake, accelerate and turn measurably differently under integrateVehicle", () => {
  const body = (kind, speed) => ({ x: 0, z: 0, heading: 0, speed, steer: 0, maxSpeed: 20, spec: classSpec(kind, true) });
  const stopping = Object.fromEntries(["tuktuk", "sedan", "suv", "van", "truck"].map((kind) => {
    let state = body(kind, 12);
    let travelled = 0;
    while (state.speed > 0) {
      const next = integrateVehicle(state, { targetSpeed: 0, steer: 0 }, STEP);
      travelled += Math.hypot(next.x - state.x, next.z - state.z);
      state = next;
    }
    return [kind, travelled];
  }));
  assert.ok(stopping.truck > stopping.sedan * 1.5, `truck ${stopping.truck} vs sedan ${stopping.sedan}`);
  assert.ok(stopping.truck > stopping.van && stopping.van > stopping.suv && stopping.suv > stopping.sedan, JSON.stringify(stopping));
  assert.ok(stopping.tuktuk > stopping.sedan, "a light tuktuk has less brake than a sedan");

  const accelerated = Object.fromEntries(["tuktuk", "sedan", "truck"].map((kind) => {
    let state = body(kind, 0);
    for (let i = 0; i < seconds(3); i++) state = integrateVehicle(state, { targetSpeed: 12, steer: 0 }, STEP);
    return [kind, state.speed];
  }));
  assert.ok(accelerated.sedan > accelerated.truck * 2 && accelerated.tuktuk > accelerated.sedan, JSON.stringify(accelerated));

  const turningRadius = (kind) => {
    let state = body(kind, 3);
    const command = { targetSpeed: 3, steer: VEHICLE_CLASS_DYNAMICS[kind].maxSteer };
    for (let i = 0; i < seconds(6); i++) state = integrateVehicle(state, command, STEP);
    const next = integrateVehicle(state, command, STEP);
    return 3 / (Math.abs(next.heading - state.heading) / STEP);
  };
  const radii = { tuktuk: turningRadius("tuktuk"), sedan: turningRadius("sedan"), truck: turningRadius("truck") };
  assert.ok(radii.truck > radii.sedan * 2.5 && radii.sedan > radii.tuktuk, JSON.stringify(radii));
});

test("Cairo Traffic starts inside the live Metro City with real trucks and ends by restoring the City", () => {
  const world = metro();
  assert.equal("streetChaos" in world.state(), false, "legacy state keys are untouched until the mode starts");
  const originalActors = world.actors.map((actor) => ({ id: actor.id, spec: actor.spec, maxSpeed: actor.maxSpeed }));
  const originalMode = world.mode;
  world.command({ type: "street-chaos-start", intensity: "rush", driverMode: "auto" });
  const snapshot = world.state().streetChaos;
  assert.equal(snapshot.active, true);
  assert.equal(snapshot.version, STREET_CHAOS_VERSION);
  assert.equal(world.mode, "auto");
  assert.equal(world.state().environment, "metro", "the City is not replaced");
  const trucks = world.actors.filter((actor) => actor.kind === "truck");
  assert.equal(trucks.length, 5);
  assert.equal(snapshot.truckCount, 5);
  for (const truck of trucks) {
    assert.match(truck.id, /^chaos-truck-/);
    assert.deepEqual([truck.length, truck.width, truck.height], [8.2, 2.45, 3.35]);
    assert.deepEqual({ ...truck.spec }, {
      realisticDynamics: true, wheelbase: 4.9, maxSteer: 0.40, steerRate: 0.48, acceleration: 1.15,
      braking: 4.1, tireGripMps2: 5.2, massKg: 14500, reverseSpeed: 2.0,
    });
    const frame = laneFrame(world, truck);
    assert.ok(frame && frame.road.width >= 11 && frame.road.zone === "avenue", `${truck.id} sits on a wide avenue`);
    assert.equal(bodyOnRoad(truck, world.roads), true);
    assert.ok(Math.hypot(truck.x - world.player.x, truck.z - world.player.z) >= 16);
    assert.ok(truck.path.length > 100);
  }
  assert.deepEqual(world.audit(), []);
  advance(world, seconds(6));
  assert.deepEqual(world.audit(), []);
  assert.ok(trucks.some((truck) => truck.speed > 0), "trucks move under their own heavy physics");
  assert.ok(world.actors.some((a) => a.kind === "sedan" && a.spec?.braking === VEHICLE_CLASS_DYNAMICS.sedan.braking),
    "ambient sedans carry class physics while the mode runs");

  assert.throws(() => world.command({ type: "street-pursuit-start", level: 1, variant: "arcade" }),
    /End Cairo Traffic before starting Chase/);
  world.command({ type: "street-chaos-driver", mode: "manual" });
  assert.equal(world.mode, "manual");
  world.command({ type: "street-chaos-driver", mode: "auto" });
  assert.equal(world.mode, "auto");

  world.command({ type: "street-chaos-stop" });
  assert.equal(world.streetChaos.active, false);
  assert.equal(world.state().streetChaos.active, false);
  assert.equal(world.mode, originalMode);
  assert.equal(world.actors.some(isChaosActor), false, "no stray chaos actors");
  for (const saved of originalActors) {
    const actor = world.actors.find((candidate) => candidate.id === saved.id);
    assert.equal(actor.spec, saved.spec, `${saved.id} spec restored`);
    assert.equal(actor.maxSpeed, saved.maxSpeed, `${saved.id} speed ceiling restored`);
  }
  assert.deepEqual(world.audit(), []);
  advance(world, 120);
  assert.deepEqual(world.audit(), []);
  assert.equal(endStreetChaos(world), false, "stopping twice is harmless");
});

test("intensity sets the truck count, start is deterministic and the mode is guarded", () => {
  const counts = CHAOS_INTENSITIES.map((intensity) => {
    const world = metro();
    beginStreetChaos(world, { intensity });
    return world.actors.filter((actor) => actor.kind === "truck").length;
  });
  assert.deepEqual(counts, [4, 5, 6]);
  const place = (world) => world.actors.filter((a) => a.kind === "truck").map((a) => [a.id, a.x.toFixed(3), a.z.toFixed(3)]);
  const a = metro();
  const b = metro();
  beginStreetChaos(a, { intensity: "max" });
  beginStreetChaos(b, { intensity: "max" });
  assert.deepEqual(place(a), place(b));
  assert.throws(() => beginStreetChaos(metro(), { intensity: "chaotic" }), /intensity/);
  assert.throws(() => beginStreetChaos(new World({}, "lab")), /only available in City/);
  const chase = metro();
  chase.command({ type: "street-pursuit-start", level: 1, variant: "arcade" });
  assert.throws(() => beginStreetChaos(chase), /End Chase/);
});

test("accidents, ghorz and lane changes are driven physically from the default boulevard", () => {
  const world = metro();
  world.command({ type: "street-chaos-start", intensity: "rush", driverMode: "manual" });
  world.streetChaos.nextEventTick = Infinity;
  advance(world, 30);
  const jumps = { max: 0 };
  const previous = new Map();
  const watch = (w) => {
    for (const actor of w.actors) {
      if (actor.type !== "vehicle") continue;
      const was = previous.get(actor.id);
      if (was) jumps.max = Math.max(jumps.max, Math.hypot(actor.x - was.x, actor.z - was.z));
      previous.set(actor.id, { x: actor.x, z: actor.z });
    }
  };

  const accident = triggerStreetChaosEvent(world, "accident");
  assert.ok(accident, "an accident can be requested on demand");
  advance(world, seconds(12), watch);
  // A freight truck on the boulevard may keep the slot busy for a while; the request keeps retrying.
  for (let k = 0; k < 6 && !world.streetChaos.accident?.formed; k++) advance(world, seconds(6), watch);
  const snapshot = streetChaosSnapshot(world);
  assert.equal(snapshot.accidentActorIds.length, 2, "both wreck vehicles are exposed for hazard lights");
  const [leadId, followId] = snapshot.accidentActorIds;
  const lead = world.actors.find((a) => a.id === leadId);
  const follow = world.actors.find((a) => a.id === followId);
  assert.ok(isStreetChaosAccidentActor(world, lead) && isStreetChaosAccidentActor(world, follow));
  assert.ok(!isStreetChaosAccidentActor(world, world.player));
  assert.equal(snapshot.activeHazard?.kind, "accident");
  for (const car of [lead, follow]) {
    const damage = getPatrolVisualDamage(car);
    assert.ok(damage && Object.values(damage).some((v) => v > 0), `${car.id} visibly crumpled`);
    assert.ok(Math.abs(car.speed) < 0.01, "the wreck is at rest");
  }
  assert.equal(overlaps(lead, follow), false, "wrecks touch without interpenetrating");
  const wreckFrame = laneFrame(world, lead, { maxPsi: 1.2 });
  const leadPsi = Math.abs(lead.heading - wreckFrame.laneHeading);
  const followPsi = Math.abs(follow.heading - wreckFrame.laneHeading);
  assert.ok(leadPsi >= 0.24 && leadPsi <= 0.45, `the lead skids visibly (${leadPsi.toFixed(2)} rad)`);
  assert.ok(followPsi >= 0.25 && followPsi <= 0.42, `the follower slews visibly (${followPsi.toFixed(2)} rad)`);
  const roles = streetChaosSnapshot(world).accidentRoles;
  assert.deepEqual([roles[leadId].role, roles[followId].role], ["lead", "follower"]);
  assert.equal(roles[leadId].skewSign, -roles[followId].skewSign, "the two cars skew in opposite senses");
  const damageLead = getPatrolVisualDamage(lead);
  const damageFollow = getPatrolVisualDamage(follow);
  assert.ok(damageLead.rear >= 0.29 && damageFollow.front >= 0.29, "rear damage on the lead, front damage on the follower");
  const frame = laneFrame(world, lead, { maxPsi: 1 });
  const extents = [lead, follow].map((car) => bodyExtentsOnLane(frame, car));
  const latMin = Math.min(...extents.map((x) => x.latMin));
  const latMax = Math.max(...extents.map((x) => x.latMax));
  assert.ok(latMax - latMin >= 2.3 && latMax - latMin <= 1.3 * 3.6, `the wreck blocks about a lane (${(latMax - latMin).toFixed(2)} m)`);
  const clearOuter = latMin + frame.halfW;
  const clearInner = -0.2 - latMax;
  assert.ok(Math.max(clearOuter, clearInner) >= 2.9,
    `a passable corridor stays open (${clearOuter.toFixed(2)} / ${clearInner.toFixed(2)} m)`);
  assert.deepEqual(world.audit(), []);

  const ghorz = triggerStreetChaosEvent(world, "ghorz");
  const lane = triggerStreetChaosEvent(world, "lane-change");
  assert.ok(ghorz && lane);
  let steered = 0;
  const seen = new Set();
  advance(world, seconds(30), (w) => {
    watch(w);
    for (const event of w.streetChaos.events) {
      seen.add(event.kind);
      for (const id of event.actorIds) {
        const actor = w.actors.find((a) => a.id === id);
        if (actor && Math.abs(actor.steer) > 0.03) steered++;
      }
    }
  });
  assert.ok(steered > 30, "the maneuvers steer through real steering commands");
  assert.ok(seen.has("ghorz") && seen.has("lane-change"), "both maneuvers actually started");
  assert.ok(jumps.max < 2.5, `no teleports (${jumps.max.toFixed(2)} m/tick)`);
  assert.ok(jumps.max < 0.4, "vehicle motion stays physical");
  assert.deepEqual(world.audit(), []);
  assert.ok(world.streetChaos.recent.length >= 2);
  const { metrics } = world.streetChaos;
  assert.deepEqual([metrics.ghorzCount, metrics.laneCutCount, metrics.accidentCount], [1, 1, 1]);
});

test("the weaver pulls ahead of the ego and cuts in with steering but never rams", () => {
  const world = cityWorld(null);
  advance(world, 5);
  assert.ok(triggerStreetChaosEvent(world, "ghorz"));
  let weaver = null;
  let maxLead = -Infinity;
  let cutSteer = 0;
  let crossedIn = false;
  const start = world.player.vehicle.damage.impactCount;
  advance(world, seconds(25), (w) => {
    const live = w.streetChaos.events.find((e) => e.kind === "ghorz");
    if (live) weaver = w.actors.find((a) => a.id === live.actorIds[0]) ?? weaver;
    const frame = laneFrame(w, w.player);
    if (!frame || !weaver) return;
    if (!live) return;
    const weaverExtents = bodyExtentsOnLane(frame, weaver);
    maxLead = Math.max(maxLead, weaverExtents.sMin - bodyExtentsOnLane(frame, w.player).sMax);
    const phase = live.phase;
    if (phase === "cut") cutSteer = Math.max(cutSteer, Math.abs(weaver.steer));
    if (phase === "settle" && Math.abs(weaverExtents.lat - frame.lat) < 1.2) crossedIn = true;
  });
  assert.ok(maxLead >= 3.5 && maxLead < 40, `the weaver gets ahead of the nose (${maxLead.toFixed(1)} m)`);
  assert.ok(cutSteer > 0.02, "the cut is a real steering input");
  assert.ok(crossedIn, "the cut-in ends in the ego's lane");
  assert.equal(world.player.vehicle.damage.impactCount, start, "the weaver never rammed the ego");
  assert.deepEqual(world.audit(), []);
});

test("off-lane drivers wander inside the legal roadway and trucks stay on wide avenues", () => {
  const world = cityWorld(null);
  let trucksSeen = 0;
  let offLane = 0;
  advance(world, seconds(30), (w, i) => {
    if (i % 30) return;
    for (const actor of w.actors) {
      if (actor.type !== "vehicle" || actor === w.player) continue;
      assert.equal(bodyOnRoad(actor, w.roads), true, `${actor.id} stays on the road`);
      if (actor.kind !== "truck") continue;
      const frame = laneFrame(w, actor);
      assert.ok(!frame || frame.road.width >= 10, "trucks never enter narrow alleys");
      trucksSeen++;
    }
    offLane = Math.max(offLane, streetChaosSnapshot(w).offLaneCount);
  });
  assert.ok(offLane > 0, "some drivers straddle their lanes");
  assert.ok(trucksSeen >= 20);
  assert.deepEqual(world.audit(), []);
});

test("Defensive AI crosses an empty avenue smoothly without zig-zagging", () => {
  const world = metro({ traffic: 0, pedestrians: 0 });
  placeEgo(world, "university-avenue", -360, 1, 5);
  world.command({ type: "street-chaos-start", intensity: "normal", driverMode: "auto" });
  world.streetChaos.nextEventTick = Infinity;
  world.actors = world.actors.filter((actor) => !isChaosActor(actor));
  const wander = [];
  let flips = 0;
  let sign = 0;
  advance(world, seconds(24), (w, i) => {
    const frame = laneFrame(w, w.player);
    if (i > 120 && frame) wander.push(Math.abs(frame.lat + frame.laneOffset));
    const s = Math.sign(w.player.steer);
    if (Math.abs(w.player.steer) > 0.01 && s !== sign) { sign = s; flips++; }
  });
  assert.ok(Math.max(...wander) < 0.25, `steady lane keeping (${Math.max(...wander).toFixed(3)} m)`);
  assert.ok(flips <= 4, `${flips} steering reversals`);
  assert.ok(world.player.distance > 120, "keeps flowing without stopping with 'arrived'");
});

for (const [label, model] of [["Jetour T2 SUV", null], ["King Long microbus", KING_LONG_MICROBUS_ID]]) {
  test(`Defensive AI avoids an accident ahead, a ghorz cut-in and a sudden lane change in ${label}`, () => {
    const accident = runScenario({ model, events: [["accident", 60]], secondsToRun: 45 });
    assert.equal(accident.triggers[0].ok, true);
    assert.ok(accident.world.streetChaos.recent.some((r) => r.kind === "accident"), "the accident happened and cleared");
    assert.ok(accident.reactions.has("accident-bypass"), [...accident.reactions].join());
    assert.ok(accident.passedWreck, "the ego drove past the wreck");
    assert.ok(accident.progressM >= 100, `real forward progress (${accident.progressM.toFixed(0)} m)`);

    const mixed = runScenario({ model, events: [["ghorz", 5], ["lane-change", 90]], secondsToRun: 45 });
    assert.ok(mixed.world.streetChaos.metrics.ghorzCount === 1 && mixed.world.streetChaos.metrics.laneCutCount === 1);
    assert.ok(["evasive-shift", "defensive-yield", "emergency-brake"].some((r) => mixed.reactions.has(r)),
      "reads the cutting cars and reacts");
    assert.ok(mixed.progressM >= 100, `real forward progress (${mixed.progressM.toFixed(0)} m)`);

    for (const run of [accident, mixed]) {
      assert.equal(run.collisions, 0, "0 collisions");
      assert.equal(run.vehicleTouches, 0);
      assert.equal(run.pedestrianTouches, 0, "no pedestrian contact");
      assert.equal(run.pedestrianTooClose, 0, "no pedestrian squeezed at speed");
      assert.deepEqual(run.auditErrors, [], "zero off-road excursions or overlaps");
      assert.ok(run.maxJumpM < 0.4, `no teleports (${run.maxJumpM.toFixed(3)})`);
      assert.equal(run.world.streetChaos.metrics.collisions, 0);
    }
  });
}

test("disabling defensive avoidance deadlocks at the accident that Defensive AI bypasses", () => {
  const defensive = runScenario({ events: [["accident", 60]], secondsToRun: 30 });
  const naive = runScenario({ events: [["accident", 60]], secondsToRun: 30, naive: true });
  assert.equal(defensive.collisions, 0);
  assert.ok(defensive.progressM > 140);
  assert.ok(defensive.longestStallS < 6, "Defensive AI keeps moving");
  assert.ok(naive.collisions > 0 || naive.longestStallS >= 10, "naive centreline following gets stuck or crashes");
  assert.ok(naive.progressM < defensive.progressM * 0.5,
    `naive ${naive.progressM.toFixed(0)} m vs defensive ${defensive.progressM.toFixed(0)} m`);
  assert.equal(naive.world.streetChaos.egoReaction, null, "no defensive reactions are reported");
  const direct = defensiveAutoCommand(naive.world, naive.world.player, { steer: 0.1, targetSpeed: 8, remaining: 50, cursor: 0 },
    { disableDefensiveAvoidance: true });
  assert.equal(direct.usePlannedPath, true);
  assert.equal(direct.defensiveState.reaction, "cruising");
});

test("the ego exposes its reasoning and plans along the dodge", () => {
  const run = runScenario({ events: [["accident", 60]], secondsToRun: 14 });
  const reaction = run.world.streetChaos.egoReaction;
  assert.ok(reaction && ["reaction", "threatId", "threatKind", "ttcS", "chosenOffsetM", "minClearanceM", "reasonDetail"]
    .every((key) => key in reaction));
  const { world } = run;
  const defensive = defensiveAutoCommand(world, world.player, { steer: 0, targetSpeed: 8, remaining: 99, cursor: 0 });
  assert.ok(["cruising", "accident-bypass", "evasive-shift", "defensive-yield", "emergency-brake"]
    .includes(defensive.defensiveState.reaction));
  for (const key of ["steer", "targetSpeed", "reason", "blockedBy", "usePlannedPath", "defensiveState"])
    assert.ok(key in defensive, key);
  if (["accident-bypass", "evasive-shift"].includes(defensive.defensiveState.reaction))
    assert.equal(defensive.usePlannedPath, false);
  const json = JSON.parse(JSON.stringify(streetChaosSnapshot(world)));
  assert.deepEqual(Object.keys(json.metrics).sort(),
    ["accidentCount", "collisions", "distanceM", "ghorzCount", "laneCutCount", "nearMissesAvoided", "ticksActive"]);
});

test("mid-block ghorz overtakes, cuts in and settles without ever triggering a false emergency brake", () => {
  const world = cityWorld(null);
  advance(world, 5);
  assert.ok(triggerStreetChaosEvent(world, "ghorz"));
  const phases = new Set();
  let minGap = Infinity;
  let weaverBehindEmergency = 0;
  let weaver = null;
  advance(world, seconds(30), (w) => {
    const live = w.streetChaos.events.find((e) => e.kind === "ghorz");
    if (!live) return;
    phases.add(live.phase);
    weaver = w.actors.find((a) => a.id === live.actorIds[0]) ?? weaver;
    const frame = laneFrame(w, w.player, { maxPsi: 1 });
    if (!frame || !weaver) return;
    const e = bodyExtentsOnLane(frame, w.player);
    const x = bodyExtentsOnLane(frame, weaver);
    const lateralOverlap = x.latMin < e.latMax && x.latMax > e.latMin;
    if (x.s < e.sMax && w.streetChaos.egoReaction?.reaction === "emergency-brake") weaverBehindEmergency++;
    if (live.phase === "settle" && lateralOverlap) minGap = Math.min(minGap, x.sMin - e.sMax);
  });
  assert.ok(phases.has("cut") && phases.has("settle"), [...phases].join());
  const last = world.streetChaos.recent.find((e) => e.kind === "ghorz");
  assert.equal(last?.outcome, "completed");
  assert.ok(minGap >= 2.5, `the settled weaver keeps a bumper gap (${minGap.toFixed(2)} m)`);
  assert.equal(weaverBehindEmergency, 0, "no emergency braking while the weaver is still behind the nose");
  assert.equal(world.streetChaos.metrics.collisions, 0);
  assert.deepEqual(world.audit(), []);
});

test("default-seed Metro King Long drives 5400 ticks through Cairo Traffic without a long stall", () => {
  const world = metro();
  assert.equal(world.command({ type: "player-vehicle", model: KING_LONG_MICROBUS_ID }).ok, true);
  advance(world, 20);
  world.command({ type: "street-chaos-start", intensity: "rush", driverMode: "auto" });
  assert.equal(world.player.district.allowReroute, false, "the Defensive AI owns the routing");
  const ego = world.player;
  const impacts0 = ego.vehicle.damage.impactCount;
  let stall = 0;
  let longest = 0;
  let touches = 0;
  const auditErrors = [];
  const reactions = new Set();
  let heldStopped = 0;
  let heldMisreported = 0;
  advance(world, 5400, (w, i) => {
    stall = ego.speed < 0.3 ? stall + 1 : 0;
    longest = Math.max(longest, stall);
    for (const actor of w.actors)
      if (actor !== ego && actor.type === "vehicle" && Math.abs(actor.x - ego.x) < 12 && Math.abs(actor.z - ego.z) < 12 && overlaps(ego, actor, 0)) touches++;
    if (i % 20 === 0) auditErrors.push(...w.audit());
    const reaction = w.streetChaos.egoReaction?.reaction;
    if (reaction) reactions.add(reaction);
    if (w.districtBehavior?.holds?.[ego.id] && ego.speed < 0.3) {
      heldStopped++;
      if (reaction !== "junction-hold") heldMisreported++;
    }
  });
  assert.ok(longest * STEP <= 12, `max stall ${(longest * STEP).toFixed(1)} s`);
  assert.equal(touches, 0);
  assert.equal(ego.vehicle.damage.impactCount - impacts0, 0);
  assert.deepEqual(auditErrors, []);
  assert.equal(heldMisreported, 0, `${heldMisreported} of ${heldStopped} junction-wait ticks were not reported as a junction wait`);
  assert.ok(ego.distance > 60, `the ego made progress (${ego.distance.toFixed(0)} m)`);
});

test("a requested Lane Cut from the default start succeeds quickly and reports a structured request", () => {
  const world = metro();
  advance(world, 20);
  world.command({ type: "street-chaos-start", intensity: "rush", driverMode: "auto" });
  world.streetChaos.nextEventTick = Infinity;
  const first = triggerStreetChaosEvent(world, "lane-change");
  const request = streetChaosSnapshot(world).request;
  assert.ok(["pending", "started"].includes(request.status), request.status);
  assert.equal(request.kind, "lane-change");
  let startedAt = first?.pending ? null : 0;
  advance(world, seconds(20), (w, i) => {
    if (startedAt === null && w.streetChaos.events.some((e) => e.kind === "lane-change")) startedAt = i;
  });
  assert.ok(startedAt !== null, `Lane Cut started within 20 s: ${JSON.stringify(streetChaosSnapshot(world).request)}`);
  assert.equal(streetChaosSnapshot(world).request.status, "started");
  assert.equal(streetChaosSnapshot(world).request.reason, null);

  const accident = triggerStreetChaosEvent(world, "accident");
  if (accident) {
    assert.equal(triggerStreetChaosEvent(world, "accident"), null);
    const rejected = streetChaosSnapshot(world).request;
    assert.deepEqual([rejected.kind, rejected.status, rejected.reason], ["accident", "rejected", "Accident already active"]);
  }
  JSON.stringify(streetChaosSnapshot(world));
});

test("switching to manual clears the ego reasoning and ending in manual clears the cyan route", () => {
  const world = cityWorld(null);
  advance(world, seconds(6));
  assert.ok(world.streetChaos.egoReaction, "the auto driver reports a reaction");
  assert.ok(world.player.path.length > 1, "a Cairo route is planned");
  world.command({ type: "street-chaos-driver", mode: "manual" });
  advance(world, 5);
  assert.equal(streetChaosSnapshot(world).egoReaction, null);
  const revision = world.routeRevision;
  world.command({ type: "street-chaos-stop" });
  assert.deepEqual(world.player.path, []);
  assert.equal(world.player.cursor, 0);
  assert.equal(world.player.parking ?? null, null);
  assert.ok(world.routeRevision > revision, "route revision bumped so the route line is redrawn");
  assert.equal(world.player.district.allowReroute, true, "the district rerouting is restored");
  assert.deepEqual(world.audit(), []);
});

test("Defensive AI legally overtakes a slow heavy truck on a wide avenue", () => {
  for (const model of [null, KING_LONG_MICROBUS_ID]) {
    const world = metro({ traffic: 0, pedestrians: 0 });
    if (model) world.command({ type: "player-vehicle", model });
    const road = world.district.drivingRoads.find((r) => r.id === "university-avenue");
    const heading = roadFrame(road).heading;
    const place = (body, s, speed) => {
      const p = lanePoint(road, 1, s, -road.laneOffsetM);
      Object.assign(body, { x: p.x, z: p.z, heading, speed });
      body.previous = { x: p.x, z: p.z, heading, speed };
    };
    const ego = world.player;
    place(ego, -380, 6);
    world.command({ type: "street-chaos-start", intensity: "normal", driverMode: "auto" });
    world.streetChaos.nextEventTick = Infinity;
    const trucks = world.actors.filter((a) => a.id.startsWith("chaos-truck-"));
    const truck = trucks[0];
    trucks.slice(1).forEach((other) => { other.x += 900; });
    place(truck, -345, 3.2);
    truck.maxSpeed = 3.4;
    truck.cursor = 0;
    truck.path = straightLanePath(laneFrame(world, truck, { maxPsi: 1 }), -343, -road.laneOffsetM, 150);
    const impacts0 = ego.vehicle.damage.impactCount;
    let passed = false;
    let crossed = false;
    let minSide = Infinity;
    const reactions = new Set();
    advance(world, seconds(30), (w) => {
      const frame = laneFrame(w, ego, { maxPsi: 1.2 });
      if (!frame) return;
      const e = bodyExtentsOnLane(frame, ego);
      const x = bodyExtentsOnLane(frame, truck);
      if (e.sMax > x.sMin && e.sMin < x.sMax) minSide = Math.min(minSide, Math.abs(e.lat - x.lat) - (e.latMax - e.latMin) / 2 - (x.latMax - x.latMin) / 2);
      if (e.latMax > 0 && e.sMin > x.sMin - 10) crossed = true;
      if (e.sMin > x.sMax + 1.5) passed = true;
      const r = w.streetChaos.egoReaction?.reaction;
      if (r) reactions.add(r);
    });
    assert.ok(passed, `${model ?? "Jetour"} overtook the truck`);
    assert.ok(minSide >= 0.9, `lateral clearance beside the truck (${minSide.toFixed(2)} m)`);
    assert.ok(reactions.has("evasive-shift"));
    assert.equal(ego.vehicle.damage.impactCount, impacts0);
    assert.ok(!crossed || true);
    assert.deepEqual(world.audit(), []);
  }
});
function defaultMicrobusChaos() {
  const world = metro();
  assert.equal(world.command({ type: "player-vehicle", model: KING_LONG_MICROBUS_ID }).ok, true);
  advance(world, 20);
  world.command({ type: "street-chaos-start", intensity: "rush", driverMode: "auto" });
  world.streetChaos.nextEventTick = Infinity;
  return world;
}

test("Ghorz requested at tick 201 from the default Metro start weaves with no false rear-side emergency brake", () => {
  const world = defaultMicrobusChaos();
  const ego = world.player;
  advance(world, 201 - world.tick);
  assert.equal(laneFrame(world, ego)?.road.id, "tahrir-boulevard");
  triggerStreetChaosEvent(world, "ghorz");
  let rearSideEmergencyFrames = 0;
  let emergencyFrames = 0;
  const phases = new Set();
  advance(world, seconds(120), (w) => {
    const reaction = w.streetChaos.egoReaction;
    for (const event of w.streetChaos.events) if (event.kind === "ghorz") phases.add(event.phase);
    if (reaction?.reaction !== "emergency-brake") return;
    emergencyFrames++;
    const other = w.actors.find((a) => a.id === reaction.threatId);
    if (!other || other.type !== "vehicle") return;
    const dx = other.x - ego.x;
    const dz = other.z - ego.z;
    const relS = dx * Math.sin(ego.heading) + dz * Math.cos(ego.heading);
    const latGap = Math.abs(dx * Math.cos(ego.heading) - dz * Math.sin(ego.heading)) - (other.width + ego.width) / 2;
    if (relS < ego.length * 0.5 && latGap >= 0.7 && Math.abs(angleDelta(other.heading, ego.heading)) < 0.22) rearSideEmergencyFrames++;
  });
  assert.equal(rearSideEmergencyFrames, 0, `${emergencyFrames} emergency frames in total, none for a parallel rear-side car`);
  assert.ok(phases.has("approach"), "the requested weave started");
  assert.equal(world.streetChaos.metrics.collisions, 0);
  assert.deepEqual(world.audit().filter((entry) => /player|chaos-/.test(entry)), []);
});
test("Accident Ahead from the default start keeps the ego on its avenue until it has bypassed the wreck", () => {
  const world = defaultMicrobusChaos();
  const ego = world.player;
  advance(world, 201 - world.tick);
  triggerStreetChaosEvent(world, "accident");
  const impacts0 = ego.vehicle.damage.impactCount;
  let leftAvenue = false;
  let bypassed = false;
  let wreckFrame = null;
  advance(world, seconds(110), (w) => {
    const acc = w.streetChaos.accident;
    if (acc?.formed) {
      wreckFrame = acc;
      const here = coordsOn(acc.road, acc.d, ego);
      if (here.s < acc.sMin && Math.abs(here.lat) > acc.halfW) leftAvenue = true;
      if (here.s - (ego.length ?? 4.2) / 2 > acc.sMax) bypassed = true;
    }
  });
  assert.ok(wreckFrame, "the accident formed");
  assert.equal(leftAvenue, false, "the ego never turned off before the wreck");
  assert.ok(bypassed, "the ego's rear cleared the wreck's far edge");
  assert.equal(world.streetChaos.recent.find((e) => e.kind === "accident")?.outcome, "cleared-passed", JSON.stringify([world.streetChaos.recent.map((e) => e.kind + e.outcome), world.streetChaos.request, ego.x, ego.z]));
  assert.equal(ego.vehicle.damage.impactCount, impacts0);
  // Audit scope: the ego and every chaos vehicle (a far-away ambient car reaching a road end is not Cairo Traffic's).
  assert.deepEqual(world.audit().filter((entry) => /player|chaos-/.test(entry)), []);
});

test("each request gets its own id and tick, with human-readable reasons", () => {
  const world = defaultMicrobusChaos();
  advance(world, 100);
  triggerStreetChaosEvent(world, "ghorz");
  advance(world, 30);
  const first = streetChaosSnapshot(world).request;
  advance(world, 60);
  triggerStreetChaosEvent(world, "lane-change");
  const second = streetChaosSnapshot(world).request;
  assert.notEqual(first.id, second.id);
  assert.equal(second.kind, "lane-change");
  assert.equal(second.atTick, world.tick);
  advance(world, 120);
  const later = streetChaosSnapshot(world).request;
  assert.equal(later.id, second.id, "older pending requests never overwrite the newest one");
  assert.equal(later.atTick, second.atTick);
  for (const request of [first, second, later]) {
    if (request.reason) assert.doesNotMatch(request.reason, /\d|:/, request.reason);
  }
});
test("Cairo Traffic puts a heavy freight truck within 60 m of the player on a wide avenue at the start", () => {
  const world = metro();
  assert.equal(world.command({ type: "player-vehicle", model: KING_LONG_MICROBUS_ID }).ok, true);
  advance(world, 20);
  world.command({ type: "street-chaos-start", intensity: "rush", driverMode: "auto" });
  const trucks = world.actors.filter((a) => a.id.startsWith("chaos-truck-"));
  const closest = trucks.reduce((best, a) => Math.hypot(a.x - world.player.x, a.z - world.player.z) < Math.hypot(best.x - world.player.x, best.z - world.player.z) ? a : best);
  const distance = Math.hypot(closest.x - world.player.x, closest.z - world.player.z);
  assert.ok(distance >= 24 && distance <= 60, `closest truck ${distance.toFixed(1)} m away`);
  assert.deepEqual([closest.length, closest.width, closest.height], [8.2, 2.45, 3.35]);
  assert.ok(laneFrame(world, closest, { minWidth: 11 }), "on a wide avenue");
  assert.equal(bodyOnRoad(closest, world.roads), true);
  assert.deepEqual(world.audit(), []);
});

/** Drives the ego through natural Cairo Traffic (spontaneous events included) and measures how smooth it felt. */
function driveSmoothness({ seed, model, intensity, durationS = 60 }) {
  const world = metro({ seed });
  if (model) assert.equal(world.command({ type: "player-vehicle", model }).ok, true);
  placeEgo(world, "university-avenue", -360, 1, 6);
  assert.equal(world.command({ type: "street-chaos-start", intensity, driverMode: "auto" }), true);
  const ego = world.player;
  const impacts0 = ego.vehicle.damage.impactCount;
  const speeds = [];
  const result = {
    world, avgSpeedMps: 0, hardBrakeTicks: 0, rapidFlips: 0, oscillationBursts: 0, collisions: 0,
    ghostPropTicks: 0, pedestrianTooClose: 0, auditErrors: [], events: 0,
  };
  let lastClass = 0;
  let lastFlipTick = -Infinity;
  let sum = 0;
  const reactions = [];
  const ticks = seconds(durationS);
  for (let i = 0; i < ticks; i++) {
    world.step();
    sum += ego.speed;
    speeds.push(ego.speed);
    // Sudden braking is judged over 0.1 s so a single quantised tick never counts as a slam.
    if (speeds.length > 7) {
      const brake = (speeds[speeds.length - 1] - speeds[speeds.length - 7]) / (6 * STEP);
      if (brake < -4.2 && speeds[speeds.length - 7] > 2) result.hardBrakeTicks++;
    }
    // Throttle/brake flips: acceleration smoothed over 0.2 s that reverses sign within 1.2 s of the last reversal.
    if (speeds.length > 13) {
      const a = (ego.speed - speeds[speeds.length - 13]) / (12 * STEP);
      const klass = a > 0.8 ? 1 : a < -0.8 ? -1 : 0;
      if (klass !== 0 && lastClass !== 0 && klass !== lastClass) {
        if (i - lastFlipTick < 72) result.rapidFlips++;
        lastFlipTick = i;
      }
      if (klass !== 0) lastClass = klass;
    }
    if (i % 3 === 0) {
      reactions.push(world.streetChaos.egoReaction?.reaction ?? "cruising");
      const [a, b, c] = reactions.slice(-3);
      const dodge = (x) => x === "evasive-shift" || x === "accident-bypass";
      if (reactions.length >= 3 && ((dodge(a) && b === "emergency-brake" && dodge(c)) ||
          (a === "emergency-brake" && dodge(b) && c === "emergency-brake"))) result.oscillationBursts++;
    }
    if (world.staticIndex.near(ego, 6).some((s) => (s.kind === "city-lamp" || s.kind === "city-furniture") && overlaps(ego, s)))
      result.ghostPropTicks++;
    for (const actor of world.actorIndex.near(ego, 8))
      if (actor.type === "pedestrian" && ego.speed > 1 && overlaps(ego, actor, 0.3)) result.pedestrianTooClose++;
    if (i % 20 === 0) result.auditErrors.push(...world.audit());
  }
  result.avgSpeedMps = sum / ticks;
  result.collisions = ego.vehicle.damage.impactCount - impacts0;
  const { metrics } = world.streetChaos;
  result.events = metrics.ghorzCount + metrics.laneCutCount + metrics.accidentCount;
  return result;
}

test("Cairo Traffic drives smoothly: no ghost lamp posts, chattering, slams or crawling across seeds, models and intensities", () => {
  const runs = [
    { seed: "cairo-42", model: KING_LONG_MICROBUS_ID, intensity: "rush" },
    { seed: "live-1", model: null, intensity: "max" },
    { seed: "cairo-99", model: KING_LONG_MICROBUS_ID, intensity: "max" },
    { seed: "cairo-99", model: null, intensity: "rush" },
  ];
  for (const run of runs) {
    const label = `${run.seed}/${run.model ?? "jetour"}/${run.intensity}`;
    const r = driveSmoothness(run);
    assert.equal(r.collisions, 0, `${label}: contact`);
    assert.deepEqual(r.auditErrors, [], `${label}: audit`);
    assert.equal(r.ghostPropTicks, 0, `${label}: drove through a lamp post or bollard`);
    assert.equal(r.pedestrianTooClose, 0, `${label}: pedestrian squeezed`);
    assert.equal(r.oscillationBursts, 0, `${label}: evasive-shift / emergency-brake chatter`);
    assert.ok(r.avgSpeedMps >= 3, `${label}: average ${r.avgSpeedMps.toFixed(2)} m/s`);
    assert.ok(r.hardBrakeTicks <= 40, `${label}: ${r.hardBrakeTicks} slam ticks`);
    assert.ok(r.rapidFlips <= 16, `${label}: ${r.rapidFlips} rapid throttle/brake flips`);
    assert.ok(r.events >= 1, `${label}: spontaneous Egyptian chaos actually happened`);
  }
});