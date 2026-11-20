import { createHash } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS, settings, STEP, VEHICLE } from "../src/core/config.js";
import { districtTurnPaths, planDistrictRoute } from "../src/core/district-navigation.js";
import { createEgyptDistrict, districtRoadPose } from "../src/core/egypt-district.js";
import {
  angleDelta, bodyOnRoad, corners, distance, overlaps, pointOnRoad, roadRect, sweepSafe,
} from "../src/core/geometry.js";
import { createPedestrianBody } from "../src/core/pedestrian-body.js";
import { PLACES } from "../src/core/places.js";
import { createUnifiedCity } from "../src/core/unified-city.js";
import { followPath, integrateVehicle } from "../src/core/vehicle.js";
import { PLAYER_VEHICLE } from "../src/core/vehicle-spec.js";
import { walkSegmentClear } from "../src/core/walk-route.js";
import { World } from "../src/core/world.js";

const SUV = {
  id: "player", type: "vehicle", length: PLAYER_VEHICLE.lengthM, width: PLAYER_VEHICLE.widthM,
  spec: { wheelbase: PLAYER_VEHICLE.wheelbaseM, maxSteer: PLAYER_VEHICLE.maxSteerRad },
  speed: 0, steer: 0, maxSpeed: DEFAULTS.speedLimit / 3.6,
};
const axisAt = (road, pose) => pose[road.axis];
const roadBy = (city, id) => city.drivingRoads.find((road) => road.id === id);
const buffer = 0.12;

test("the larger map keeps the original narrow geometry and both sets of public destinations", () => {
  const city = createUnifiedCity(), district = createEgyptDistrict();
  const bounds = city.drivingRoads.map((road) => roadRect(road));
  assert.ok(Math.max(...bounds.map((b) => b.maxX)) - Math.min(...bounds.map((b) => b.minX)) >= 320);
  assert.ok(Math.max(...bounds.map((b) => b.maxZ)) - Math.min(...bounds.map((b) => b.minZ)) >= 150);
  assert.equal(new Set(city.roads.map((road) => road.id)).size, city.roads.length);
  for (const road of city.roads) {
    assert.ok(Number.isFinite(road.laneOffsetM) && Number.isFinite(road.speedLimitMps));
    assert.ok([-1, 0, 1].includes(road.flow) && ["none", "center"].includes(road.marking));
    assert.ok(["avenue", "neighborhood"].includes(road.zone));
  }
  for (const id of ["alley-west", "alley-east"]) {
    const { zone, ...alley } = roadBy(city, id);
    assert.equal(zone, "neighborhood");
    assert.deepEqual(alley, roadBy(district, id));
    const wider = city.roads.filter((road) => road.id !== id);
    for (const t of [0.35, 0.5, 0.65]) {
      const pose = districtRoadPose(alley, alley.min + (alley.max - alley.min) * t);
      assert.ok(bodyOnRoad({ ...SUV, ...pose }, [alley], buffer));
      for (const sign of [-1, 1]) {
        const beyondCurb = { x: pose.x + sign * (alley.width / 2 + 0.03), z: pose.z };
        assert.ok(!pointOnRoad(beyondCurb, wider), `${id} must not have wider phantom support`);
      }
    }
  }
  assert.deepEqual(city.places.filter((place) => place.id.startsWith("district-")), district.places);
  assert.deepEqual(city.showcaseRoutes.slice(1), district.showcaseRoutes);
  assert.deepEqual(city.caseAnchors, district.caseAnchors);
  assert.deepEqual(city.places.filter((place) => !place.id.startsWith("district-"))
    .map(({ id, name }) => ({ id, name })), PLACES.map(({ id, name }) => ({ id, name })));
  const start = { ...SUV, ...city.playerStart };
  for (const goal of [...city.places, ...city.pursuitExits]) {
    const street = roadBy(city, goal.roadId);
    assert.ok([1, -1].some((sign) => (!street.flow || sign === street.flow) &&
      distance(goal, districtRoadPose(street, axisAt(street, goal), sign)) < 1e-8 &&
      Math.abs(angleDelta(goal.heading, districtRoadPose(street, axisAt(street, goal), sign).heading)) < 1e-8),
    `${goal.id}: unambiguous registered lane/heading`);
    assert.ok(planDistrictRoute(city, start, goal).length > 10, `${goal.id}: from City start`);
  }
  assert.ok(city.pursuitExits.length >= 4);
});

