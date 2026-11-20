import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createDistrictBehaviorState, initializeDistrictActor, nextDistrictWalk,
  stepDistrictPedestrian, updateDistrictTraffic, districtTrafficCommand,
  districtBehaviorDiagnostics, planDistrictTrafficTrip,
} from "../src/core/district-behavior.js";
import {
  DISTRICT_CASES, createDistrictCase, advanceDistrictCase,
} from "../src/core/district-scenarios.js";
import { createPedestrianBody } from "../src/core/pedestrian-body.js";
import { safeSpeed } from "../src/core/traffic-control.js";
import { STEP } from "../src/core/config.js";
import { Random } from "../src/core/random.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { angleDelta, bodyOnRoad, distance, overlaps, sweepSafe } from "../src/core/geometry.js";
import { followPath, integrateVehicle } from "../src/core/vehicle.js";
import { walkSegmentClear } from "../src/core/walk-route.js";
import { createEgyptDistrict } from "../src/core/egypt-district.js";
import { planDistrictRoute } from "../src/core/district-navigation.js";
import { PLAYER_VEHICLE } from "../src/core/vehicle-spec.js";
import { World } from "../src/core/world.js";
import {
  createDistrictSpeedState, mappedDistrictSpeed, composeDistrictSpeed, attributeDistrictApplied,
} from "../src/core/visual-speed-policy.js";

function vehicle(id, pose = {}) {
  return {
    id, type: "vehicle", kind: "sedan", x: 0, z: 0, heading: 0,
    speed: 0, steer: 0, length: 4.2, width: 1.85, maxSpeed: 4.5,
    path: [], cursor: 0, distance: 0, wait: 0, phase: 0.5, reason: "ready",
    ...pose,
  };
}

function districtFixture(seed = "district-dev-a") {
  const road = {
    id: "local", axis: "z", fixed: 0, min: -60, max: 60,
    width: 6.4, speedLimitMps: 4.5, laneOffsetM: 1.5, flow: 0,
  };
  const walkways = [
    { id: "west-walk", roadId: road.id, axis: "z", fixed: -4.2, min: -45, max: 45, side: 1, shared: false },
    { id: "east-walk", roadId: road.id, axis: "z", fixed: 4.2, min: -45, max: 45, side: -1, shared: false },
  ];
  const world = {
    environment: "egypt", rng: new Random(seed), config: { chaos: 0.4 },
    tick: 0, mode: "manual", input: { targetSpeed: 0, steer: 0 },
    district: { drivingRoads: [road], roads: [road], walkways, conflictZones: [], statics: [] },
    districtBehavior: createDistrictBehaviorState(),
    drivingRoads: [road], roads: [road], statics: [], actors: [],
    junctions: [], junctionGroups: [], junctionOwners: new Map(),
  };
  world.nextWalk = (p) => nextDistrictWalk(world, p);
  world.staticIndex = new SpatialIndex();
  world.actorIndex = new SpatialIndex();
  return world;
}

function walker(world, overrides = {}) {
  const person = {
    id: "person", type: "pedestrian", kind: "man-polo",
    x: -4.2, z: 0, heading: Math.PI / 2, speed: 0, walkSpeed: 1.3,
    radius: 0.34, phase: 0.25, distance: 0, wait: 0, reason: "ready",
    road: world.roads[0], side: 1, along: 0,
    target: { x: 4.2, z: 0 }, pause: 0, crossing: true, motionMode: "ambient",
    ...overrides,
  };
  person.body = createPedestrianBody(person);
  person.radius = person.body.radiusM;
  return person;
}

function refresh(world) {
  world.actorIndex = new SpatialIndex(world.actors);
  world.staticIndex = new SpatialIndex(world.statics);
}

function acceptPerson(world, p, advance = stepDistrictPedestrian) {
  refresh(world);
  const before = { ...p };
  const next = advance(world, p);
  const others = world.actors.filter((actor) => actor !== p).concat(world.statics);
  const guard = sweepSafe(p, next, others);
  assert.equal(guard.safe, true, `${p.id}: ${guard.reason}/${guard.actor}`);
  const moved = distance(p, next);
  if (next.reason !== "blocked") {
    assert.ok(next.speed - before.speed <= p.body.maxAccelerationMps2 * STEP + 1e-8);
    assert.ok(before.speed - next.speed <= p.body.maxDecelerationMps2 * STEP + 1e-8);
  }
  assert.ok(Math.abs(angleDelta(next.heading, before.heading)) <= 3 * STEP + 1e-8);
  assert.ok(Math.abs(moved - next.speed * STEP) < 1e-8);
  Object.assign(p, next, {
    previous: before, distance: p.distance + moved,
    wait: moved < 0.001 ? p.wait + STEP : 0,
  });
  return moved;
}

function acceptCar(world, car, requested, mapEnabled = false) {
  refresh(world);
  const behavior = districtTrafficCommand(world, car, requested);
  const composed = mapEnabled ? composeDistrictSpeed(behavior, {
    map: mappedDistrictSpeed({
      zones: world.district.cautionZones,
      ego: { x: car.x, z: car.z, headingRad: car.heading, speedMps: car.speed,
        lengthM: car.length, widthM: car.width },
    }),
    dt: STEP, previousState: car.testSpeedState ?? createDistrictSpeedState(),
  }) : behavior;
  if (mapEnabled) car.testSpeedState = composed.nextState;
  const guarded = safeSpeed(world, car, composed);
  const safe = mapEnabled ? attributeDistrictApplied({
    requested, behavior, composed, safe: guarded,
  }) : guarded;
  const next = integrateVehicle(car, safe, STEP);
  const others = world.actors.filter((actor) => actor !== car).concat(world.statics);
  const guard = sweepSafe(car, next, others, world.roads);
  assert.equal(guard.safe, true, `${car.id} at ${world.tick}: ${guard.reason}/${guard.actor} ${JSON.stringify({
    x: next.x, z: next.z, heading: next.heading, speed: next.speed, command: safe,
  })}`);
  const moved = distance(car, next);
  assert.ok(moved <= (Math.max(car.speed, next.speed) + 1e-8) * STEP);
  Object.assign(car, next, {
    distance: car.distance + moved, reason: safe.reason, blockedBy: safe.blockedBy,
    wait: moved < 0.001 ? car.wait + STEP : 0,
  });
  return safe;
}

function uncachedEntryDistance(car, zone) {
  const box = {
    type: "static", x: (zone.minX + zone.maxX) / 2, z: (zone.minZ + zone.maxZ) / 2,
    width: zone.maxX - zone.minX, length: zone.maxZ - zone.minZ, heading: 0,
  };
  if (overlaps(car, box, 0.12)) return 0;
  let nearest = Math.max(0, car.cursor - 2), best = Infinity;
  for (let i = nearest; i < Math.min(car.path.length, car.cursor + 18); i++) {
    const d = distance(car, car.path[i]);
    if (d < best) { best = d; nearest = i; }
  }
  let travelled = 0, prior = car;
  for (let i = nearest; i < car.path.length && travelled < 110; i++) {
    const point = car.path[i];
    if (i === nearest && (point.x - car.x) * Math.sin(car.heading) +
        (point.z - car.z) * Math.cos(car.heading) < -0.05) continue;
    const segment = distance(prior, point);
    if (segment < 0.03) continue;
    travelled += segment;
    const pose = { ...car, ...point,
      heading: Math.atan2(point.x - prior.x, point.z - prior.z) };
    if (overlaps(pose, box, 0.12)) return travelled;
    prior = point;
  }
  return Infinity;
}

function assertExactApproach(world, car, zone) {
  const expected = uncachedEntryDistance(car, zone);
  const threshold = Math.max(zone.approachM, car.length + 1, car.speed ** 2 / 7 + 2);
  world.districtBehavior = createDistrictBehaviorState();
  updateDistrictTraffic(world);
  assert.equal(world.districtBehavior.approaches[car.id]?.distanceM,
    expected <= threshold ? expected : undefined);
}

test("district entry points do not consume legacy RNG or create legacy state", () => {
  const world = {
    environment: "city",
    rng: { next() { throw new Error("legacy RNG consumed"); } },
  };
  const car = vehicle("car"), command = { targetSpeed: 3, steer: 0 };
  assert.equal(initializeDistrictActor(world, car), car);
  assert.equal(nextDistrictWalk(world, {}), false);
  updateDistrictTraffic(world);
  assert.equal(districtTrafficCommand(world, car, command), command);
  assert.equal(districtBehaviorDiagnostics(world), null);
  assert.equal(Object.hasOwn(world, "districtBehavior"), false);
  assert.equal(Object.hasOwn(car, "district"), false);
});

test("warm immutable path footprints match uncached geometry across poses, short segments and worlds", () => {
  const zone = { id: "cache-zone", kind: "junction", minX: -0.8, maxX: 0.8,
    minZ: -2, maxZ: 2, approachM: 9 };
  const path = Array.from({ length: 121 }, (_, i) => ({
    x: Math.sin(i / 11) * 0.6, z: -18 + i * 0.35,
  })).flatMap((point, i) => i % 17 ? [point]
    : [point, { x: point.x + 0.005, z: point.z + 0.005 }]);
  const original = structuredClone(path);
  for (let i = 0; i < 80; i++) {
    const world = districtFixture();
    world.roads[0].width = 20;
    world.mode = "auto";
    world.district.conflictZones = [zone];
    const z = -8 + (i % 40) * 0.4;
    const car = vehicle("cached", {
      x: (i % 3 - 1) * 0.4, z, heading: (i % 5 - 2) * 0.35,
      path, cursor: Math.max(0, Math.floor((z + 18) / 0.35)),
      length: i % 2 ? 2.9 : 4.2, width: i % 2 ? 1.5 : 1.85,
      district: { caseId: "cache-test", profile: "ordinary", loadingUntilTick: null },
    });
    world.actors = [car];
    assertExactApproach(world, car, zone);
  }
  assert.deepEqual(path, original, "derived cache must not annotate or mutate caller paths");
});

test("in-place path, zone and body mutations invalidate warmed footprints immediately", () => {
  const world = districtFixture();
  world.roads[0].width = 20;
  world.mode = "auto";
  const zone = { id: "mutable-zone", kind: "junction", minX: -0.8, maxX: 0.8,
    minZ: -2, maxZ: 2, approachM: 9 };
  const path = Array.from({ length: 85 }, (_, i) => ({ x: 0, z: -18 + i * 0.5 }));
  const car = vehicle("cached", {
    z: -8, path, cursor: 20,
    district: { caseId: "cache-test", profile: "ordinary", loadingUntilTick: null },
  });
  world.actors = [car]; world.district.conflictZones = [zone];
  const query = () => { world.tick++; assertExactApproach(world, car, zone); };
  query(); query();
  for (const point of path) point.x = 3;
  query();
  for (const point of path) { point.x = 0; point.z += 0.4; }
  query();
  zone.minX = 2; zone.maxX = 4;
  query();
  car.width = 5;
  query();
  car.length = 5.1;
  query();
  zone.minZ = -3.1;
  query();
  car.path = structuredClone(path);
  query();
  car.path[20] = { x: -0, z: 1000 };
  query();
});

