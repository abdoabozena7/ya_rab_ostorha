import assert from "node:assert/strict";
import test from "node:test";
import { sampleCitySurface } from "../src/core/city-surfaces.js";
import { STEP } from "../src/core/config.js";
import { angleDelta, bodyOnRoad, distance, overlaps } from "../src/core/geometry.js";
import { AGGRESSIVE_CHASE_PRESENCE } from "../src/core/pako-aggressive-police.js";
import { isPoseSupportedWithCurbs, METRO_CITY_CURBS } from "../src/core/pako-curb.js";
import { PATROL_LATERAL_YIELD } from "../src/core/pako-patrol-yield.js";
import { CITY_FAIR_POLICE, TACTICAL_PURSUIT_MODE } from "../src/core/pako-tactical-police.js";
import { DISPATCH_DAMAGE_FEEDBACK, PATROL_TRAFFIC_PREVIEW, refreshTacticalPatrolSpecs } from "../src/core/pursuit-gta.js";
import { SpatialIndex } from "../src/core/spatial-index.js";
import {
  getVehicleMounts, JETOUR_T2_ID, KING_LONG_MICROBUS, KING_LONG_MICROBUS_ID, mountToWorld,
} from "../src/core/vehicle-spec.js";
import { integrateVehicle } from "../src/core/vehicle.js";
import { computeWheelWorldPositions } from "../src/core/wheel-interaction-physics.js";
import { World } from "../src/core/world.js";

const city = (options = {}) => new World({ cityVersion: 5, traffic: 0, pedestrians: 0, ...options }, "metro");
const select = (world, model = KING_LONG_MICROBUS_ID) => world.command({ type: "player-vehicle", model });
const step = (world, ticks) => { for (let i = 0; i < ticks; i++) world.step(); };
const manual = (world, control) => world.command({ type: "manual", ...control });
const drive = (world, targetSpeed, steer = 0) => world.command({ type: "drive", targetSpeed, steer });
const near = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) < tolerance, `${actual} should be within ${tolerance} of ${expected}`);
const replay = (world) => World.fromReplay(JSON.parse(JSON.stringify(world.replay())));

function pair() {
  const suv = city(), van = city();
  assert.deepEqual(select(van), { ok: true, changed: true });
  return [suv, van];
}

test("the Metro switch is idle-only, atomic, and checks the oriented candidate against live solids and people", () => {
  const world = city({ traffic: 2, pedestrians: 3 });
  const { player, actors, statics, roads, district, graph } = world;
  const originalActors = [...actors];
  const originalPose = [player.x, player.y, player.z, player.heading];
  const originalRng = world.rng.state;
  const beforeMount = world.sensors.mounts.camera;
  assert.deepEqual(select(world, JETOUR_T2_ID), { ok: true, changed: false });

  const assertRejected = (model, error) => {
    const before = [world.events.length, world.sensors, player.spec, player.vehicle, world.actorIndex, world.input];
    const result = select(world, model);
    assert.equal(result.ok, false);
    assert.match(result.error, error);
    const after = [world.events.length, world.sensors, player.spec, player.vehicle, world.actorIndex, world.input];
    for (let i = 0; i < before.length; i++) assert.strictEqual(after[i], before[i]);
  };
  assertRejected("sports-bus", /Unknown/);
  assert.match(select(new World({}, "lab")).error, /only available in City/);
  manual(world, { throttle: 1 });
  assertRejected(KING_LONG_MICROBUS_ID, /Stop and idle/);
  world.command({ type: "stop" });

  const block = { id: "selector-test-solid", type: "static", x: player.x + 2.76, z: player.z,
    heading: player.heading, width: 1, length: 1 };
  assert.equal(overlaps(player, block), false, "the SUV fits, but not the longer candidate");
  statics.push(block);
  assertRejected(KING_LONG_MICROBUS_ID, /clear space/);
  statics.pop();
  const person = { id: "selector-test-person", type: "pedestrian", x: player.x + 2.56, z: player.z, radius: 0.3 };
  assert.equal(overlaps(player, person), false);
  actors.push(person);
  assertRejected(KING_LONG_MICROBUS_ID, /clear space/);
  actors.pop();

  block.x = player.x + 2.94;
  statics.push(block); // Close but genuinely clear; an inflated guard would reject it.
  assert.deepEqual(select(world), { ok: true, changed: true });
  assert.equal(overlaps(player, block), false);
  statics.pop();
  assert.equal(world.rng.state, originalRng);
  assert.deepEqual([player.x, player.y, player.z, player.heading], originalPose);
  assert.equal(world.player, player);
  assert.equal(world.actors, actors);
  for (let i = 0; i < actors.length; i++) assert.equal(actors[i], originalActors[i]);
  assert.equal(world.statics, statics);
  assert.equal(world.roads, roads);
  assert.equal(world.district, district);
  assert.equal(world.graph, graph);
  assert.ok(world.actorIndex.matchesItems(actors));
  assert.notDeepEqual(world.sensors.mounts.camera, beforeMount);
  assert.deepEqual(world.sensors.mounts.camera.position, mountToWorld(player, getVehicleMounts(player).camera.position));
  assert.equal(world.sensors.imu.longitudinalAccelerationMps2, 0);
  assert.equal(world.state().player.vehicleModel, KING_LONG_MICROBUS_ID);
  assert.equal(world.snapshot().actors.find(a => a.id === player.id).vehicleModel, KING_LONG_MICROBUS_ID);
  assert.deepEqual(select(world), { ok: true, changed: false });

  block.x = player.x;
  block.z = player.z + .99;
  block.width = .2;
  statics.push(block);
  assert.equal(overlaps(player, block), false, "the narrow van fits, but not the wider SUV");
  assertRejected(JETOUR_T2_ID, /clear space/);
  statics.pop();

  assert.deepEqual(select(world, JETOUR_T2_ID), { ok: true, changed: true });
  assert.equal(Object.hasOwn(player, "vehicleModel"), false);
  assert.deepEqual(world.sensors.mounts.camera, beforeMount);
  assert.deepEqual(world.events.filter(e => e.command.type === "player-vehicle").map(e => e.command.model),
    [KING_LONG_MICROBUS_ID, JETOUR_T2_ID]);
});

