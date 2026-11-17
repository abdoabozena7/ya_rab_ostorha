import test from "node:test";
import assert from "node:assert/strict";
import {
  measureRanges,
  measureVehicleSensors,
  RangeSignalProcessor,
  SENSOR_MAX_M,
} from "../src/signal_processing/range-sensors.js";
import { getVehicleMounts, mountToWorld } from "../src/core/vehicle-spec.js";
import { World } from "../src/core/world.js";

const near = (actual, expected, tolerance = 1e-8) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);

test("the forward range beam measures the visible box face in metres", () => {
  const car = {
    id: "player",
    type: "vehicle",
    x: 0,
    z: 0,
    heading: 0,
    length: 4,
    width: 1.8,
  };
  const obstacle = {
    id: "van",
    type: "vehicle",
    x: 0,
    z: 10,
    heading: 0,
    length: 4,
    width: 2,
  };
  const ranges = measureRanges({ actors: [car, obstacle], statics: [] }, car);
  assert.equal(ranges[2], 5.96);
  assert.equal(ranges[0], SENSOR_MAX_M);
  assert.equal(ranges[4], SENSOR_MAX_M);
});

test("quarter-turn bumper lenses and nearest wall faces use the same metre-space transform", () => {
  const car = {
    id: "player", type: "vehicle", x: 3, z: -4,
    heading: Math.PI / 2, length: 4.2, width: 1.85,
  };
  const wall = {
    id: "rotated-wall", type: "static", x: 11, z: -4,
    heading: Math.PI / 2, length: 2, width: 40, height: 2,
  };
  const measured = measureVehicleSensors({ actors: [car], statics: [wall] }, car);
  const offsets = [-0.76, -0.43, 0, 0.43, 0.76];
  const angles = [-70, -35, 0, 35, 70];
  for (let i = 0; i < 5; i++) {
    const ray = measured.rays[i];
    const angle = angles[i] * Math.PI / 180;
    const expectedRange = (10 - 5.14) / Math.cos(angle);
    near(ray.origin.x, 5.14);
    near(ray.origin.y, 0.66);
    near(ray.origin.z, -4 - offsets[i]);
    near(ray.rangeM, expectedRange);
    near(ray.end.x, 10);
    near(ray.end.y, 0.66);
    near(ray.end.z, -4 - offsets[i] - Math.sin(angle) * expectedRange);
    assert.equal(ray.hitId, "rotated-wall");
    assert.deepEqual(measured.mounts.ranges[i].position, ray.origin);
    near(measured.rawM[i], Math.round(expectedRange * 100) / 100);
  }
  near(measured.mounts.camera.position.x, 3.72);
  near(measured.mounts.camera.position.y, 1.58);
  near(measured.mounts.camera.position.z, -4);
});

test("each differently mounted ray hits the independent near circle oracle at arbitrary headings", () => {
  const layout = [
    { id: "left-outer", angle: -70, x: -0.76, y: 0.66, z: 2.14 },
    { id: "left-inner", angle: -35, x: -0.43, y: 0.66, z: 2.14 },
    { id: "center", angle: 0, x: 0, y: 0.66, z: 2.14 },
    { id: "right-inner", angle: 35, x: 0.43, y: 0.66, z: 2.14 },
    { id: "right-outer", angle: 70, x: 0.76, y: 0.66, z: 2.14 },
    { id: "rear-left", angle: -145, x: -0.66, y: 0.7, z: -2.14 },
    { id: "rear-center", angle: 180, x: 0, y: 0.7, z: -2.14 },
    { id: "rear-right", angle: 145, x: 0.66, y: 0.7, z: -2.14 },
    { id: "side-left", angle: -90, x: -0.955, y: 0.76, z: 0.15 },
    { id: "side-right", angle: 90, x: 0.955, y: 0.76, z: 0.15 },
  ];
  for (const heading of [0, 0.73, Math.PI / 2, -Math.PI / 2, Math.PI]) {
    const car = { id: "player", type: "vehicle", x: -7, z: 4, heading, length: 4.2, width: 1.85 };
    for (let i = 0; i < layout.length; i++) {
      const mount = layout[i];
      const angle = heading + mount.angle * Math.PI / 180;
      const origin = {
        x: -7 + Math.cos(heading) * mount.x + Math.sin(heading) * mount.z,
        y: mount.y,
        z: 4 - Math.sin(heading) * mount.x + Math.cos(heading) * mount.z,
      };
      const nearBody = {
        id: "nearest-circle", type: "pedestrian", radius: 0.4,
        x: origin.x + Math.sin(angle) * 8,
        z: origin.z + Math.cos(angle) * 8,
      };
      const farther = {
        ...nearBody, id: "farther-circle",
        x: origin.x + Math.sin(angle) * 12,
        z: origin.z + Math.cos(angle) * 12,
      };
      const behind = {
        ...nearBody, id: "behind-circle",
        x: origin.x - Math.sin(angle) * 3,
        z: origin.z - Math.cos(angle) * 3,
      };
      const measured = measureVehicleSensors({
        actors: [structuredClone(car), farther, behind, nearBody], statics: [],
      }, car);
      const ray = measured.rays[i];
      assert.equal(ray.id, mount.id);
      assert.equal(ray.angleDeg, mount.angle);
      assert.equal(ray.hitId, "nearest-circle");
      near(ray.rangeM, 7.6);
      if (i < 5) near(measured.rawM[i], 7.6);
      else {
        near(measured.auxiliary[i - 5].rangeM, 7.6);
        assert.deepEqual(measured.auxiliary[i - 5], ray);
      }
      for (const axis of ["x", "y", "z"]) near(ray.origin[axis], origin[axis]);
      near(ray.end.x, origin.x + Math.sin(angle) * 7.6);
      near(ray.end.z, origin.z + Math.cos(angle) * 7.6);
    }
  }
});

