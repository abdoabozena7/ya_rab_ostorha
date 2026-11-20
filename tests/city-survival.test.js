import assert from "node:assert/strict";
import test from "node:test";
import { angleDelta, bodyOnRoad, distance, overlaps } from "../src/core/geometry.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import { World } from "../src/core/world.js";

const start = { type: "street-pursuit-start", level: 3, variant: "survival" };
const coast = { steer: 0, throttle: 0, brake: 0, gear: 1 };
const initialCity = options => new World({ cityVersion: 4, traffic: 0, pedestrians: 0, ...options }, "metro");
const advance = (world, ticks) => { for (let i = 0; i < ticks; i++) world.step(); };
const direction = (car, metres) => ({
  x: car.x + Math.sin(car.heading) * metres, z: car.z + Math.cos(car.heading) * metres, heading: car.heading,
});
const drive = (world, action) => world.command({ type: "pursuit-drive", action: { ...coast, ...action } });

function controlled(options) {
  const world = initialCity(options);
  world.command(start);
  const stockPatrols = [...world.pursuit.patrols];
  for (const actor of stockPatrols) world.actors.splice(world.actors.indexOf(actor), 1);
  world.pursuit.patrols.clear();
  world.pursuit.nextDispatchTick = Infinity;
  world.command({ type: "mode", mode: "manual" });
  drive(world);
  world.actorIndex = new SpatialIndex(world.actors);
  return { world, stockPatrols, power: world.pursuit.survival, player: world.player };
}

function acquire({ world, player, power }, kind) {
  power.pickup = { ...direction(player, .4), kind, until: world.tick + 60 };
  world.step();
  assert.ok(power.effects.some(e => e.kind === kind && e.type === "pickup"));
}

function setupPatrol({ world, stockPatrols, player }, metres, speed = 10) {
  const patrol = stockPatrols.shift();
  Object.assign(patrol, direction(player, metres), { speed, path: [] });
  patrol.heading += Math.PI;
  patrol.pursuitDrive.nextPlan = Infinity;
  world.actors.push(patrol);
  world.pursuit.patrols.add(patrol);
  return patrol;
}

test("survival keeps the same City, moving civilians and original SUV", () => {
  const world = initialCity({ traffic: 12, pedestrians: 12 });
  const { player, roads, statics, actors } = world;
  const originals = actors.map(actor => ({ actor, ...actor }));
  const before = world.tick;
  world.command(start);
  assert.equal(world.mode, "auto");
  assert.equal(world.pursuit.patrols.size, 2);
  assert.ok([...world.pursuit.patrols].every(car => car.speed > 0 && bodyOnRoad(car, world.roads)));
  advance(world, 96);
  assert.equal(world.tick - before, 96);
  assert.ok(world.pursuit.metrics.distanceM > 2);
  assert.ok(originals.some(p => p.type === "pedestrian" && distance(p, p.actor) > .3));
  assert.ok(originals.some(p => p.type === "vehicle" && p.actor !== player && distance(p, p.actor) > .3));
  assert.ok(world.pursuit.decision && world.pursuit.learner.snapshot().updates === 0);
  world.command({ type: "street-pursuit-stop" });
  assert.equal(world.mode, "manual");
  assert.equal(world.roads, roads);
  assert.equal(world.statics, statics);
  assert.equal(world.player, player);
  assert.equal(world.actors, actors);
  assert.deepEqual(actors, originals.map(p => p.actor));
  assert.deepEqual(world.audit(), []);
});

test("survival escalates through City streets with a genuinely heavy body and peer wrecks", () => {
  const world = initialCity();
  world.command(start);
  const s = world.pursuit, a = s.survival, trace = new Map(), sectors = new Set();
  let max = 2, heavy = null, pileup = null, previous = 0;
  while (s.phase === "running" && s.metrics.survivalS < 21) {
    world.step();
    max = Math.max(max, s.patrols.size);
    for (const event of a.effects) if (event.id > previous) {
      if (event.type === "dispatch") {
        sectors.add(event.sector);
        trace.set(event.actorId, event);
      }
      if (event.type === "wreck" && event.reason === "patrol") pileup = event;
      previous = event.id;
    }
    heavy ||= [...s.patrols].find(car => car.pursuitUnit === "heavy" && car.distance > 3);
  }
  assert.ok(s.metrics.survivalS > 18 && a.spawnCount >= 10 && max >= 7 && sectors.size >= 3);
  assert.ok(heavy && heavy.kind === "van" && heavy.length > 5 && heavy.width > 2 && trace.has(heavy.id));
  assert.ok(pileup && a.effects.some(event => event.id !== pileup.id && event.tick === pileup.tick &&
    event.type === "wreck" && event.actorId !== pileup.actorId));
  assert.ok([...a.wrecks].every(([wreck]) => world.actors.includes(wreck) && wreck.speed === 0));
  assert.deepEqual(world.audit(), []);
});

test("survival manual drift changes the accepted trajectory without changing normal braking", () => {
  const left = controlled(), straight = controlled();
  for (const { world } of [left, straight]) advance(world, 105);
  assert.ok(left.player.speed > 3.9);
  const before = left.player.heading;
  drive(left.world, { steer: .6 });
  advance(left.world, 23);
  advance(straight.world, 23);
  assert.ok(angleDelta(left.player.heading, before) > .1);
  assert.ok(left.player.arcadeSlip < -.06);
  assert.ok(distance(left.player, straight.player) > .17);
  drive(left.world, { brake: 1, steer: 0 });
  advance(left.world, 60);
  assert.equal(left.player.speed, 0);
  assert.deepEqual(left.world.audit(), []);
});