test("identical Metro controls expose the van's acceleration, wheel radius, turning radius, roll, braking and reverse", () => {
  const [suv, van] = pair();
  const radii = [0.35, 0.315];
  for (const [i, world] of [suv, van].entries()) {
    manual(world, { throttle: 1 });
    step(world, 120);
    near(world.player.vehicle.wheelSpinRad, (world.player.distance / radii[i]) % (2 * Math.PI));
  }
  near(suv.player.speed, 4.8); // e616585, from rest at the original Metro spawn
  assert.ok(van.player.speed > 3 && van.player.speed < suv.player.speed - 1);
  assert.ok(van.player.distance < suv.player.distance - 1);
  const wheels = computeWheelWorldPositions(van.player);
  near(wheels.frontLeft.x - van.player.x, 1.555);
  near(wheels.rearLeft.x - van.player.x, -1.015);
  near(distance(wheels.frontLeft, wheels.frontRight), 1.45);

  const corner = (world) => {
    const p = world.player;
    drive(world, 5);
    step(world, 180);
    near(p.speed, 5);
    drive(world, 5, 1);
    step(world, 42);
    const { heading, distance: startDistance } = p;
    step(world, 12);
    near(p.speed, 5);
    assert.ok(p.vehicle.wheelAngles.frontRight > p.steer && p.steer > p.vehicle.wheelAngles.frontLeft);
    return { radius: (p.distance - startDistance) / Math.abs(angleDelta(p.heading, heading)),
      roll: p.vehicle.suspension.rollRad };
  };
  const [suvTurn, vanTurn] = pair().map(corner);
  assert.ok(vanTurn.radius > suvTurn.radius * 1.15);
  assert.ok(vanTurn.roll > suvTurn.roll * 1.3 && vanTurn.roll < .12);

  const stop = (world) => {
    drive(world, 5);
    step(world, 180);
    const p = world.player, start = p.distance;
    manual(world, { brake: 1 });
    let ticks = 0;
    while (p.speed > 0 && ticks++ < 100) world.step();
    assert.equal(p.speed, 0);
    const brakeDistance = p.distance - start;
    const stopX = p.x;
    manual(world, { throttle: 1, gear: -1 });
    step(world, 100);
    assert.ok(p.x < stopX);
    return { brakeDistance, reverse: p.speed };
  };
  const [suvStop, vanStop] = pair().map(stop);
  near(suvStop.brakeDistance, 1.7858333333333292);
  assert.ok(vanStop.brakeDistance > suvStop.brakeDistance * 1.2 && vanStop.brakeDistance < 2.5);
  assert.ok(vanStop.reverse < -1.5 && vanStop.reverse > suvStop.reverse);
});

