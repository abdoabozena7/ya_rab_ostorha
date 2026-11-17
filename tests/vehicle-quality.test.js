import test from "node:test";
import assert from "node:assert/strict";
import { STEP } from "../src/core/config.js";
import { FixedClock } from "../src/core/clock.js";
import { overlaps } from "../src/core/geometry.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { integrateVehicle, resolveVehicleContact } from "../src/core/vehicle.js";
import { advanceVehicleState, createVehicleState } from "../src/core/vehicle-state.js";
import { World, LAB_ROADS } from "../src/core/world.js";

const near = (actual, expected, tolerance = 1e-8) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const spinDelta = (a, b) => Math.atan2(Math.sin(a - b), Math.cos(a - b));
const advance = (world, ticks) => {
  for (let i = 0; i < ticks; i++) world.step();
};
const finiteNumbers = (value) => {
  if (typeof value === "number") assert.ok(Number.isFinite(value));
  else if (value && typeof value === "object")
    Object.values(value).forEach(finiteNumbers);
};
function impactWorld() {
  const world = new World({ seed: "quality-impact", traffic: 28, pedestrians: 32 }, "vehicle");
  assert.equal(world.command({ type: "vehicle-test", operation: "run" }), true);
  while (world.vehicleTest.phase === "running" && world.tick < 480) world.step();
  assert.equal(world.vehicleTest.phase, "contact");
  return world;
}

test("only the player has running gear; parked rack motion has signed Ackermann geometry", () => {
  for (const sign of [-1, 1]) {
    const world = new World({ traffic: 1, pedestrians: 0 }, "lab");
    const { x, z, heading } = world.player;
    assert.ok(world.player.vehicle);
    assert.ok(world.actors.filter((a) => a !== world.player).every((a) => !("vehicle" in a)));
    world.command({ type: "drive", targetSpeed: 0, steer: sign });
    for (let i = 0; i < 80; i++) {
      const old = world.player.steer;
      world.step();
      assert.ok(Math.abs(world.player.steer - old) <= 0.9 / 60 + 1e-10);
    }
    const state = world.player.vehicle;
    const { frontLeft: left, frontRight: right } = state.wheelAngles;
    near(world.player.steer, sign * 0.62);
    near(state.steeringWheelRad, sign * 0.62 * 14.5);
    assert.equal(Math.sign(left), sign);
    assert.equal(Math.sign(right), sign);
    assert.ok(Math.abs(left) < 0.78 && Math.abs(right) < 0.78);
    assert.ok(sign > 0 ? right > left : Math.abs(left) > Math.abs(right));
    near(Math.abs(1 / Math.tan(left) - 1 / Math.tan(right)), 1.55 / 2.6);
    assert.deepEqual({ x: world.player.x, z: world.player.z, heading: world.player.heading }, { x, z, heading });
    assert.equal(state.wheelSpinRad, 0);
    assert.equal(state.damage.total, 0);
    finiteNumbers(state);
  }
});

test("rolling follows accepted signed travel, and reverse brakes through zero before changing gear", () => {
  const world = new World({ traffic: 0, pedestrians: 0 }, "lab");
  world.command({ type: "drive", targetSpeed: 3, steer: 0 });
  for (let i = 0; i < 90; i++) {
    const before = structuredClone(world.player);
    world.step();
    assert.ok(world.player.speed - before.speed <= 2.4 * STEP + 1e-10);
    const travelled = Math.hypot(world.player.x - before.x, world.player.z - before.z);
    near(spinDelta(world.player.vehicle.wheelSpinRad, before.vehicle.wheelSpinRad), travelled / 0.35);
    assert.equal(world.player.vehicle.controls.gear, "D");
  }
  near(world.player.speed, 3);
  world.command({ type: "drive", targetSpeed: -1.5, steer: 0 });
  let stopped = false;
  let reversed = false;
  for (let i = 0; i < 120; i++) {
    const before = structuredClone(world.player);
    world.step();
    const car = world.player;
    const travelled = car.z - before.z;
    near(spinDelta(car.vehicle.wheelSpinRad, before.vehicle.wheelSpinRad), travelled / 0.35);
    if (before.speed > 0) {
      assert.ok(car.speed >= 0, "direction must not flip within the braking step");
      assert.equal(car.vehicle.controls.brake, 1);
      assert.equal(car.vehicle.controls.throttle, 0);
      assert.ok(before.speed - car.speed <= 7 * STEP + 1e-10);
    }
    if (car.speed === 0) stopped = true;
    if (car.speed < 0) {
      assert.ok(stopped, "reverse thrust requires a preceding zero-speed state");
      assert.equal(car.vehicle.controls.gear, "R");
      assert.ok(travelled < 0);
      reversed = true;
    }
  }
  assert.ok(reversed);
  near(world.player.speed, -1.5);
  assert.equal(world.player.vehicle.damage.total, 0);
});

