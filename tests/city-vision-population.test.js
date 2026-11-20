import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { STEP, VEHICLE } from "../src/core/config.js";
import { planDistrictTrafficTrip } from "../src/core/district-behavior.js";
import { districtRoadPose } from "../src/core/egypt-district.js";
import { angleDelta, bodyOnRoad, distance, overlaps } from "../src/core/geometry.js";
import { createPedestrianBody } from "../src/core/pedestrian-body.js";
import { createUnifiedCity, METRO_POPULATION_LIMITS } from "../src/core/unified-city.js";
import { PLAYER_VEHICLE } from "../src/core/vehicle-spec.js";
import { World } from "../src/core/world.js";

const LEGACY_TRAFFIC = 72, LEGACY_PEDESTRIANS = 96;
const FULL_CAR = { type: "vehicle", length: VEHICLE.length, width: VEHICLE.width };
const MAX_WALKER_RADIUS = createPedestrianBody({ kind: "man-jacket", phase: 1 }).radiusM;

test("dense City appends spawns without changing the serialized legacy City", () => {
  const legacy = createUnifiedCity();
  // Captured from the pre-change entrypoint, including key order and both spawn tables.
  const digest = createHash("sha256").update(JSON.stringify(legacy)).digest("hex");
  assert.equal(digest, "65020bdf93845a89bffee775951f378ca60d6ecbe5f86b80e543ab951134183d");
  assert.deepEqual(createUnifiedCity({ dense: false }), legacy);

  const { trafficSpawns, pedestrianSpawns, ...layout } = createUnifiedCity({ dense: true });
  const { trafficSpawns: oldCars, pedestrianSpawns: oldWalkers, ...oldLayout } = legacy;
  assert.deepEqual(layout, oldLayout);
  assert.deepEqual(trafficSpawns.slice(0, LEGACY_TRAFFIC), oldCars);
  assert.deepEqual(pedestrianSpawns.slice(0, LEGACY_PEDESTRIANS), oldWalkers);
  assert.deepEqual({ traffic: trafficSpawns.length, pedestrians: pedestrianSpawns.length },
    { traffic: 96, pedestrians: 120 });
  assert.deepEqual(METRO_POPULATION_LIMITS,
    { traffic: trafficSpawns.length, pedestrians: pedestrianSpawns.length });
});

test("every dense spawn has full-size clearance, its own lane or walkline, and a legal continuation", () => {
  const city = createUnifiedCity({ dense: true });
  const cars = city.trafficSpawns.map((spawn, i) => ({ ...FULL_CAR, ...spawn, id: `traffic-${i}` }));
  const people = city.pedestrianSpawns.map((spawn, i) =>
    ({ type: "pedestrian", radius: MAX_WALKER_RADIUS, ...spawn, id: `person-${i}` }));
  const player = { ...FULL_CAR, ...city.playerStart, id: "player",
    length: PLAYER_VEHICLE.lengthM, width: PLAYER_VEHICLE.widthM };
  const bodies = [player, ...cars, ...people];
  const roads = new Map(city.drivingRoads.map((road) => [road.id, road]));
  const walks = new Map(city.walkways.map((line) => [line.id, line]));
  const conflicts = city.conflictZones.map(({ id, minX, maxX, minZ, maxZ }) => ({
    id, x: (minX + maxX) / 2, z: (minZ + maxZ) / 2,
    width: maxX - minX, length: maxZ - minZ, heading: 0,
  }));
  for (const [i, body] of bodies.entries()) {
    for (const other of [...city.statics, ...bodies.slice(i + 1)])
      assert.ok(!overlaps(body, other, 0.12), `${body.id} overlaps ${other.id}`);
  }
  for (const [i, car] of cars.entries()) {
    const road = roads.get(car.roadId);
    assert.ok(road && !road.supportApron && !road.parkingBay, car.id);
    assert.ok((road.flow ? [road.flow] : [-1, 1]).some((direction) => {
      const lane = districtRoadPose(road, car[road.axis], direction);
      return distance(lane, car) < 1e-8 && Math.abs(angleDelta(lane.heading, car.heading)) < 1e-8;
    }), `${car.id} is off the lane or facing the wrong way`);
    assert.ok(bodyOnRoad(car, [road], 0.12), `${car.id} needs full-size support on ${road.id}`);
    assert.ok(distance(car, player) >= 14, `${car.id} crowds the start`);
    assert.ok(!conflicts.some((conflict) => overlaps(car, conflict, 0.45)), `${car.id} occupies a junction`);
    for (const other of cars.slice(i + 1)) {
      assert.ok(!overlaps(car, other, 0.8), `${car.id} crowds ${other.id}`);
      if (car.roadId === other.roadId && car.heading === other.heading)
        assert.ok(distance(car, other) >= 12, `${car.id} has insufficient headway to ${other.id}`);
    }

    // Test the standard car even on spots World happens to fill with a smaller tuktuk.
    const path = planDistrictTrafficTrip({ district: city, actors: bodies }, car, i);
    assert.ok(path.length > 10 && distance(car, path.at(-1)) >= 12 && city.trafficGoals.some((goal) =>
      distance(goal, path.at(-1)) < 1e-7), `${car.id} has no full-size trip to a registered traffic goal`);
  }
  for (const [i, person] of people.entries()) {
    const line = walks.get(person.walkwayId);
    assert.ok(line && line.roadId === person.roadId && line.side === person.side, person.id);
    assert.equal(person[line.axis], person.along, person.id);
    assert.equal(person[line.axis === "x" ? "z" : "x"], line.fixed, person.id);
    const inset = person.radius + 0.12;
    assert.ok(person.along >= line.min + inset && person.along <= line.max - inset, person.id);
    assert.ok(people.slice(i + 1).every((other) => distance(person, other) >= 1.4), person.id);
  }
});