test("the gateway's directed turns have whole-body clearance and physically severing both joins breaks routing", () => {
  const city = createUnifiedCity(), district = createEgyptDistrict();
  const joins = [["bab-el-louk-link", "entry-local"], ["gateway-avenue", "school-local"]];
  const turns = districtTurnPaths(city, SUV);
  for (const [connector, local] of joins) {
    const movements = (incoming, outgoing) => turns.filter((turn) =>
      turn.incomingRoadId === incoming && turn.outgoingRoadId === outgoing);
    const entering = movements(connector, local), leaving = movements(local, connector);
    assert.equal(entering.length, 2, `${connector}: both legal entries into the neighborhood`);
    assert.equal(leaving.length, 2, `${connector}: both legal departures from the neighborhood`);
    assert.equal(new Set([...entering, ...leaving].map((turn) =>
      `${turn.incomingRoadId}:${turn.incomingSign}>${turn.outgoingRoadId}:${turn.outgoingSign}`)).size, 4);
    for (const turn of [...entering, ...leaving])
      for (const speed of [0, roadBy(city, turn.incomingRoadId).speedLimitMps]) {
        let body = { ...SUV, ...turn.start, speed }, cursor = 0;
        const path = Object.freeze(turn.path.map(Object.freeze));
        for (let tick = 0; tick < 25 / STEP && distance(body, turn.goal) > 0.8; tick++) {
          const command = followPath(body, path, cursor);
          cursor = command.cursor;
          command.targetSpeed = Math.min(command.targetSpeed, roadBy(city, turn.outgoingRoadId).speedLimitMps);
          const next = integrateVehicle(body, command, STEP);
          assert.ok(sweepSafe(body, next, city.statics, city.roads).safe, `${turn.id} @ ${speed}: sweep`);
          assert.ok(bodyOnRoad(next, city.roads, buffer), `${turn.id} @ ${speed}: curb clearance`);
          body = next;
        }
        assert.ok(distance(body, turn.goal) <= 0.8 && Math.abs(angleDelta(body.heading, turn.goal.heading)) < 0.2,
          `${turn.id} @ ${speed}: physical arrival`);
      }
  }

  const sever = (road) => road.id === "school-local" ? roadBy(district, road.id) : road;
  const southern = roadBy(city, joins[0][0]);
  const detached = {
    ...city, drivingRoads: city.drivingRoads.filter((road) => road !== southern).map(sever),
    roads: city.roads.filter((road) => road !== southern &&
      !(road.supportApron && joins.some(([vertical, horizontal]) =>
        road.junctionX === roadBy(city, vertical).fixed && road.junctionZ === roadBy(city, horizontal).fixed))).map(sever),
  };
  const trip = city.showcaseRoutes[0];
  assert.ok(pointOnRoad({ x: southern.fixed, z: -75 }, city.roads));
  assert.ok(!pointOnRoad({ x: southern.fixed, z: -75 }, detached.roads));
  assert.deepEqual(planDistrictRoute(detached, { ...SUV, ...trip.start }, trip.goal), []);
  assert.deepEqual(planDistrictRoute(city, { ...SUV, x: 20, z: 18, heading: Math.PI }, trip.goal), [],
    "Wrong-way attachment in the original one-way alley is illegal");
});

