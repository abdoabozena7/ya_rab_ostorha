import test from "node:test";
import assert from "node:assert/strict";
import { STEP } from "../src/core/config.js";
import { overlaps } from "../src/core/geometry.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { integrateVehicle, resolveVehicleContact, vehicleProbe, vehicleVelocity } from "../src/core/vehicle.js";
import { advanceVehicleState, createVehicleState } from "../src/core/vehicle-state.js";
import { World } from "../src/core/world.js";

const spec = { realisticDynamics: true, tireGripMps2: 8,
  contactResponse: "inelastic-slide-v1", massKg: 1800 };
const near = (a, b, tolerance = 1e-8) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const car = (overrides = {}) => ({ type: "vehicle", x: 0, z: 0, heading: 0,
  speed: 30, steer: .62, length: 4.2, width: 1.85, maxSpeed: 40,
  spec, vehicle: createVehicleState(), ...overrides });
const wall = { id: "wall", type: "static", x: 3, z: 0, width: .2, length: 100, heading: 0 };

test("explicit City grip bounds high-speed turns and reserves grip for braking and acceleration", () => {
  for (const targetSpeed of [0, 30, 40]) {
    const before = car();
    const after = integrateVehicle(before, { targetSpeed, steer: .62 }, STEP);
    const longitudinal = (after.speed - before.speed) / STEP;
    const lateral = (before.speed + after.speed) / 2 * (after.heading - before.heading) / STEP;
    assert.ok(longitudinal ** 2 + lateral ** 2 <= 64 + 1e-8);
    assert.ok(lateral > 0);
    if (targetSpeed === 30) near(lateral, 8);
    if (targetSpeed === 0) near(lateral, Math.sqrt(15));
    assert.ok(Object.values(vehicleVelocity(after)).every(Number.isFinite));
  }
  const legacy = integrateVehicle(car({ spec: { realisticDynamics: true } }), { targetSpeed: 30, steer: .62 }, STEP);
  assert.ok(30 * legacy.heading / STEP > 100, "negative control: old realistic steering was not grip-limited");
});

test("parking-speed steering, forward/reverse braking, coasting, probes and zero-dt stay coherent", () => {
  for (const speed of [-2, 0, 2]) {
    for (const targetSpeed of [-2, 0, 2]) {
      const body = car({ speed, steer: .25 });
      const actual = integrateVehicle(body, { targetSpeed, steer: .3 }, STEP);
      const legacy = integrateVehicle({ ...body, spec: {} }, { targetSpeed, steer: .3 }, STEP);
      for (const key of ["x", "z", "heading", "speed", "steer"]) near(actual[key], legacy[key]);
      const probed = integrateVehicle(vehicleProbe(body, speed), { targetSpeed, steer: .3 }, STEP);
      for (const key of ["x", "z", "heading", "speed", "steer"]) near(probed[key], actual[key]);
    }
  }
  const body = car({ speed: 12, steer: .2, chaseSlipRad: -.03 });
  const zero = integrateVehicle(body, { targetSpeed: -2, steer: -.6 }, 0);
  for (const key of ["x", "z", "heading", "speed", "steer", "chaseSlipRad"]) near(zero[key], body[key]);
  const reversed = integrateVehicle(car({ speed: .05 }), { targetSpeed: -2 }, STEP);
  assert.equal(reversed.speed, 0);
  const coasting = integrateVehicle(body, { targetSpeed: 0, coasting: true }, STEP);
  near(coasting.speed, 12 - (1.65 + .0018 * 144) * STEP);
  assert.ok(coasting.speed > integrateVehicle(body, { targetSpeed: 0 }, STEP).speed);
});