test("bounded chassis load transfer responds to acceleration and turning and settles at rest", () => {
  const world = new World({ traffic: 0, pedestrians: 0 }, "lab");
  world.command({ type: "drive", targetSpeed: 3, steer: 0 });
  advance(world, 40);
  let state = world.player.vehicle;
  assert.ok(state.suspension.pitchRad < 0, "forward acceleration lifts the nose");
  assert.ok(state.wheelLoadsN.frontLeft < state.wheelLoadsN.rearLeft);
  const transferN = 1800 * 2.4 * 0.68 / (2 * 2.6);
  near(state.wheelLoadsN.frontLeft, 1800 * 9.81 / 4 - transferN, 1e-6);
  near(state.wheelLoadsN.rearLeft, 1800 * 9.81 / 4 + transferN, 1e-6);
  world.command({ type: "drive", targetSpeed: 3, steer: 0.25 });
  advance(world, 40);
  state = world.player.vehicle;
  assert.ok(state.suspension.rollRad > 0, "a right turn loads the left side");
  assert.ok(state.wheelLoadsN.frontLeft + state.wheelLoadsN.rearLeft >
    state.wheelLoadsN.frontRight + state.wheelLoadsN.rearRight);
  near(Object.values(state.wheelLoadsN).reduce((a, b) => a + b), 1800 * 9.81, 1e-6);
  assert.ok(Object.values(state.wheelLoadsN).every((n) => n > 0));
  assert.ok(Object.values(state.suspension.wheelOffsetsM).every((n) => Math.abs(n) <= 0.07));
  assert.ok(Math.abs(state.suspension.pitchRad) <= 0.065);
  assert.ok(Math.abs(state.suspension.rollRad) <= 0.07);
  assert.ok(Math.abs(state.suspension.heaveM) <= 0.04);
  world.command({ type: "stop" });
  advance(world, 300);
  state = world.player.vehicle;
  assert.equal(world.player.speed, 0);
  assert.equal(state.controls.gear, "N");
  near(state.suspension.pitchRad, 0);
  near(state.suspension.rollRad, 0);
  near(state.suspension.heaveM, 0);
  finiteNumbers(state);
  assert.equal(state.damage.impactCount, 0);
});