test("seeded profiles are repeatable, have actual headway effects and no cross-world state", () => {
  const run = () => {
    const world = districtFixture();
    const cars = Array.from({ length: 24 }, (_, i) => vehicle(`car-${i}`));
    for (const car of cars) initializeDistrictActor(world, car);
    return cars.map((car) => car.district);
  };
  assert.deepEqual(run(), run());
  assert.deepEqual([...new Set(run().map((p) => p.headwayS))].sort(), [1, 1.6, 2.2]);
  const distances = [];
  for (const [profile, headwayS] of [["cautious", 2.2], ["ordinary", 1.6], ["assertive", 1]]) {
    const world = districtFixture(), follower = vehicle("follower", { x: -1.5, speed: 3 });
    const leader = vehicle("leader", { x: -1.5, z: 10, speed: 2 });
    follower.district = { profile, headwayS, loadingUntilTick: null };
    world.actors = [follower, leader];
    for (let tick = 0; tick < 90; tick++) {
      Object.assign(leader, integrateVehicle(leader, { targetSpeed: 2, steer: 0 }, STEP));
      const command = acceptCar(world, follower, { targetSpeed: 4.5, steer: 0, reason: "route" });
      assert.equal(command.blockedBy, leader.id);
      world.tick++;
    }
    distances.push(follower.distance);
  }
  assert.ok(distances[0] + 0.3 < distances[1], distances.join(","));
  assert.ok(distances[1] + 0.3 < distances[2], distances.join(","));
  const a = districtFixture(), b = districtFixture();
  a.districtBehavior.reservations.test = { ownerId: "only-a" };
  assert.deepEqual(b.districtBehavior.reservations, {});
});

test("declared shared alley walklines remain legal and static-blocked targets are rejected", () => {
  const world = districtFixture();
  world.district.walkways = [{
    id: "shared", roadId: "local", axis: "z", fixed: 0.5,
    min: -12, max: 12, side: 1, shared: true,
  }];
  const p = walker(world, { x: 0.5, heading: 0, phase: 0.75, side: 1, target: null });
  world.actors = [p];
  world.rng.next = () => 0.8;
  assert.equal(nextDistrictWalk(world, p), true);
  assert.equal(p.target.x, 0.5);
  assert.ok(p.target.z >= -12 + p.radius + 0.12 && p.target.z <= 12 - p.radius - 0.12);
  for (let tick = 0; tick < 120; tick++) {
    acceptPerson(world, p);
    world.tick++;
  }
  assert.ok(p.distance > 1);
  assert.ok(Math.abs(p.x - 0.5) < 0.02);
  const wall = { id: "door-block", type: "static", x: 0.5, z: 8, heading: 0, width: 2, length: 5 };
  world.statics = [wall];
  nextDistrictWalk(world, p);
  assert.equal(walkSegmentClear(p, p.target, p.target, [wall], 0.12), true);
  assert.equal(walkSegmentClear(p, p, p.target, [wall], 0.12), true);
});

test("a declared doorway connection produces continuous walking around its registered corner", () => {
  const world = districtFixture();
  world.district.walkways = [
    { id: "rear", roadId: "local", axis: "z", fixed: 0.5, min: 0, max: 12, side: 1, shared: true },
    { id: "doorway", roadId: "local", axis: "x", fixed: 11.5, min: 0.5, max: 7, side: -1, shared: true, doorway: true },
  ];
  world.statics = [{ id: "corner", type: "static", x: 3.5, z: 9.8, width: 5, length: 1.5, heading: 0 }];
  const p = walker(world, { x: 0.5, z: 10, heading: 0, phase: 0.75, target: null });
  world.actors = [p]; world.rng.next = () => 0.48;
  assert.equal(nextDistrictWalk(world, p), true);
  assert.equal(p.target.z, 11.5);
  assert.equal(p.district.targetWalkwayId, "doorway");
  assert.ok(p.walkRoute.length >= 2);
  for (let tick = 0; tick < 420; tick++) {
    acceptPerson(world, p);
    world.tick++;
  }
  assert.ok(p.distance > 3);
  assert.ok(p.x > 2);
  assert.ok(world.districtBehavior.metrics.acceptedPedestrianDistanceM > 3);
});

test("32 authored people keep safe declared targets beside the actual 28 stationary traffic bodies", () => {
  const district = createEgyptDistrict(), world = districtFixture("district-dev-b");
  Object.assign(world, {
    district, roads: district.roads, drivingRoads: district.drivingRoads, statics: district.statics,
  });
  const traffic = district.trafficSpawns.slice(0, 28).map((pose, i) => vehicle(`traffic-${i}`, pose));
  const people = district.pedestrianSpawns.slice(0, 32).map((pose, i) => walker(world, {
    ...pose, id: `person-${i}`, target: null, phase: world.rng.next(),
    road: district.drivingRoads.find((road) => road.id === pose.roadId),
  }));
  world.actors = [...traffic, ...people];
  for (const p of people) nextDistrictWalk(world, p);
  for (let tick = 0; tick < 600; tick++) {
    for (const p of people) {
      acceptPerson(world, p);
      assert.equal(walkSegmentClear(p, p.target, p.target, world.statics, 0.12), true);
      const target = p.district.destination;
      const belongs = district.walkways.some((line) => {
        const position = line.axis === "z" ? target.z : target.x;
        const lateral = line.axis === "z" ? target.x : target.z;
        return Math.abs(lateral - line.fixed) < 0.25 &&
          position >= line.min - 0.25 && position <= line.max + 0.25;
      });
      assert.equal(belongs, true, `${p.id}: undeclared target ${JSON.stringify(target)}`);
    }
    world.tick++;
  }
  assert.equal(people.length, 32);
  assert.equal(traffic.length, 28);
  assert.ok(people.filter((person) => person.distance > 1).length >= 24,
    JSON.stringify(people.map(({ id, distance, reason }) => ({ id, distance, reason }))));
});

test("Egypt-only non-yielding curb profile actually enters while a yielding twin looks", () => {
  const positions = [];
  for (const yieldAtCurb of [true, false]) {
    const world = districtFixture();
    const p = walker(world);
    p.district = { caseId: "controlled", yieldAtCurb, holdAtTarget: true, observedDistanceM: 0 };
    const car = vehicle("approach", { x: -1.5, z: -6, speed: 3 });
    world.actors = [car, p];
    for (let tick = 0; tick < 72; tick++) {
      acceptCar(world, car, { targetSpeed: 3, steer: 0, reason: "route" });
      acceptPerson(world, p);
      world.tick++;
    }
    positions.push(p.x);
    if (yieldAtCurb) assert.equal(p.reason, "looking");
    else assert.ok(p.distance > 0.7, "the opt-in must cause physical movement, not a label");
  }
  assert.ok(positions[1] > positions[0] + 0.6);
});

test("hesitation and retreat are triggered by actual approaching traffic, with bounded resume", () => {
  for (const [choice, expected] of [[0.2, "hesitating"], [0.35, "retreating"]]) {
    const world = districtFixture();
    world.rng.next = () => choice;
    const p = walker(world, { target: null });
    const car = vehicle("approach", { x: -1.5, z: -10, speed: 3.2 });
    world.actors = [car, p];
    nextDistrictWalk(world, p);
    let sawAcceptedRetreat = false, previousX = p.x;
    for (let tick = 0; tick < 900; tick++) {
      acceptCar(world, car, { targetSpeed: 3.2, steer: 0, reason: "route" });
      acceptPerson(world, p);
      if (p.district.stage === "retreating" && p.x < previousX - 0.001)
        sawAcceptedRetreat = true;
      previousX = p.x;
      world.tick++;
    }
    const events = districtBehaviorDiagnostics(world).events;
    const reaction = events.find((entry) => entry.kind === expected);
    assert.ok(reaction, `${expected} must be observed`);
    assert.equal(reaction.trigger, "vehicle-approach-after-entry");
    assert.equal(reaction.actorId, p.id);
    assert.equal(reaction.triggerActorId, car.id);
    assert.equal(reaction.acceptedProgressM > 0.55, true);
    assert.ok(events.some((entry) => entry.kind === "resume"));
    if (expected === "retreating") assert.equal(sawAcceptedRetreat, true);
    assert.ok(p.distance > 4);
  }
});

test("stationary, parallel, diagonal and emergence have distinct accepted motion", () => {
  for (const [choice, pattern] of [
    [0.02, "diagonal"], [0.48, "emergence"], [0.65, "stationary"], [0.8, "parallel"],
  ]) {
    const world = districtFixture();
    world.rng.next = () => choice;
    const p = walker(world, { target: null,
      ...(pattern === "parallel" ? { phase: 0.75, heading: 0 } : {}),
    });
    world.actors = [p];
    nextDistrictWalk(world, p);
    const start = { ...p };
    const ticks = pattern === "stationary" ? 45 : pattern === "emergence" ? 390 : 300;
    for (let tick = 0; tick < ticks; tick++) {
      acceptPerson(world, p);
      world.tick++;
    }
    if (pattern === "stationary") assert.equal(p.distance, 0);
    if (pattern === "parallel") {
      assert.ok(Math.abs(p.z - start.z) > 3);
      assert.ok(Math.abs(p.x - start.x) < 0.02);
    }
    if (pattern === "diagonal") {
      assert.ok(p.x - start.x > 3);
      assert.ok(Math.abs(p.z - start.z) > 1);
    }
    if (pattern === "emergence") {
      assert.ok(p.distance > 1);
      assert.ok(districtBehaviorDiagnostics(world).events.some((entry) =>
        entry.kind === "emergence" && entry.trigger === "bounded-idle-release"));
    }
  }
});

test("district pedestrian cause attribution clears stale blockers and retains actual physical stops", () => {
  const obstacle = (p) => ({
    id: "live-person", type: "pedestrian", radius: p.radius, speed: 0,
    x: p.x + Math.sin(p.heading) * (p.radius * 2 + 0.121),
    z: p.z + Math.cos(p.heading) * (p.radius * 2 + 0.121),
  });
  for (const blocked of [false, true]) {
    const world = districtFixture(), p = walker(world, {
      blockedBy: "old-person", speed: blocked ? 1 : 0,
    });
    p.district = blocked
      ? { pattern: "stationary", stage: "holding", holdUntilTick: 600 }
      : { caseId: "attribution", yieldAtCurb: false, holdAtTarget: true };
    const blocker = obstacle(p);
    world.actors = blocked ? [p, blocker] : [p];
    refresh(world);
    const next = stepDistrictPedestrian(world, p);
    if (blocked) {
      assert.equal(next.reason, "blocked");
      assert.equal(next.blockedBy, blocker.id);
      assert.equal(next.speed, 0);
    } else {
      assert.ok(next.speed > 0);
      assert.equal(next.blockedBy, null);
    }
  }
  const world = districtFixture();
  world.district = caseProfile();
  const scene = createDistrictCase(world.district, "visible-left", "district-dev-a");
  const p = scene.people[0], blocker = obstacle(p);
  p.speed = 1;
  p.blockedBy = "old-person";
  world.districtCase = scene;
  scene.phase = "running";
  world.player = vehicle("player", scene.playerStart);
  world.actors = [world.player, p, blocker];
  refresh(world);
  const next = advanceDistrictCase(world, p);
  assert.equal(next.reason, "blocked", "a case hold cannot mask an actual physical stop");
  assert.equal(next.blockedBy, blocker.id);
  assert.equal(next.speed, 0);
});