test("maximum metro v3 population moves near the actual downtown route and the trip parks", () => {
  const world = new World({ seed: "cairo-42", cityVersion: 3, traffic: 200, pedestrians: 200 }, "metro");
  const cars = world.actors.filter((actor) => actor.type === "vehicle" && actor !== world.player);
  const people = world.actors.filter((actor) => actor.type === "pedestrian");
  assert.deepEqual([cars.length, people.length], [96, 120]);
  assert.ok(cars.every((car) => car.path.length > 10 && bodyOnRoad(car, world.roads, 0.12)));
  assert.ok(people.every((person) => person.body?.radiusM === person.radius &&
    Number.isFinite(person.target?.x) && Number.isFinite(person.target?.z)));
  assert.deepEqual(world.audit(), []);

  const downtown = world.district.places.find((place) => place.id === "downtown");
  assert.equal(world.command({ type: "destination", place: downtown }), true);
  const route = world.player.path;
  const extraCars = cars.slice(LEGACY_TRAFFIC), extraPeople = people.slice(LEGACY_PEDESTRIANS);
  const alongRoute = (actor, radius) => route.some((point) => distance(actor, point) < radius);
  const approachCars = extraCars.filter((car) => distance(car, world.player) < 50 && alongRoute(car, 8));
  const arrivalWalkers = extraPeople.filter((person) => distance(person, downtown) < 24 && alongRoute(person, 14));
  assert.ok(approachCars.length > 0, "added traffic serves the first approach");
  assert.ok(arrivalWalkers.length > 0, "added walkers serve the destination approach");

  const travel = new Map(world.actors.map((actor) => [actor, 0]));
  let closestMovingTrafficM = Infinity;
  for (let i = 0; i < 35 / STEP && world.metrics.completedTrips === 0; i++) {
    const previous = world.actors.map(({ x, z, speed }) => ({ x, z, speed }));
    world.step();
    assert.equal(world.actors.length, travel.size, "the dense population remains registered");
    for (const [index, actor] of world.actors.entries()) {
      const from = previous[index];
      const maxStep = Math.max(Math.abs(from.speed), Math.abs(actor.speed)) * STEP;
      const travelled = distance(from, actor);
      if (!(travelled <= maxStep + 1e-7))
        assert.fail(`${actor.id} teleported at tick ${world.tick}`);
      travel.set(actor, travel.get(actor) + travelled);
    }
    if (world.player.speed > 1)
      for (const car of approachCars)
        if (car.speed > 1) closestMovingTrafficM = Math.min(closestMovingTrafficM, distance(car, world.player));
    if (world.tick % 60 === 0) assert.deepEqual(world.audit(), [], `tick ${world.tick}`);
  }
  const moving = (actors) => actors.filter((actor) => travel.get(actor) > 1).length;
  const [movedCars, movedWalkers] = [moving(extraCars), moving(extraPeople)];
  console.log("METRO_DENSE_TRIP", JSON.stringify({
    traffic: cars.length, pedestrians: people.length, movedCars, movedWalkers,
    closestMovingTrafficM, ticks: world.tick, remainingM: distance(world.player, downtown),
  }));
  assert.ok(closestMovingTrafficM < 20, "real added traffic moved within 20 m en route");
  assert.ok(moving(arrivalWalkers) > 0, "a walker from the destination approach actually moved");
  assert.ok(movedCars >= 18 && movedWalkers >= 18, "most added bodies actually moved");
  assert.equal(world.metrics.completedTrips, 1);
  assert.ok(world.metrics.distance > 100 && Math.abs(world.player.speed) <= 0.05);
  assert.ok(distance(world.player, downtown) <= 0.8 &&
    Math.abs(angleDelta(world.player.heading, downtown.heading)) <= 0.2);
  assert.deepEqual(world.audit(), []);
});