test("grazing contact retains tangential travel without penetration or kinetic energy creation", () => {
  const before = car({ speed: 10, steer: 0, heading: Math.atan2(1, 4) });
  const proposed = { ...before, x: 4, z: 16 };
  const contact = resolveVehicleContact(before, proposed, wall, 2);
  assert.ok(contact);
  assert.equal(contact.side, "right");
  near(contact.closingSpeedMps, 2);
  near(contact.energyJ, 3600);
  near(contact.body.z, 16);
  assert.equal(overlaps(contact.body, wall), false);
  const v = vehicleVelocity(contact.body);
  near(v.x, 0);
  near(v.z, 8);
  assert.ok(v.x ** 2 + v.z ** 2 <= 68);
  let state = advanceVehicleState(before, contact.body, { targetSpeed: 10 }, STEP, { contact });
  const translated = { ...contact.body, z: contact.body.z + 2 };
  state = advanceVehicleState({ ...contact.body, vehicle: state }, translated, { targetSpeed: 10 }, STEP);
  state = advanceVehicleState({ ...translated, vehicle: state }, translated, { targetSpeed: 10 }, STEP, { contact });
  assert.equal(state.damage.impactCount, 1, "tangential travel does not start a second contact episode");
  const probe = vehicleProbe(contact.body, contact.body.speed);
  assert.deepEqual(vehicleVelocity(probe), v);
  const probeNext = integrateVehicle(probe, { targetSpeed: probe.speed, steer: .3 }, STEP, probe);
  const next = integrateVehicle(contact.body, { targetSpeed: contact.body.speed, steer: .3 }, STEP);
  near(probeNext.x, next.x);
  near(probeNext.z, next.z);
  const away = { ...contact.body, x: contact.body.x - .1 };
  assert.equal(resolveVehicleContact(contact.body, away, wall, STEP), null);
  assert.equal(resolveVehicleContact(contact.body, contact.body, wall, STEP), null);
});

test("relative closing speed and reduced mass drive energy, while repeated wall contact cannot redent", () => {
  const before = car({ speed: 5, steer: 0 });
  const front = { id: "lead", type: "vehicle", x: 0, z: 7, width: 2, length: 1,
    heading: 0, speed: 2, spec: { massKg: 600 } };
  const contact = resolveVehicleContact(before, { ...before, z: 10 }, front, 2);
  near(contact.closingSpeedMps, 3);
  near(contact.energyJ, 2025); // 0.5 * reduced mass (450 kg) * 3²
  assert.equal(overlaps(contact.body, front), false);
  let state = advanceVehicleState(before, contact.body, { targetSpeed: 5 }, STEP, { contact });
  near(state.damage.front, 2025 / 45000);
  const later = { ...contact.body, z: contact.body.z + 1, vehicle: state };
  state = advanceVehicleState({ ...contact.body, vehicle: state }, later, { targetSpeed: 5 }, STEP, { contact });
  assert.equal(state.damage.impactCount, 1);
  near(state.damage.front, 2025 / 45000);
  const fasterLead = { ...front, speed: 9 };
  const separating = resolveVehicleContact(before, { ...before, z: 10 }, fasterLead, 2);
  near(separating.closingSpeedMps, 0);
  near(separating.energyJ, 0);
  assert.ok(Math.hypot(...Object.values(vehicleVelocity(separating.body))) <= 5 + 1e-8);
});