test("stopped district walkers detour around a real queued peer instead of freezing beside a vehicle", () => {
  const district = createEgyptDistrict(), world = districtFixture();
  const car = vehicle("stopped-alley-car", {
    x: 19.9036443609187, z: 11.879978423104978, heading: 0.03496820767820719,
  });
  Object.assign(world, {
    district, roads: district.roads, drivingRoads: district.drivingRoads,
    statics: district.statics,
  });
  const people = [
    { id: "southbound-person", x: 21.36943269679872, z: 13.856101493250577,
      heading: 3.0529748076421224, radius: 0.35031416311667, walkSpeed: 1.469521932839416,
      target: { x: 21.75, z: 9.572872045577233 } },
    { id: "northbound-person", x: 21.816334619901554, z: 12.232446011643866,
      heading: -0.24768267491488327, radius: 0.37891246650209964, walkSpeed: 1.2331619366654196,
      target: { x: 18.25, z: 14.759823103129245 },
      walkRoute: [{ x: 21.485576392301326, z: 13.540437216690007 },
        { x: 18.25, z: 14.759823103129245 }] },
  ].map((data) => {
    const person = walker(world, { ...data, wait: 2, crossing: true });
    person.radius = data.radius;
    person.body = { ...person.body, radiusM: data.radius };
    person.district = {
      caseId: "stopped-peer", routeConstrained: true, yieldAtCurb: false,
      holdAtTarget: true, observedDistanceM: 0,
    };
    person.walkRoute ??= [{ ...person.target }];
    return person;
  });
  world.actors = [car, ...people];
  const carPose = { x: car.x, z: car.z, heading: car.heading };
  for (; world.tick < 30 * 60; world.tick++)
    for (const person of people) acceptPerson(world, person);
  for (const person of people) {
    assert.ok(distance(person, person.target) < 0.3, `${person.id}: ${JSON.stringify({
      x: person.x, z: person.z, target: person.target, reason: person.reason,
    })}`);
    assert.ok(person.speed < 0.08);
    assert.ok(person.distance > 3);
  }
  assert.deepEqual({ x: car.x, z: car.z, heading: car.heading }, carPose);
});

function passageFixture({ opposing = true } = {}) {
  const world = districtFixture();
  const narrow = { id: "narrow", axis: "z", fixed: 0, min: -10, max: 10, width: 3.8, speedLimitMps: 4.5 };
  world.roads = [
    narrow,
    { id: "south", axis: "z", fixed: 0, min: -40, max: -10, width: 8, speedLimitMps: 4.5 },
    { id: "north", axis: "z", fixed: 0, min: 10, max: 40, width: 8, speedLimitMps: 4.5 },
  ];
  world.drivingRoads = world.roads;
  world.district.drivingRoads = world.roads;
  world.district.conflictZones = [{
    id: "passage", kind: "single-lane",
    minX: -4, maxX: 4, minZ: -17, maxZ: 17, approachM: 9,
  }];
  const path = (sign) => Array.from({ length: 161 }, (_, i) => {
    const z = sign * (-28 + i * 0.375);
    const t = Math.max(0, Math.min(1, (Math.abs(z) - 7) / 11));
    return { x: -sign * 1.6 * t * t * (3 - 2 * t), z };
  });
  const a = vehicle("northbound", { x: -1.6, z: -28, path: path(1), goal: { x: -1.6, z: 32 } });
  const b = vehicle("southbound", { x: 1.6, z: 28, heading: Math.PI, path: path(-1), goal: { x: 1.6, z: -32 } });
  for (const car of [a, b])
    car.district = { profile: "ordinary", headwayS: 1.6, caseId: "passage", loadingUntilTick: null };
  world.actors = opposing ? [a, b] : [a];
  world.mode = "auto";
  return { world, a, b };
}

test("actual opposing vehicles both finish the narrow passage, with fair bounded waiting", () => {
  const { world, a, b } = passageFixture();
  const ids = world.actors.map((car) => car.id);
  const completed = new Map(), arrivals = new Map();
  let maxSecondWaitS = 0;
  for (let tick = 0; tick < 45 * 60 && completed.size < 2; tick++) {
    updateDistrictTraffic(world);
    for (const entry of world.districtBehavior.events)
      if (entry.kind === "resource-arrival" && !arrivals.has(entry.actorId))
        arrivals.set(entry.actorId, entry.timeS);
    for (const entry of world.districtBehavior.queues.passage ?? [])
      if (entry.actorId === b.id) maxSecondWaitS = Math.max(maxSecondWaitS, entry.waitS);
    for (const car of [a, b]) {
      const command = followPath(car, car.path, car.cursor);
      car.cursor = command.cursor;
      const remaining = (car.goal.x - car.x) * Math.sin(car.heading) +
        (car.goal.z - car.z) * Math.cos(car.heading);
      command.targetSpeed = Math.min(command.targetSpeed,
        Math.sqrt(Math.max(0, remaining - 0.25) * 3.2));
      acceptCar(world, car, command);
      assert.equal(bodyOnRoad(car, world.roads), true);
      if (distance(car, car.goal) <= 0.8 && car.speed <= 0.05 && !completed.has(car.id)) {
        completed.set(car.id, world.tick * STEP);
        assert.ok(Math.abs(angleDelta(car.heading, car === a ? 0 : Math.PI)) < 0.2);
        car.path = [];
      }
    }
    assert.deepEqual(world.actors.map((car) => car.id), ids);
    assert.equal(overlaps(a, b, 0.12), false);
    world.tick++;
  }
  assert.equal(completed.size, 2, JSON.stringify(districtBehaviorDiagnostics(world)));
  assert.ok(Math.abs(arrivals.get(a.id) - arrivals.get(b.id)) <= 1.5);
  assert.ok(maxSecondWaitS > 1 && maxSecondWaitS <= 20, String(maxSecondWaitS));
  assert.ok(Math.max(...completed.values()) <= 45);
  assert.ok(world.districtBehavior.metrics.grants >= 2);
  assert.equal(world.districtBehavior.metrics.peakBlockingCycles, 0);
});

test("a junction waiter leaves the occupied owner's actual turning corridor clear", () => {
  const district = createEgyptDistrict(), world = districtFixture();
  const owner = vehicle("turning-owner", {
    x: 52.5, z: -13, speed: 4.5, maxSpeed: 35 / 3.6,
    goal: { x: 37, z: -1.4, heading: -Math.PI / 2 },
  });
  const waiter = vehicle("opposing-waiter", {
    x: 42.2, z: 1.4, heading: Math.PI / 2, speed: 4.5, maxSpeed: 35 / 3.6,
    goal: { x: 55.5, z: -24, heading: Math.PI },
  });
  Object.assign(world, {
    district, roads: district.roads, drivingRoads: district.drivingRoads,
    statics: district.statics, actors: [owner, waiter], mode: "auto",
  });
  for (const car of world.actors) {
    car.district = {
      caseId: "junction-turn-clearance", profile: "ordinary", headwayS: 1.6,
      loadingUntilTick: null,
    };
    car.path = planDistrictRoute(district, car, car.goal);
    assert.ok(car.path.length > 10);
  }
  const completed = new Set();
  let observedWait = false;
  for (; world.tick < 45 * 60 && completed.size < 2; world.tick++) {
    updateDistrictTraffic(world);
    const hold = world.districtBehavior.holds[waiter.id];
    observedWait ||= hold?.blockedBy === owner.id;
    for (const car of world.actors) {
      const requested = followPath(car, car.path, car.cursor);
      car.cursor = requested.cursor;
      if (distance(car, car.goal) < 10 &&
          Math.abs(angleDelta(car.heading, car.goal.heading)) < 0.35) {
        const remaining = (car.goal.x - car.x) * Math.sin(car.goal.heading) +
          (car.goal.z - car.z) * Math.cos(car.goal.heading);
        requested.targetSpeed = Math.min(requested.targetSpeed,
          Math.sqrt(Math.max(0, remaining - 0.25) * 3.2));
      }
      acceptCar(world, car, requested);
      assert.equal(bodyOnRoad(car, world.roads, 0.12), true);
      if (distance(car, car.goal) <= 0.8 && car.speed <= 0.05 &&
          Math.abs(angleDelta(car.heading, car.goal.heading)) <= 0.2) {
        completed.add(car.id);
        car.path = [];
      }
    }
  }
  assert.equal(observedWait, true, "the opposing car must actually queue for the turning owner");
  assert.equal(completed.size, 2, JSON.stringify({
    actors: world.actors.map(({ id, x, z, heading, speed, reason, blockedBy }) =>
      ({ id, x, z, heading, speed, reason, blockedBy })),
    behavior: districtBehaviorDiagnostics(world),
  }));
  assert.equal(world.districtBehavior.metrics.peakBlockingCycles, 0);
});

test("resource diagnostics detect a genuine stopped blocking cycle, including the player", () => {
  const world = districtFixture();
  const player = vehicle("player", { x: -1.5, z: -5, wait: 6, blockedBy: "other" });
  const other = vehicle("other", { x: 1.5, z: 5, wait: 6, blockedBy: "player" });
  world.player = player; world.actors = [player, other];
  updateDistrictTraffic(world);
  assert.equal(districtBehaviorDiagnostics(world).metrics.blockingCycles, 1);
  other.speed = 1;
  world.tick++;
  updateDistrictTraffic(world);
  const diagnostics = districtBehaviorDiagnostics(world);
  assert.equal(diagnostics.metrics.blockingCycles, 0);
  assert.equal(diagnostics.metrics.peakBlockingCycles, 1);
  diagnostics.events.push({ arbitrary: true });
  assert.notDeepEqual(diagnostics.events, world.districtBehavior.events);
});

test("occupied ownership cannot expire, and an idle outside player cannot hoard it", () => {
  const { world, a, b } = passageFixture();
  a.x = 0; a.z = 0; a.speed = 0;
  b.z = 20.5; b.cursor = 20;
  a.path = []; world.player = a; world.mode = "manual"; world.input.targetSpeed = 0;
  updateDistrictTraffic(world);
  assert.equal(world.districtBehavior.reservations.passage.ownerId, a.id);
  for (let tick = 1; tick <= 36000; tick += 600) {
    world.tick = tick;
    updateDistrictTraffic(world);
    assert.equal(world.districtBehavior.reservations.passage.ownerId, a.id);
    const command = districtTrafficCommand(world, b, { targetSpeed: 4.5, steer: 0 });
    assert.equal(command.blockedBy, a.id);
  }
  const outside = passageFixture();
  outside.world.player = outside.a; outside.world.mode = "manual";
  outside.world.input.targetSpeed = 0; outside.a.path = [];
  updateDistrictTraffic(outside.world);
  assert.equal(outside.world.districtBehavior.reservations.passage.ownerId, outside.b.id);
});

test("manual steering participates through the actual plant corridor, not just a forward ray", () => {
  const world = districtFixture();
  world.roads[0].width = 12;
  const owner = vehicle("occupied-owner", { x: 0, z: 8 });
  const player = vehicle("player", { x: -3, z: 0, speed: 2 });
  world.player = player; world.actors = [player, owner];
  world.mode = "manual"; world.input = { targetSpeed: 3, steer: 0.35 };
  world.district.conflictZones = [{
    id: "turn-entry", kind: "junction", minX: -1, maxX: 1, minZ: 5, maxZ: 10, approachM: 8,
  }];
  const before = { x: player.x, z: player.z, heading: player.heading };
  updateDistrictTraffic(world);
  assert.equal(world.districtBehavior.reservations["turn-entry"].ownerId, owner.id);
  assert.equal(world.districtBehavior.holds[player.id].blockedBy, owner.id);
  assert.ok(world.districtBehavior.approaches[player.id].distanceM < 8);
  assert.deepEqual({ x: player.x, z: player.z, heading: player.heading }, before);
  let observedTurn = false;
  for (let tick = 0; tick < 120; tick++) {
    updateDistrictTraffic(world);
    acceptCar(world, player, world.input);
    observedTurn ||= player.heading > 0.1;
    assert.equal(world.districtBehavior.reservations["turn-entry"].ownerId, owner.id);
    assert.equal(overlaps(player, {
      type: "static", x: 0, z: 7.5, width: 2, length: 5, heading: 0,
    }, 0.12), false);
    world.tick++;
  }
  assert.equal(observedTurn, true);
  assert.ok(player.distance > 0.5);
});