test("the van's new footprint and mass participate in real static impact, without penetration", () => {
  const impact = (world) => {
    const p = world.player;
    const barrier = { id: "physical-test-barrier", type: "static", x: p.x + p.length / 2 + .54,
      z: p.z, heading: p.heading, width: 3, length: 1, height: 1 };
    world.statics.push(barrier);
    world.staticIndex = new SpatialIndex(world.statics);
    p.speed = 5; // Matched initial approach in this controlled City scenario.
    manual(world, { throttle: 1 });
    world.step();
    assert.equal(p.vehicle.contact.hitId, barrier.id);
    assert.equal(p.vehicle.damage.lastImpact.side, "front");
    assert.equal(p.speed, 0);
    assert.equal(overlaps(p, barrier), false);
    const { closingSpeedMps, energyJ } = p.vehicle.damage.lastImpact;
    return { reach: barrier.x - barrier.length / 2 - p.x, mass: 2 * energyJ / closingSpeedMps ** 2 };
  };
  const [suv, van] = pair().map(impact);
  near(suv.reach, 2.1, 1e-6);
  near(van.reach, 2.42, 1e-6);
  near(suv.mass, 1800);
  near(van.mass, 2250);
});

test("real Metro curb and flyover runs exercise profile-specific wheel support and downhill Nitro cap", () => {
  const scrub = (world) => {
    const p = world.player;
    Object.assign(p, { z: -107.2, heading: 1.10, speed: 2.4 });
    assert.ok(bodyOnRoad(p, world.roads));
    drive(world, 2.4);
    let first = null, peakStroke = 0, peakHeight = 0;
    for (let i = 0; i < 75; i++) {
      world.step();
      const { suspension, interaction } = p.vehicle;
      peakStroke = Math.max(peakStroke, ...Object.values(suspension.wheelOffsetsM).map(Math.abs));
      peakHeight = Math.max(peakHeight, p.y ?? 0);
      if (interaction.scraping.kind === "curb" && first === null) {
        assert.equal(p.curbSupportId, "tahrir-boulevard:pos:6");
        assert.equal(interaction.scraping.wheel, "frontLeft");
        first = world.tick;
      }
    }
    assert.ok(first !== null && peakHeight > .01);
    assert.ok(isPoseSupportedWithCurbs(world.curbs, world.roads, p));
    assert.ok(!world.statics.some(body => overlaps(p, body)));
    return { first, peakStroke };
  };
  const [suvCurb, vanCurb] = pair().map(scrub);
  assert.ok(vanCurb.first < suvCurb.first);
  assert.ok(vanCurb.peakStroke > suvCurb.peakStroke && vanCurb.peakStroke <= .085);

  const climb = (world) => {
    const p = world.player;
    p.x = -20; // Tahrir's original uphill ramp, heading east from the City start lane.
    const atRest = p.vehicle.wheelLoadsN;
    manual(world, { throttle: 1 });
    step(world, 120);
    assert.ok(p.vehicle.surface.gradeSin > .05 && p.x > -20);
    assert.ok(p.vehicle.suspension.pitchRad < -.01);
    assert.ok(p.vehicle.wheelLoadsN.rearLeft > atRest.rearLeft + 500);
    return p.speed;
  };
  const [suvClimb, vanClimb] = pair().map(climb);
  assert.ok(vanClimb > 2 && vanClimb < suvClimb - 1);

  const [, van] = pair();
  Object.assign(van.player, { x: 60, speed: 12.45 });
  manual(van, { throttle: 1, nitro: 1 });
  for (let i = 0; i < 36; i++) {
    van.step();
    assert.ok(van.player.speed <= 12.5);
  }
  assert.ok(van.player.vehicle.surface.gradeSin < -.05);
  assert.equal(van.player.nitroActive, true);
  assert.ok(van.player.speed > 12.45 && van.player.nitroCharge < 0.9);
});

