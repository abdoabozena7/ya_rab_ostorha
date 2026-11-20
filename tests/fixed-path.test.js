import test from "node:test";
import assert from "node:assert/strict";
import { followPath, integrateVehicle } from "../src/core/vehicle.js";
import { lanePath } from "../src/core/navigation.js";

test("frozen district path reuses exact geometry without changing any accepted command or pose", () => {
  const path = lanePath([{ x: 0, z: -30 }, { x: 0, z: 15 }, { x: 30, z: 15 }, { x: 30, z: 50 }]);
  const fixed = Object.freeze(path.map((point) => Object.freeze({ ...point })));
  let a = { x: path[0].x, z: path[0].z, heading: 0, speed: 0, steer: 0,
    maxSpeed: 5.5, width: 1.85, length: 4.2 }, b = { ...a }, cursor = 0;
  for (let tick = 0; tick < 1800; tick++) {
    const expected = followPath(a, path, cursor);
    const actual = followPath(b, fixed, cursor);
    assert.deepEqual(actual, expected, `Full command at tick${tick}`);
    assert.deepEqual(followPath(b, fixed, cursor, true), followPath(a, path, cursor, true));
    cursor = expected.cursor;
    a = integrateVehicle(a, expected, 1 / 60);
    b = integrateVehicle(b, actual, 1 / 60);
    assert.deepEqual(b, a);
  }
});

test("a frozen array with mutable points never acquires an invalid geometry cache", () => {
  const points = Object.freeze([{ x: 0, z: 0 }, { x: 0, z: 10 }, { x: 0, z: 30 }]);
  const car = { x: 0, z: 0, heading: 0, speed: 1, steer: 0, maxSpeed: 5 };
  followPath(car, points);
  points[1].x = 4;
  points[2].z = 20;
  assert.deepEqual(followPath(car, points), followPath(car, points.map((point) => ({ ...point }))));
});