test("a real downstream body prevents a grant and identifies the exit-storage blocker", () => {
  const { world, a } = passageFixture({ opposing: false });
  const stopped = vehicle("blocked-exit", { x: -1.6, z: 22 });
  world.actors.push(stopped);
  updateDistrictTraffic(world);
  assert.equal(world.districtBehavior.reservations.passage, undefined);
  assert.equal(world.districtBehavior.holds[a.id].reason, "district-exit-storage");
  assert.equal(world.districtBehavior.holds[a.id].blockedBy, stopped.id);
});

test("the first eligible ticket can clear an unowned passage without discarding a blocked older ticket", () => {
  const { world, a, b } = passageFixture();
  const blocker = vehicle("blocked-older-exit", { x: -1.6, z: 22 });
  world.actors.push(blocker);
  const ids = world.actors.map((actor) => actor.id);
  updateDistrictTraffic(world);
  assert.equal(world.districtBehavior.reservations.passage?.ownerId, b.id);
  assert.equal(world.districtBehavior.holds[a.id].blockedBy, blocker.id);
  const older = structuredClone(world.districtBehavior.queues.passage.find((entry) => entry.actorId === a.id));
  assert.ok(older.ticket < world.districtBehavior.reservations.passage.ticket);
  world.tick++;
  updateDistrictTraffic(world);
  const retained = world.districtBehavior.queues.passage.find((entry) => entry.actorId === a.id);
  assert.equal(retained.ticket, older.ticket);
  assert.equal(retained.arrivedTick, older.arrivedTick);
  assert.equal(retained.waitS, older.waitS + STEP);
  assert.equal(world.districtBehavior.holds[a.id].blockedBy, b.id);
  assert.equal(world.districtBehavior.reservations.passage.ownerId, b.id);
  assert.deepEqual(world.actors.map((actor) => actor.id), ids);
});

test("a clear exit cannot grant a passage to a follower trapped behind an older approach ticket", () => {
  const district = createEgyptDistrict(), world = districtFixture();
  const front = vehicle("older-front", {
    x: -19.8, z: 1.4, heading: Math.PI / 2, length: 2.9, width: 1.5,
    goal: { x: 35, z: -43.5, heading: -Math.PI / 2 },
  });
  const rear = vehicle("younger-rear", {
    x: -25.2, z: 1.4, heading: Math.PI / 2,
    goal: { x: 35, z: -40.5, heading: Math.PI / 2 },
  });
  const blocker = vehicle("front-exit-body", { x: 0, z: 1.4, heading: Math.PI / 2 });
  Object.assign(world, {
    district, roads: district.roads, drivingRoads: district.drivingRoads,
    statics: district.statics, actors: [front, rear, blocker], mode: "auto",
  });
  for (const car of world.actors) {
    car.district = {
      caseId: "entry-queue", profile: "ordinary", headwayS: 1.6,
      loadingUntilTick: null,
    };
    if (car.goal) {
      car.path = planDistrictRoute(district, car, car.goal);
      assert.ok(car.path.length > 10);
    }
  }
  const poses = world.actors.map(({ x, z, heading }) => ({ x, z, heading }));
  updateDistrictTraffic(world);
  assert.equal(world.districtBehavior.reservations["west-alley-passage"], undefined,
    "a safe downstream exit is useless when its grantee cannot pass the held front car");
  assert.equal(world.districtBehavior.holds[front.id].blockedBy, blocker.id);
  assert.equal(world.districtBehavior.holds[rear.id].blockedBy, front.id);
  assert.equal(world.districtBehavior.holds[rear.id].reason, "district-entry-queue");
  const older = structuredClone(world.districtBehavior.queues["west-alley-passage"]
    .find((entry) => entry.actorId === front.id));
  assert.deepEqual(world.actors.map(({ x, z, heading }) => ({ x, z, heading })), poses);
  let granted = false;
  for (let tick = 0; tick < 240 && !granted; tick++) {
    acceptCar(world, blocker, { targetSpeed: 3, steer: 0, reason: "route" });
    world.tick++;
    updateDistrictTraffic(world);
    granted = world.districtBehavior.reservations["west-alley-passage"]?.ownerId === front.id;
  }
  assert.equal(granted, true, "the older reachable ticket must win once its real exit clears");
  assert.equal(world.districtBehavior.reservations["west-alley-passage"].ticket, older.ticket);
  assert.equal(world.districtBehavior.metrics.peakBlockingCycles, 0);
});

test("warm geometric caches never cache live exit storage or occupied reservations", () => {
  const { world, a } = passageFixture({ opposing: false });
  const blocker = vehicle("moving-exit-body", { x: -1.6, z: 22 });
  world.actors.push(blocker);
  updateDistrictTraffic(world);
  assert.equal(world.districtBehavior.holds[a.id].blockedBy, blocker.id);
  assert.equal(world.districtBehavior.reservations.passage, undefined);
  let granted = false;
  for (let tick = 0; tick < 300 && !granted; tick++) {
    const next = integrateVehicle(blocker, { targetSpeed: 3, steer: 0 }, STEP);
    assert.equal(sweepSafe(blocker, next,
      world.actors.filter((actor) => actor !== blocker), world.roads).safe, true);
    Object.assign(blocker, next);
    world.tick++;
    updateDistrictTraffic(world);
    granted = world.districtBehavior.reservations.passage?.ownerId === a.id;
  }
  assert.equal(granted, true, "accepted downstream motion must release storage on its actual tick");
  assert.equal(world.districtBehavior.metrics.grants, 1);
});

test("loading is caused by accepted trip distance and clear storage, then physically stops and resumes", () => {
  const world = districtFixture(), car = vehicle("loading-car", { x: -1.5, speed: 2 });
  car.district = {
    profile: "ordinary", headwayS: 1.6, nextLoadingDistanceM: 2,
    loadingDurationS: 0.7, loadingUntilTick: null,
  };
  world.actors = [car];
  let stationaryTicks = 0, resumed = false;
  for (let tick = 0; tick < 300; tick++) {
    updateDistrictTraffic(world);
    acceptCar(world, car, { targetSpeed: 3, steer: 0, reason: "route" });
    if (car.reason === "district-loading" && car.speed === 0) stationaryTicks++;
    if (stationaryTicks && car.speed > 1 && car.reason !== "district-loading") resumed = true;
    world.tick++;
  }
  const trigger = world.districtBehavior.events.find((entry) => entry.kind === "loading-hold");
  assert.ok(trigger && trigger.distanceM >= 2);
  assert.equal(trigger.trigger, "actual-trip-distance-and-clear-road");
  assert.ok(stationaryTicks >= 30 && stationaryTicks <= 120);
  assert.equal(resumed, true);
  assert.ok(car.distance > 6);
});

test("a queued case replans from a frozen path without replacing its fixed goal or pose", () => {
  const district = createEgyptDistrict(), world = districtFixture();
  const scene = createDistrictCase(district, "queue-alternate-route", "district-dev-a");
  const car = vehicle("queued-auto", {
    ...scene.playerStart, goal: scene.goal,
    district: { caseId: "queue-alternate-route", allowReroute: true },
  });
  car.path = planDistrictRoute(district, car, car.goal);
  assert.ok(car.path.length > 10);
  for (const point of car.path) Object.freeze(point);
  Object.freeze(car.path);
  const originalPath = car.path, originalGoal = structuredClone(car.goal);
  const originalPose = { x: car.x, z: car.z, heading: car.heading, speed: car.speed };
  const owner = vehicle("service-body", { x: -35.7, z: -40.5, heading: Math.PI / 2 });
  Object.assign(world, {
    tick: 420, district, roads: district.roads, drivingRoads: district.drivingRoads,
    statics: district.statics, player: car, actors: [owner, car], mode: "auto",
    assignTrafficRoute() { throw new Error("A fixed case cannot use ambient random goals"); },
  });
  world.districtBehavior.queues["district-junction-0"] = [{
    actorId: car.id, ticket: 1, arrivedTick: 0, startDistanceM: 0,
  }];
  updateDistrictTraffic(world);
  assert.deepEqual({ x: car.x, z: car.z, heading: car.heading, speed: car.speed }, originalPose);
  assert.deepEqual(car.goal, originalGoal);
  assert.notEqual(car.path, originalPath);
  assert.ok(car.path.length > 10);
  assert.equal(world.districtBehavior.metrics.replans, 1);
  const observation = world.districtBehavior.events.find((entry) =>
    ["traffic-reroute", "traffic-replan"].includes(entry.kind));
  assert.ok(observation && observation.waitS >= 7);
  assert.equal(observation.blockedBy, owner.id);
  assert.equal(typeof observation.routeChanged, "boolean");
});

test("a detour must improve admission rather than retain the same occupied passage dependency", () => {
  const district = createEgyptDistrict(), world = districtFixture();
  const car = vehicle("waiting-auto", {
    x: -25.3262545985654, z: -40.5, heading: Math.PI / 2, goal: district.places[0],
    district: { profile: "ordinary", headwayS: 1.6, allowReroute: true, loadingUntilTick: null },
  });
  const occupied = vehicle("occupied-passage", { x: -12, z: -20 });
  Object.assign(world, {
    tick: 420, district, roads: district.roads, drivingRoads: district.drivingRoads,
    statics: district.statics, player: car, actors: [car, occupied], mode: "auto",
  });
  car.path = planDistrictRoute(district, car, car.goal);
  const original = car.path;
  for (const point of original) Object.freeze(point);
  Object.freeze(original);
  world.districtBehavior.queues["west-alley-passage"] = [{
    actorId: car.id, ticket: 1, arrivedTick: 0, startDistanceM: 0,
  }];
  world.districtBehavior.nextTicket = 2;
  updateDistrictTraffic(world);
  assert.equal(world.districtBehavior.reservations["west-alley-passage"].ownerId, occupied.id);
  assert.equal(car.path, original,
    "removing the alley from route search still crosses the owned mouth and cannot shorten this wait");
  assert.equal(world.districtBehavior.metrics.reroutes, 0);
});

test("a precise arrival does not trade a brief queue for a much longer driving loop", () => {
  const district = createEgyptDistrict(), world = districtFixture();
  const goal = district.places[0];
  const car = vehicle("destination-trip", {
    x: -47.5, z: -10.35, heading: 0, goal, parking: { ...goal },
    district: { profile: "ordinary", headwayS: 1.6, allowReroute: true, loadingUntilTick: null },
  });
  const blockedExit = vehicle("blocked-departure", { x: -32.12, z: 1.4, heading: Math.PI / 2 });
  Object.assign(world, {
    tick: 420, district, roads: district.roads, drivingRoads: district.drivingRoads,
    statics: district.statics, player: car, actors: [car, blockedExit], mode: "auto",
  });
  car.path = planDistrictRoute(district, car, goal);
  const original = car.path;
  world.districtBehavior.queues["district-junction-3"] = [{
    actorId: car.id, ticket: 1, arrivedTick: 0, startDistanceM: 0,
  }];
  updateDistrictTraffic(world);
  assert.equal(car.path === original, true,
    "a clear alternative exit is not progress if its extra driving greatly exceeds the observed delay");
  assert.deepEqual(car.parking, goal);
});