test("building hulls respect registered pavement and avenues and market walks support the shared profile seeds", () => {
  const city = createUnifiedCity(), statics = city.statics.filter((site) => site.kind === "building");
  const hulls = city.roads.map((road) => {
    const { minX, maxX, minZ, maxZ } = roadRect(road);
    return { x: (minX + maxX) / 2, z: (minZ + maxZ) / 2, width: maxX - minX,
      length: maxZ - minZ, heading: 0, id: road.id };
  });
  const nearStart = statics.filter((site) => distance(site, city.playerStart) <= 45);
  assert.ok(nearStart.some((site) => site.architecture === "boulevard" && site.height >= 20));
  assert.ok(statics.some((site) => site.architecture === "neighborhood" && site.height < 20));
  for (const [i, site] of statics.entries()) {
    assert.ok(["neighborhood", "boulevard"].includes(site.architecture), site.id);
    assert.ok(!hulls.some((hull) => overlaps(site, hull, buffer)), site.id);
    assert.ok(!statics.slice(i + 1).some((other) => overlaps(site, other, buffer)), site.id);
  }
  for (const line of city.walkways) {
    const point = (along) => line.axis === "z" ? { x: line.fixed, z: along } : { x: along, z: line.fixed };
    assert.ok(walkSegmentClear({ type: "pedestrian", radius: 0.38 },
      point(line.min), point(line.max), city.statics, buffer), line.id);
  }

  const profile = settings({ traffic: 200, pedestrians: 200 });
  for (const seed of [DEFAULTS.seed, "district-dev-a", "district-dev-b"]) {
    const world = new World({ seed, traffic: profile.traffic, pedestrians: profile.pedestrians }, "metro");
    assert.deepEqual(world.capacity, { traffic: 72, pedestrians: 96 }, seed);
    const traffic = world.actors.filter((actor) => actor.type === "vehicle" && actor !== world.player);
    const walkers = world.actors.filter((actor) => actor.type === "pedestrian");
    assert.equal(traffic.length, profile.traffic);
    assert.equal(walkers.length, profile.pedestrians);
    assert.ok(traffic.every((car) => car.path.length > 10 && bodyOnRoad(car, world.roads, buffer)), seed);
    const first = walkers.slice(0, DEFAULTS.pedestrians);
    assert.deepEqual(new Set(first.map((walker) => walker.roadPreference)), new Set(["avenue", "market"]));
    for (const walker of walkers) {
      const line = world.district.walkways.find(({ id }) => id === walker.walkwayId);
      assert.equal(walker.roadPreference, line.roadPreference, walker.id);
      assert.ok(walker.target && Number.isFinite(walker.target.x) && Number.isFinite(walker.target.z),
        `${seed}: ${walker.id} initialized a walk`);
    }
    assert.deepEqual(world.audit(), [], seed);
  }
});

test("rush City adds 24 spawns without changing any v3 spawn or the authored map", () => {
  const dense = createUnifiedCity({ dense: true });
  // Pre-rush v3 registry, including all 96 car and 120 pedestrian poses in order.
  assert.equal(createHash("sha256").update(JSON.stringify(dense)).digest("hex"),
    "a70fdb1e8a38a1ef6044406ce23cce2675da1cb139b4928560aaef0f82209afd");
  const city = createUnifiedCity({ rush: true });
  const { rush, trafficSpawns, pedestrianSpawns, ...map } = city;
  const { trafficSpawns: oldCars, pedestrianSpawns: oldPeople, ...oldMap } = dense;
  assert.deepEqual([trafficSpawns.length, pedestrianSpawns.length], [96, 144]);
  assert.deepEqual(trafficSpawns, oldCars);
  assert.deepEqual(pedestrianSpawns.slice(0, 120), oldPeople);
  assert.deepEqual(map, oldMap);
  assert.equal(rush, true);
  assert.deepEqual(createUnifiedCity({ dense: true, rush: true }), city);
});

