import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { World } from "../src/core/world.js";
import { overlaps } from "../src/core/geometry.js";
import { JETOUR_T2_ID, KING_LONG_MICROBUS_ID, getVehicleMounts } from "../src/core/vehicle-spec.js";

const output = process.env.PROVE_IT_OUTPUT_DIR;
assert.ok(output, "Set PROVE_IT_OUTPUT_DIR to a fresh evidence directory.");
await mkdir(output, { recursive: true });

const seed = "king-long-vehicle-verification";
const config = { seed, cityVersion: 5, traffic: 0, pedestrians: 0, chaos: 0, terrainProfile: "flat" };
const createCity = settings => new World({ ...config, ...settings }, "metro");
const choose = (world, model) => world.command({ type: "player-vehicle", model });
const step = (world, count) => { for (let i = 0; i < count; i++) world.step(); };
const snapshot = ({ player: p }) => ({
  model: p.vehicleModel ?? JETOUR_T2_ID, x: p.x, z: p.z, heading: p.heading,
  speed: p.speed, distance: p.distance, steer: p.steer, spin: p.vehicle.wheelSpinRad,
  frontLeft: p.vehicle.wheelAngles.frontLeft, roll: p.vehicle.suspension.rollRad,
  pitch: p.vehicle.suspension.pitchRad, wheelLoadsN: { ...p.vehicle.wheelLoadsN },
  length: p.length, width: p.width, height: p.height, maxSpeed: p.maxSpeed,
  plant: { ...p.spec },
});
const drive = (world, action, ticks) => {
  world.command({ type: "manual", ...action });
  step(world, ticks);
  return snapshot(world);
};
const sequence = world => ({
  initial: snapshot(world),
  straight: drive(world, { throttle: 1 }, 150),
  turn: drive(world, { throttle: 0.4, steer: 0.6 }, 36),
  brake: drive(world, { brake: 1 }, 120),
});
const near = (a, b, message) => assert.ok(Math.abs(a - b) < 1e-8, `${message}: ${a} versus ${b}`);
const report = { passed: false, runtime: "actual standalone City World fixed-step engine",
  baselineCommit: "e616585649b05282745354c99742ec025dfd68f9", seed };