test("circulating traffic avoids a queued passage before committing to its long narrow traversal", () => {
  for (const congested of [false, true]) {
    const district = createEgyptDistrict(), world = districtFixture();
    const goal = { x: 35, z: -40.5, heading: Math.PI / 2 };
    const car = vehicle("approaching-junction", { x: -47.5, z: -10.35, heading: 0, goal });
    const owner = vehicle("occupied-passage", { x: -12, z: -20 });
    const waiting = vehicle("actual-passage-approach", { x: -2, z: -1.4, heading: -Math.PI / 2, goal });
    Object.assign(world, {
      tick: 420, district, roads: district.roads, drivingRoads: district.drivingRoads,
      statics: district.statics, actors: congested ? [car, owner, waiting] : [car, owner], mode: "auto",
    });
    for (const actor of [car, waiting])
      actor.path = planDistrictRoute(district, actor, actor.goal, world.actors);
    const original = car.path, poses = world.actors.map(({ x, z, heading }) => ({ x, z, heading }));
    world.districtBehavior.reservations["west-alley-passage"] = {
      ownerId: owner.id, ticket: 1, sinceTick: 0, entered: true,
      lastProgressTick: 0, lastPose: { x: owner.x, z: owner.z },
    };
    world.districtBehavior.queues["west-alley-passage"] = [];
    world.districtBehavior.nextTicket = 3;
    const alley = district.drivingRoads.find((road) => road.id === "alley-west");
    const traverses = (path) => path.some((point) =>
      Math.abs(point.x - alley.fixed) < 1e-4 &&
      point.z > alley.min + car.length && point.z < alley.max - car.length);
    assert.equal(traverses(original), true);
    updateDistrictTraffic(world);
    assert.equal(car.path === original, !congested);
    assert.equal(traverses(car.path), !congested);
    assert.ok(distance(car.path.at(-1), goal) < 0.01);
    assert.deepEqual(world.actors.map(({ x, z, heading }) => ({ x, z, heading })), poses);
  }
});

test("new NPC trips account for demand at both mouths of the shared passage", () => {
  const district = createEgyptDistrict();
  const car = vehicle("starting-car", { x: -47.5, z: -24, heading: 0 });
  const north = vehicle("crossing-north-mouth", { x: -22, z: 1.4,
    path: [{ x: -22, z: 1.4 }, { x: -12, z: 1.4 }, { x: 0, z: 1.4 }] });
  const south = vehicle("crossing-south-mouth", { x: -25, z: -40.5,
    path: [{ x: -25, z: -40.5 }, { x: -12, z: -40.5 }, { x: 0, z: -40.5 }] });
  const start = district.trafficGoals.findIndex((goal) => goal.id === "entry-local-goal--31--1");
  const original = planDistrictRoute(district, car, district.trafficGoals[start], [car, north, south]);
  assert.ok(original.length > 10);
  assert.deepEqual(planDistrictTrafficTrip({ district, actors: [car, north] }, car, start).at(-1),
    original.at(-1), "One other trip must not displace the seeded choice");
  const actors = [car, north, south];
  const alternative = planDistrictTrafficTrip({ district, actors }, car, start);
  assert.deepEqual(alternative.at(-1), { x: -47.5, z: 19 });
  assert.deepEqual(car.path, [], "Comparing trips must not mutate a vehicle");
  const only = { ...district, trafficGoals: [district.trafficGoals[start]] };
  assert.deepEqual(planDistrictTrafficTrip({ district: only, actors }, car, 0), original,
    "Saturation is an advisory choice, not a way to strand a trip with no alternative");
});

test("safeSpeed keeps the actual upstream Egypt cause unless its own physical cap binds", () => {
  const world = districtFixture();
  const car = vehicle("player", { x: -1.5, speed: 4.5 });
  world.player = car; world.actors = [car]; refresh(world);
  const command = {
    targetSpeed: 1.5, steer: 0, reason: "mapped-blind-corner",
    blockedBy: "literal-map-zone", decelerationMps2: 2,
  };
  assert.deepEqual(safeSpeed(world, car, command), command);
  world.statics.push({
    id: "guard-block", type: "static", x: -1.5, z: 8, heading: 0,
    width: 1.85, length: 4.2,
  });
  refresh(world);
  assert.deepEqual(safeSpeed(world, car, command), command, "a nonbinding geometry cap has no causal ownership");
  world.statics[0].z = 4.5;
  refresh(world);
  const stopped = safeSpeed(world, car, { ...command, targetSpeed: 4.5 });
  assert.ok(stopped.targetSpeed < 4.5);
  assert.equal(stopped.reason, "yielding");
  assert.equal(stopped.blockedBy, "guard-block");
  assert.equal(Object.hasOwn(stopped, "decelerationMps2"), false);
  const next = integrateVehicle(car, stopped, STEP);
  assert.ok(Math.abs(next.speed - (4.5 - 7 * STEP)) < 1e-8);
  world.environment = "city"; world.statics = []; refresh(world);
  assert.equal(safeSpeed(world, car, command).reason, "driving");
});

test("an unavailable zero target brakes softly only while the independent geometry guard is clear", () => {
  const world = districtFixture();
  const car = vehicle("player", { x: -1.5, speed: 4.5 });
  world.player = car; world.actors = [car]; refresh(world);
  const unavailable = {
    targetSpeed: 0, steer: 0, reason: "camera-unavailable", blockedBy: null,
    decelerationMps2: 2,
  };
  const clear = safeSpeed(world, car, unavailable);
  assert.deepEqual(clear, unavailable);
  assert.ok(Math.abs(integrateVehicle(car, clear, STEP).speed - (4.5 - 2 * STEP)) < 1e-8);
  world.statics = [{
    id: "real-stop", type: "static", x: -1.5, z: 5, heading: 0, width: 1.85, length: 4.2,
  }];
  refresh(world);
  const physical = safeSpeed(world, car, unavailable);
  assert.equal(physical.targetSpeed, 0);
  assert.equal(physical.reason, "yielding");
  assert.equal(physical.blockedBy, "real-stop");
  assert.equal(Object.hasOwn(physical, "decelerationMps2"), false);
  assert.ok(Math.abs(integrateVehicle(car, physical, STEP).speed - (4.5 - 7 * STEP)) < 1e-8);
});

function caseProfile() {
  const world = districtFixture(), district = world.district;
  district.showcaseRoutes = [{ id: "camera-run", goal: { x: -1.5, z: 15, heading: 0 } }];
  district.statics = [{
    id: "same-van", type: "static", kind: "parked-vehicle",
    x: 9, z: 0, heading: 0, width: 2.1, length: 4.5,
  }];
  district.caseAnchors = DISTRICT_CASES.filter((item) => item.id !== "ambient").map(({ id }) => ({
    id: `anchor-${id}`, matrixCase: id, routeId: "camera-run", occluderId: "same-van",
    playerStart: { x: -1.5, z: -20, heading: 0 },
    actorStart: { x: -4.2, z: 0, roadId: "local", heading: Math.PI / 2 },
    actorTarget: id === "parallel-away" ? { x: -4.2, z: 12 } : { x: 4.2, z: 2 },
    triggerEgoAlongM: 4, emptyTwin: "same-occluder-empty",
    traffic: ["two-car-narrow-passage", "queue-alternate-route"].includes(id)
      ? [{ id: "opposing-case-car", start: { x: 1.5, z: 25, heading: Math.PI }, goal: { x: 1.5, z: -20, heading: Math.PI } }]
      : [],
  }));
  return district;
}

test("all twelve case families use authored geometry and empty twins keep identical seeded draws", () => {
  const district = caseProfile(), before = structuredClone(district);
  assert.equal(createDistrictCase(district, "ambient", "district-dev-a"), null);
  for (const { id } of DISTRICT_CASES.filter((item) => item.id !== "ambient")) {
    const scene = createDistrictCase(district, id, "district-dev-a");
    assert.equal(scene.phase, "ready");
    assert.equal(scene.traffic.length, ["two-car-narrow-passage", "queue-alternate-route"].includes(id) ? 1 : 0);
    for (const p of scene.people) {
      assert.equal(p.type, "pedestrian");
      assert.ok(Number.isFinite(p.radius) && p.radius >= 0.3);
      assert.ok(p.road && p.target && p.body);
      assert.equal(walkSegmentClear(p, p, p, district.statics, 0.12), true);
    }
  }
  const hidden = createDistrictCase(district, "fully-hidden-emergence", "district-dev-b");
  const empty = createDistrictCase(district, "same-occluder-empty", "district-dev-b");
  assert.equal(hidden.caseRngState, empty.caseRngState);
  assert.equal(hidden.occluderId, empty.occluderId);
  assert.deepEqual(hidden.playerStart, empty.playerStart);
  assert.deepEqual(district, before);
  assert.throws(() => createDistrictCase(district, "unknown", "district-dev-a"), /Unknown district case/);
  const missing = structuredClone(district); missing.caseAnchors = [];
  assert.throws(() => createDistrictCase(missing, "visible-left"), /no anchor/);
});