test("extra rush walkers occupy clear walklines across the avenues and original neighborhood", () => {
  const city = createUnifiedCity({ rush: true });
  const legacyWalks = new Set(createEgyptDistrict().walkways.map(({ id }) => id));
  const newPeople = city.pedestrianSpawns.slice(120);
  const lines = new Map(city.walkways.map((line) => [line.id, line]));
  const radius = createPedestrianBody({ kind: "man-jacket", phase: 1 }).radiusM;
  const occupied = [...city.statics, { ...SUV, ...city.playerStart },
    ...city.trafficSpawns.map((pose) => ({ type: "vehicle", ...VEHICLE, ...pose }))];
  const pavement = city.roads.map((road) => {
    const { minX, maxX, minZ, maxZ } = roadRect(road);
    return { id: road.id, x: (minX + maxX) / 2, z: (minZ + maxZ) / 2,
      width: maxX - minX, length: maxZ - minZ, heading: 0 };
  });
  const avenues = [], neighborhood = [];
  for (const [index, pose] of newPeople.entries()) {
    const line = lines.get(pose.walkwayId);
    assert.ok(line && line.roadId === pose.roadId && line.side === pose.side, pose.walkwayId);
    assert.equal(pose.roadPreference, line.roadPreference, line.id);
    assert.equal(pose[line.axis], pose.along, line.id);
    assert.equal(pose[line.axis === "x" ? "z" : "x"], line.fixed, line.id);
    const min = line.min + radius + buffer, max = line.max - radius - buffer;
    assert.ok(pose.along >= min && pose.along <= max, line.id);
    const body = { ...pose, id: `person-${120 + index}`, type: "pedestrian", radius };
    assert.ok([-3, 3].some((offset) => {
      const along = pose.along + offset;
      return along >= min && along <= max &&
        walkSegmentClear(body, body, { ...body, [line.axis]: along }, occupied, buffer);
    }), `${line.id}: a clear initial walking leg`);
    assert.ok(!pavement.some((road) => !(line.shared && road.id === line.roadId) &&
      overlaps(body, road, buffer)), `${line.id}: don't start in a perpendicular road or mouth`);
    assert.ok(city.pedestrianSpawns.every((other) => pose === other || distance(pose, other) >= 1.4),
      `${line.id}: pedestrian headway`);
    if (roadBy(city, pose.roadId).zone === "avenue") avenues.push(pose);
    if (legacyWalks.has(line.id)) neighborhood.push(pose);
  }
  assert.ok(avenues.length >= 10 && new Set(avenues.map(({ roadId }) => roadId)).size >= 6,
    "additional people must be distributed across the avenue network");
  assert.ok(avenues.some((pose) => pose.roadId === city.playerStart.roadId &&
    distance(pose, city.playerStart) < 50), "the opening boulevard gets a nearby addition");
  assert.ok(neighborhood.length >= 6 && new Set(neighborhood.map(({ roadId }) => roadId)).size >= 5,
    "additional people must occupy original walks, not just the new connectors");
  assert.ok(neighborhood.some((pose) => lines.get(pose.walkwayId).shared),
    "the original shared alleys receive an additional walker");
});