try {
  const suv = createCity();
  report.suv = sequence(suv);
  // Measured on the previous released unmodified City, not derived from this version.
  near(report.suv.straight.speed, 6, "Original SUV acceleration");
  near(report.suv.straight.distance, 7.5, "Original SUV straight distance");
  near(report.suv.turn.heading, 1.933208848424867, "Original SUV steering");
  near(report.suv.turn.roll, 0.05735833663967079, "Original SUV load response");
  near(report.suv.brake.x, -240.56574412746784, "Original SUV final x");
  near(report.suv.brake.z, -111.59454961268246, "Original SUV final z");
  near(report.suv.brake.spin, 2.2193271876370635, "Original SUV wheel rotation");

  const van = createCity();
  const player = van.player, ambient = [...van.actors], start = snapshot(van), rng = van.rng.state;
  assert.equal(choose(van, KING_LONG_MICROBUS_ID).ok, true);
  assert.equal(van.player, player);
  assert.equal(van.rng.state, rng, "Switching must not spend City RNG or repopulate actors");
  assert.deepEqual(van.actors, ambient);
  assert.deepEqual([player.x, player.z, player.heading], [start.x, start.z, start.heading]);
  report.microbusMounts = getVehicleMounts(player);
  report.microbus = sequence(van);
  assert.ok(player.length > start.length + 0.5 && player.width < start.width && player.height > start.height);
  assert.ok(report.microbus.straight.speed > 3 && report.microbus.straight.speed < report.suv.straight.speed - 0.75);
  assert.ok(report.microbus.turn.heading > start.heading && report.microbus.turn.heading < report.suv.turn.heading);
  assert.equal(player.speed, 0);
  assert.equal(player.vehicle.contact?.hitId ?? null, null);
  near(report.microbus.straight.spin, (report.microbus.straight.distance / 0.315) % (2 * Math.PI),
    "Microbus wheel must roll with its smaller physical radius");
  near(Object.values(report.microbus.initial.wheelLoadsN).reduce((a, b) => a + b, 0), 2250 * 9.81,
    "Static wheel loads must reflect loaded microbus mass");
  near(report.microbusMounts.ranges[2].position.z, player.length / 2 + 0.04, "Forward range on microbus bumper");
  assert.ok(report.microbusMounts.camera.position.z > 1.4 && report.microbusMounts.camera.position.y > 1.5);

  report.matched = [];
  for (const model of [JETOUR_T2_ID, KING_LONG_MICROBUS_ID]) {
    const world = createCity();
    assert.ok(choose(world, model).ok);
    world.command({ type: "drive", targetSpeed: 5, steer: 0 });
    step(world, 180);
    const before = snapshot(world);
    near(before.speed, 5, "Matched braking input");
    const after = drive(world, { brake: 1 }, 100);
    assert.equal(after.speed, 0);
    assert.equal(world.player.vehicle.contact?.hitId ?? null, null);
    const corner = createCity();
    assert.ok(choose(corner, model).ok);
    corner.command({ type: "drive", targetSpeed: 4, steer: 0 });
    step(corner, 160);
    corner.command({ type: "drive", targetSpeed: 4, steer: 0.32 });
    step(corner, 55);
    const turning = snapshot(corner), heading = corner.player.previous.heading;
    const lateralMps2 = turning.speed * (turning.heading - heading) * 60;
    assert.ok(lateralMps2 > 0.8 && turning.roll > 0);
    report.matched.push({ model, brakeTravelM: after.distance - before.distance, leftTurn: turning,
      lateralMps2, rollPerLateralAccel: turning.roll / lateralMps2 });
  }
  assert.ok(report.matched[1].brakeTravelM > 1.13 * report.matched[0].brakeTravelM);
  assert.ok(report.matched[1].rollPerLateralAccel > 1.15 * report.matched[0].rollPerLateralAccel);

  const replay = World.fromReplay(van.replay());
  assert.deepEqual(snapshot(replay), snapshot(van), "Successful vehicle changes survive deterministic replay");
  assert.equal(choose(van, JETOUR_T2_ID).ok, true);
  assert.deepEqual(van.player.spec, report.suv.initial.plant);
  assert.deepEqual([van.player.length, van.player.width, van.player.height], [4.2, 1.85, 1.82]);
  assert.deepEqual(snapshot(World.fromReplay(van.replay())), snapshot(van), "Replay also restores the original rig profile");

  const moving = createCity();
  drive(moving, { throttle: 1 }, 60);
  const untouched = snapshot(moving), eventCount = moving.events.length;
  const denied = choose(moving, KING_LONG_MICROBUS_ID);
  assert.equal(denied.ok, false, "Cannot change dimensions while moving");
  assert.deepEqual(snapshot(moving), untouched);
  assert.equal(moving.events.length, eventCount);
  assert.equal(choose(moving, "unknown-model").ok, false);
  const blocked = createCity();
  const tree = blocked.statics.find(s => s.id === "city-tree-4");
  const p = blocked.player;
  Object.assign(p, { x: tree.x, z: tree.z - tree.length / 2 - 2.23, heading: 0 });
  assert.equal(overlaps(p, tree), false, "Control: original SUV fits without overlap");
  assert.equal(choose(blocked, KING_LONG_MICROBUS_ID).ok, false, "Longer model would overlap the real tree");
  assert.equal(p.vehicleModel ?? JETOUR_T2_ID, JETOUR_T2_ID);
  report.rejections = { moving: denied, overlap: true, unknown: true };

  report.impacts = [];
  for (const id of ["city-tree-4", "district-produce"]) {
    const impactWorld = createCity({ terrainProfile: undefined });
    assert.ok(choose(impactWorld, KING_LONG_MICROBUS_ID).ok);
    const target = impactWorld.statics.find(s => s.id === id), ip = impactWorld.player;
    Object.assign(ip, { x: target.x, z: target.z - 6, heading: 0, speed: 14 });
    impactWorld.command({ type: "drive", targetSpeed: 14, steer: 0 });
    let contactTicks = 0;
    for (let i = 0; i < 60; i++) {
      impactWorld.step();
      assert.equal(overlaps(ip, target), false, `Microbus must not tunnel through ${target.id}`);
      contactTicks += Number(ip.vehicle.contact?.hitId === target.id);
    }
    const hit = ip.vehicle.damage.lastImpact;
    assert.ok(contactTicks > 0, `Must contact ${target.id}, not stop at an unrelated road boundary`);
    assert.ok(hit.closingSpeedMps > 5 && hit.energyJ > 10_000 && target.propImpact.damage > 0);
    assert.ok(ip.z < target.z - ip.length / 2);
    report.impacts.push({ target: target.id, contactTicks, hit, vehicleDamage: ip.vehicle.damage.total,
      propDamage: target.propImpact.damage, bumperGapM: target.z - (ip.z + ip.length / 2) });
  }

  report.destinations = [];
  for (const id of ["corniche", "district-bakery"]) {
    const auto = createCity({ terrainProfile: undefined });
    assert.ok(choose(auto, KING_LONG_MICROBUS_ID).ok);
    const place = auto.district.places.find(p => p.id === id);
    assert.ok(auto.command({ type: "destination", place }));
    assert.equal(auto.mode, "auto");
    const routeLength = auto.player.path.length;
    while (auto.tick < 6000 && !auto.metrics.completedTrips) auto.step();
    const gap = Math.hypot(auto.player.x - place.x, auto.player.z - place.z);
    report.destinations.push({ id, routeLength, progressM: auto.player.distance, tick: auto.tick,
      arrived: auto.metrics.completedTrips === 1, remainingM: gap, speed: auto.player.speed,
      reason: auto.player.reason });
    assert.ok(routeLength > 1 && auto.metrics.completedTrips === 1 && gap < 0.8,
      `Microbus must complete the real City route to ${id}: ${auto.player.reason}, ${gap.toFixed(2)} m remaining`);
    assert.equal(auto.player.speed, 0);
  }

  const chase = createCity({ traffic: 12, pedestrians: 20 });
  const originals = [...chase.actors];
  assert.ok(choose(chase, KING_LONG_MICROBUS_ID).ok);
  const normal = snapshot(chase);
  chase.command({ type: "street-pursuit-start", level: 1, variant: "gta", config: {
    ruleset: "dispatch-v1", policeFairness: "city-fair-v1", tacticalPursuit: "gta-tactical-v1",
    chasePresence: "city-chase-v1", curbSupport: "metro-city-curbs-v2",
  } });
  assert.equal(chase.pursuit.phase, "running");
  assert.equal(choose(chase, JETOUR_T2_ID).ok, false, "A running Chase cannot swap the body");
  chase.command({ type: "pursuit-drive", action: { throttle: 1, steer: 0, brake: 0, gear: 1 } });
  step(chase, 70);
  assert.ok(chase.player.distance > 0.75 && chase.player.speed > 1);
  assert.ok(chase.player.spec.acceleration < 6.8 && chase.player.maxSpeed < 32);
  const caps = [...chase.pursuit.patrols].map(patrol => patrol.maxSpeed);
  assert.ok(caps.length && caps.every(cap => cap <= chase.player.maxSpeed));
  assert.ok(originals.every(actor => chase.actors.includes(actor)));
  report.chase = { played: snapshot(chase), policeCaps: caps };
  chase.command({ type: "street-pursuit-stop" });
  assert.deepEqual(chase.player.spec, normal.plant);
  assert.equal(chase.player.maxSpeed, normal.maxSpeed);
  report.passed = true;
} catch (error) {
  report.failure = error.stack ?? String(error);
  throw error;
} finally {
  await writeFile(join(output, "engine.json"), `${JSON.stringify(report, null, 2)}\n`);
}

console.log(`Matched full brake: SUV ${report.matched[0].brakeTravelM.toFixed(2)} m, microbus ${report.matched[1].brakeTravelM.toFixed(2)} m; real impact and replay verified.`);