test("rear and side beams at a quarter-turn hit the nearest independent wall planes", () => {
  const car = {
    id: "player", type: "vehicle", x: 3, z: -4,
    heading: Math.PI / 2, length: 4.2, width: 1.85,
  };
  const rearWall = {
    id: "rear-wall", type: "static", x: -7, z: -4,
    heading: Math.PI / 2, length: 2, width: 40, height: 2,
  };
  const rear = measureVehicleSensors({
    actors: [{ ...car }], statics: [{ ...rearWall, id: "farther-wall", x: -20 }, rearWall],
  }, car);
  for (const [i, x, angle] of [[0, -0.66, -145], [1, 0, 180], [2, 0.66, 145]]) {
    const ray = rear.auxiliary[i];
    const worldAngle = (90 + angle) * Math.PI / 180;
    const expectedRange = 6.86 / -Math.sin(worldAngle);
    near(ray.origin.x, 0.86);
    near(ray.origin.z, -4 - x);
    near(ray.origin.y, 0.7);
    near(ray.rangeM, expectedRange);
    near(ray.end.x, -6);
    near(ray.end.z, -4 - x + Math.cos(worldAngle) * expectedRange);
    assert.equal(ray.hitId, "rear-wall");
  }
  for (const fixture of [
    { id: "side-left", index: 3, wallZ: 2, originZ: -3.045, endZ: 1, rangeM: 4.045 },
    { id: "side-right", index: 4, wallZ: -12, originZ: -4.955, endZ: -11, rangeM: 6.045 },
  ]) {
    const wall = {
      id: fixture.id + "-wall", type: "static", x: 3, z: fixture.wallZ,
      heading: 0, length: 2, width: 16, height: 2,
    };
    const ray = measureVehicleSensors({ actors: [car], statics: [wall] }, car).auxiliary[fixture.index];
    assert.equal(ray.id, fixture.id);
    assert.equal(ray.hitId, wall.id);
    near(ray.origin.x, 3.15);
    near(ray.origin.z, fixture.originZ);
    near(ray.origin.y, 0.76);
    near(ray.rangeM, fixture.rangeM);
    near(ray.end.x, 3.15);
    near(ray.end.z, fixture.endZ);
  }
});

test("front and rear camera positions and opposite view axes share the rotated metre-space datum", () => {
  for (const heading of [0, 0.73, Math.PI / 2, -Math.PI / 2, Math.PI]) {
    const car = { id: "player", type: "vehicle", x: -7, z: 4, heading, length: 4.2, width: 1.85 };
    const measured = measureVehicleSensors({ actors: [car], statics: [] }, car);
    const [front, rear] = measured.mounts.cameras;
    assert.deepEqual(measured.mounts.camera, front);
    assert.equal(front.id, "front-camera");
    assert.equal(rear.id, "rear-camera");
    near(front.position.x, -7 + Math.sin(heading) * 0.72);
    near(front.position.z, 4 + Math.cos(heading) * 0.72);
    near(front.position.y, 1.58);
    near(rear.position.x, -7 - Math.sin(heading) * 2.135);
    near(rear.position.z, 4 - Math.cos(heading) * 2.135);
    near(rear.position.y, 1.42);
    near(Math.sin(front.headingRad), Math.sin(heading));
    near(Math.cos(front.headingRad), Math.cos(heading));
    near(Math.sin(rear.headingRad), -Math.sin(heading));
    near(Math.cos(rear.headingRad), -Math.cos(heading));
    near(measured.mounts.telemetry.position.x, -7 - Math.sin(heading) * 0.15);
    near(measured.mounts.telemetry.position.z, 4 - Math.cos(heading) * 0.15);
    near(measured.mounts.telemetry.position.y, 2);
  }
});