function runAuthoredPassage(mapEnabled = false) {
  const district = createEgyptDistrict(), world = districtFixture();
  const scene = createDistrictCase(district, "two-car-narrow-passage", "district-dev-a");
  const player = vehicle("player", {
    ...scene.playerStart, goal: scene.goal,
    length: PLAYER_VEHICLE.lengthM, width: PLAYER_VEHICLE.widthM,
    spec: { wheelbase: PLAYER_VEHICLE.wheelbaseM, maxSteer: PLAYER_VEHICLE.maxSteerRad },
    district: { caseId: scene.id, profile: "ordinary", headwayS: 1.6, loadingUntilTick: null },
  });
  Object.assign(world, {
    district, roads: district.roads, drivingRoads: district.drivingRoads,
    statics: district.statics, actors: [player, ...scene.traffic], player, mode: "auto",
  });
  for (const car of world.actors) {
    car.path = planDistrictRoute(district, car, car.goal);
    assert.ok(car.path.length > 10, `${car.id} requires a real dense route`);
  }
  const ids = world.actors.map((car) => car.id), completions = {}, arrivals = {};
  const physicalApproaches = {}, physicalEntries = {};
  const paths = new Map(world.actors.map((car) => [car.id, car.path]));
  const zone = district.conflictZones.find((item) => item.id === scene.waitingZoneId);
  const box = {
    type: "static", x: (zone.minX + zone.maxX) / 2, z: (zone.minZ + zone.maxZ) / 2,
    width: zone.maxX - zone.minX, length: zone.maxZ - zone.minZ, heading: 0,
  };
  let maxNpcQueueWaitS = 0;
  for (; world.tick < 45 * 60 && Object.keys(completions).length < ids.length; world.tick++) {
    for (const car of world.actors) {
      if (geometricPathDistanceToZone(car, paths.get(car.id), zone) <= zone.approachM + 1e-8)
        physicalApproaches[car.id] ??= world.tick * STEP;
      if (overlaps(car, box)) physicalEntries[car.id] ??= world.tick * STEP;
    }
    updateDistrictTraffic(world);
    for (const entry of world.districtBehavior.events)
      if (entry.kind === "resource-arrival" && entry.zoneId === scene.waitingZoneId)
        arrivals[entry.actorId] ??= entry.timeS;
    for (const entry of world.districtBehavior.queues["west-alley-passage"] ?? [])
      if (entry.actorId !== player.id) maxNpcQueueWaitS = Math.max(maxNpcQueueWaitS, entry.waitS);
    for (const car of world.actors) {
      if (completions[car.id] !== undefined) continue;
      const command = followPath(car, car.path, car.cursor);
      car.cursor = command.cursor;
      if (distance(car, car.goal) < 10 && Math.abs(angleDelta(car.heading, car.goal.heading)) < 0.35) {
        const remaining = (car.goal.x - car.x) * Math.sin(car.goal.heading) +
          (car.goal.z - car.z) * Math.cos(car.goal.heading);
        command.targetSpeed = Math.min(command.targetSpeed,
          Math.sqrt(Math.max(0, remaining - 0.25) * 3.2));
      }
      acceptCar(world, car, command, mapEnabled);
      assert.equal(bodyOnRoad(car, world.roads, 0.12), true);
      if (distance(car, car.goal) <= 0.8 && car.speed <= 0.05 &&
          Math.abs(angleDelta(car.heading, car.goal.heading)) <= 0.2) {
        completions[car.id] = world.tick * STEP;
        car.path = [];
      }
    }
    for (const reservation of Object.values(world.districtBehavior.reservations)) {
      const owner = world.actors.find((actor) => actor.id === reservation.ownerId);
      if (reservation.entered && owner.speed > 1)
        assert.ok(world.tick - reservation.lastProgressTick <= 8,
          "sub-8cm accepted steps must still advance actual progress diagnostics");
    }
    assert.deepEqual(world.actors.map((car) => car.id), ids);
  }
  assert.equal(Object.keys(completions).length, ids.length, JSON.stringify(districtBehaviorDiagnostics(world)));
  assert.equal(Object.keys(physicalEntries).length, ids.length);
  const secondId = [...ids].sort((a, b) => physicalEntries[b] - physicalEntries[a])[0];
  const physicalSecondWaitS = physicalEntries[secondId] - physicalApproaches[secondId];
  assert.ok(physicalSecondWaitS <= 20, String(physicalSecondWaitS));
  assert.equal(world.districtBehavior.metrics.peakBlockingCycles, 0);
  const actualArrivals = world.districtBehavior.events.filter((entry) =>
    entry.kind === "resource-arrival" && entry.zoneId === "west-alley-passage");
  assert.equal(actualArrivals.length, 2);
  assert.ok(Math.abs(actualArrivals[0].timeS - actualArrivals[1].timeS) <= 1.5);
  console.info("AUTHORED_DISTRICT_RESOURCE", JSON.stringify({
    mapEnabled, completions, maxNpcQueueWaitS, physicalSecondWaitS, physicalApproaches, physicalEntries,
    arrivals: actualArrivals.map(({ actorId, timeS }) => ({ actorId, timeS })) }));
}

test("authored opposing-case SUV and NPC both complete their actual district routes", () => {
  runAuthoredPassage();
});

test("authored opposing trips retain bounded progress with the actual static-map caps", () => {
  runAuthoredPassage(true);
});

function geometricPathDistanceToZone(car, points, zone) {
  const box = {
    type: "static", x: (zone.minX + zone.maxX) / 2, z: (zone.minZ + zone.maxZ) / 2,
    width: zone.maxX - zone.minX, length: zone.maxZ - zone.minZ, heading: 0,
  };
  if (overlaps(car, box)) return 0;
  const segments = [];
  let arc = 0, nearest = null;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i], size = distance(a, b);
    if (size <= 1e-8) continue;
    const dx = b.x - a.x, dz = b.z - a.z;
    const projection = Math.max(0, Math.min(1,
      ((car.x - a.x) * dx + (car.z - a.z) * dz) / (size * size)));
    const separation = distance(car, { x: a.x + dx * projection, z: a.z + dz * projection });
    if (!nearest || separation < nearest.separation)
      nearest = { separation, arc: arc + size * projection };
    segments.push({ a, size, dx, dz, arc });
    arc += size;
  }
  if (!nearest || nearest.separation > 2) return Infinity;
  for (const segment of segments) {
    if (segment.arc + segment.size < nearest.arc) continue;
    const heading = Math.atan2(segment.dx, segment.dz), c = Math.cos(heading), s = Math.sin(heading);
    let enter = Math.max(0, (nearest.arc - segment.arc) / segment.size), leave = 1;
    for (const [ax, az] of [[1, 0], [0, 1], [c, -s], [s, c]]) {
      const extent = box.width / 2 * Math.abs(ax) + box.length / 2 * Math.abs(az) +
        car.width / 2 * Math.abs(ax * c - az * s) +
        car.length / 2 * Math.abs(ax * s + az * c);
      const start = (segment.a.x - box.x) * ax + (segment.a.z - box.z) * az;
      const delta = segment.dx * ax + segment.dz * az;
      if (Math.abs(delta) <= 1e-8) {
        if (Math.abs(start) > extent) { enter = 2; break; }
      } else {
        const low = (-extent - start) / delta, high = (extent - start) / delta;
        enter = Math.max(enter, Math.min(low, high));
        leave = Math.min(leave, Math.max(low, high));
        if (enter > leave) break;
      }
    }
    if (enter <= leave)
      return Math.max(0, segment.arc + enter * segment.size - nearest.arc);
  }
  return Infinity;
}

function firstPassageGrant({ reverse = false, rename = false, olderLongRoute = false } = {}) {
  const district = createEgyptDistrict(), world = districtFixture();
  const scene = createDistrictCase(district, "two-car-narrow-passage", "district-dev-a");
  const long = vehicle(rename ? "arrival-b" : "arrival-a", {
    ...scene.playerStart, goal: scene.goal,
    spec: { wheelbase: PLAYER_VEHICLE.wheelbaseM, maxSteer: PLAYER_VEHICLE.maxSteerRad },
  });
  const short = vehicle(rename ? "arrival-a" : "arrival-b", {
    ...scene.traffic[0], id: rename ? "arrival-a" : "arrival-b",
  });
  Object.assign(world, {
    district, roads: district.roads, drivingRoads: district.drivingRoads,
    statics: district.statics, actors: reverse ? [short, long] : [long, short],
    player: long, mode: "auto",
  });
  for (const car of world.actors) {
    car.district = {
      caseId: "arrival-order", profile: "ordinary", headwayS: 1.6, loadingUntilTick: null,
    };
    car.path = planDistrictRoute(district, car, car.goal, world.actors);
    assert.ok(car.path.length > 10);
  }
  const zone = district.conflictZones.find((item) => item.id === scene.waitingZoneId);
  for (; world.tick < 240; world.tick++) {
    if (olderLongRoute && [long, short].every((car) =>
      uncachedEntryDistance(car, zone) <= zone.approachM)) {
      world.districtBehavior.queues[zone.id] = [
        { actorId: long.id, ticket: 1, arrivedTick: world.tick - 1, startDistanceM: long.distance },
        { actorId: short.id, ticket: 2, arrivedTick: world.tick, startDistanceM: short.distance },
      ];
      world.districtBehavior.nextTicket = 3;
    }
    updateDistrictTraffic(world);
    const lease = world.districtBehavior.reservations[zone.id];
    if (lease) return { lease, world, long, short };
    for (const car of world.actors) {
      const command = followPath(car, car.path, car.cursor);
      car.cursor = command.cursor;
      command.targetSpeed = Math.min(command.targetSpeed, 4.5);
      acceptCar(world, car, command);
    }
  }
  assert.fail("Both physically approaching cars require a live passage grant");
}

test("simultaneous narrow passage arrivals choose clearance geometry independent of labels and array order", () => {
  for (const reverse of [false, true])
    for (const rename of [false, true]) {
      const { lease, world, short } = firstPassageGrant({ reverse, rename });
      const arrivals = world.districtBehavior.events.filter((entry) =>
        entry.kind === "resource-arrival" && entry.zoneId === "west-alley-passage");
      assert.equal(arrivals.length, 2);
      assert.equal(arrivals[0].tick, arrivals[1].tick, "the counterfactual must really be simultaneous");
      assert.equal(lease.ownerId, short.id,
        "array position and actor labels cannot decide a simultaneous physical clearance tie");
    }
});

test("an earlier narrow arrival is not overtaken by a shorter clearance path", () => {
  const { lease, world, long } = firstPassageGrant({ reverse: true, olderLongRoute: true });
  assert.equal(lease.ownerId, long.id);
  assert.equal(lease.ticket, 1);
  assert.equal(world.districtBehavior.queues["west-alley-passage"][0].ticket, 2);
});

test("the canonical actual World narrow case meets physical approach-to-entry and both-goal bounds", () => {
  const world = new World({ seed: "district-dev-a", districtCase: "two-car-narrow-passage" }, "egypt");
  assert.deepEqual(world.capacity, { traffic: 1, pedestrians: 0 });
  world.command({ type: "visual-mode", mode: "sensors-only" });
  assert.equal(world.command({ type: "district-run" }), true);
  const cars = [...world.actors], zone = world.district.conflictZones
    .find((item) => item.id === world.districtCase.waitingZoneId);
  assert.ok(Math.abs(angleDelta(cars[0].heading, cars[1].heading)) > Math.PI / 2);
  const box = {
    type: "static", x: (zone.minX + zone.maxX) / 2, z: (zone.minZ + zone.maxZ) / 2,
    width: zone.maxX - zone.minX, length: zone.maxZ - zone.minZ, heading: 0,
  };
  const paths = new Map(cars.map((car) => [car.id, car.path]));
  const goals = new Map(cars.map((car) => [car.id, { ...car.parking }]));
  const outcomes = cars.map((car) => ({
    actorId: car.id, approachS: null, entryS: null, exitS: null, goalS: null,
  }));
  const pose = (car) => ({
    id: car.id, type: car.type, x: car.x, z: car.z, heading: car.heading,
    speed: car.speed, length: car.length, width: car.width, maxSpeed: car.maxSpeed,
    distance: car.distance, reason: car.reason, blockedBy: car.blockedBy,
    sources: car.districtSources,
  });
  const report = {
    evidenceClass: "Actual sensors-only World public narrow case; no camera/NN acceptance",
    passed: false, seed: world.config.seed, capacity: world.capacity, outcomes,
    paths: cars.map((car) => ({ actorId: car.id, points: paths.get(car.id) })),
    zone, samples: [],
  };
  const retain = () => {
    const timeS = world.tick * STEP;
    let occupants = 0;
    for (const [index, car] of cars.entries()) {
      const outcome = outcomes[index], goal = goals.get(car.id);
      if (outcome.approachS === null &&
          geometricPathDistanceToZone(car, paths.get(car.id), zone) <= zone.approachM + 1e-8)
        outcome.approachS = timeS;
      if (overlaps(car, box)) {
        occupants++;
        outcome.entryS ??= timeS;
      } else if (outcome.entryS !== null) outcome.exitS ??= timeS;
      if (distance(car, goal) <= 0.8 && Math.abs(angleDelta(car.heading, goal.heading)) <= 0.2 &&
          Math.abs(car.speed) <= 0.05)
        outcome.goalS ??= timeS;
    }
    report.samples.push({
      tick: world.tick, timeS, cars: cars.map(pose),
      resources: structuredClone(world.districtBehavior), audit: world.audit(),
    });
    assert.ok(occupants <= 1, "The actual physical passage must never have conflicting occupants");
  };
  try {
    retain();
    while (world.tick < 45 * 60 && outcomes.some((outcome) => outcome.goalS === null)) {
      const previous = cars.map((car) => ({ ...pose(car) }));
      const tick = world.tick;
      world.step();
      assert.equal(world.tick, tick + 1);
      assert.equal(world.actors.length, cars.length);
      assert.deepEqual(world.audit(), []);
      for (const [index, car] of cars.entries()) {
        assert.equal(world.actors[index], car);
        assert.ok(distance(car, previous[index]) <= Math.max(car.speed, previous[index].speed) * STEP + 1e-8);
        assert.equal(bodyOnRoad(car, world.roads, 0.12), true);
      }
      assert.equal(overlaps(cars[0], cars[1], 0.12), false);
      assert.equal(world.districtBehavior.metrics.blockingCycles, 0);
      assert.equal(world.districtBehavior.metrics.peakBlockingCycles, 0);
      retain();
    }
    assert.ok(outcomes.every((outcome) => outcome.approachS !== null &&
      outcome.entryS !== null && outcome.exitS !== null && outcome.goalS !== null &&
      outcome.goalS <= 45), JSON.stringify(outcomes));
    assert.ok(Math.abs(outcomes[0].approachS - outcomes[1].approachS) <= 1.5);
    const second = [...outcomes].sort((a, b) => b.entryS - a.entryS)[0];
    report.secondPhysicalWaitS = second.entryS - second.approachS;
    assert.ok(report.secondPhysicalWaitS <= 20, JSON.stringify({
      actorId: second.actorId, secondPhysicalWaitS: report.secondPhysicalWaitS, outcomes,
    }));
    report.passed = true;
  } finally {
    report.behaviorMetrics = structuredClone(world.districtBehavior.metrics);
    const output = process.env.PROVE_IT_OUTPUT_DIR;
    if (output) {
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, "canonical-narrow-world.json"), JSON.stringify(report), { flag: "wx" });
    }
    console.info("CANONICAL_NARROW_WORLD", JSON.stringify({
      passed: report.passed, outcomes, secondPhysicalWaitS: report.secondPhysicalWaitS,
      behaviorMetrics: report.behaviorMetrics,
    }));
  }
});