test("the public isolated run makes one real finite-energy contact without entering the barrier", () => {
  const world = new World({ traffic: 28, pedestrians: 32, scenarioInterval: 2 }, "vehicle");
  assert.deepEqual(world.drivingRoads, LAB_ROADS);
  assert.deepEqual(world.capacity, { traffic: 0, pedestrians: 0 });
  assert.equal(world.actors.length, 1);
  assert.equal(world.statics.length, 1);
  near(world.sensors.rawM[2], 13.86);
  assert.equal(world.command({ type: "vehicle-test", operation: "run" }), true);
  assert.equal(world.command({ type: "drive", targetSpeed: 20, steer: 0.62 }), false);
  let peakSpeed = 0;
  let approachSamples = 0;
  let lastRange = world.sensors.rawM[2];
  for (let i = 0; i < 480 && world.vehicleTest.phase === "running"; i++) {
    assert.equal(world.player.vehicle.damage.impactCount, 0);
    world.step();
    peakSpeed = Math.max(peakSpeed, world.player.speed);
    assert.ok(world.sensors.rawM[2] <= lastRange);
    if (world.sensors.rawM[2] < lastRange) approachSamples++;
    lastRange = world.sensors.rawM[2];
    assert.deepEqual(world.audit(), []);
    finiteNumbers(world.player.vehicle);
    finiteNumbers(world.sensors);
  }
  const car = world.player;
  const damage = car.vehicle.damage;
  assert.equal(world.vehicleTest.phase, "contact");
  assert.ok(peakSpeed > 4.9 && peakSpeed <= 6);
  assert.equal(car.speed, 0);
  assert.ok(approachSamples > 150);
  assert.equal(world.metrics.scenarios, 0);
  assert.equal(world.metrics.interventions, 0);
  assert.equal(world.scenario, null);
  assert.ok(car.z + 2.1 <= -9 + 1e-6, "front bumper must not pass the known z=-9 face");
  near(car.z, -11.1, 1e-6);
  assert.equal(overlaps(car, world.statics[0]), false);
  assert.equal(damage.impactCount, 1);
  assert.ok(damage.front > 0 && damage.front <= 1);
  assert.deepEqual([damage.rear, damage.left, damage.right], [0, 0, 0]);
  near(damage.lastImpact.closingSpeedMps, 5);
  near(damage.lastImpact.energyJ, 0.5 * 1800 * 5 ** 2, 1e-6);
  near(world.sensors.imu.longitudinalAccelerationMps2, -300);
  assert.equal(damage.lastImpact.side, "front");
  assert.equal(world.vehicleTest.impact.hitId, "vehicle-impact-barrier");
});

test("stationary contact cannot accumulate damage, reverse can leave it, and reconstruction resets it", () => {
  const world = impactWorld();
  const damage = structuredClone(world.player.vehicle.damage);
  const spin = world.player.vehicle.wheelSpinRad;
  const z = world.player.z;
  assert.equal(world.command({ type: "vehicle-test", operation: "run" }), false);
  advance(world, 240);
  assert.deepEqual(world.player.vehicle.damage, damage);
  assert.equal(world.player.vehicle.wheelSpinRad, spin);
  assert.equal(world.player.z, z);
  assert.equal(world.sensors.imu.longitudinalAccelerationMps2, 0);
  assert.equal(world.sensors.imu.yawRateRadS, 0);
  world.command({ type: "drive", targetSpeed: -1, steer: 0 });
  advance(world, 60);
  assert.ok(world.player.z < z - 0.7);
  assert.equal(world.player.vehicle.controls.gear, "R");
  assert.deepEqual(world.player.vehicle.damage, damage);
  assert.deepEqual(world.audit(), []);
  const pristine = new World(world.config, "vehicle");
  assert.deepEqual(pristine.player.vehicle, createVehicleState());
  assert.equal(pristine.vehicleTest.phase, "ready");
  near(pristine.player.z, -25);
  const copy = world.snapshot();
  copy.actors[0].vehicle.damage.front = 1;
  assert.deepEqual(world.player.vehicle.damage, damage, "snapshots must not mutate live damage");
});

test("ordinary city and lab guards reject contact without damage or test-command side effects", () => {
  for (const environment of ["city", "lab"]) {
    const world = new World({ traffic: 0, pedestrians: 0 }, environment);
    const replay = world.replay();
    assert.equal(world.command({ type: "vehicle-test", operation: "run" }), false);
    assert.deepEqual(world.replay(), replay);
    const barrier = {
      id: "ordinary-safety-control", type: "static", kind: "barrier",
      x: world.player.x, z: world.player.z + 8,
      width: 3, length: 0.8, heading: 0, height: 1,
    };
    world.statics.push(barrier);
    world.staticIndex = new SpatialIndex(world.statics);
    world.command({ type: "drive", targetSpeed: 5, steer: 0 });
    for (let i = 0; i < 300; i++) {
      world.step();
      assert.equal(overlaps(world.player, barrier), false);
      assert.equal(world.player.vehicle.damage.total, 0);
    }
    assert.ok(world.player.z + 2.1 <= barrier.z - 0.4 - 0.12 + 1e-6);
    assert.deepEqual(world.player.vehicle.damage.lastImpact, null);
    assert.deepEqual(world.audit(), []);
  }
});