test("survival powers use actual City bodies, not animation-only events", () => {
  const plain = controlled(), giant = controlled();
  for (const item of [plain, giant]) {
    const { world, player, power } = item;
    const nominal = player.width;
    if (item === giant) {
      acquire(item, "giant");
      assert.ok(player.width > nominal * 1.3);
    }
    const patrol = setupPatrol(item, player.length / 2 + 2.23 + .035);
    for (let i = 0; i < 10 && world.pursuit.phase === "running" && world.actors.includes(patrol); i++) world.step();
    if (item === giant) {
      assert.equal(world.pursuit.phase, "running");
      assert.equal(world.actors.includes(patrol), false);
      assert.ok(power.effects.some(e => e.type === "wreck" && e.reason === "giant"));
      world.command({ type: "street-pursuit-stop" });
      assert.equal(player.width, nominal);
    } else assert.equal(world.pursuit.metrics.terminalCause, "police-touch");
    assert.deepEqual(world.audit(), []);
  }

  const ghost = controlled(), { world, player, power } = ghost;
  acquire(ghost, "ghost");
  const barrier = { ...direction(player, 3.9), id: "verification-street-prop", type: "static",
    kind: "barrier", width: 2.4, length: .45, height: .65 };
  world.statics = world.statics.concat(barrier);
  world.staticIndex = new SpatialIndex(world.statics);
  while (!overlaps(player, barrier) && world.tick < 110 && world.pursuit.phase === "running") world.step();
  assert.ok(overlaps(player, barrier));
  assert.equal(world.pursuit.phase, "running");
  assert.throws(() => world.command({ type: "street-pursuit-stop" }), /Move clear/);
  power.active.until = world.tick;
  world.step();
  assert.equal(power.active?.kind, "ghost");
  while (power.active && world.tick < 190 && world.pursuit.phase === "running") world.step();
  assert.equal(power.active, null);
  assert.equal(world.pursuit.phase, "running");
  assert.ok(distance(player, barrier) > 2);
  assert.deepEqual(world.audit(), []);
  world.command({ type: "street-pursuit-stop" });
});

test("survival Ghost phases through civilian vehicles but cannot pass a person", () => {
  const ghost = controlled({ pedestrians: 1 }), { world, player, power } = ghost;
  acquire(ghost, "ghost");
  const lateral = offset => ({ x: Math.cos(player.heading) * offset, z: -Math.sin(player.heading) * offset });
  const civilian = world.makeVehicle("verification-civilian", "sedan", direction(player, 5.2));
  const side = lateral(1.15);
  civilian.x += side.x;
  civilian.z += side.z;
  civilian.maxSpeed = 0;
  world.actors.push(civilian);
  while (!overlaps(player, civilian) && world.tick < 120 && world.pursuit.phase === "running") world.step();
  assert.ok(overlaps(player, civilian) && world.audit().length === 0);
  assert.throws(() => world.command({ type: "street-pursuit-stop" }), /Move clear/);
  const person = world.actors.find(actor => actor.type === "pedestrian");
  world.command({ type: "pedestrian-motion", id: person.id, mode: "stop" });
  Object.assign(person, direction(player, player.length / 2 + person.radius + .015), { speed: 0 });
  const otherSide = lateral(-.65);
  person.x += otherSide.x;
  person.z += otherSide.z;
  assert.equal(overlaps(person, civilian), false);
  player.speed = 8;
  advance(world, 2);
  assert.equal(world.pursuit.metrics.terminalCause, "pedestrian-impact");
  assert.ok(world.pursuit.metrics.pedestrianCost >= 240 && person.impact);
  while (world.pursuit.reviewUntilTick) world.step();
  assert.equal(power.active, null);
  assert.deepEqual(world.audit(), []);
});

test("survival Mine and Pulse spend one charge and disable real City patrols", () => {
  for (const kind of ["mine", "pulse"]) {
    const item = controlled(), { world, player, power } = item;
    assert.equal(world.command({ type: "pursuit-use" }), false);
    acquire(item, kind);
    const before = { ...player };
    assert.equal(world.command({ type: "pursuit-use" }), true);
    assert.equal(world.command({ type: "pursuit-use" }), false);
    world.step();
    const [device] = power.devices;
    assert.equal(device.kind, kind);
    assert.equal(power.held, null);
    const longitudinal = (device.x - before.x) * Math.sin(before.heading) +
      (device.z - before.z) * Math.cos(before.heading);
    assert.ok(kind === "mine" ? longitudinal < -2 : longitudinal > 2);
    drive(world, { brake: 1 });
    const patrol = setupPatrol(item, kind === "mine" ? -5.3 : 6.7, kind === "mine" ? 0 : 1);
    while (!patrol.pursuitWreck && world.pursuit.phase === "running" && world.tick < 40) world.step();
    assert.ok(patrol.pursuitWreck && power.wrecks.has(patrol));
    assert.ok(power.effects.some(e => e.actorId === patrol.id && e.reason === kind));
    assert.equal(world.pursuit.phase, "running");
  }
});

test("survival replay reproduces real collection, use, score, and City coordinates", () => {
  const world = initialCity();
  world.command(start);
  while (!world.pursuit.survival.held && world.pursuit.phase === "running" && world.tick < 750) world.step();
  assert.equal(world.pursuit.survival.held, "mine");
  assert.ok(world.command({ type: "pursuit-use" }));
  advance(world, 100);
  const replay = World.fromReplay(world.replay());
  assert.deepEqual(replay.snapshot(), world.snapshot());
});