function polylineDistance(point, path) {
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], dx = b.x - a.x, dz = b.z - a.z;
    const t = Math.max(0, Math.min(1,
      ((point.x - a.x) * dx + (point.z - a.z) * dz) / (dx * dx + dz * dz || 1)));
    best = Math.min(best, distance(point, { x: a.x + dx * t, z: a.z + dz * t }));
  }
  return best;
}

test("the actual World queue drives changed geometry after a real hold and reaches its original goals", () => {
  const world = new World({ seed: "district-dev-a", districtCase: "queue-alternate-route" }, "egypt");
  assert.deepEqual(world.capacity, { traffic: 1, pedestrians: 0 });
  world.command({ type: "visual-mode", mode: "sensors-only" });
  assert.equal(world.command({ type: "district-run" }), true);
  const cars = [...world.actors], goals = new Map(cars.map((car) => [car.id, { ...car.parking }]));
  const tracked = new Map(cars.map((car) => [car.id, { path: null, revision: -1 }]));
  const report = {
    evidenceClass: "Actual sensors-only World public queue case; no camera/NN acceptance",
    passed: false, seed: world.config.seed, initialPlayer: {
      x: world.player.x, z: world.player.z, heading: world.player.heading,
    }, goals: Object.fromEntries(goals), paths: [], samples: [],
    longestPlayerHoldS: 0, playerNewOnlyDrivenM: 0, loadingStops: [], goalsAtS: {},
  };
  const retain = () => {
    const snapshots = cars.map((car) => {
      const state = tracked.get(car.id);
      if (state.path !== car.path) {
        state.path = car.path;
        state.revision++;
        report.paths.push({
          actorId: car.id, revision: state.revision, firstTick: world.tick,
          points: car.path.map(({ x, z }) => ({ x, z })),
        });
      }
      const goal = goals.get(car.id);
      if (distance(car, goal) <= 0.8 && Math.abs(angleDelta(car.heading, goal.heading)) <= 0.2 &&
          Math.abs(car.speed) <= 0.05)
        report.goalsAtS[car.id] ??= world.tick * STEP;
      return {
        id: car.id, type: car.type, x: car.x, z: car.z, heading: car.heading,
        speed: car.speed, length: car.length, width: car.width, distance: car.distance,
        reason: car.reason, blockedBy: car.blockedBy, pathRevision: state.revision,
        district: structuredClone(car.district), sources: car.districtSources,
      };
    });
    const sample = {
      tick: world.tick, timeS: world.tick * STEP, cars: snapshots,
      resources: structuredClone(world.districtBehavior),
    };
    const player = snapshots.find((car) => car.id === world.player.id);
    const previous = report.samples.at(-1), priorPlayer = previous?.cars
      .find((car) => car.id === player.id);
    if (player.speed <= 0.05 && cars.some((car) => car.id === player.blockedBy) &&
        distance(player, goals.get(player.id)) > 0.8) {
      const continued = priorPlayer && priorPlayer.blockedBy === player.blockedBy &&
        priorPlayer.speed <= 0.05 && distance(player, priorPlayer) <= 0.001;
      sample.playerHoldTicks = continued ? (previous.playerHoldTicks ?? 0) + 1 : 0;
      sample.playerHoldS = sample.playerHoldTicks * STEP;
      report.longestPlayerHoldS = Math.max(report.longestPlayerHoldS, sample.playerHoldS);
    }
    for (const car of snapshots)
      if (car.id !== player.id && car.reason === "district-loading" && car.speed === 0 &&
          !report.loadingStops.some((stop) => stop.actorId === car.id))
        report.loadingStops.push({
          actorId: car.id, tick: world.tick, acceptedDistanceM: car.distance,
          x: car.x, z: car.z, heading: car.heading,
        });
    report.samples.push(sample);
  };
  try {
    retain();
    while (world.tick < 90 * 60 && Object.keys(report.goalsAtS).length < cars.length) {
      const previous = cars.map((car) => ({ x: car.x, z: car.z, speed: car.speed }));
      const tick = world.tick;
      world.step();
      assert.equal(world.tick, tick + 1);
      assert.equal(world.actors.length, cars.length);
      assert.deepEqual(world.audit(), []);
      for (const [index, car] of cars.entries()) {
        assert.equal(world.actors[index], car);
        assert.deepEqual(car.parking, goals.get(car.id), "A replan cannot replace the original goal");
        assert.ok(distance(car, previous[index]) <= Math.max(car.speed, previous[index].speed) * STEP + 1e-8);
        assert.equal(bodyOnRoad(car, world.roads, 0.12), true);
      }
      assert.equal(overlaps(cars[0], cars[1], 0.12), false);
      assert.equal(world.districtBehavior.metrics.blockingCycles, 0);
      assert.equal(world.districtBehavior.metrics.peakBlockingCycles, 0);
      retain();
    }
    for (const path of report.paths.filter((path) => path.actorId === world.player.id && path.points.length > 1)) {
      const prior = report.paths.filter((candidate) => candidate.actorId === path.actorId &&
        candidate.firstTick < path.firstTick && candidate.points.length > 1).at(-1);
      if (!prior) continue;
      if (!report.samples.some((sample) => sample.tick < path.firstTick && sample.playerHoldS >= 6))
        continue;
      assert.ok(distance(path.points.at(-1), goals.get(path.actorId)) <= 0.8);
      assert.ok(distance(prior.points.at(-1), goals.get(path.actorId)) <= 0.8);
      let previous = null;
      for (const sample of report.samples) {
        const car = sample.cars.find((car) => car.id === path.actorId);
        const onNewOnly = sample.tick >= path.firstTick && car.pathRevision === path.revision &&
          car.speed > 0.05 && polylineDistance(car, path.points) <= 0.5 &&
          polylineDistance(car, prior.points) > 0.5;
        if (onNewOnly && previous && sample.tick === previous.tick + 1)
          report.playerNewOnlyDrivenM += distance(car, previous.car);
        previous = onNewOnly ? { tick: sample.tick, car } : null;
      }
    }
    assert.equal(Object.keys(report.goalsAtS).length, cars.length, JSON.stringify(report.goalsAtS));
    assert.ok(report.playerNewOnlyDrivenM > 0.5, JSON.stringify({
      longestPlayerHoldS: report.longestPlayerHoldS, playerNewOnlyDrivenM: report.playerNewOnlyDrivenM,
      revisions: report.paths.map(({ actorId, revision, firstTick, points }) =>
        ({ actorId, revision, firstTick, points: points.length })),
    }));
    assert.ok(report.longestPlayerHoldS >= 6, "The replan needs a real accepted hold, not an injected counter");
    assert.ok(report.loadingStops.some((stop) => stop.acceptedDistanceM > 1));
    const initialPath = report.paths.find((path) => path.actorId === world.player.id);
    assert.ok(report.loadingStops.some((stop) => polylineDistance(stop, initialPath.points) <= 0.5),
      "The initial route must not already avoid the future service stop");
    assert.equal(world.districtBehavior.events.filter((entry) => entry.kind === "loading-hold").length, 1);
    assert.ok(report.samples.some((sample) => sample.cars.some((car) =>
      report.loadingStops.some((stop) => stop.actorId === car.id && sample.tick > stop.tick) && car.speed > 0.5)));
    report.passed = true;
  } finally {
    report.behaviorMetrics = structuredClone(world.districtBehavior.metrics);
    const output = process.env.PROVE_IT_OUTPUT_DIR;
    if (output) {
      mkdirSync(output, { recursive: true });
      writeFileSync(join(output, "actual-world-queue.json"), JSON.stringify(report), { flag: "wx" });
    }
    console.info("ACTUAL_WORLD_QUEUE", JSON.stringify({
      passed: report.passed, longestPlayerHoldS: report.longestPlayerHoldS,
      playerNewOnlyDrivenM: report.playerNewOnlyDrivenM, goalsAtS: report.goalsAtS,
      loadingStops: report.loadingStops, behaviorMetrics: report.behaviorMetrics,
    }));
  }
});

test("a case cannot move in preview or arm from time alone; actual ego approach arms bounded motion", () => {
  const district = caseProfile(), world = districtFixture();
  world.district = district; world.statics = district.statics;
  const scene = createDistrictCase(district, "visible-left", "district-dev-a");
  world.districtCase = scene;
  const p = scene.people[0], car = vehicle("player", scene.playerStart);
  world.player = car; world.actors = [car, p];
  const before = structuredClone(p);
  world.tick = 10000;
  assert.deepEqual(advanceDistrictCase(world, p), before);
  assert.deepEqual(p, before);
  scene.phase = "running"; scene.startedTick = world.tick;
  for (let tick = 0; tick < 600; tick++) {
    acceptPerson(world, p, advanceDistrictCase);
    world.tick++;
  }
  assert.equal(p.distance, 0);
  assert.equal(scene.triggeredTick, null);
  for (let tick = 0; tick < 240; tick++) {
    acceptCar(world, car, { targetSpeed: tick < 150 ? 3 : 0, steer: 0, reason: "driver" });
    acceptPerson(world, p, advanceDistrictCase);
    world.tick++;
  }
  assert.notEqual(scene.triggeredTick, null);
  assert.ok(scene.triggerObservedAlongM >= scene.triggerEgoAlongM);
  assert.ok(p.distance > 0.2);
  assert.equal(p.district.triggers[0].trigger, "actual-ego-approach-distance");
});