test("the van reaches the bakery and Corniche on shipped Metro terrain without road-boundary holds", () => {
  const options = { seed: "king-long-vehicle-verification", chaos: 0 };
  for (const id of ["district-bakery", "corniche"]) {
    const van = city(options);
    assert.equal(van.config.terrainProfile, "cairo-surfaces-v1");
    assert.deepEqual(select(van), { ok: true, changed: true });
    const place = id === "district-bakery"
      ? van.district.showcaseRoutes[0].goal : van.district.places.find(p => p.id === id);
    assert.equal(place.id, id);
    assert.equal(van.command({ type: "destination", place }), true);
    assert.equal(van.mode, "auto");
    assert.match(select(van, JETOUR_T2_ID).error, /Stop and idle/);
    let boundaryHolds = 0;
    for (let i = 0; i < 5000 && !van.metrics.completedTrips; i++) {
      van.step();
      boundaryHolds += Number(van.player.reason === "road-boundary");
    }
    assert.equal(van.metrics.completedTrips, 1,
      `${id} must complete, not stop at ${van.player.reason} (cursor ${van.player.cursor})`);
    assert.equal(boundaryHolds, 0);
    assert.ok(van.player.distance > 100 && distance(van.player, place) < .8);
    assert.ok(Math.abs(angleDelta(van.player.heading, place.heading)) <= .2);
    assert.equal(van.player.speed, 0);
    assert.deepEqual(van.audit(), []);
    if (id === "district-bakery") assert.deepEqual(replay(van).snapshot(), van.snapshot());
  }

  const suv = city(options);
  assert.equal(suv.command({ type: "destination", place: suv.district.showcaseRoutes[0].goal }), true);
  for (let i = 0; i < 5000 && !suv.metrics.completedTrips; i++) suv.step();
  assert.equal(suv.metrics.completedTrips, 1);
  assert.equal(suv.tick, 3867); // Baseline before the profile-specific navigation repair.
  near(suv.player.x, 3.7506785804529987);
  near(suv.player.z, 1.4065418178864242);
  near(suv.player.heading, 1.5654977997941382);
});

const fairChaseConfig = {
  ruleset: "dispatch-v1", damageFeedback: DISPATCH_DAMAGE_FEEDBACK, wantedLevelMax: 5, maxActivePatrols: 14,
  curbSupport: METRO_CITY_CURBS, chasePresence: AGGRESSIVE_CHASE_PRESENCE, tacticalPursuit: TACTICAL_PURSUIT_MODE,
  policeFairness: CITY_FAIR_POLICE, patrolTrafficPreview: PATROL_TRAFFIC_PREVIEW, patrolChainYield: PATROL_LATERAL_YIELD,
};

test("standard fair City Chase retains the selected manual plant; unsupported variants leave the City unchanged", () => {
  const [suv, van] = pair();
  const citySpec = van.player.spec;
  const previous = van.snapshot();
  assert.throws(() => van.command({ type: "street-pursuit-start", level: 1, variant: "hunt" }), /standard manual City Chase/);
  assert.deepEqual(van.snapshot(), previous);

  for (const world of [suv, van]) {
    world.command({ type: "street-pursuit-start", level: 1, variant: "gta", config: fairChaseConfig });
    assert.ok(world.pursuit.patrols.size > 0);
    for (const patrol of world.pursuit.patrols) assert.equal(patrol.maxSpeed, world === van ? 25 : 28);
    assert.equal(world.mode, "manual");
    manual(world, { throttle: 1 });
    step(world, 120);
    assert.equal(world.pursuit.phase, "running");
  }
  near(suv.player.speed, 13.6);
  near(van.player.speed, 9);
  assert.equal(van.player.maxSpeed, 25);
  assert.equal(van.player.gtaMassKg, KING_LONG_MICROBUS.massKg);
  assert.match(select(van, JETOUR_T2_ID).error, /End Chase/);
  assert.equal(van.command({ type: "mode", mode: "auto" }), false);
  assert.equal(van.mode, "manual");
  assert.deepEqual(replay(van).snapshot(), van.snapshot());
  van.command({ type: "street-pursuit-stop" });
  assert.equal(van.player.spec, citySpec);
  assert.equal(van.player.maxSpeed, 12.5);
  assert.equal(van.player.vehicleModel, KING_LONG_MICROBUS_ID);
  manual(van, { brake: 1 });
  step(van, 150);
  assert.equal(van.player.speed, 0);
  van.pursuit.reviewUntilTick = van.tick + 1;
  assert.match(select(van, JETOUR_T2_ID).error, /impact review/);
});