test("a fully rejected move does not roll wheels or manufacture an impact", () => {
  const world = new World({ traffic: 0, pedestrians: 0 }, "lab");
  const before = { x: world.player.x, z: world.player.z };
  world.statics.push({
    id: "close-control", type: "static", x: before.x, z: before.z + 2.625,
    width: 3, length: 0.8, heading: 0, height: 1,
  });
  world.staticIndex = new SpatialIndex(world.statics);
  world.command({ type: "drive", targetSpeed: 6, steer: 0 });
  advance(world, 120);
  assert.deepEqual({ x: world.player.x, z: world.player.z }, before);
  assert.equal(world.player.vehicle.wheelSpinRad, 0);
  assert.equal(world.player.vehicle.damage.impactCount, 0);
  assert.equal(world.sensors.imu.speedMps, 0);
  assert.equal(world.sensors.imu.longitudinalAccelerationMps2, 0);
});

test("virtual roof IMU/GNSS reports accepted pose, signed speed and true fixed-step derivatives", () => {
  const world = new World({ traffic: 0, pedestrians: 0 }, "lab");
  assert.equal(world.sensors.imu.source, "simulated-vehicle-state");
  near(world.sensors.imu.positionM.x, world.player.x);
  near(world.sensors.imu.positionM.y, 2);
  near(world.sensors.imu.positionM.z, world.player.z - 0.15);
  assert.equal(world.sensors.imu.yawRateRadS, 0);
  assert.equal(world.sensors.imu.longitudinalAccelerationMps2, 0);
  world.command({ type: "drive", targetSpeed: 3, steer: 0.2 });
  let observedYaw = false;
  for (let i = 0; i < 60; i++) {
    const before = { speed: world.player.speed, heading: world.player.heading };
    world.step();
    const car = world.player;
    const imu = world.sensors.imu;
    near(imu.headingRad, car.heading);
    near(imu.speedMps, car.speed);
    near(imu.positionM.x, car.x - 0.15 * Math.sin(car.heading));
    near(imu.positionM.z, car.z - 0.15 * Math.cos(car.heading));
    near(imu.positionM.y, 2);
    near(imu.yawRateRadS, (car.heading - before.heading) * 60);
    near(imu.longitudinalAccelerationMps2, (car.speed - before.speed) * 60);
    near(imu.longitudinalAccelerationMps2, 2.4);
    assert.deepEqual(imu.positionM, world.sensors.mounts.telemetry.position);
    if (imu.yawRateRadS > 0) observedYaw = true;
  }
  assert.ok(observedYaw);
  world.command({ type: "drive", targetSpeed: -1, steer: 0 });
  let observedBraking = false;
  for (let i = 0; i < 120; i++) {
    world.step();
    if (world.sensors.imu.longitudinalAccelerationMps2 < -1)
      observedBraking = true;
  }
  assert.ok(observedBraking);
  near(world.sensors.imu.speedMps, -1);
  assert.deepEqual(World.fromReplay(world.replay()).snapshot(), world.snapshot());
});