test("diagonal case actually brakes at its intermediate point, holds and resumes without teleporting", () => {
  const district = caseProfile(), world = districtFixture();
  const scene = createDistrictCase(district, "diagonal-hesitant", "district-dev-a");
  world.district = district; world.districtCase = scene; world.statics = district.statics;
  const p = scene.people[0];
  const car = vehicle("player", scene.playerStart);
  world.player = car; world.actors = [car, p];
  scene.phase = "running";
  let heldTicks = 0;
  for (let tick = 0; tick < 1100; tick++) {
    acceptCar(world, car, { targetSpeed: tick < 150 ? 3 : 0, steer: 0, reason: "driver" });
    acceptPerson(world, p, advanceDistrictCase);
    if (p.district.caseStage === "hesitating" && p.speed === 0) heldTicks++;
    world.tick++;
  }
  assert.ok(heldTicks >= 20);
  assert.equal(p.district.caseStage, "complete");
  assert.ok(distance(p, p.district.destination) < 0.3);
  assert.ok(p.distance > 7);
  assert.deepEqual(p.district.triggers.map((entry) => entry.trigger), [
    "actual-ego-approach-distance", "accepted-intermediate-arrival",
    "bounded-hesitation-complete", "accepted-destination-arrival",
  ]);
});

test("authored hidden emergence walks around the actual van rather than through it", () => {
  const district = createEgyptDistrict(), world = districtFixture();
  const scene = createDistrictCase(district, "fully-hidden-emergence", "district-dev-a");
  const p = scene.people[0], car = vehicle("player", {
    ...scene.playerStart,
    length: PLAYER_VEHICLE.lengthM, width: PLAYER_VEHICLE.widthM,
    spec: { wheelbase: PLAYER_VEHICLE.wheelbaseM, maxSteer: PLAYER_VEHICLE.maxSteerRad },
  });
  Object.assign(world, {
    district, districtCase: scene, roads: district.roads, drivingRoads: district.drivingRoads,
    statics: district.statics, player: car, actors: [car, p],
  });
  scene.phase = "running";
  assert.equal(walkSegmentClear(p, p, p.target, district.statics, 0.12), false,
    "the negative control must really have an occluder across the direct walk");
  for (let tick = 0; tick < 1200; tick++) {
    acceptCar(world, car, { targetSpeed: tick < 165 ? 3 : 0, steer: 0, reason: "driver" });
    acceptPerson(world, p, advanceDistrictCase);
    world.tick++;
  }
  assert.equal(p.district.caseStage, "complete");
  assert.ok(distance(p, p.district.destination) < 0.3);
  assert.ok(p.distance > distance(p.district.origin, p.district.destination));
  assert.ok(scene.triggerObservedAlongM >= scene.triggerEgoAlongM);
});

for (const caseId of ["stationary-curb", "parallel-away"])
  test(`authored ${caseId} actually permits the unchanged same-map reactive driver to finish`, () => {
    const district = createEgyptDistrict(), world = districtFixture();
    const scene = createDistrictCase(district, caseId, "district-dev-a");
    const person = scene.people[0], car = vehicle("player", {
      ...scene.playerStart, goal: scene.goal,
      length: PLAYER_VEHICLE.lengthM, width: PLAYER_VEHICLE.widthM,
      spec: { wheelbase: PLAYER_VEHICLE.wheelbaseM, maxSteer: PLAYER_VEHICLE.maxSteerRad },
    });
    Object.assign(world, {
      district, districtCase: scene, roads: district.roads, drivingRoads: district.drivingRoads,
      statics: district.statics, player: car, actors: [car, person], mode: "auto",
    });
    car.path = planDistrictRoute(district, car, car.goal);
    scene.phase = "running";
    let completed = false;
    for (; world.tick < 30 * 60 && !completed; world.tick++) {
      updateDistrictTraffic(world);
      const command = followPath(car, car.path, car.cursor);
      car.cursor = command.cursor;
      const remaining = car.goal.z - car.z;
      command.targetSpeed = Math.min(command.targetSpeed,
        Math.sqrt(Math.max(0, remaining - 0.25) * 3.2));
      acceptCar(world, car, command, true);
      acceptPerson(world, person, advanceDistrictCase);
      completed = distance(car, car.goal) <= 0.8 && car.speed <= 0.05 &&
        Math.abs(angleDelta(car.heading, car.goal.heading)) <= 0.2;
    }
    assert.equal(completed, true, JSON.stringify({
      caseId, car: { x: car.x, z: car.z, speed: car.speed, reason: car.reason, blockedBy: car.blockedBy },
      person: { x: person.x, z: person.z, speed: person.speed, reason: person.reason },
    }));
  });

test("the default public cairo-42 first goal progresses after the integrated control prefix", () => {
  const world = new World({ seed: "cairo-42" }, "egypt");
  assert.deepEqual(world.capacity, { traffic: 28, pedestrians: 32 });
  const actors = [...world.actors];
  world.command({ type: "visual-mode", mode: "sensors-only" });
  world.command({ type: "drive", targetSpeed: 0, steer: 0 });
  for (; world.tick < 332; world.step()) {
    if (world.tick === 241)
      world.command({ type: "drive", targetSpeed: world.player.maxSpeed, steer: 0 });
    if (world.tick === 272)
      world.command({ type: "drive", targetSpeed: 0, steer: 0 });
  }
  const goal = world.district.places[0];
  assert.equal(world.command({ type: "destination", place: goal }), true);
  const originalGoal = { ...world.player.parking }, completed = world.metrics.completedTrips;
  let observedRealQueue = false;
  for (const end = world.tick + 180 * 60;
    world.tick < end && world.metrics.completedTrips === completed;) {
    const before = actors.map((actor) => ({ x: actor.x, z: actor.z, speed: actor.speed }));
    world.step();
    assert.equal(world.actors.length, actors.length);
    for (const [index, actor] of actors.entries()) {
      assert.equal(world.actors[index], actor);
      assert.ok(distance(actor, before[index]) <= Math.max(actor.speed, before[index].speed) * STEP + 1e-8);
      if (actor.type === "vehicle") assert.equal(bodyOnRoad(actor, world.roads, 0.12), true);
    }
    assert.deepEqual(world.audit(), []);
    assert.deepEqual(world.player.parking, originalGoal);
    assert.equal(world.districtBehavior.metrics.blockingCycles, 0);
    assert.equal(world.districtBehavior.metrics.peakBlockingCycles, 0);
    const hold = world.districtBehavior.holds[world.player.id];
    observedRealQueue ||= Boolean(hold && world.player.speed <= 0.05 &&
      world.actors.some((actor) => actor.id === hold.blockedBy && actor.type === "vehicle"));
  }
  assert.equal(observedRealQueue, true, "The fixture must exercise the actual saturated first-fork queue");
  assert.equal(world.metrics.completedTrips, completed + 1, JSON.stringify({
    tick: world.tick, player: { x: world.player.x, z: world.player.z, wait: world.player.wait,
      reason: world.player.reason, blockedBy: world.player.blockedBy, district: world.player.district },
    hold: world.districtBehavior.holds[world.player.id],
  }));
  assert.ok(distance(world.player, goal) <= 0.8 && world.player.speed <= 0.05);
  assert.ok(Math.abs(angleDelta(world.player.heading, goal.heading)) <= 0.2);
});

test("actual moving 28/32 development World clears its blocker chain and completes three chained public trips", () => {
  const world = new World({ seed: "district-dev-a" }, "egypt");
  assert.deepEqual(world.capacity, { traffic: 28, pedestrians: 32 });
  const actors = [...world.actors];
  world.command({ type: "visual-mode", mode: "sensors-only" });
  const trips = [];
  for (const place of world.district.places) {
    const completedBefore = world.metrics.completedTrips, startTick = world.tick;
    assert.equal(world.command({ type: "destination", place }), true);
    while (world.tick - startTick < 180 * 60 &&
        world.metrics.completedTrips === completedBefore) {
      const previous = actors.map((actor) => ({
        x: actor.x, z: actor.z, speed: actor.speed, heading: actor.heading,
      }));
      world.step();
      assert.equal(world.actors.length, actors.length, "Population cannot change for progress");
      for (let i = 0; i < actors.length; i++) {
        const actor = actors[i], before = previous[i];
        assert.equal(world.actors[i], actor, "Actor identities cannot change for progress");
        assert.ok(distance(before, actor) <= Math.max(before.speed, actor.speed) * STEP + 1e-8,
          `${actor.id} cannot teleport around the queue`);
        if (actor.type === "pedestrian")
          assert.ok(Math.abs(angleDelta(actor.heading, before.heading)) <= 3 * STEP + 1e-8);
      }
      if (world.tick % 60 === 0) {
        assert.deepEqual(world.audit(), []);
        for (const actor of actors)
          for (const other of actors)
            if (other !== actor)
              assert.equal(overlaps(actor, other, 0.12), false,
                `${actor.id}/${other.id}: live body clearance`);
      }
    }
    if (world.metrics.completedTrips === completedBefore) {
      const failure = {
        destination: place.id, trips, world: world.snapshot(),
        actors: actors.map((actor) => ({
          id: actor.id, x: actor.x, z: actor.z, heading: actor.heading,
          speed: actor.speed, steer: actor.steer, wait: actor.wait,
          length: actor.length, width: actor.width, radius: actor.radius,
          reason: actor.reason, blockedBy: actor.blockedBy,
          district: actor.district, parking: actor.parking, target: actor.target,
          path: actor.path, cursor: actor.cursor, walkRoute: actor.walkRoute,
          requested: actor.type === "vehicle"
            ? followPath(actor, actor.path, actor.cursor) : null,
        })),
      };
      const output = process.env.PROVE_IT_OUTPUT_DIR;
      if (output) {
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, "moving-district-failure.json"),
          JSON.stringify(failure), { flag: "wx" });
      }
      console.info("MOVING_DISTRICT_FAILURE", JSON.stringify({
        destination: place.id, tick: world.tick, trips,
        actorEvidence: output ? join(output, "moving-district-failure.json") : null,
        metrics: world.districtBehavior.metrics,
      }));
    }
    assert.equal(world.metrics.completedTrips, completedBefore + 1, JSON.stringify({
      destination: place.id, tick: world.tick,
      player: { x: world.player.x, z: world.player.z, speed: world.player.speed,
        reason: world.player.reason, blockedBy: world.player.blockedBy },
      holds: world.districtBehavior.holds, reservations: world.districtBehavior.reservations,
    }));
    assert.ok(distance(world.player, place) <= 0.8);
    assert.ok(Math.abs(world.player.speed) <= 0.05);
    assert.ok(Math.abs(angleDelta(world.player.heading, place.heading)) <= 0.2);
    assert.equal(bodyOnRoad(world.player, world.roads, 0.12), true);
    trips.push({ destination: place.id, ticks: world.tick - startTick });
  }
  assert.ok(world.metrics.trafficTrips > 0);
  assert.equal(world.districtBehavior.metrics.blockingCycles, 0);
  console.log("MOVING_DISTRICT_PUBLIC_TRIPS", JSON.stringify({
    seed: world.config.seed, capacity: world.capacity, trips,
    completedTrips: world.metrics.completedTrips, trafficTrips: world.metrics.trafficTrips,
  }));
});