test("the default populated World completes the Phone bakery trip at avenue and alley speeds", () => {
  const world = new World({}, "metro"), city = world.district;
  assert.deepEqual(world.capacity, { traffic: DEFAULTS.traffic, pedestrians: DEFAULTS.pedestrians });
  assert.deepEqual(world.audit(), []);
  const declared = city.showcaseRoutes[0], place = city.places.find(({ id }) => id === "district-bakery");
  assert.deepEqual(declared.goal, place);
  assert.deepEqual(declared.start, city.playerStart);
  const avenue = roadBy(city, declared.start.roadId), alley = roadBy(city, "alley-west");
  assert.ok(avenue.width >= 10 && bodyOnRoad(world.player, [avenue], buffer));
  const otherPavement = city.roads.filter((road) => road !== alley);
  assert.equal(world.command({ type: "destination", place }), true);
  let distanceM = 0, peakAvenueMps = 0, peakAlleyMps = 0, avenueM = 0, alleyRunM = 0, alleyM = 0;
  for (let i = 0; i < 150 / STEP && world.metrics.completedTrips === 0; i++) {
    const before = { ...world.player };
    world.step();
    const player = world.player;
    const travelled = distance(before, player);
    assert.ok(bodyOnRoad(player, world.roads, buffer), `ego must stay on the road: tick ${world.tick}`);
    assert.ok(travelled <= Math.max(Math.abs(before.speed), Math.abs(player.speed)) * STEP + 1e-7,
      `ego may not teleport: tick ${world.tick}`);
    distanceM += travelled;
    if (bodyOnRoad(player, [avenue], buffer)) {
      avenueM += travelled;
      peakAvenueMps = Math.max(peakAvenueMps, player.speed);
    }
    const alleyOnly = bodyOnRoad(player, [alley], buffer) &&
      corners(player).every((corner) => !pointOnRoad(corner, otherPavement));
    alleyRunM = alleyOnly ? alleyRunM + travelled : 0;
    if (alleyOnly) peakAlleyMps = Math.max(peakAlleyMps, player.speed);
    alleyM = Math.max(alleyM, alleyRunM);
  }
  const evidence = { distanceM, avenueM, alleyM, peakAvenueMps, peakAlleyMps,
    ticks: world.tick, remainingM: distance(world.player, place), reason: world.player.reason };
  console.log(`METRO_PHONE ${JSON.stringify(evidence)}`);
  assert.equal(world.metrics.completedTrips, 1, JSON.stringify(evidence));
  assert.ok(distanceM >= 240 && avenueM >= 100 && alleyM >= 12, JSON.stringify(evidence));
  assert.ok(peakAvenueMps >= 8 && peakAlleyMps > 0 && peakAlleyMps <= 3.9, JSON.stringify(evidence));
  assert.ok(evidence.remainingM <= 0.8 && world.player.speed <= 0.1);
  assert.ok(Math.abs(angleDelta(world.player.heading, place.heading)) <= 0.2);
  assert.deepEqual(world.audit(), []);
});

test("the rush ambient default completes the Phone bakery trip through the neighborhood connector", () => {
  const world = new World({ cityVersion: 4, seed: "cairo-42" }, "metro");
  const population = {
    traffic: world.actors.filter((actor) => actor.type === "vehicle" && actor !== world.player).length,
    pedestrians: world.actors.filter((actor) => actor.type === "pedestrian").length,
  };
  assert.equal(world.config.speedLimit, 48);
  // This public departure exposed two occupied mouth reservations that held
  // mutually blocking vehicles indefinitely, even though neither overlapped.
  for (let tick = 0; tick < 146; tick++) world.step();
  const place = world.district.places.find(({ id }) => id === "district-bakery");
  assert.equal(world.command({ type: "destination", place }), true);
  while (world.tick < 7500 && world.metrics.completedTrips === 0) world.step();
  assert.ok(world.metrics.distance > 330, "The car must already be through the busy connector");
  while (world.tick < 10_800 && world.metrics.completedTrips === 0) world.step();
  const remainingM = distance(world.player, place);
  const evidence = { ...population, tick: world.tick, distanceM: world.metrics.distance,
    remainingM, reason: world.player.reason };
  console.log(`METRO_RUSH_PHONE ${JSON.stringify(evidence)}`);
  assert.equal(world.metrics.completedTrips, 1, JSON.stringify(evidence));
  assert.deepEqual(population, { traffic: 36, pedestrians: 80 });
  assert.ok(world.metrics.distance > 330 && remainingM <= 0.8 && Math.abs(world.player.speed) <= 0.1);
  assert.deepEqual(world.audit(), []);
});