test("actual default Metro step resolves reached contact; older City and test bay retain their profiles", () => {
  const world = new World({ cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  const player = world.player;
  assert.equal(player.spec.contactResponse, spec.contactResponse);
  const barrier = { id: "city-contact-control", type: "static", kind: "barrier",
    x: player.x + 2.25, z: player.z, heading: player.heading, length: .1, width: 8 };
  world.statics.push(barrier);
  world.staticIndex = new SpatialIndex(world.statics);
  const identity = world.actors;
  player.speed = 20;
  world.command({ type: "drive", targetSpeed: 20, steer: 0 });
  world.step();
  assert.equal(world.actors, identity);
  assert.equal(world.vehicleTest, null);
  assert.equal(player.speed, 0);
  assert.equal(player.vehicle.damage.impactCount, 1);
  assert.equal(player.vehicle.contact.hitId, barrier.id);
  assert.equal(overlaps(player, barrier), false);
  near(player.x + 2.1, barrier.x - .05, 1e-6);
  const damage = structuredClone(player.vehicle.damage);
  for (let i = 0; i < 30; i++) world.step();
  assert.deepEqual(player.vehicle.damage, damage);
  world.command({ type: "drive", targetSpeed: -1, steer: 0 });
  for (let i = 0; i < 60; i++) world.step();
  assert.ok(player.x < barrier.x - 2.5);
  assert.deepEqual(world.audit(), []);
  for (const version of [1, 2, 3, 4]) {
    const old = new World({ cityVersion: version, traffic: 0, pedestrians: 0 }, "metro");
    assert.equal(old.player.spec.contactResponse, undefined);
    assert.equal(old.player.spec.realisticDynamics, undefined);
  }
  const bay = new World({ traffic: 0, pedestrians: 0 }, "vehicle");
  assert.equal(bay.player.spec.contactResponse, undefined);
});

test("starting a preserved pursuit suspends the City profile and ending restores it", () => {
  const world = new World({ cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  const original = world.player.spec;
  assert.equal(world.command({ type: "street-pursuit-start", variant: "legacy", level: 1 }), true);
  assert.equal(world.player.spec.tireGripMps2, undefined);
  assert.equal(world.player.spec.realisticDynamics, undefined);
  assert.equal(world.command({ type: "street-pursuit-stop" }), true);
  assert.equal(world.player.spec, original);
});

test("a pedestrian guard before a candidate wall contact prevents phantom contact and damage", () => {
  const world = new World({ cityVersion: 5, traffic: 0, pedestrians: 1 }, "metro");
  const player = world.player;
  const before = { x: player.x, z: player.z };
  const pedestrian = world.actors.find(a => a.type === "pedestrian");
  Object.assign(pedestrian, { x: player.x + 2.5, z: player.z, radius: .25,
    speed: 0, motionMode: "stop" });
  const barrier = { id: "guarded-wall", type: "static", x: player.x + 2.25,
    z: player.z, heading: player.heading, length: .1, width: 8 };
  world.statics.push(barrier);
  world.staticIndex = new SpatialIndex(world.statics);
  player.speed = 20;
  const proposed = integrateVehicle(player, { targetSpeed: 0, steer: 0 }, STEP);
  assert.ok(resolveVehicleContact(player, proposed, barrier, STEP),
    "the proposed motion reaches a real wall contact if the pedestrian guard is omitted");
  world.command({ type: "drive", targetSpeed: 20, steer: 0 });
  world.step();
  assert.deepEqual({ x: player.x, z: player.z }, before);
  assert.equal(player.speed, 0);
  assert.equal(player.blockedBy, pedestrian.id);
  assert.equal(player.vehicle.contact, null);
  assert.equal(player.vehicle.damage.impactCount, 0);
  assert.equal(player.vehicle.damage.lastImpact, null);
});

test("the original populated City slides along an existing parked car with one low-energy dent", () => {
  const world = new World({ cityVersion: 5 }, "metro");
  const player = world.player;
  const parked = world.statics.find(a => a.id === "grand-parked-tahrir-boulevard-0");
  const actors = [...world.actors];
  const theta = .1;
  Object.assign(player, {
    x: parked.x,
    z: parked.z - parked.width / 2 -
      (Math.sin(theta) * player.length / 2 + Math.cos(theta) * player.width / 2) - .003,
    heading: Math.PI / 2 - theta, speed: 6, steer: 0, path: [],
  });
  world.command({ type: "drive", targetSpeed: 6, steer: 0 });
  world.step();
  assert.equal(player.vehicle.contact.hitId, parked.id);
  assert.equal(player.vehicle.damage.impactCount, 1);
  assert.ok(player.vehicle.damage.left > 0);
  near(player.vehicle.damage.lastImpact.energyJ,
    .5 * 1800 * ((6 - 7 / 120) * Math.sin(.1)) ** 2, 1e-5);
  assert.ok(player.speed > 5, "a glancing City contact must not apply the old full-stop response");
  assert.ok(player.x > parked.x + .09);
  assert.equal(overlaps(player, parked), false);
  for (let i = 0; i < 10; i++) world.step();
  assert.equal(player.vehicle.damage.impactCount, 1);
  assert.equal(overlaps(player, parked), false);
  assert.ok(actors.every(a => world.actors.includes(a)), "the same ambient City actors remain");
  assert.deepEqual(world.audit(), []);
});

test("tangential exit from a real parked footprint ends the episode and permits a new impact", () => {
  const world = new World({ cityVersion: 5, traffic: 0, pedestrians: 0 }, "metro");
  const player = world.player;
  const parked = world.statics.find(a => a.id === "grand-parked-tahrir-boulevard-0");
  const initial = {
    x: parked.x,
    z: parked.z - parked.width / 2 -
      (Math.sin(.1) * player.length / 2 + Math.cos(.1) * player.width / 2) - .003,
    heading: Math.PI / 2 - .1, speed: 6, steer: 0, path: [],
  };
  Object.assign(player, initial);
  world.command({ type: "drive", targetSpeed: 6, steer: 0 });
  world.step();
  const first = structuredClone(player.vehicle.damage);
  assert.equal(first.impactCount, 1);
  world.step();
  assert.equal(player.vehicle.damage.impactCount, 1);
  assert.equal(player.vehicle.contact.hitId, parked.id);
  const normal = player.vehicle.contact.normal;
  const prior = { x: player.x, z: player.z };
  // Controlled pose setup isolates tangential separation, not reverse travel.
  Object.assign(player, { x: parked.x + 7, speed: 0 });
  world.command({ type: "stop" });
  world.step();
  near((player.x - prior.x) * normal.x + (player.z - prior.z) * normal.z, 0);
  assert.equal(player.vehicle.contact, null);
  assert.deepEqual(player.vehicle.damage, first);
  Object.assign(player, initial);
  world.command({ type: "drive", targetSpeed: 6, steer: 0 });
  world.step();
  assert.equal(player.vehicle.damage.impactCount, 2);
  assert.ok(player.vehicle.damage.left > first.left);
  assert.equal(overlaps(player, parked), false);
  assert.deepEqual(world.audit(), []);
});

test("new profiled tactical pursuits retain grip while their collision and braking authority stay separate", () => {
  for (const vehicleDynamics of ["legacy", "city-realism-v1"]) {
    const world = new World({ cityVersion: 5, vehicleDynamics, traffic: 0, pedestrians: 0 }, "metro");
    const original = world.player.spec;
    world.command({ type: "street-pursuit-start", variant: "gta", level: 1,
      config: { ruleset: "dispatch-v1", chasePresence: "city-chase-v1",
        tacticalPursuit: "gta-tactical-v1" } });
    assert.equal(world.player.spec.contactResponse, undefined);
    assert.equal(world.player.spec.braking, 9.6);
    if (vehicleDynamics === "legacy") {
      assert.equal(world.player.spec.tireGripMps2, undefined);
    } else {
      const body = vehicleProbe(world.player, 30);
      body.steer = .62;
      const next = integrateVehicle(body, { targetSpeed: 30, steer: .62 }, STEP);
      near(30 * (next.heading - body.heading) / STEP, 9.6);
      const braked = integrateVehicle(body, { targetSpeed: 0, steer: .62 }, STEP);
      near((body.speed - braked.speed) / STEP, 9.6);
    }
    world.command({ type: "street-pursuit-stop" });
    assert.equal(world.player.spec, original);
  }
});

test("new live City records its profile while unprofiled Metro v5 replays keep exact legacy dynamics", () => {
  for (const vehicleDynamics of ["legacy", "city-realism-v1"]) {
    const world = new World({ cityVersion: 5, vehicleDynamics, traffic: 0, pedestrians: 0 }, "metro");
    world.command({ type: "drive", targetSpeed: 8, steer: .05 });
    for (let i = 0; i < 120; i++) world.step();
    const replay = JSON.parse(JSON.stringify(world.replay()));
    assert.equal(replay.config.vehicleDynamics, vehicleDynamics === "legacy" ? undefined : vehicleDynamics);
    const restored = World.fromReplay(replay);
    assert.equal(restored.player.spec.contactResponse,
      vehicleDynamics === "legacy" ? undefined : spec.contactResponse);
    assert.deepEqual(restored.snapshot(), world.snapshot());
  }
  const legacy = car({ spec: {} });
  const next = integrateVehicle(legacy, { targetSpeed: 30, steer: .62 }, STEP);
  const beta = Math.atan(.5 * Math.tan(.62));
  near(next.heading, 30 / 2.6 * Math.cos(beta) * Math.tan(.62) * STEP);
  near(next.x, Math.sin(next.heading / 2 + beta) * 30 * STEP);
  assert.throws(() => new World({ cityVersion: 5, vehicleDynamics: "unknown" }, "metro"),
    /Unsupported City vehicle dynamics/);
});