test("the fair minibus cap covers all deployed patrol types, spec refresh and downhill propulsion", () => {
  const [, van] = pair();
  van.command({ type: "street-pursuit-start", level: 5, variant: "gta",
    config: { ...fairChaseConfig, enableSwat: true } });
  const dispatched = [...van.pursuit.patrols];
  assert.ok(dispatched.length > 4);
  assert.deepEqual(new Set(dispatched.map(patrol => patrol.unitType)), new Set(["patrol", "interceptor", "swat"]));
  assert.ok(dispatched.every(patrol => patrol.maxSpeed <= van.player.maxSpeed));

  van.pursuit.wantedLevel = 3;
  refreshTacticalPatrolSpecs(van.pursuit);
  const heading = Math.PI / 2;
  const surface = sampleCitySurface(van.terrain, 60, -109.3, heading);
  assert.ok(surface.gradeSin < -.05);
  for (const patrol of dispatched) {
    assert.ok(patrol.maxSpeed <= van.player.maxSpeed);
    const pose = { ...patrol, x: 60, z: -109.3, heading, speed: patrol.maxSpeed };
    const next = integrateVehicle(pose, { targetSpeed: 30, steer: 0, surface }, STEP);
    assert.ok(next.speed <= van.player.maxSpeed);
  }
});

test("successful selection replays both ways; rejected or malformed swaps cannot change history", () => {
  const [, van] = pair();
  manual(van, { throttle: 1 });
  step(van, 120);
  assert.match(select(van, JETOUR_T2_ID).error, /Stop and idle/);
  assert.equal(van.replay().events.filter(e => e.command.type === "player-vehicle").length, 1);
  assert.deepEqual(replay(van).snapshot(), van.snapshot());

  const tampered = van.replay();
  tampered.events.push({ tick: van.tick, command: { type: "player-vehicle", model: JETOUR_T2_ID } });
  assert.throws(() => World.fromReplay(tampered), /Invalid replay vehicle swap/);
  tampered.events[0].command.model = "not-a-model";
  assert.throws(() => World.fromReplay(tampered), /Invalid replay event/);
  assert.throws(() => World.fromReplay({ ...van.replay(), environment: "city" }), /Invalid replay event/);

  manual(van, { brake: 1 });
  step(van, 100);
  assert.deepEqual(select(van, JETOUR_T2_ID), { ok: true, changed: true });
  assert.deepEqual(replay(van).snapshot(), van.snapshot());
  assert.equal(Object.hasOwn(replay(van).snapshot().actors[0], "vehicleModel"), false);
});

test("stock and historic no-selection Jetour trajectories match e616585 in the same Metro layout", () => {
  const controls = [[{ throttle: 1 }, 120], [{ throttle: 1, steer: .6 }, 55],
    [{ brake: 1 }, 65], [{ throttle: 1, gear: -1, steer: -.5 }, 70]];
  const options = { seed: "king-long-jetour-baseline", traffic: 2, pedestrians: 3 };
  const stock = city(options);
  for (const [control, ticks] of controls) {
    manual(stock, control);
    step(stock, ticks);
  }
  const measured = [stock.player.x, stock.player.z, stock.player.heading, stock.player.speed, stock.player.vehicle.wheelSpinRad];
  const expected = [-243.14095631738945, -112.8276436582951, 2.554750214568248, -2.5, -3.145302319267942];
  measured.forEach((value, i) => near(value, expected[i]));
  assert.deepEqual(replay(stock).snapshot(), stock.snapshot());
  assert.equal(Object.hasOwn(stock.player, "vehicleModel"), false);
  const historic = World.fromReplay({ ...stock.replay(), config: { ...options, cityVersion: 5 } });
  near(historic.player.x, -243.26753779277732);
  near(historic.player.z, -112.95682617503971);
  near(historic.player.heading, 2.5806862514859907);
  near(historic.player.vehicle.wheelSpinRad, -3.1453023192684104);
  assert.equal(historic.config.vehicleDynamics, undefined);
  assert.equal(Object.hasOwn(historic.player, "vehicleModel"), false);
});