test("contact geometry distinguishes front, rear and side and rejects noncontact motion", () => {
  const before = {
    type: "vehicle", x: 0, z: 0, heading: 0, speed: 5, steer: 0,
    length: 4.2, width: 1.85, vehicle: createVehicleState(),
  };
  for (const fixture of [
    { proposed: { z: 12 }, wall: { x: 0, z: 8, width: 4, length: 0.6 }, dt: 2.4, side: "front", stop: { z: 5.6 } },
    { proposed: { z: -8 }, wall: { x: 0, z: -5, width: 4, length: 0.6 }, dt: 1.6, side: "rear", stop: { z: -2.6 } },
    { proposed: { x: 6 }, wall: { x: 4, z: 0, width: 0.8, length: 8 }, dt: 1.2, side: "right", stop: { x: 2.675 } },
  ]) {
    const wall = { id: fixture.side, type: "static", heading: 0, ...fixture.wall };
    const proposed = { ...before, ...fixture.proposed };
    const contact = resolveVehicleContact(before, proposed, wall, fixture.dt);
    assert.ok(contact);
    assert.equal(contact.side, fixture.side);
    assert.equal(overlaps(contact.body, wall), false);
    for (const [axis, expected] of Object.entries(fixture.stop)) near(contact.body[axis], expected, 1e-6);
    near(contact.closingSpeedMps, 5);
    near(contact.energyJ, 0.5 * 1800 * 5 ** 2, 1e-6);
    const state = advanceVehicleState(before, contact.body, { targetSpeed: 5 }, STEP, { tick: 7, contact });
    assert.ok(state.damage[fixture.side] > 0);
    assert.equal(state.damage.impactCount, 1);
  }
  const far = { id: "far", type: "static", x: 20, z: 8, width: 2, length: 1, heading: 0 };
  assert.equal(resolveVehicleContact(before, { ...before, z: 1 }, far), null);
  assert.equal(resolveVehicleContact(before, before, far), null);
  const untouched = advanceVehicleState(before, { ...before, z: 0.05 }, { targetSpeed: 5 }, STEP);
  assert.equal(untouched.damage.total, 0);
});

test("an interrupted test brakes safely, cannot restart away from the mark, and replays exactly", () => {
  const world = new World({ traffic: 0, pedestrians: 0 }, "vehicle");
  world.command({ type: "vehicle-test", operation: "run" });
  advance(world, 80);
  const speed = world.player.speed;
  world.command({ type: "stop" });
  assert.equal(world.player.speed, speed);
  assert.equal(world.vehicleTest.phase, "ready");
  assert.equal(world.command({ type: "vehicle-test", operation: "run" }), false);
  advance(world, 180);
  assert.equal(world.player.speed, 0);
  assert.equal(world.player.vehicle.damage.total, 0);
  assert.deepEqual(world.audit(), []);
  assert.deepEqual(World.fromReplay(world.replay()).snapshot(), world.snapshot());
});

test("contact, running gear and live sensor geometry survive replay and different frame partitions", () => {
  const results = [];
  for (const fps of [30, 60, 144]) {
    const world = new World({ seed: "vehicle-frame-partitions" }, "vehicle");
    world.command({ type: "vehicle-test", operation: "run" });
    const clock = new FixedClock();
    for (let frame = 0; frame < fps * 5; frame++)
      clock.advance(1 / fps, () => world.step());
    assert.equal(world.tick, 300);
    assert.equal(world.vehicleTest.phase, "contact");
    world.command({ type: "drive", targetSpeed: -1, steer: 0 });
    advance(world, 45);
    world.command({ type: "stop" });
    advance(world, 60);
    const replay = JSON.parse(JSON.stringify(world.replay()));
    assert.deepEqual(World.fromReplay(replay).snapshot(), world.snapshot());
    results.push(world.snapshot());
  }
  assert.deepEqual(results[0], results[1]);
  assert.deepEqual(results[0], results[2]);
});

test("invalid integration inputs cannot poison valid car state or bypass replay admission", () => {
  const body = { x: 0, z: 0, heading: 0, speed: 0, steer: 0, maxSpeed: 10 };
  const result = integrateVehicle(body, { targetSpeed: Infinity, steer: NaN }, STEP);
  assert.equal(result.speed, 0);
  assert.equal(result.steer, 0);
  finiteNumbers(result);
  assert.throws(() => integrateVehicle(body, {}, NaN), RangeError);
  const replay = new World({ traffic: 0, pedestrians: 0 }, "vehicle").replay();
  assert.throws(() => World.fromReplay({
    ...replay, events: [{ tick: 0, command: { type: "vehicle-test", operation: "damage" } }],
  }), /Invalid replay event/);
});