test("the legacy front filter remains exactly five channels alongside actual five-channel auxiliary geometry", () => {
  const world = new World({ traffic: 0, pedestrians: 0 }, "vehicle");
  const sensors = world.sensors;
  assert.equal(sensors.rawM.length, 5);
  assert.equal(sensors.filteredM.length, 5);
  assert.deepEqual(sensors.anglesDeg, [-70, -35, 0, 35, 70]);
  assert.equal(sensors.rays.length, 10);
  assert.deepEqual(sensors.auxiliary.map((ray) => ray.id),
    ["rear-left", "rear-center", "rear-right", "side-left", "side-right"]);
  assert.deepEqual(sensors.rays.slice(5), sensors.auxiliary);
  assert.deepEqual(sensors.rawM, measureRanges(world, world.player));
  assert.throws(() => new RangeSignalProcessor().update(sensors.rays.map((ray) => ray.rangeM)),
    /Invalid proximity sample/);
});

test("a large near surface is not discarded by its distant center, and below-lens geometry is clear", () => {
  const car = { id: "player", type: "vehicle", x: 0, z: 0, heading: 0, length: 4.2, width: 1.85 };
  const huge = { id: "long-wall", type: "static", x: 0, z: 70, heading: 0, length: 120, width: 8, height: 2 };
  const low = { id: "below-lens", type: "static", x: 0, z: 5, heading: 0, length: 1, width: 8, height: 0.2 };
  const ray = measureVehicleSensors({ actors: [car], statics: [huge, low] }, car).rays[2];
  assert.equal(ray.hitId, "long-wall");
  near(ray.rangeM, 7.86);
  near(ray.end.z, 10);
});

test("empty, self-only and out-of-range scenes terminate all rays at the configured maximum", () => {
  const car = { id: "player", type: "vehicle", x: 5, z: -3, heading: 1.1, length: 4.2, width: 1.85 };
  const distant = { id: "distant", type: "pedestrian", radius: 0.3, x: 500, z: 500 };
  const measured = measureVehicleSensors({ actors: [car, { ...car }, distant], statics: [] }, car);
  assert.deepEqual(measureRanges({ actors: [car], statics: [] }, car), [35, 35, 35, 35, 35]);
  for (const ray of measured.rays) {
    assert.equal(ray.hitId, null);
    assert.equal(ray.rangeM, 35);
    near(Math.hypot(ray.end.x - ray.origin.x, ray.end.z - ray.origin.z), 35);
    near(ray.end.y, ray.origin.y);
  }
});

test("body-width scaling changes physical lens offsets without changing their named order", () => {
  const body = { x: 2, z: -1, heading: Math.PI, length: 5, width: 3.7 };
  const mounts = getVehicleMounts(body);
  assert.deepEqual(mounts.ranges.map((m) => m.id), ["left-outer", "left-inner", "center", "right-inner", "right-outer"]);
  const transformed = mountToWorld(body, mounts.ranges[0].position);
  near(transformed.x, 3.52);
  near(transformed.y, 0.66);
  near(transformed.z, -3.54);
  const rear = mountToWorld(body, mounts.auxiliary[0].position);
  near(rear.x, 3.32);
  near(rear.y, 0.7);
  near(rear.z, 1.54);
  const side = mountToWorld(body, mounts.auxiliary[3].position);
  near(side.x, 3.88);
  near(side.y, 0.76);
  near(side.z, -1.15);
});

test("world ray geometry stays current between filtered sampling ticks", () => {
  const world = new World({ traffic: 0, pedestrians: 0 }, "vehicle");
  world.command({ type: "drive", targetSpeed: 2, steer: 0 });
  for (let i = 0; i < 5; i++) world.step();
  const ray = world.sensors.rays[2];
  near(ray.origin.x, world.player.x);
  near(ray.origin.z, world.player.z + 2.14);
  near(ray.origin.y, 0.66);
  near(ray.end.z, -9);
  assert.ok(world.sensors.rawM[2] < world.sensors.filteredM[2]);
  assert.deepEqual(world.sensors.rawM, measureRanges(world, world.player));
  assert.equal(world.sensors.source, "simulated-geometry");
});

test("range processing retains raw measurements and smooths transient samples", () => {
  const processor = new RangeSignalProcessor();
  processor.update([35, 35, 35, 35, 35]);
  const transient = processor.update([35, 35, 5, 35, 35]);
  assert.equal(transient.rawM[2], 5);
  assert.equal(transient.filteredM[2], 35);
  const confirmed = processor.update([35, 35, 5, 35, 35]);
  assert.equal(confirmed.filteredM[2], 21.5);
  assert.equal(confirmed.source, "simulated-geometry");
  for (const invalid of [[35], [35, 35, NaN, 35, 35], [35, -1, 35, 35, 35], [35, 35, 36, 35, 35]])
    assert.throws(() => processor.update(invalid), /Invalid proximity sample/);
});
