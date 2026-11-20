import assert from "node:assert/strict";
import test from "node:test";
import { districtTrafficCommand, updateDistrictTraffic } from "../src/core/district-behavior.js";
import { bodyOnRoad, corners, pointOnRoad } from "../src/core/geometry.js";
import { followPath, integrateVehicle, vehicleProbe } from "../src/core/vehicle.js";
import { walkSegmentBlocker, walkSegmentClear } from "../src/core/walk-route.js";

test("walking clearance keeps the first actual blocker, including contacts between endpoints", () => {
  const person = { id: "walker", type: "pedestrian", radius: 0.25, x: -1, z: 0 };
  const end = { x: 1, z: 0 }, gap = 0.125;
  const tangent = { id: "tangent", type: "pedestrian", radius: 0.25, x: 0, z: 0.625 };
  const first = { ...tangent, id: "first", z: 0.625 - 1e-8 };
  const last = { ...first, id: "last" };
  assert.ok(walkSegmentClear(person, person, end, [person, tangent], gap));
  assert.ok(walkSegmentClear(person, person, person, [first], gap));
  assert.ok(walkSegmentClear(person, end, end, [first], gap));
  assert.equal(walkSegmentBlocker(person, person, end, [tangent, first, last], gap), first);
  assert.equal(walkSegmentBlocker(person, person, end, [last, first], gap), last);

  const longWall = { id: "wall", type: "static", x: 30, z: 0,
    heading: Math.PI / 2, length: 60, width: 1 };
  assert.equal(walkSegmentBlocker(person, person, end, [longWall], gap), longWall);
});

test("road support uses the union of complete footprints, not just the corners", () => {
  const car = { type: "vehicle", x: 0, z: 0, heading: 0, length: 4, width: 2 };
  const strip = { axis: "x", min: -3, max: 3, width: 3 };
  const split = [{ ...strip, fixed: -1.6 }, { ...strip, fixed: 1.6 }];
  const joined = [{ ...strip, fixed: -1.5 }, { ...strip, fixed: 1.5 }];
  assert.ok(corners(car).every((point) => pointOnRoad(point, split)));
  assert.equal(bodyOnRoad(car, split, 0), false);
  assert.equal(bodyOnRoad(car, joined, 0), true);
  assert.equal(bodyOnRoad(car, joined, 0.12), false);
});

test("a frozen route with a live accessor still uses its current geometry", () => {
  let x = 0;
  const route = Object.freeze([
    Object.freeze({ x: 0, z: 0 }), Object.freeze({ get x() { return x; }, z: 3 }),
    Object.freeze({ x: 0, z: 8 }), Object.freeze({ x: 0, z: 20 }),
  ]);
  const car = { x: 0, z: 1.3, heading: 0, speed: 5.6, maxSpeed: 10 };
  const before = followPath(car, route);
  x = 3;
  const after = followPath(car, route);
  assert.notDeepEqual(after, before);
  assert.deepEqual(after, followPath(car, route.map((point) => ({ ...point }))));
});

test("compact prediction preserves all live plant inputs through acceleration, turning and reversing", () => {
  const car = { type: "vehicle", x: -11.2, z: 14.7, heading: 2.78, speed: 4,
    length: 4.2, width: 1.85, steer: 0, maxSpeed: 10, spec: { wheelbase: 2.8 } };
  const probe = vehicleProbe(car, car.speed);
  let reference = car;
  for (let i = 0; i < 80; i++) {
    const command = { steer: i < 20 ? 0.4 : -0.5, targetSpeed: i < 40 ? 6 : -2 };
    reference = integrateVehicle(reference, command, 0.16);
    assert.equal(integrateVehicle(probe, command, 0.16, probe), probe);
    assert.deepEqual(probe, vehicleProbe(reference, reference.speed));
  }
  assert.equal(car.speed, 4);
});

test("equally limiting leaders keep actor-array priority", () => {
  const car = { id: "car", type: "vehicle", x: 0, z: 0, speed: 3, heading: 0,
    length: 4, width: 2, maxSpeed: 5,
    district: { profile: "ordinary", headwayS: 1.6, loadingUntilTick: null } };
  const first = { ...car, id: "first", x: -0.5, z: 8, speed: 0 };
  const last = { ...first, id: "last", x: 0.5 };
  const world = { environment: "metro", actors: [car, first, last] };
  const input = { targetSpeed: 5, steer: 0 };
  assert.deepEqual(districtTrafficCommand(world, car, input),
    { ...input, targetSpeed: 0, reason: "district-following", blockedBy: first.id });
  world.actors = [car, last, first];
  assert.equal(districtTrafficCommand(world, car, input).blockedBy, last.id);
});

test("a planned footprint is admitted as soon as its exact entry reaches the approach radius", () => {
  const path = Object.freeze(Array.from({ length: 60 },
    (_, i) => Object.freeze({ x: 0, z: -13 + i * 0.5 })));
  const car = { id: "car", type: "vehicle", x: 0, z: -12, heading: 0, speed: 0,
    length: 4, width: 2, path, cursor: 2, district: { profile: "ordinary" } };
  const road = { axis: "z", fixed: 0, min: -20, max: 30, width: 6 };
  const zone = { id: "zone", kind: "junction", minX: -3, maxX: 3, minZ: -2, maxZ: 2,
    approachM: 5 };
  const world = { environment: "metro", player: car, actors: [car], roads: [road],
    mode: "auto", tick: 0, district: { conflictZones: [zone] } };
  updateDistrictTraffic(world);
  assert.equal(world.districtBehavior.approaches.car, undefined);
  car.z = -9;
  car.cursor = 8;
  world.tick++;
  updateDistrictTraffic(world);
  assert.deepEqual(world.districtBehavior.approaches.car, { zoneId: "zone", distanceM: 5 });
});
